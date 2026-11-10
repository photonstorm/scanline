//! The control API on a local socket, and the client side of it.
//!
//! JSON-RPC, one message per line, over a Unix socket only the user can open. No network
//! port is opened (02-ARCHITECTURE.md, sections 9.2 and 10). The running host writes a
//! runtime file beside the socket; the other modes find the host through it.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use scanline_core::Host;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

fn home() -> PathBuf {
    scanline_core::default_home()
}

fn socket_path() -> PathBuf {
    home().join("control.sock")
}

fn runtime_path() -> PathBuf {
    home().join("runtime.json")
}

/// The connection to the host was lost mid-call.
#[derive(Debug)]
pub struct Dropped;

impl std::fmt::Display for Dropped {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "The Scanline host stopped while the command was running. Its sessions are gone; launch again.")
    }
}

impl std::error::Error for Dropped {}

#[cfg(unix)]
pub async fn serve() -> Result<()> {
    use std::os::unix::fs::PermissionsExt;

    let home = home();
    let socket = socket_path();

    std::fs::create_dir_all(&home).with_context(|| format!("creating {}", home.display()))?;
    std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o700)).ok();

    if tokio::net::UnixStream::connect(&socket).await.is_ok() {
        bail!("A Scanline host is already running (socket {}). Use `scanline stop` to stop it.", socket.display());
    }

    // A socket file left by a host that did not exit cleanly.
    let _ = std::fs::remove_file(&socket);

    let listener = tokio::net::UnixListener::bind(&socket).with_context(|| {
        format!("binding the control socket at {}. If the path is too long for a socket, set SCANLINE_HOME to a shorter directory.", socket.display())
    })?;

    std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600)).ok();

    std::fs::write(runtime_path(), json!({ "socket": socket, "pid": std::process::id(), "version": env!("CARGO_PKG_VERSION") }).to_string())
        .with_context(|| format!("writing {}", runtime_path().display()))?;

    let host = Host::new(home.clone())?;
    let stop = Arc::new(tokio::sync::Notify::new());

    eprintln!("scanline {} serving on {}", env!("CARGO_PKG_VERSION"), socket.display());

    let mut interrupt = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())?;
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;

    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let Ok((stream, _)) = accepted else { continue };

                tokio::spawn(connection(stream, host.clone(), stop.clone()));
            }
            _ = stop.notified() => break,
            _ = interrupt.recv() => break,
            _ = terminate.recv() => break,
        }
    }

    // Close every browser before going, so none is left running with nobody driving it.
    host.shutdown().await;

    let _ = std::fs::remove_file(&socket);
    let _ = std::fs::remove_file(runtime_path());

    Ok(())
}

#[cfg(unix)]
async fn connection(stream: tokio::net::UnixStream, host: Arc<Host>, stop: Arc<tokio::sync::Notify>) {
    let (read, mut write) = stream.into_split();
    let (replies, mut outbox) = tokio::sync::mpsc::unbounded_channel::<String>();

    tokio::spawn(async move {
        while let Some(reply) = outbox.recv().await {
            if write.write_all(reply.as_bytes()).await.is_err() || write.write_all(b"\n").await.is_err() {
                break;
            }
        }
    });

    let mut lines = BufReader::new(read).lines();

    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(request) = serde_json::from_str::<Value>(&line) else { continue };
        let host = host.clone();
        let replies = replies.clone();
        let stop = stop.clone();

        // Each request runs on its own task: a long wait must not hold up a pause.
        tokio::spawn(async move {
            let id = request["id"].clone();
            let method = request["method"].as_str().unwrap_or("").to_string();

            let reply = if method == "host.stop" {
                stop.notify_one();
                json!({ "id": id, "result": { "summary": "Scanline host stopping; its browsers are being closed.", "data": {}, "images": [] } })
            } else {
                match host.call(&method, request["params"].clone()).await {
                    Ok(result) => json!({ "id": id, "result": result }),
                    Err(error) => json!({ "id": id, "error": { "message": format!("{error:#}") } }),
                }
            };

            let _ = replies.send(reply.to_string());
        });
    }
}

#[cfg(not(unix))]
pub async fn serve() -> Result<()> {
    bail!("The Scanline host does not run on this platform yet. macOS only for now.")
}

/// A client connection to the running host.
#[cfg(unix)]
pub struct Link {
    lines: tokio::io::Lines<BufReader<tokio::net::unix::OwnedReadHalf>>,
    write: tokio::net::unix::OwnedWriteHalf,
    next_id: u64,
}

#[cfg(unix)]
impl Link {
    /// Connects to the host, starting it first if it is not running.
    pub async fn connect() -> Result<Self> {
        if let Some(link) = Self::try_connect().await {
            return Ok(link);
        }

        start_host()?;

        for _ in 0..100 {
            tokio::time::sleep(Duration::from_millis(50)).await;

            if let Some(link) = Self::try_connect().await {
                return Ok(link);
            }
        }

        bail!("Started the Scanline host but could not reach it at {} within 5 s. Run `scanline serve` in a terminal to see why.", socket_path().display())
    }

    pub async fn try_connect() -> Option<Self> {
        let stream = tokio::net::UnixStream::connect(socket_path()).await.ok()?;
        let (read, write) = stream.into_split();

        Some(Link { lines: BufReader::new(read).lines(), write, next_id: 1 })
    }

    pub async fn call(&mut self, method: &str, params: Value) -> Result<Value> {
        let id = self.next_id;

        self.next_id += 1;

        let request = json!({ "id": id, "method": method, "params": params }).to_string();

        if self.write.write_all(request.as_bytes()).await.is_err() || self.write.write_all(b"\n").await.is_err() {
            return Err(Dropped.into());
        }

        loop {
            let line = match self.lines.next_line().await {
                Ok(Some(line)) => line,
                _ => return Err(Dropped.into()),
            };

            let Ok(mut reply) = serde_json::from_str::<Value>(&line) else { continue };

            if reply["id"].as_u64() != Some(id) {
                continue;
            }

            return match reply.get("error") {
                Some(error) => Err(anyhow!("{}", error["message"].as_str().unwrap_or("The host reported an error it did not describe."))),
                None => Ok(reply["result"].take()),
            };
        }
    }
}

/// Starts the host as a process of its own that outlives this one.
#[cfg(unix)]
fn start_host() -> Result<()> {
    use std::os::unix::process::CommandExt;

    let executable = std::env::current_exe().context("finding the scanline binary to start the host")?;
    let home = home();

    std::fs::create_dir_all(&home).with_context(|| format!("creating {}", home.display()))?;

    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(home.join("host.log"))
        .with_context(|| format!("opening {}", home.join("host.log").display()))?;

    let mut command = std::process::Command::new(executable);

    command.arg("serve").stdin(std::process::Stdio::null()).stdout(log.try_clone()?).stderr(log);

    // Its own session, so closing the terminal or the agent client does not take the host
    // (and the browsers a person may be playing in) down with it.
    unsafe {
        command.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }

    command.spawn().context("starting the Scanline host")?;

    Ok(())
}

#[cfg(unix)]
pub async fn stop() -> Result<String> {
    match Link::try_connect().await {
        None => Ok("No Scanline host is running.".to_string()),
        Some(mut link) => {
            let reply = link.call("host.stop", json!({})).await?;

            // Wait for it to finish closing browsers, so a following command starts a fresh host.
            for _ in 0..100 {
                if !socket_path().exists() {
                    break;
                }

                tokio::time::sleep(Duration::from_millis(50)).await;
            }

            Ok(reply["summary"].as_str().unwrap_or("Stopped.").replace("stopping; its browsers are being closed.", "stopped; its browsers are closed."))
        }
    }
}

#[cfg(not(unix))]
pub struct Link;

#[cfg(not(unix))]
impl Link {
    pub async fn connect() -> Result<Self> {
        bail!("Scanline does not run on this platform yet. macOS only for now.")
    }

    pub async fn call(&mut self, _method: &str, _params: Value) -> Result<Value> {
        bail!("Scanline does not run on this platform yet. macOS only for now.")
    }
}

#[cfg(not(unix))]
pub async fn stop() -> Result<String> {
    bail!("Scanline does not run on this platform yet. macOS only for now.")
}
