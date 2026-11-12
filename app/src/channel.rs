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

/// A connection to the host, as a half to read and a half to write.
#[cfg(unix)]
pub fn dial(home: &Path) -> std::io::Result<(Reader, Writer)> {
    let stream = std::os::unix::net::UnixStream::connect(home.join("control.sock"))?;
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
    let pipe = std::fs::OpenOptions::new().read(true).write(true).open(name)?;
    let reader = pipe.try_clone()?;

    Ok((Box::new(reader), Box::new(pipe)))
}
