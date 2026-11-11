//! MCP over loopback HTTP (02-ARCHITECTURE.md, sections 9.1 and 10): `scanline serve --http`.
//!
//! For a client that speaks MCP over HTTP and cannot spawn `scanline mcp`. It is the one
//! listening network port Scanline ever opens, so it is off unless asked for, and narrow:
//!
//!   - bound to 127.0.0.1, never to another address;
//!   - every request carries a token made for this run of the host, which is written to a
//!     file only the person can read (`http-token` in the home directory);
//!   - the `Host` header has to name this machine and this port, which stops a web page
//!     from reaching the port through a name it controls (DNS rebinding);
//!   - a request with an `Origin` header is refused: a browser sends one, and no page (the
//!     game included) has any business here.
//!
//! The transport is the plain part of MCP's streamable HTTP: one JSON-RPC message in a
//! POST to /mcp, one JSON answer back. There is no server-sent stream, because the server
//! never speaks first.

use std::path::Path;
use std::sync::Arc;

use anyhow::{Context, Result, bail};
use scanline_core::Host;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const HEAD_LIMIT: usize = 16 * 1024;
const BODY_LIMIT: usize = 8 * 1024 * 1024;

/// A token for this run: 32 bytes from the operating system, as hex.
fn new_token() -> Result<String> {
    let mut bytes = [0u8; 32];

    #[cfg(unix)]
    std::io::Read::read_exact(&mut std::fs::File::open("/dev/urandom").context("opening /dev/urandom for a token")?, &mut bytes)?;

    #[cfg(windows)]
    {
        use windows_sys::Win32::Security::Cryptography::{BCRYPT_USE_SYSTEM_PREFERRED_RNG, BCryptGenRandom};

        let status = unsafe { BCryptGenRandom(std::ptr::null_mut(), bytes.as_mut_ptr(), bytes.len() as u32, BCRYPT_USE_SYSTEM_PREFERRED_RNG) };

        if status != 0 {
            bail!("The operating system gave no random bytes for a token (status {status:#x}).");
        }
    }

    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

pub fn token_path(home: &Path) -> std::path::PathBuf {
    home.join("http-token")
}

/// Whether two strings are equal, taking the same time whatever they hold.
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Binds the port and writes the token. Returns the listener, the port it got and the token.
pub async fn bind(home: &Path, port: u16) -> Result<(TcpListener, u16, String)> {
    let listener = TcpListener::bind(("127.0.0.1", port)).await.with_context(|| format!("binding 127.0.0.1:{port} for MCP over HTTP"))?;
    let port = listener.local_addr()?.port();
    let token = new_token()?;
    let path = token_path(home);

    // Made private from the instant it exists. On Unix that is its mode. On Windows a new
    // file takes the rule of the directory it is made in, and the host has already made
    // the home directory the person's alone (control.rs).
    let _ = std::fs::remove_file(&path);
    let mut options = std::fs::OpenOptions::new();

    options.write(true).create_new(true);

    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);

    let mut file = options.open(&path).with_context(|| format!("writing {}", path.display()))?;

    std::io::Write::write_all(&mut file, token.as_bytes())?;

    Ok((listener, port, token))
}

pub async fn serve(listener: TcpListener, port: u16, token: String, host: Arc<Host>) {
    let token = Arc::new(token);

    loop {
        let Ok((stream, _)) = listener.accept().await else { continue };

        tokio::spawn(connection(stream, port, token.clone(), host.clone()));
    }
}

struct Request {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Request {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(key, _)| key.eq_ignore_ascii_case(name)).map(|(_, value)| value.as_str())
    }
}

/// Reads one request. `Ok(None)` when the client has closed the connection.
async fn read_request(stream: &mut TcpStream, pending: &mut Vec<u8>) -> Result<Option<Request>> {
    let end = loop {
        if let Some(at) = pending.windows(4).position(|window| window == b"\r\n\r\n") {
            break at;
        }

        if pending.len() > HEAD_LIMIT {
            bail!("431 the request's headers are too long");
        }

        let mut chunk = [0u8; 4096];
        let read = stream.read(&mut chunk).await?;

        if read == 0 {
            return if pending.is_empty() { Ok(None) } else { bail!("400 the request was cut short") };
        }

        pending.extend_from_slice(&chunk[..read]);
    };

    let head = String::from_utf8_lossy(&pending[..end]).to_string();
    let mut lines = head.split("\r\n");
    let mut first = lines.next().unwrap_or("").split(' ');
    let (method, path) = (first.next().unwrap_or("").to_string(), first.next().unwrap_or("").to_string());
    let headers: Vec<(String, String)> =
        lines.filter_map(|line| line.split_once(':')).map(|(name, value)| (name.trim().to_string(), value.trim().to_string())).collect();

    pending.drain(..end + 4);

    let mut request = Request { method, path, headers, body: Vec::new() };

    if request.header("transfer-encoding").is_some() {
        bail!("411 send the body with Content-Length");
    }

    let length: usize = match request.header("content-length") {
        Some(text) => text.parse().map_err(|_| anyhow::anyhow!("400 Content-Length is not a number"))?,
        None => 0,
    };

    if length > BODY_LIMIT {
        bail!("413 the request is larger than {BODY_LIMIT} bytes");
    }

    while pending.len() < length {
        let mut chunk = [0u8; 16384];
        let read = stream.read(&mut chunk).await?;

        if read == 0 {
            bail!("400 the request was cut short");
        }

        pending.extend_from_slice(&chunk[..read]);
    }

    request.body = pending.drain(..length).collect();

    Ok(Some(request))
}

async fn respond(stream: &mut TcpStream, status: &str, extra: &str, body: &str) -> std::io::Result<()> {
    let kind = if body.starts_with('{') || body.starts_with('[') { "application/json" } else { "text/plain; charset=utf-8" };
    let head = format!("HTTP/1.1 {status}\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nCache-Control: no-store\r\n{extra}\r\n", body.len());

    stream.write_all(head.as_bytes()).await?;
    stream.write_all(body.as_bytes()).await?;
    stream.flush().await
}

/// Why a request is refused before it is read as MCP, as a status line and words; or None.
fn refusal(request: &Request, port: u16, token: &str) -> Option<(&'static str, &'static str, String)> {
    // The name the client used for this server. Anything but this machine and this port is
    // a name somebody else controls.
    let host = request.header("host").unwrap_or("");

    if host != format!("127.0.0.1:{port}") && host != format!("localhost:{port}") {
        return Some(("403 Forbidden", "", "This server answers only as 127.0.0.1 or localhost, on its own port.".into()));
    }

    // A browser says where a request comes from. Nothing a page sends is wanted here.
    if request.header("origin").is_some() {
        return Some(("403 Forbidden", "", "Requests from web pages are refused.".into()));
    }

    let given = request.header("authorization").and_then(|value| value.strip_prefix("Bearer ")).unwrap_or("");

    if !same(given.trim(), token) {
        return Some((
            "401 Unauthorized",
            "WWW-Authenticate: Bearer\r\n",
            "Send the token for this run of the host as Authorization: Bearer <token>. It is in the file http-token in Scanline's home directory.".into(),
        ));
    }

    let path = request.path.split('?').next().unwrap_or("");

    if path != "/mcp" {
        return Some(("404 Not Found", "", "MCP is served at /mcp.".into()));
    }

    if request.method != "POST" {
        // There is no stream to open (GET) and no session to end (DELETE).
        return Some(("405 Method Not Allowed", "Allow: POST\r\n", "Send each MCP message in a POST.".into()));
    }

    None
}

async fn connection(mut stream: TcpStream, port: u16, token: Arc<String>, host: Arc<Host>) {
    let mut pending = Vec::new();

    loop {
        let request = match read_request(&mut stream, &mut pending).await {
            Ok(Some(request)) => request,
            Ok(None) => return,
            Err(error) => {
                let text = error.to_string();
                let (status, words) = text.split_once(' ').unwrap_or(("400", "the request could not be read"));
                let line = match status {
                    "411" => "411 Length Required",
                    "413" => "413 Content Too Large",
                    "431" => "431 Request Header Fields Too Large",
                    _ => "400 Bad Request",
                };
                let _ = respond(&mut stream, line, "Connection: close\r\n", words).await;

                return;
            }
        };

        if let Some((status, extra, words)) = refusal(&request, port, &token) {
            if respond(&mut stream, status, extra, &words).await.is_err() {
                return;
            }

            continue;
        }

        let call = |command: String, arguments: Value| {
            let host = host.clone();

            async move { host.call(&command, arguments).await }
        };

        let reply = match serde_json::from_slice::<Value>(&request.body) {
            // Earlier revisions of MCP allowed several messages in one request.
            Ok(Value::Array(messages)) => {
                let mut replies = Vec::new();

                for message in &messages {
                    if let Some(reply) = scanline_mcp::handle(message, &call).await {
                        replies.push(reply);
                    }
                }

                (!replies.is_empty()).then(|| Value::Array(replies))
            }
            Ok(message) => scanline_mcp::handle(&message, &call).await,
            Err(error) => Some(json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": format!("Parse error: {error}") } })),
        };

        let sent = match reply {
            Some(reply) => respond(&mut stream, "200 OK", "", &reply.to_string()).await,
            // A notification, or a response to something the server asked: nothing to say.
            None => respond(&mut stream, "202 Accepted", "", "").await,
        };

        if sent.is_err() {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(headers: &[(&str, &str)], method: &str, path: &str) -> Request {
        Request {
            method: method.into(),
            path: path.into(),
            headers: headers.iter().map(|(name, value)| (name.to_string(), value.to_string())).collect(),
            body: Vec::new(),
        }
    }

    #[test]
    fn only_this_machine_this_port_and_the_token_get_through() {
        let good = [("Host", "127.0.0.1:4000"), ("Authorization", "Bearer secret")];

        assert!(refusal(&request(&good, "POST", "/mcp"), 4000, "secret").is_none());
        assert!(refusal(&request(&[("host", "localhost:4000"), ("authorization", "Bearer secret")], "POST", "/mcp?x=1"), 4000, "secret").is_none());

        let status = |headers: &[(&str, &str)], method: &str, path: &str| refusal(&request(headers, method, path), 4000, "secret").map(|refused| refused.0);

        // A name somebody else controls, pointed at this machine.
        assert_eq!(status(&[("Host", "evil.example:4000"), ("Authorization", "Bearer secret")], "POST", "/mcp"), Some("403 Forbidden"));
        assert_eq!(status(&[("Host", "127.0.0.1:4001"), ("Authorization", "Bearer secret")], "POST", "/mcp"), Some("403 Forbidden"));
        assert_eq!(status(&[("Authorization", "Bearer secret")], "POST", "/mcp"), Some("403 Forbidden"));

        // A web page, even one served from this machine, even with the token.
        assert_eq!(
            status(&[("Host", "127.0.0.1:4000"), ("Origin", "http://localhost:5173"), ("Authorization", "Bearer secret")], "POST", "/mcp"),
            Some("403 Forbidden")
        );

        assert_eq!(status(&[("Host", "127.0.0.1:4000")], "POST", "/mcp"), Some("401 Unauthorized"));
        assert_eq!(status(&[("Host", "127.0.0.1:4000"), ("Authorization", "Bearer secre")], "POST", "/mcp"), Some("401 Unauthorized"));
        assert_eq!(status(&[("Host", "127.0.0.1:4000"), ("Authorization", "Basic secret")], "POST", "/mcp"), Some("401 Unauthorized"));
        assert_eq!(status(&good, "POST", "/"), Some("404 Not Found"));
        assert_eq!(status(&good, "GET", "/mcp"), Some("405 Method Not Allowed"));
    }

    #[test]
    fn tokens_are_compared_whole() {
        assert!(same("abc", "abc"));
        assert!(!same("abc", "abd"));
        assert!(!same("abc", "abcd"));
        assert!(!same("", "a"));
    }
}
