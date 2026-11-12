//! Opened from the Dock or the Finder: ask the host for a session shown in the app, and go.
//!
//! The host launches this same executable again as the session's player, over the pipe, as
//! it would launch Chrome. The request goes to the host's control socket as the person's own;
//! if no host is running, the command line inside the bundle (Contents/MacOS/scanline-cli)
//! starts one first.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde_json::{Value, json};

/// The command line that starts the host: the one beside the app (named scanline-cli, as file
/// names on a Mac and on Windows ignore case and the app is Scanline), else `SCANLINE_BIN`,
/// else `scanline`.
fn command_line(me: &Path) -> PathBuf {
    let bundled = me.parent().map(|folder| folder.join(if cfg!(windows) { "scanline-cli.exe" } else { "scanline-cli" }));

    match (bundled, std::env::var_os("SCANLINE_BIN")) {
        (Some(path), _) if path.exists() => path,
        (_, Some(path)) => PathBuf::from(path),
        _ => PathBuf::from("scanline"),
    }
}

/// The page a new window opens on: the app's own start page, in the bundle's Resources on a
/// Mac and beside the executable on Windows.
fn start_page(me: &Path) -> String {
    let folder = me.parent();
    let page = if cfg!(windows) {
        folder.map(|folder| folder.join("start.html"))
    } else {
        folder.and_then(Path::parent).map(|contents| contents.join("Resources/start.html"))
    };

    page.filter(|page| page.exists()).map(|page| page.display().to_string()).unwrap_or_else(|| "about:blank".to_string())
}

#[cfg(target_os = "macos")]
fn alert(title: &str, message: &str) {
    let quote = |text: &str| text.replace('\\', "\\\\").replace('"', "\\\"");
    let script = format!("display alert \"{}\" message \"{}\" as critical", quote(title), quote(message));

    let _ = Command::new("osascript").arg("-e").arg(script).status();
}

#[cfg(windows)]
fn alert(title: &str, message: &str) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MB_ICONERROR, MB_OK, MessageBoxW};

    let wide = |text: &str| text.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let (title, message) = (wide(title), wide(message));

    unsafe {
        MessageBoxW(std::ptr::null_mut(), message.as_ptr(), title.as_ptr(), MB_OK | MB_ICONERROR);
    }
}

/// One call to the host, as the person.
fn call(home: &Path, method: &str, mut params: Value) -> Result<Value, String> {
    let (reader, mut writer) = crate::channel::dial(home).map_err(|error| error.to_string())?;

    params["_by"] = json!("person");

    let line = json!({ "id": 1, "method": method, "params": params }).to_string();

    writer.write_all(format!("{line}\n").as_bytes()).map_err(|error| error.to_string())?;
    writer.flush().ok();

    let mut reply = String::new();

    BufReader::new(reader).read_line(&mut reply).map_err(|error| error.to_string())?;

    let mut reply: Value = serde_json::from_str(&reply).map_err(|_| "The host's reply could not be read.".to_string())?;

    match reply.get("error") {
        Some(error) => Err(error["message"].as_str().unwrap_or("The host reported an error.").to_string()),
        None => Ok(reply["result"].take()),
    }
}

pub fn run(argv: &[String]) {
    // Capture files opened from the Finder arrive as an event once the application has
    // started, not on the command line: GPUI is started, without a window, to hear them.
    let opened = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let heard = opened.clone();
    let argv = argv.to_vec();

    let application = gpui::Application::new();

    application.on_open_urls(move |urls| heard.lock().unwrap().extend(urls));
    application.run(move |cx| {
        cx.spawn(async move |cx| {
            cx.background_executor().timer(std::time::Duration::from_millis(400)).await;

            let files: Vec<PathBuf> = opened.lock().unwrap().iter().filter_map(|url| file_path(url)).collect();

            open(&argv, &files);
            let _ = cx.update(|cx| cx.quit());
        })
        .detach();
    });
}

/// A file:// URL as a path.
pub fn file_path(url: &str) -> Option<PathBuf> {
    let rest = url.strip_prefix("file://")?;
    let bytes = rest.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut at = 0;

    while at < bytes.len() {
        if bytes[at] == b'%' && at + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(std::str::from_utf8(&bytes[at + 1..at + 3]).ok()?, 16) {
                decoded.push(byte);
                at += 3;
                continue;
            }
        }

        decoded.push(bytes[at]);
        at += 1;
    }

    let path = String::from_utf8(decoded).ok()?;

    // file:///C:/… on Windows.
    let path = if cfg!(windows) { path.trim_start_matches('/').to_string() } else { path };

    Some(PathBuf::from(path))
}

/// Asks the host for a window, and shows in it any capture files that were opened.
fn open(argv: &[String], files: &[PathBuf]) {
    let me = std::env::current_exe().expect("own path");
    let home = crate::channel::home();

    // A page given on the command line (Scanline https://…), or the start page.
    let url = argv.iter().skip(1).find(|arg| !arg.starts_with('-')).cloned().unwrap_or_else(|| start_page(&me));

    // No host: the command line starts one (any command does), and it is waited for.
    if crate::channel::dial(&home).is_err() {
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

    // Each capture file is read into the host's captures first.
    let mut captures = Vec::new();

    for file in files {
        match call(&home, "import", json!({ "path": file.display().to_string() })) {
            Ok(reply) => captures.extend(reply["data"]["capture"].as_str().map(str::to_string)),
            Err(error) => alert(&format!("Scanline could not open {}", file.display()), &error),
        }
    }

    let browser = me.display().to_string();

    match call(&home, "launch", json!({ "url": url, "display": "app", "browser": browser })) {
        Err(error) => alert("Scanline could not open a window", &error),
        // A host from before the app ignores display and opens a browser window instead.
        Ok(reply) if reply["data"]["display"] != "app" => {
            if let Some(session) = reply["data"]["session"].as_str() {
                let _ = call(&home, "close", json!({ "session": session }));
            }

            alert(
                "An older Scanline host is running",
                "The Scanline host running now was started by an older scanline, which cannot show a game in the app. Stop it with `scanline stop` in a terminal, then open Scanline again.",
            );
        }
        Ok(reply) => {
            // The last capture opened is shown in the new window's Captures panel.
            if let (Some(session), Some(capture)) = (reply["data"]["session"].as_str(), captures.last()) {
                let _ = call(&home, "viewer", json!({ "session": session, "show": "capture", "capture": capture }));
            }
        }
    }
}
