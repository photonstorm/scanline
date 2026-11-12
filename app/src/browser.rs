//! The CEF side: the application object every process shares, and the browser's client.
//!
//! With `external_message_pump` the browser process's UI thread is the main thread, the one
//! GPUI runs on, so every callback here arrives on it and the shared state can be
//! thread-local. The page itself is driven by the host over `--remote-debugging-pipe`; this
//! side only creates the browser and reports what it sees for the window's title and bar.

use std::cell::RefCell;

use cef::*;

/// What the browser has said since the window last looked.
#[derive(Default)]
pub struct Inbox {
    pub context_ready: bool,
    pub created: Option<Browser>,
    pub title: Option<String>,
    pub address: Option<String>,
    pub loading: Option<bool>,
    pub closed: bool,
}

thread_local! {
    pub static INBOX: RefCell<Inbox> = RefCell::new(Inbox::default());
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
    }

    impl Client {
        fn life_span_handler(&self) -> Option<LifeSpanHandler> {
            Some(self.life.clone())
        }

        fn display_handler(&self) -> Option<DisplayHandler> {
            Some(self.display.clone())
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
    }
}

pub fn client() -> Client {
    ScanlineClient::new(ScanlineLifeSpan::new(), ScanlineDisplay::new())
}
