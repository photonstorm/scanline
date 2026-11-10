//! A thin DevTools Protocol client over the `--remote-debugging-pipe` transport.
//!
//! The pipe carries JSON messages separated by a NUL byte. There is no listening port, so
//! nothing else on the machine can attach to the browser (02-ARCHITECTURE.md, section 2.4).
//!
//! Messages are `serde_json::Value` for now. Generated protocol types are a later step; the
//! commands Scanline uses are few and each is wrapped where it is called.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use serde_json::{Value, json};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{broadcast, mpsc, oneshot};

/// An event from the browser.
#[derive(Debug, Clone)]
pub struct Event {
    pub method: String,
    pub params: Value,
    /// The flattened session the event belongs to; `None` for the browser itself.
    pub session: Option<String>,
}

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<std::result::Result<Value, String>>>>>;

/// One connection to a browser. Cheap to clone.
#[derive(Clone)]
pub struct Client {
    next_id: Arc<AtomicU64>,
    pending: Pending,
    outgoing: mpsc::UnboundedSender<Vec<u8>>,
    events: broadcast::Sender<Event>,
    closed: Arc<std::sync::atomic::AtomicBool>,
}

/// How long a command may go unanswered before it becomes an error that names it.
/// Spike S4 found a command the browser never answered; without this it looks like a hang.
pub const REPLY_TIMEOUT: Duration = Duration::from_secs(30);

impl Client {
    /// Starts the reader and writer tasks on the two ends of the pipe.
    pub fn new<R, W>(mut from_browser: R, mut to_browser: W) -> Self
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let (events, _) = broadcast::channel(4096);
        let (outgoing, mut queue) = mpsc::unbounded_channel::<Vec<u8>>();
        let closed = Arc::new(std::sync::atomic::AtomicBool::new(false));

        tokio::spawn(async move {
            while let Some(mut message) = queue.recv().await {
                message.push(0);

                if to_browser.write_all(&message).await.is_err() || to_browser.flush().await.is_err() {
                    break;
                }
            }
        });

        let reader_pending = pending.clone();
        let reader_events = events.clone();
        let reader_closed = closed.clone();

        tokio::spawn(async move {
            let mut buffer: Vec<u8> = Vec::with_capacity(1 << 16);
            let mut chunk = vec![0u8; 1 << 16];

            loop {
                let read = match from_browser.read(&mut chunk).await {
                    Ok(0) | Err(_) => break,
                    Ok(read) => read,
                };

                buffer.extend_from_slice(&chunk[..read]);

                while let Some(end) = buffer.iter().position(|byte| *byte == 0) {
                    let message: Vec<u8> = buffer.drain(..=end).collect();

                    if let Ok(value) = serde_json::from_slice::<Value>(&message[..message.len() - 1]) {
                        dispatch(value, &reader_pending, &reader_events);
                    }
                }
            }

            // The browser has gone. Fail everything still waiting, and say so.
            reader_closed.store(true, Ordering::SeqCst);

            for (_, waiter) in reader_pending.lock().unwrap().drain() {
                let _ = waiter.send(Err("the browser exited".to_string()));
            }

            let _ = reader_events.send(Event { method: "Scanline.disconnected".into(), params: Value::Null, session: None });
        });

        Client { next_id: Arc::new(AtomicU64::new(1)), pending, outgoing, events, closed }
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    /// Every event from every session. Filter on `Event::session` and `Event::method`.
    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.events.subscribe()
    }

    /// Sends a command and waits for its reply.
    pub async fn send(&self, method: &str, params: Value, session: Option<&str>) -> Result<Value> {
        self.send_with_timeout(method, params, session, REPLY_TIMEOUT).await
    }

    pub async fn send_with_timeout(&self, method: &str, params: Value, session: Option<&str>, timeout: Duration) -> Result<Value> {
        let (id, reply) = self.write(method, params, session)?;

        match tokio::time::timeout(timeout, reply).await {
            Ok(Ok(Ok(value))) => Ok(value),
            Ok(Ok(Err(message))) => Err(anyhow!("{method}: {message}")),
            Ok(Err(_)) => Err(anyhow!("{method}: the browser exited before replying")),
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                Err(anyhow!("{method} got no reply from the browser in {} s", timeout.as_secs()))
            }
        }
    }

    /// Writes a command without waiting for its reply.
    ///
    /// Needed for targets held at start: commands are written in order and the browser runs
    /// them in order once the target is released (spike S1).
    pub fn post(&self, method: &str, params: Value, session: Option<&str>) -> Result<()> {
        self.write(method, params, session).map(|_| ())
    }

    fn write(&self, method: &str, params: Value, session: Option<&str>) -> Result<(u64, oneshot::Receiver<std::result::Result<Value, String>>)> {
        if self.is_closed() {
            bail!("{method}: the browser has exited");
        }

        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let mut message = json!({ "id": id, "method": method, "params": params });

        if let Some(session) = session {
            message["sessionId"] = Value::String(session.to_string());
        }

        let (sender, receiver) = oneshot::channel();

        self.pending.lock().unwrap().insert(id, sender);
        self.outgoing.send(serde_json::to_vec(&message).context("encoding a protocol command")?).map_err(|_| anyhow!("{method}: the browser has exited"))?;

        Ok((id, receiver))
    }

    /// Waits for the next event that `matches`, up to `timeout`.
    pub async fn wait_for<F>(&self, mut receiver: broadcast::Receiver<Event>, timeout: Duration, mut matches: F) -> Result<Event>
    where
        F: FnMut(&Event) -> bool,
    {
        let wait = async {
            loop {
                match receiver.recv().await {
                    Ok(event) if matches(&event) => return Ok(event),
                    Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => bail!("the browser exited"),
                }
            }
        };

        tokio::time::timeout(timeout, wait).await.map_err(|_| anyhow!("timed out after {} ms waiting for a browser event", timeout.as_millis()))?
    }
}

fn dispatch(mut value: Value, pending: &Pending, events: &broadcast::Sender<Event>) {
    if let Some(id) = value.get("id").and_then(Value::as_u64) {
        let Some(waiter) = pending.lock().unwrap().remove(&id) else { return };

        let reply = match value.get("error") {
            Some(error) => Err(error.get("message").and_then(Value::as_str).unwrap_or("unknown protocol error").to_string()),
            None => Ok(value.get_mut("result").map(Value::take).unwrap_or(Value::Null)),
        };

        let _ = waiter.send(reply);

        return;
    }

    if let Some(method) = value.get("method").and_then(Value::as_str).map(str::to_string) {
        let session = value.get("sessionId").and_then(Value::as_str).map(str::to_string);
        let params = value.get_mut("params").map(Value::take).unwrap_or(Value::Null);

        // No receivers is not an error: nobody is listening yet.
        let _ = events.send(Event { method, params, session });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn replies_and_events_are_split_on_nul_and_routed() {
        let (client_end, mut browser_end) = tokio::io::duplex(1 << 16);
        let (from_browser, to_browser) = tokio::io::split(client_end);
        let client = Client::new(from_browser, to_browser);
        let mut events = client.subscribe();

        let fake = tokio::spawn(async move {
            let mut received = Vec::new();
            let mut byte = [0u8; 1];

            loop {
                browser_end.read_exact(&mut byte).await.unwrap();

                if byte[0] == 0 {
                    break;
                }

                received.push(byte[0]);
            }

            let command: Value = serde_json::from_slice(&received).unwrap();

            assert_eq!(command["method"], "Browser.getVersion");
            assert_eq!(command["sessionId"], "S1");

            // An event and the reply in one write, the event split across two.
            let event = br#"{"method":"Target.targetCreated","params":{"n":1},"sessionId":"S1"}"#;
            let reply = format!(r#"{{"id":{},"result":{{"product":"Chrome/1"}}}}"#, command["id"]);

            browser_end.write_all(&event[..10]).await.unwrap();
            browser_end.flush().await.unwrap();
            browser_end.write_all(&event[10..]).await.unwrap();
            browser_end.write_all(&[0]).await.unwrap();
            browser_end.write_all(reply.as_bytes()).await.unwrap();
            browser_end.write_all(&[0]).await.unwrap();

            browser_end
        });

        let reply = client.send("Browser.getVersion", json!({}), Some("S1")).await.unwrap();

        assert_eq!(reply["product"], "Chrome/1");

        let event = events.recv().await.unwrap();

        assert_eq!(event.method, "Target.targetCreated");
        assert_eq!(event.session.as_deref(), Some("S1"));
        assert_eq!(event.params["n"], 1);

        // When the browser goes away, a waiting command fails with a clear message.
        drop(fake.await.unwrap());

        let error = client.send("Page.enable", json!({}), None).await.unwrap_err().to_string();

        assert!(error.contains("exited"), "{error}");
    }

    #[tokio::test]
    async fn a_protocol_error_names_the_command() {
        let (client_end, mut browser_end) = tokio::io::duplex(1 << 16);
        let (from_browser, to_browser) = tokio::io::split(client_end);
        let client = Client::new(from_browser, to_browser);

        tokio::spawn(async move {
            let mut received = Vec::new();
            let mut byte = [0u8; 1];

            while browser_end.read_exact(&mut byte).await.is_ok() && byte[0] != 0 {
                received.push(byte[0]);
            }

            let command: Value = serde_json::from_slice(&received).unwrap();
            let reply = format!(r#"{{"id":{},"error":{{"code":-32601,"message":"'Nope.nope' wasn't found"}}}}"#, command["id"]);

            browser_end.write_all(reply.as_bytes()).await.unwrap();
            browser_end.write_all(&[0]).await.unwrap();
            tokio::time::sleep(Duration::from_millis(200)).await;
        });

        let error = client.send("Nope.nope", json!({}), None).await.unwrap_err().to_string();

        assert_eq!(error, "Nope.nope: 'Nope.nope' wasn't found");
    }
}
