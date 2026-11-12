//! Opened from the Dock or the Finder: ask the host for a session shown in the app, and go.
//!
//! The host launches this same executable again as the session's player, over the pipe, as
//! it would launch Chrome. The request goes to the host's control socket as the person's own;
//! if no host is running, the command line inside the bundle (Contents/MacOS/scanline-cli)
//! starts one first.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use serde_json::{Value, json};

/// The command line that starts the host: the one in this bundle (named scanline-cli, as file
/// names on a Mac ignore case and the app is Scanline), else `SCANLINE_BIN`, else `scanline`.
fn command_line(me: &Path) -> PathBuf {
    let bundled = me.parent().map(|folder| folder.join("scanline-cli"));

    match (bundled, std::env::var_os("SCANLINE_BIN")) {
        (Some(path), _) if path.exists() => path,
        (_, Some(path)) => PathBuf::from(path),
        _ => PathBuf::from("scanline"),
    }
}

fn home() -> PathBuf {
    std::env::var_os("SCANLINE_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join("Library/Application Support/Scanline"))
}

/// The page a new window opens on: the app's own start page.
fn start_page(me: &Path) -> String {
    me.parent()
        .and_then(Path::parent)
        .map(|contents| contents.join("Resources/start.html"))
        .filter(|page| page.exists())
        .map(|page| page.display().to_string())
        .unwrap_or_else(|| "about:blank".to_string())
}

fn alert(title: &str, message: &str) {
    let quote = |text: &str| text.replace('\\', "\\\\").replace('"', "\\\"");
    let script = format!("display alert \"{}\" message \"{}\" as critical", quote(title), quote(message));

    let _ = Command::new("osascript").arg("-e").arg(script).status();
}

/// One call to the host, as the person.
fn call(socket: &Path, method: &str, mut params: Value) -> Result<Value, String> {
    let mut stream = UnixStream::connect(socket).map_err(|error| error.to_string())?;

    params["_by"] = json!("person");
    stream.set_read_timeout(Some(Duration::from_secs(90))).ok();

    let line = json!({ "id": 1, "method": method, "params": params }).to_string();

    stream.write_all(format!("{line}\n").as_bytes()).map_err(|error| error.to_string())?;

    let mut reply = String::new();

    BufReader::new(stream).read_line(&mut reply).map_err(|error| error.to_string())?;

    let mut reply: Value = serde_json::from_str(&reply).map_err(|_| "The host's reply could not be read.".to_string())?;

    match reply.get("error") {
        Some(error) => Err(error["message"].as_str().unwrap_or("The host reported an error.").to_string()),
        None => Ok(reply["result"].take()),
    }
}

pub fn run(argv: &[String]) {
    let me = std::env::current_exe().expect("own path");
    let socket = home().join("control.sock");

    // A page given on the command line (Scanline https://…), or the start page.
    let url = argv.iter().skip(1).find(|arg| !arg.starts_with('-')).cloned().unwrap_or_else(|| start_page(&me));

    // No host: the command line starts one (any command does), and it is waited for.
    if UnixStream::connect(&socket).is_err() {
        let scanline = command_line(&me);
        let started = Command::new(&scanline).arg("sessions").env("SCANLINE_APP", &me).stdout(Stdio::null()).stderr(Stdio::piped()).output();

        if let Err(error) = started {
            alert(
                "Scanline could not start",
                &format!("It could not run its command line at {}: {error}. Reinstall Scanline, or set SCANLINE_BIN to a scanline binary.", scanline.display()),
            );
            return;
        }
    }

    let browser = me.display().to_string();

    match call(&socket, "launch", json!({ "url": url, "display": "app", "browser": browser })) {
        Err(error) => alert("Scanline could not open a window", &error),
        // A host from before the app ignores display and opens a browser window instead.
        Ok(reply) if reply["data"]["display"] != "app" => {
            if let Some(session) = reply["data"]["session"].as_str() {
                let _ = call(&socket, "close", json!({ "session": session }));
            }

            alert(
                "An older Scanline host is running",
                "The Scanline host running now was started by an older scanline, which cannot show a game in the app. Stop it with `scanline stop` in a terminal, then open Scanline again.",
            );
        }
        Ok(_) => {}
    }
}
