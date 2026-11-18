//! Where the host is, and a connection to it: a Unix socket in its home directory on macOS
//! and Linux, a named pipe on Windows whose name the host writes in `runtime.json` (the
//! same places `crates/scanline/src/control.rs` serves).

use std::io::{Read, Write};
use std::path::{Path, PathBuf};

/// The host's home: `SCANLINE_HOME`, else the usual place for the platform.
pub fn home() -> PathBuf {
    if let Some(home) = std::env::var_os("SCANLINE_HOME") {
        return PathBuf::from(home);
    }

    if cfg!(windows) {
        std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_default().join("Scanline")
    } else if cfg!(target_os = "macos") {
        PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join("Library/Application Support/Scanline")
    } else {
        PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".local/share/scanline")
    }
}

pub type Reader = Box<dyn Read + Send>;
pub type Writer = Box<dyn Write + Send>;

/// The host's socket: in its home directory, or, for a home whose path is too long to hold a
/// socket, in the short place the host chose and wrote in `runtime.json`.
#[cfg(unix)]
pub fn socket(home: &Path) -> PathBuf {
    let usual = home.join("control.sock");

    if usual.exists() {
        return usual;
    }

    std::fs::read_to_string(home.join("runtime.json"))
        .ok()
        .and_then(|runtime| serde_json::from_str::<serde_json::Value>(&runtime).ok())
        .and_then(|runtime| runtime["socket"].as_str().map(PathBuf::from))
        .unwrap_or(usual)
}

/// A connection to the host, as a half to read and a half to write.
#[cfg(unix)]
pub fn dial(home: &Path) -> std::io::Result<(Reader, Writer)> {
    let stream = std::os::unix::net::UnixStream::connect(socket(home))?;
    let reader = stream.try_clone()?;

    Ok((Box::new(reader), Box::new(stream)))
}

/// A connection to the host, as a half to read and a half to write. The pipe is opened
/// without overlapped I/O, so a read and a write on it wait for each other: use it for one
/// request and its reply at a time.
#[cfg(windows)]
pub fn dial(home: &Path) -> std::io::Result<(Reader, Writer)> {
    let runtime = std::fs::read_to_string(home.join("runtime.json"))?;
    let runtime: serde_json::Value = serde_json::from_str(&runtime).map_err(std::io::Error::other)?;
    let name = runtime["pipe"].as_str().ok_or_else(|| std::io::Error::other("runtime.json names no pipe"))?;

    // The host offers one instance of the pipe at a time, and the window asks it several
    // things at once: between the host taking one client and offering the pipe to the next,
    // every instance is in use. That is "busy", not "nobody there" (the host's own dial waits
    // the same way, crates/scanline/src/control.rs).
    const PIPE_BUSY: i32 = 231;

    for _ in 0..40 {
        match std::fs::OpenOptions::new().read(true).write(true).open(name) {
            Ok(pipe) => {
                let reader = pipe.try_clone()?;

                return Ok((Box::new(reader), Box::new(pipe)));
            }
            Err(error) if error.raw_os_error() == Some(PIPE_BUSY) => std::thread::sleep(std::time::Duration::from_millis(25)),
            Err(error) => return Err(error),
        }
    }

    Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "the host's pipe stayed busy for a second"))
}

/// Whether a failure to dial means there is no host, rather than one that did not answer.
pub fn no_host(error: &std::io::Error) -> bool {
    error.kind() == std::io::ErrorKind::NotFound
}
