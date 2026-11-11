//! A Debug key that works whatever application has the keyboard (04-AGENT-INTERFACE.md,
//! hand-off): `scanline hotkey <session> [key]`.
//!
//! F9 in the game's window is seen by the page. When the person is playing in another
//! window, or the game has the pointer and another application the keys, it is not. So
//! while the person has been asked to press Debug, the host runs this as a helper: it asks
//! the operating system for the key, and each press makes the same `debug` call the strip's
//! button does. It is a process of its own so that nothing it does can hurt the host, and
//! it holds the key only while a request is open: the host stops it at the press.
//!
//! macOS only: the key is registered with Carbon's hot key API, which needs no permission
//! from the person (unlike watching the keyboard, which does).

use anyhow::{Result, bail};

/// A key by name, as the virtual key code macOS knows it by.
#[cfg(target_os = "macos")]
fn key_code(name: &str) -> Option<u32> {
    Some(match name.to_ascii_uppercase().as_str() {
        "F1" => 0x7A,
        "F2" => 0x78,
        "F3" => 0x63,
        "F4" => 0x76,
        "F5" => 0x60,
        "F6" => 0x61,
        "F7" => 0x62,
        "F8" => 0x64,
        "F9" => 0x65,
        "F10" => 0x6D,
        "F11" => 0x67,
        "F12" => 0x6F,
        "F13" => 0x69,
        "F14" => 0x6B,
        "F15" => 0x71,
        _ => return None,
    })
}

#[cfg(target_os = "macos")]
mod carbon {
    use std::ffi::c_void;

    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct HotKeyId {
        pub signature: u32,
        pub id: u32,
    }

    #[repr(C)]
    pub struct EventType {
        pub class: u32,
        pub kind: u32,
    }

    pub const KEYBOARD: u32 = u32::from_be_bytes(*b"keyb");
    pub const HOT_KEY_PRESSED: u32 = 5;
    pub const DIRECT_OBJECT: u32 = u32::from_be_bytes(*b"----");
    pub const HOT_KEY_ID: u32 = u32::from_be_bytes(*b"hkid");

    pub type Handler = extern "C" fn(next: *mut c_void, event: *mut c_void, data: *mut c_void) -> i32;

    #[link(name = "Carbon", kind = "framework")]
    unsafe extern "C" {
        pub fn GetApplicationEventTarget() -> *mut c_void;
        pub fn GetMainEventQueue() -> *mut c_void;
        pub fn RegisterEventHotKey(key: u32, modifiers: u32, id: HotKeyId, target: *mut c_void, options: u32, out: *mut *mut c_void) -> i32;
        pub fn InstallEventHandler(
            target: *mut c_void,
            handler: Handler,
            count: usize,
            types: *const EventType,
            data: *mut c_void,
            out: *mut *mut c_void,
        ) -> i32;
        pub fn RunApplicationEventLoop();
        pub fn QuitApplicationEventLoop();
        pub fn CreateEvent(allocator: *const c_void, class: u32, kind: u32, when: f64, attributes: u32, out: *mut *mut c_void) -> i32;
        pub fn SetEventParameter(event: *mut c_void, name: u32, kind: u32, size: usize, data: *const c_void) -> i32;
        pub fn PostEventToQueue(queue: *mut c_void, event: *mut c_void, priority: i16) -> i32;
    }
}

/// What a press does: the same `debug` call the strip's button makes, for one session.
#[cfg(target_os = "macos")]
static SESSION: std::sync::OnceLock<(String, bool)> = std::sync::OnceLock::new();

#[cfg(target_os = "macos")]
fn press() -> Result<String> {
    use std::io::{BufRead, Write};

    let (session, _) = SESSION.get().expect("set before the key is registered");
    let socket = scanline_core::default_home().join("control.sock");
    let mut stream = std::os::unix::net::UnixStream::connect(&socket)?;

    stream.set_read_timeout(Some(std::time::Duration::from_secs(30)))?;
    writeln!(stream, "{}", serde_json::json!({ "id": 1, "method": "debug", "params": { "session": session, "by": "hotkey", "_by": "person" } }))?;

    let mut line = String::new();

    std::io::BufReader::new(stream).read_line(&mut line)?;

    Ok(line)
}

#[cfg(target_os = "macos")]
extern "C" fn pressed(_next: *mut std::ffi::c_void, _event: *mut std::ffi::c_void, _data: *mut std::ffi::c_void) -> i32 {
    let outcome = press();
    let once = SESSION.get().is_some_and(|(_, once)| *once);

    match &outcome {
        Ok(reply) if once => println!("pressed: {}", reply.trim().chars().take(200).collect::<String>()),
        Err(error) => eprintln!("scanline hotkey: the press could not be passed on: {error}"),
        _ => {}
    }

    // One press is one Debug. The host starts another helper with the next request.
    unsafe { carbon::QuitApplicationEventLoop() };

    0
}

/// Registers the key and waits for it. With `self_test`, posts the event a press would
/// cause, to prove the path from the operating system's event to the host without a hand
/// on the keyboard.
#[cfg(target_os = "macos")]
pub fn run(args: &[String]) -> Result<()> {
    let self_test = args.iter().any(|arg| arg == "--self-test");
    let mut plain = args.iter().filter(|arg| !arg.starts_with("--"));
    let Some(session) = plain.next() else {
        bail!(
            "scanline hotkey <session> [key]: holds a key system-wide (F9 by default) and makes each press a Debug press for that session. The host runs it while a person has been asked to press Debug."
        );
    };
    let name = plain.next().map(String::as_str).unwrap_or("F9");
    let Some(key) = key_code(name) else {
        bail!("\"{name}\" is not a key this can hold. It takes F1 to F15.");
    };

    SESSION.set((session.clone(), self_test)).ok();

    let id = carbon::HotKeyId { signature: u32::from_be_bytes(*b"scnl"), id: 1 };
    let types = [carbon::EventType { class: carbon::KEYBOARD, kind: carbon::HOT_KEY_PRESSED }];

    unsafe {
        let target = carbon::GetApplicationEventTarget();
        let mut handler = std::ptr::null_mut();
        let mut hot_key = std::ptr::null_mut();

        let installed = carbon::InstallEventHandler(target, pressed, 1, types.as_ptr(), std::ptr::null_mut(), &mut handler);

        if installed != 0 {
            bail!("The operating system would not take a handler for the key (error {installed}).");
        }

        let registered = carbon::RegisterEventHotKey(key, 0, id, target, 0, &mut hot_key);

        if registered != 0 {
            bail!(
                "The operating system would not give Scanline the {name} key (error {registered}): another application may hold it. F9 still works in the game's window and the strip."
            );
        }

        println!("holding {name} for {session}");

        if self_test {
            let mut event = std::ptr::null_mut();

            if carbon::CreateEvent(std::ptr::null(), carbon::KEYBOARD, carbon::HOT_KEY_PRESSED, 0.0, 0, &mut event) != 0 {
                bail!("The test event could not be made.");
            }

            carbon::SetEventParameter(event, carbon::DIRECT_OBJECT, carbon::HOT_KEY_ID, std::mem::size_of::<carbon::HotKeyId>(), (&raw const id).cast());
            carbon::PostEventToQueue(carbon::GetMainEventQueue(), event, 1);
        }

        carbon::RunApplicationEventLoop();
    }

    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn run(_args: &[String]) -> Result<()> {
    bail!("A system-wide Debug key is built for macOS only. F9 works in the game's window and the strip.")
}
