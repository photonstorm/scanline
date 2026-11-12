//! The CEF side: the application object every process shares, and the browser's client.
//!
//! With `external_message_pump` the browser process's UI thread is the main thread, the one
//! GPUI runs on, so every callback here arrives on it and the shared state can be
//! thread-local. The page itself is driven by the host over `--remote-debugging-pipe`; this
//! side only creates the browser and reports what it sees for the window's title and bar.

use std::cell::RefCell;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use cef::*;

/// What the browser has said since the window last looked.
#[derive(Default)]
pub struct Inbox {
    pub context_ready: bool,
    pub created: Option<Browser>,
    pub title: Option<String>,
    pub address: Option<String>,
    pub loading: Option<bool>,
    /// The page has put an element fullscreen, or left it.
    pub fullscreen: Option<bool>,
    /// The game has taken the pointer (true) or given it back (false): the probe's stand-in
    /// lock, said on the console (probe/src/pointerlock.ts).
    pub pointer: Option<bool>,
    pub closed: bool,
}

/// Whether the page has an element fullscreen now.
static FULLSCREEN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Gives the person back the pointer and the screen, as Esc does in Chrome: the page's pointer
/// lock released and its fullscreen element left. A game that takes the pointer must not keep
/// it; one that asks again on its next click may.
pub fn release(browser: &Browser) {
    // The cursor at once, whatever the page does.
    crate::platform::hold_pointer(false);
    inbox(|inbox| inbox.pointer = Some(false));

    if let Some(frame) = browser.main_frame() {
        // The probe's stand-in lock is given back by its own event; a real one by exitPointerLock.
        let script = "dispatchEvent(new Event('scanline:release-pointer')); if (document.pointerLockElement) document.exitPointerLock(); if (document.fullscreenElement) document.exitFullscreen();";

        frame.execute_java_script(Some(&CefString::from(script)), Some(&CefString::from("")), 0);
    }

    if FULLSCREEN.load(Ordering::Relaxed) {
        if let Some(host) = browser.host() {
            host.exit_fullscreen(1);
        }
    }
}

thread_local! {
    pub static INBOX: RefCell<Inbox> = RefCell::new(Inbox::default());
}

/// When CEF next wants its work done, in microseconds from START (0: as soon as possible).
/// CEF says so from any thread, through OnScheduleMessagePumpWork.
static WORK_DUE: AtomicU64 = AtomicU64::new(0);
static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();

fn now() -> u64 {
    START.get_or_init(Instant::now).elapsed().as_micros() as u64
}

/// Whether CEF's work is due: asked for and its time come, or `fallback` since it was last done.
pub fn work_due(last: Instant, fallback: Duration) -> bool {
    let due = WORK_DUE.load(Ordering::Relaxed);

    (due != u64::MAX && now() >= due) || last.elapsed() >= fallback
}

/// CEF's work done: nothing more is due until it asks again.
pub fn work_done() {
    WORK_DUE.store(u64::MAX, Ordering::Relaxed);
}

fn inbox(f: impl FnOnce(&mut Inbox)) {
    INBOX.with(|inbox| f(&mut inbox.borrow_mut()));
}

wrap_browser_process_handler! {
    pub struct ScanlineBrowserProcess;

    impl BrowserProcessHandler {
        fn on_context_initialized(&self) {
            inbox(|inbox| inbox.context_ready = true);
        }

        fn on_schedule_message_pump_work(&self, delay_ms: i64) {
            let at = now() + (delay_ms.max(0) as u64) * 1000;

            // The soonest request wins.
            let _ = WORK_DUE.try_update(Ordering::Relaxed, Ordering::Relaxed, |due| Some(due.min(at)));
        }
    }
}

wrap_app! {
    pub struct ScanlineApp;

    impl App {
        fn browser_process_handler(&self) -> Option<BrowserProcessHandler> {
            Some(ScanlineBrowserProcess::new())
        }

        fn on_before_command_line_processing(&self, process_type: Option<&CefString>, command_line: Option<&mut CommandLine>) {
            // The host passes Chrome's switches, which Chromium reads for itself. The browser
            // process adds only what an embedded browser needs that a launched one has anyway.
            if process_type.is_some() {
                return;
            }

            let Some(command_line) = command_line else { return };

            for switch in ["disable-background-timer-throttling", "disable-renderer-backgrounding", "disable-backgrounding-occluded-windows"] {
                command_line.append_switch(Some(&CefString::from(switch)));
            }
        }
    }
}

wrap_client! {
    pub struct ScanlineClient {
        life: LifeSpanHandler,
        display: DisplayHandler,
        keys: KeyboardHandler,
    }

    impl Client {
        fn life_span_handler(&self) -> Option<LifeSpanHandler> {
            Some(self.life.clone())
        }

        fn display_handler(&self) -> Option<DisplayHandler> {
            Some(self.display.clone())
        }

        fn keyboard_handler(&self) -> Option<KeyboardHandler> {
            Some(self.keys.clone())
        }
    }
}

wrap_keyboard_handler! {
    pub struct ScanlineKeys;

    impl KeyboardHandler {
        // Esc always gives the pointer and the screen back. The page still sees the key.
        fn on_pre_key_event(&self, browser: Option<&mut Browser>, event: Option<&KeyEvent>, _os_event: *mut u8, _is_keyboard_shortcut: Option<&mut std::os::raw::c_int>) -> std::os::raw::c_int {
            if let (Some(browser), Some(event)) = (browser, event) {
                if event.windows_key_code == 0x1B && event.type_ == KeyEventType::RAWKEYDOWN {
                    release(browser);
                }
            }

            0
        }
    }
}

wrap_life_span_handler! {
    pub struct ScanlineLifeSpan;

    impl LifeSpanHandler {
        fn on_after_created(&self, browser: Option<&mut Browser>) {
            if let Some(browser) = browser {
                let browser = browser.clone();

                inbox(|inbox| {
                    // The first browser is the game's. Popups the page opens are left to CEF.
                    if inbox.created.is_none() {
                        inbox.created = Some(browser);
                    }
                });
            }
        }

        fn on_before_close(&self, _browser: Option<&mut Browser>) {
            inbox(|inbox| inbox.closed = true);
        }
    }
}

wrap_display_handler! {
    pub struct ScanlineDisplay;

    impl DisplayHandler {
        fn on_address_change(&self, _browser: Option<&mut Browser>, frame: Option<&mut Frame>, url: Option<&CefString>) {
            let main = frame.map(|frame| frame.is_main() != 0).unwrap_or(false);

            if let (true, Some(url)) = (main, url) {
                let url = url.to_string();

                inbox(|inbox| inbox.address = Some(url));
            }
        }

        fn on_title_change(&self, _browser: Option<&mut Browser>, title: Option<&CefString>) {
            if let Some(title) = title {
                let title = title.to_string();

                inbox(|inbox| inbox.title = Some(title));
            }
        }

        fn on_loading_progress_change(&self, _browser: Option<&mut Browser>, progress: f64) {
            inbox(|inbox| inbox.loading = Some(progress < 1.0));
        }

        // An element fullscreen fills the game's view, not the screen: the window keeps its
        // panels, and Esc (or Game ▸ Give Back the Pointer and Screen) leaves it.
        // The probe's word to the app, before anything else hears it: the game has taken the
        // pointer, or let it go.
        fn on_console_message(&self, _browser: Option<&mut Browser>, _level: LogSeverity, message: Option<&CefString>, _source: Option<&CefString>, _line: std::os::raw::c_int) -> std::os::raw::c_int {
            let Some(message) = message.map(|message| message.to_string()) else { return 0 };

            match message.strip_prefix("\u{1}scanline:pointer-lock ") {
                // The window holds the cursor, only while it is in front (player.rs).
                Some(word) => {
                    let held = word.trim() == "held";

                    if !held {
                        crate::platform::hold_pointer(false);
                    }

                    inbox(|inbox| inbox.pointer = Some(held));

                    1
                }
                None => 0,
            }
        }

        fn on_fullscreen_mode_change(&self, _browser: Option<&mut Browser>, fullscreen: std::os::raw::c_int) {
            FULLSCREEN.store(fullscreen != 0, Ordering::Relaxed);
            inbox(|inbox| inbox.fullscreen = Some(fullscreen != 0));
        }
    }
}

pub fn client() -> Client {
    ScanlineClient::new(ScanlineLifeSpan::new(), ScanlineDisplay::new(), ScanlineKeys::new())
}
