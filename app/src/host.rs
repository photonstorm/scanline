//! The app's link to the Scanline host: the control API, JSON-RPC one message per line on the
//! host's Unix socket in its home directory (crates/scanline/src/control.rs).
//!
//! A thread keeps the connection, reconnecting if the host restarts; calls are queued and
//! their replies collected for the window to pick up on its next turn. Nothing here blocks
//! the window.

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};

pub type Reply = Result<Value, String>;

pub struct HostLink {
    outbox: Sender<(u64, String)>,
    replies: Arc<Mutex<VecDeque<(u64, Reply)>>>,
    connected: Arc<AtomicBool>,
    next: u64,
}

impl HostLink {
    pub fn open(home: &Path) -> Self {
        let (outbox, requests) = channel::<(u64, String)>();
        let replies = Arc::new(Mutex::new(VecDeque::new()));
        let connected = Arc::new(AtomicBool::new(false));

        let socket = home.join("control.sock");

        {
            let replies = replies.clone();
            let connected = connected.clone();

            std::thread::Builder::new().name("scanline-host-link".into()).spawn(move || keep(socket, requests, replies, connected)).expect("a thread");
        }

        HostLink { outbox, replies, connected, next: 1 }
    }

    pub fn connected(&self) -> bool {
        self.connected.load(Ordering::Relaxed)
    }

    /// Queues a call. `by` is "viewer" for the window keeping itself up to date, which the
    /// host does not log, or "person" for what the person does, which it logs as theirs.
    pub fn call(&mut self, method: &str, mut params: Value, by: &str) -> u64 {
        let id = self.next;

        self.next += 1;

        if !params.is_object() {
            params = json!({});
        }

        params["_by"] = json!(by);

        let line = json!({ "id": id, "method": method, "params": params }).to_string();

        if self.outbox.send((id, line)).is_err() {
            self.replies.lock().unwrap().push_back((id, Err("The link to the host has stopped.".into())));
        }

        id
    }

    pub fn drain(&self) -> Vec<(u64, Reply)> {
        self.replies.lock().unwrap().drain(..).collect()
    }
}

/// Holds the connection: dial, send what is queued, read what comes back, dial again.
fn keep(socket: PathBuf, requests: Receiver<(u64, String)>, replies: Arc<Mutex<VecDeque<(u64, Reply)>>>, connected: Arc<AtomicBool>) {
    loop {
        let stream = match UnixStream::connect(&socket) {
            Ok(stream) => stream,
            Err(_) => {
                // Calls made while there is no host fail at once, rather than piling up.
                while let Ok((id, _)) = requests.try_recv() {
                    replies.lock().unwrap().push_back((id, Err("The Scanline host is not running.".into())));
                }

                std::thread::sleep(Duration::from_millis(500));
                continue;
            }
        };

        connected.store(true, Ordering::Relaxed);

        let reader = match stream.try_clone() {
            Ok(reader) => reader,
            Err(_) => continue,
        };
        let alive = Arc::new(AtomicBool::new(true));

        {
            let replies = replies.clone();
            let alive = alive.clone();

            std::thread::spawn(move || {
                for line in BufReader::new(reader).lines() {
                    let Ok(line) = line else { break };
                    let Ok(mut message) = serde_json::from_str::<Value>(&line) else { continue };
                    let Some(id) = message["id"].as_u64() else { continue };
                    let reply = match message.get("error") {
                        Some(error) => Err(error["message"].as_str().unwrap_or("The host reported an error it did not describe.").to_string()),
                        None => Ok(message["result"].take()),
                    };

                    replies.lock().unwrap().push_back((id, reply));
                }

                alive.store(false, Ordering::Relaxed);
            });
        }

        let mut writer = stream;

        loop {
            if !alive.load(Ordering::Relaxed) {
                break;
            }

            match requests.recv_timeout(Duration::from_millis(200)) {
                Ok((id, line)) => {
                    if writer.write_all(line.as_bytes()).and_then(|_| writer.write_all(b"\n")).and_then(|_| writer.flush()).is_err() {
                        replies.lock().unwrap().push_back((id, Err("The connection to the host was lost.".into())));
                        break;
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return,
            }
        }

        connected.store(false, Ordering::Relaxed);
        let _ = writer.shutdown(std::net::Shutdown::Both);
    }
}
