//! The CEF side: the application object every process shares, the browser's client, and the
//! DevTools protocol in process.
//!
//! With `external_message_pump` the browser process's UI thread is the main thread, the one
//! GPUI runs on, so every callback here arrives on it and the shared state can be thread-local.

use std::cell::RefCell;
use std::collections::VecDeque;

use cef::*;

/// What the browser has said since the interface last looked.
#[derive(Default)]
pub struct Inbox {
    /// Protocol messages, replies and events, as JSON.
    pub protocol: VecDeque<Vec<u8>>,
    /// Console lines from CEF's display handler.
    pub console: VecDeque<String>,
    pub title: Option<String>,
    pub address: Option<String>,
    pub loading: Option<bool>,
    pub created: Option<Browser>,
    pub context_ready: bool,
    pub closed: bool,
}

thread_local! {
    pub static INBOX: RefCell<Inbox> = RefCell::new(Inbox::default());
}

fn inbox(f: impl FnOnce(&mut Inbox)) {
    INBOX.with(|inbox| f(&mut inbox.borrow_mut()));
}

wrap_browser_process_handler! {
    pub struct PrototypeBrowserProcess;

    impl BrowserProcessHandler {
        fn on_context_initialized(&self) {
            inbox(|inbox| inbox.context_ready = true);
        }
    }
}

wrap_app! {
    pub struct PrototypeApp;

    impl App {
        fn browser_process_handler(&self) -> Option<BrowserProcessHandler> {
            Some(PrototypeBrowserProcess::new())
        }

        fn on_before_command_line_processing(
            &self,
            process_type: Option<&CefString>,
            command_line: Option<&mut CommandLine>,
        ) {
            // The browser process only: no first-run prompts, and frames keep flowing when the
            // window is covered, as Scanline's launched browser does.
            if process_type.is_some() {
                return;
            }

            let Some(command_line) = command_line else { return };

            for switch in [
                "disable-background-timer-throttling",
                "disable-renderer-backgrounding",
                "disable-backgrounding-occluded-windows",
                "enable-unsafe-webgpu",
            ] {
                command_line.append_switch(Some(&CefString::from(switch)));
            }
        }
    }
}

wrap_client! {
    pub struct PrototypeClient {
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
    pub struct PrototypeLifeSpan;

    impl LifeSpanHandler {
        fn on_after_created(&self, browser: Option<&mut Browser>) {
            if let Some(browser) = browser {
                let browser = browser.clone();

                inbox(|inbox| inbox.created = Some(browser));
            }
        }

        fn on_before_close(&self, _browser: Option<&mut Browser>) {
            inbox(|inbox| inbox.closed = true);
        }
    }
}

wrap_display_handler! {
    pub struct PrototypeDisplay;

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

wrap_dev_tools_message_observer! {
    pub struct PrototypeObserver;

    impl DevToolsMessageObserver {
        // Every message, reply or event, raw. Returning 0 lets CEF also call the more specific
        // callbacks, which this does not use.
        fn on_dev_tools_message(&self, _browser: Option<&mut Browser>, message: Option<&[u8]>) -> ::std::os::raw::c_int {
            if let Some(message) = message {
                let message = message.to_vec();

                inbox(|inbox| inbox.protocol.push_back(message));
            }

            1
        }
    }
}

pub fn client() -> Client {
    PrototypeClient::new(PrototypeLifeSpan::new(), PrototypeDisplay::new())
}

pub fn observer() -> DevToolsMessageObserver {
    PrototypeObserver::new()
}
