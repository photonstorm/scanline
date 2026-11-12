//! The window: a toolbar, the game in Chromium's own view, and panels fed by the DevTools
//! protocol. Deliberately plain apart from a first try at the look in docs/APP.md, section 6.

use std::cell::Cell;
use std::collections::{HashMap, VecDeque};
use std::ffi::c_void;
use std::rc::Rc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine;
use cef::{ImplBrowser, ImplBrowserHost, ImplFrame};
use gpui::{
    App, Application, Bounds, Context, FocusHandle, Image, ImageFormat, KeyDownEvent, MouseButton, Pixels, Rgba, SharedString, Window, WindowBounds,
    WindowOptions, canvas, div, img, prelude::*, px, rgb, size, uniform_list,
};
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use serde_json::{Value, json};

use crate::{browser, mac};

const START: &str = "http://127.0.0.1:8765/prototypes/app/pages/start.html";
const PANEL_WIDTH: f32 = 380.0;
const ROWS: usize = 10_000;

// Colours, after docs/APP.md, section 6.
const WINDOW: u32 = 0x0b0d10;
const CARD: u32 = 0x12151a;
const TEXT: u32 = 0xd8dde4;
const DIM: u32 = 0x7b8494;
const GREEN: u32 = 0x4ade80;
const BLUE: u32 = 0x60a5fa;
const PURPLE: u32 = 0xc084fc;
const AMBER: u32 = 0xfbbf24;
const RED: u32 = 0xf87171;

/// Watches the page's own frames, and pauses it by holding the callbacks it asks for.
const PAGE_SCRIPT: &str = r#"(() => {
    if (window.__prototype) { return; }
    const real = window.requestAnimationFrame.bind(window);
    const state = window.__prototype = { paused: false, held: [], frames: 0, times: [], last: -1 };
    const mark = (time) => {
        if (time === state.last) { return; }
        state.last = time;
        state.frames++;
        state.times.push(performance.now());
        if (state.times.length > 241) { state.times.shift(); }
    };
    const wrap = (callback) => (time) => { mark(time); callback(time); };
    window.requestAnimationFrame = (callback) => {
        if (state.paused) { state.held.push(callback); return 0; }
        return real(wrap(callback));
    };
    state.pause = () => { state.paused = true; };
    state.resume = () => { state.paused = false; const held = state.held; state.held = []; held.forEach((callback) => real(wrap(callback))); };
    state.step = () => { const held = state.held; state.held = []; held.forEach((callback) => real(wrap(callback))); };
    state.read = () => {
        const gaps = [];
        for (let i = 1; i < state.times.length; i++) { gaps.push(state.times[i] - state.times[i - 1]); }
        const recent = gaps.slice(-120);
        const mean = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : 0;
        const spread = recent.length ? Math.sqrt(recent.reduce((a, b) => a + (b - mean) ** 2, 0) / recent.length) : 0;
        const stale = state.times.length && performance.now() - state.times[state.times.length - 1] > 500;
        return { frames: state.frames, mean, spread, worst: recent.length ? Math.max(...recent) : 0, paused: state.paused, stale };
    };
})();"#;

const ADAPTER_SCRIPT: &str = r#"(async () => {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    let webgl = 'no WebGL';
    if (gl) {
        const info = gl.getExtension('WEBGL_debug_renderer_info');
        webgl = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    }
    let webgpu = 'no WebGPU';
    if (navigator.gpu) {
        const adapter = await navigator.gpu.requestAdapter();
        if (adapter) {
            const info = adapter.info || {};
            webgpu = [info.vendor, info.architecture, info.description].filter(Boolean).join(' · ') || 'an adapter, unnamed';
        }
    }
    return JSON.stringify({ webgl, webgpu, agent: navigator.userAgent });
})()"#;

/// What a protocol reply is for.
#[derive(Clone, Debug)]
enum Purpose {
    Ignore,
    Check(&'static str),
    Poll,
    Adapter,
    Screenshot,
}

#[derive(Clone)]
struct Line {
    level: SharedString,
    text: SharedString,
}

struct Prototype {
    focus: FocusHandle,
    gpui_view: *mut c_void,
    content_view: *mut c_void,
    game: Rc<Cell<Option<Bounds<Pixels>>>>,

    browser: Option<cef::Browser>,
    browser_view: *mut c_void,
    registration: Option<cef::Registration>,
    requested: bool,

    address: String,
    editing: bool,
    title: SharedString,
    loading: bool,
    paused: bool,

    next_id: i64,
    pending: HashMap<i64, (Purpose, Instant)>,
    sent: u64,
    received: u64,
    round_trip: Duration,
    checks: Vec<(SharedString, SharedString, bool)>,
    attached: Vec<SharedString>,

    frames: u64,
    mean: f64,
    spread: f64,
    worst: f64,
    stale: bool,
    history: VecDeque<f32>,
    last_poll: Instant,

    webgl: SharedString,
    webgpu: SharedString,
    agent: SharedString,
    console: VecDeque<Line>,
    screenshot: Option<Arc<Image>>,
    started: Instant,
    first_frame: Option<Duration>,
    last_report: Instant,
}

impl Prototype {
    fn new(gpui_view: *mut c_void, focus: FocusHandle) -> Self {
        let address = std::env::args().skip(1).find(|arg| !arg.starts_with('-')).unwrap_or_else(|| START.to_owned());

        Self {
            focus,
            gpui_view,
            content_view: mac::content_view(gpui_view),
            game: Rc::new(Cell::new(None)),
            browser: None,
            browser_view: std::ptr::null_mut(),
            registration: None,
            requested: false,
            address,
            editing: false,
            title: "".into(),
            loading: true,
            paused: false,
            next_id: 1,
            pending: HashMap::new(),
            sent: 0,
            received: 0,
            round_trip: Duration::ZERO,
            checks: Vec::new(),
            attached: Vec::new(),
            frames: 0,
            mean: 0.0,
            spread: 0.0,
            worst: 0.0,
            stale: true,
            history: VecDeque::new(),
            last_poll: Instant::now(),
            webgl: "…".into(),
            webgpu: "…".into(),
            agent: "".into(),
            console: VecDeque::new(),
            screenshot: None,
            started: Instant::now(),
            first_frame: None,
            last_report: Instant::now(),
        }
    }

    // ── The protocol ──────────────────────────────────────────────────────────────────────

    fn send(&mut self, method: &str, params: Value, purpose: Purpose) {
        let Some(host) = self.browser.as_ref().and_then(|browser| browser.host()) else { return };
        let id = self.next_id;

        self.next_id += 1;

        let message = json!({ "id": id, "method": method, "params": params }).to_string();

        if host.send_dev_tools_message(Some(message.as_bytes())) == 1 {
            self.pending.insert(id, (purpose, Instant::now()));
            self.sent += 1;
        }
    }

    fn evaluate(&mut self, expression: &str, purpose: Purpose) {
        self.send("Runtime.evaluate", json!({ "expression": expression, "returnByValue": true, "awaitPromise": true }), purpose);
    }

    fn attach(&mut self, browser: cef::Browser) {
        let host = browser.host().expect("a created browser has a host");

        self.browser_view = host.window_handle();
        self.registration = host.add_dev_tools_message_observer(Some(&mut browser::observer()));
        self.browser = Some(browser);

        // What Scanline needs, tried one by one: test 2 of stage 0.
        self.send("Runtime.enable", json!({}), Purpose::Check("Runtime.enable"));
        self.send("Page.enable", json!({}), Purpose::Check("Page.enable"));
        self.send("Page.addScriptToEvaluateOnNewDocument", json!({ "source": PAGE_SCRIPT }), Purpose::Check("Page.addScriptToEvaluateOnNewDocument"));
        self.send("Browser.getVersion", json!({}), Purpose::Check("Browser.getVersion"));
        self.send("SystemInfo.getInfo", json!({}), Purpose::Check("SystemInfo.getInfo"));
        self.send(
            "Target.setAutoAttach",
            json!({ "autoAttach": true, "waitForDebuggerOnStart": false, "flatten": true }),
            Purpose::Check("Target.setAutoAttach"),
        );
        self.send("Target.getTargets", json!({}), Purpose::Check("Target.getTargets"));
        self.send("Emulation.setFocusEmulationEnabled", json!({ "enabled": true }), Purpose::Check("Emulation.setFocusEmulationEnabled"));
        self.evaluate(PAGE_SCRIPT, Purpose::Ignore);
        self.evaluate(ADAPTER_SCRIPT, Purpose::Adapter);
    }

    fn receive(&mut self, raw: &[u8]) {
        let Ok(message) = serde_json::from_slice::<Value>(raw) else { return };

        self.received += 1;

        if let Some(id) = message.get("id").and_then(Value::as_i64) {
            let Some((purpose, sent)) = self.pending.remove(&id) else { return };

            self.round_trip = sent.elapsed();
            self.reply(purpose, &message);

            return;
        }

        let method = message.get("method").and_then(Value::as_str).unwrap_or_default();
        let params = message.get("params").cloned().unwrap_or(Value::Null);

        match method {
            "Runtime.consoleAPICalled" => {
                let level = params.get("type").and_then(Value::as_str).unwrap_or("log").to_owned();
                let text = params
                    .get("args")
                    .and_then(Value::as_array)
                    .map(|args| {
                        args.iter()
                            .map(|arg| match arg.get("value") {
                                Some(Value::String(text)) => text.clone(),
                                Some(value) => value.to_string(),
                                None => arg.get("description").and_then(Value::as_str).unwrap_or("…").to_owned(),
                            })
                            .collect::<Vec<_>>()
                            .join(" ")
                    })
                    .unwrap_or_default();

                self.log(&level, &text);
            }
            "Runtime.exceptionThrown" => {
                let text = params
                    .pointer("/exceptionDetails/exception/description")
                    .or_else(|| params.pointer("/exceptionDetails/text"))
                    .and_then(Value::as_str)
                    .unwrap_or("an exception");

                self.log("error", text);
            }
            "Target.attachedToTarget" => {
                let kind = params.pointer("/targetInfo/type").and_then(Value::as_str).unwrap_or("?");
                let url = params.pointer("/targetInfo/url").and_then(Value::as_str).unwrap_or("");
                let name = url.rsplit('/').next().unwrap_or(url);

                self.attached.push(format!("{kind} {name}").into());
            }
            "Page.frameNavigated" => {
                if params.pointer("/frame/parentId").is_none() {
                    self.attached.clear();
                    self.history.clear();
                    self.webgl = "…".into();
                    self.webgpu = "…".into();
                }
            }
            "Page.loadEventFired" => {
                self.evaluate(ADAPTER_SCRIPT, Purpose::Adapter);
            }
            _ => {}
        }
    }

    fn reply(&mut self, purpose: Purpose, message: &Value) {
        let error = message.pointer("/error/message").and_then(Value::as_str);
        let result = message.get("result").cloned().unwrap_or(Value::Null);
        let value = result.pointer("/result/value").and_then(Value::as_str).and_then(|text| serde_json::from_str::<Value>(text).ok());

        match purpose {
            Purpose::Ignore => {}
            Purpose::Check(name) => {
                let said = match (error, name) {
                    (Some(error), _) => error.to_owned(),
                    (None, "Browser.getVersion") => result.get("product").and_then(Value::as_str).unwrap_or("works").to_owned(),
                    (None, "SystemInfo.getInfo") => result.pointer("/gpu/devices/0/deviceString").and_then(Value::as_str).unwrap_or("works").to_owned(),
                    (None, "Target.getTargets") => {
                        let kinds: Vec<String> = result
                            .get("targetInfos")
                            .and_then(Value::as_array)
                            .map(|all| all.iter().filter_map(|target| target.get("type").and_then(Value::as_str).map(str::to_owned)).collect())
                            .unwrap_or_default();

                        format!("sees {}", if kinds.is_empty() { "nothing".to_owned() } else { kinds.join(", ") })
                    }
                    _ => "works".to_owned(),
                };

                self.checks.push((name.into(), said.into(), error.is_none()));
            }
            Purpose::Poll => {
                let Some(value) = value else { return };
                let frames = value.get("frames").and_then(Value::as_u64).unwrap_or(0);

                if frames > 0 && self.first_frame.is_none() {
                    self.first_frame = Some(self.started.elapsed());
                }

                self.frames = frames;
                self.mean = value.get("mean").and_then(Value::as_f64).unwrap_or(0.0);
                self.spread = value.get("spread").and_then(Value::as_f64).unwrap_or(0.0);
                self.worst = value.get("worst").and_then(Value::as_f64).unwrap_or(0.0);
                self.stale = value.get("stale").and_then(Value::as_bool).unwrap_or(true);
                self.paused = value.get("paused").and_then(Value::as_bool).unwrap_or(false);

                let rate = if self.stale || self.mean <= 0.0 { 0.0 } else { (1000.0 / self.mean) as f32 };

                self.history.push_back(rate);

                while self.history.len() > 120 {
                    self.history.pop_front();
                }
            }
            Purpose::Adapter => {
                if let Some(value) = value {
                    self.webgl = value.get("webgl").and_then(Value::as_str).unwrap_or("?").to_owned().into();
                    self.webgpu = value.get("webgpu").and_then(Value::as_str).unwrap_or("?").to_owned().into();
                    self.agent = value.get("agent").and_then(Value::as_str).unwrap_or("").to_owned().into();
                }
            }
            Purpose::Screenshot => {
                let data = result.get("data").and_then(Value::as_str).unwrap_or_default();

                if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(data) {
                    self.screenshot = Some(Arc::new(Image::from_bytes(ImageFormat::Png, bytes)));
                }
            }
        }
    }

    fn log(&mut self, level: &str, text: &str) {
        self.console.push_back(Line { level: level.to_owned().into(), text: text.chars().take(300).collect::<String>().into() });

        while self.console.len() > 200 {
            self.console.pop_front();
        }
    }

    // ── Each turn of the message pump ─────────────────────────────────────────────────────

    fn tick(&mut self, cx: &mut Context<Self>) {
        let mut changed = false;
        let mut created = None;
        let mut messages = Vec::new();
        let mut ready = false;

        browser::INBOX.with(|inbox| {
            let mut inbox = inbox.borrow_mut();

            ready = inbox.context_ready;
            created = inbox.created.take();
            messages.extend(inbox.protocol.drain(..));

            if let Some(title) = inbox.title.take() {
                self.title = title.into();
                changed = true;
            }

            if let Some(address) = inbox.address.take() {
                if !self.editing {
                    self.address = address;
                }

                changed = true;
            }

            if let Some(loading) = inbox.loading.take() {
                self.loading = loading;
                changed = true;
            }
        });

        if ready && !self.requested && !self.content_view.is_null() {
            self.requested = true;
            self.create_browser();
        }

        if let Some(browser) = created {
            self.attach(browser);
            changed = true;
        }

        for message in &messages {
            self.receive(message);
        }

        changed |= !messages.is_empty();

        if let Some(bounds) = self.game.get() {
            mac::place(self.browser_view, f64::from(bounds.origin.x), f64::from(bounds.origin.y), f64::from(bounds.size.width), f64::from(bounds.size.height));
        }

        if self.browser.is_some() && self.last_poll.elapsed() >= Duration::from_millis(250) {
            self.last_poll = Instant::now();
            self.evaluate("JSON.stringify(window.__prototype ? window.__prototype.read() : null)", Purpose::Poll);
        }

        if self.last_report.elapsed() >= Duration::from_secs(1) {
            self.last_report = Instant::now();
            self.report();
        }

        if changed {
            cx.notify();
        }
    }

    /// With SCANLINE_PROTOTYPE_REPORT set, the panels' state is written there once a second,
    /// so the prototype's checks can be read without looking at the window.
    fn report(&self) {
        let Ok(path) = std::env::var("SCANLINE_PROTOTYPE_REPORT") else { return };
        let game = self.game.get();
        let report = json!({
            "address": self.address,
            "title": self.title.as_ref(),
            "loading": self.loading,
            "paused": self.paused,
            "browser": self.browser.is_some(),
            "game": game.map(|b| [f32::from(b.origin.x), f32::from(b.origin.y), f32::from(b.size.width), f32::from(b.size.height)]),
            "browser_view": mac::frame(self.browser_view),
            "frames": self.frames,
            "fps": self.history.back(),
            "mean_ms": self.mean,
            "spread_ms": self.spread,
            "worst_ms": self.worst,
            "first_frame_s": self.first_frame.map(|d| d.as_secs_f64()),
            "webgl": self.webgl.as_ref(),
            "webgpu": self.webgpu.as_ref(),
            "agent": self.agent.as_ref(),
            "sent": self.sent,
            "received": self.received,
            "round_trip_ms": self.round_trip.as_secs_f64() * 1000.0,
            "checks": self.checks.iter().map(|(name, said, ok)| json!({ "name": name.as_ref(), "said": said.as_ref(), "ok": ok })).collect::<Vec<_>>(),
            "attached": self.attached.iter().map(|a| a.to_string()).collect::<Vec<_>>(),
            "console": self.console.iter().rev().take(10).map(|l| format!("{}: {}", l.level, l.text)).collect::<Vec<_>>(),
            "screenshot": self.screenshot.is_some(),
            "uptime_s": self.started.elapsed().as_secs_f64(),
        });

        let _ = std::fs::write(path, serde_json::to_string_pretty(&report).unwrap_or_default());
    }

    fn create_browser(&mut self) {
        let bounds = self.game.get();
        let rect = cef::Rect {
            x: bounds.map(|b| f32::from(b.origin.x) as i32).unwrap_or(0),
            y: bounds.map(|b| f32::from(b.origin.y) as i32).unwrap_or(48),
            width: bounds.map(|b| f32::from(b.size.width) as i32).unwrap_or(800),
            height: bounds.map(|b| f32::from(b.size.height) as i32).unwrap_or(600),
        };
        let info = cef::WindowInfo { runtime_style: cef::RuntimeStyle::ALLOY, ..Default::default() }.set_as_child(self.content_view, &rect);
        let mut client = browser::client();

        cef::browser_host_create_browser(
            Some(&info),
            Some(&mut client),
            Some(&cef::CefString::from(self.address.as_str())),
            Some(&cef::BrowserSettings::default()),
            None,
            None,
        );
    }

    // ── What the buttons do ───────────────────────────────────────────────────────────────

    fn go(&mut self) {
        let mut address = self.address.trim().to_owned();

        if !address.contains("://") && !address.starts_with("about:") {
            address = format!("http://{address}");
        }

        self.editing = false;
        self.address = address.clone();

        if let Some(frame) = self.browser.as_ref().and_then(|browser| browser.main_frame()) {
            frame.load_url(Some(&cef::CefString::from(address.as_str())));
        }

        mac::focus(self.browser_view);
    }

    fn open(&mut self, path: &str) {
        self.address = format!("http://127.0.0.1:8765{path}");
        self.go();
    }

    fn reload(&mut self) {
        if let Some(browser) = &self.browser {
            browser.reload();
        }
    }

    fn toggle_pause(&mut self) {
        let call = if self.paused { "resume" } else { "pause" };

        self.paused = !self.paused;
        self.evaluate(&format!("window.__prototype && window.__prototype.{call}()"), Purpose::Ignore);
    }

    fn step(&mut self) {
        self.evaluate("window.__prototype && window.__prototype.step()", Purpose::Ignore);
    }

    fn screenshot(&mut self) {
        self.send("Page.captureScreenshot", json!({ "format": "png" }), Purpose::Screenshot);
    }

    fn crash_gpu(&mut self) {
        self.address = "chrome://gpucrash".to_owned();
        self.go();
    }

    fn type_key(&mut self, event: &KeyDownEvent, cx: &mut Context<Self>) {
        let keystroke = &event.keystroke;

        if keystroke.modifiers.platform {
            if keystroke.key == "v" {
                if let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) {
                    self.address.push_str(text.trim());
                }
            } else if keystroke.key == "a" {
                self.address.clear();
            }
        } else {
            match keystroke.key.as_str() {
                "enter" => self.go(),
                "escape" => self.editing = false,
                "backspace" => {
                    self.address.pop();
                }
                _ => {
                    if let Some(text) = &keystroke.key_char {
                        self.address.push_str(text);
                    }
                }
            }
        }

        cx.notify();
    }
}

// ── Drawing ───────────────────────────────────────────────────────────────────────────────

fn tint(colour: u32, alpha: f32) -> Rgba {
    let mut c = rgb(colour);

    c.a = alpha;
    c
}

fn card(title: &str, colour: u32) -> gpui::Div {
    div()
        .flex()
        .flex_col()
        .gap_1()
        .p_3()
        .rounded_lg()
        .bg(rgb(CARD))
        .border_1()
        .border_color(tint(colour, 0.35))
        .child(div().text_color(tint(colour, 0.95)).text_sm().child(title.to_owned()))
}

/// A row of segments like a hardware level meter: `lit` of `count` glow in `colour`.
fn meter(count: usize, lit: usize, colour: u32) -> gpui::Div {
    div().flex().gap(px(2.0)).children((0..count).map(move |index| {
        let on = index < lit;

        div().w(px(7.0)).h(px(14.0)).rounded_sm().bg(if on { tint(colour, 0.95) } else { tint(colour, 0.12) })
    }))
}

fn button(id: &'static str, label: impl Into<SharedString>, colour: u32) -> gpui::Stateful<gpui::Div> {
    div()
        .id(id)
        .px_2()
        .py_1()
        .rounded_md()
        .text_sm()
        .cursor_pointer()
        .bg(tint(colour, 0.14))
        .border_1()
        .border_color(tint(colour, 0.4))
        .text_color(tint(colour, 1.0))
        .hover(|style| style.bg(tint(colour, 0.28)))
        .child(label.into())
}

fn value_row(label: &str, value: impl Into<SharedString>) -> gpui::Div {
    div()
        .flex()
        .justify_between()
        .gap_2()
        .text_xs()
        .child(div().text_color(rgb(DIM)).child(label.to_owned()))
        .child(div().text_color(rgb(TEXT)).overflow_hidden().child(value.into()))
}

impl Render for Prototype {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let game = self.game.clone();
        let rate = self.history.back().copied().unwrap_or(0.0);
        let peak = self.history.iter().copied().fold(60.0f32, f32::max);
        let field_colour = if self.editing { BLUE } else { DIM };

        // The toolbar.
        let toolbar = div()
            .flex()
            .items_center()
            .gap_2()
            .px_3()
            .h(px(48.0))
            .border_b_1()
            .border_color(tint(DIM, 0.25))
            .child(button("reload", "⟳", TEXT).on_click(cx.listener(|this, _, _, _| this.reload())))
            .child(
                div()
                    .id("address")
                    .track_focus(&self.focus)
                    .flex_1()
                    .px_2()
                    .py_1()
                    .rounded_md()
                    .text_sm()
                    .bg(rgb(0x07080a))
                    .border_1()
                    .border_color(tint(field_colour, 0.6))
                    .text_color(rgb(TEXT))
                    .overflow_hidden()
                    .whitespace_nowrap()
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(|this, _, window, cx| {
                            this.editing = true;
                            mac::focus(this.gpui_view);
                            window.focus(&this.focus);
                            cx.notify();
                        }),
                    )
                    .on_key_down(cx.listener(|this, event: &KeyDownEvent, _, cx| this.type_key(event, cx)))
                    .child(format!("{}{}", self.address, if self.editing { "▏" } else { "" })),
            )
            .child(button("go", "Go", BLUE).on_click(cx.listener(|this, _, _, cx| {
                this.go();
                cx.notify();
            })))
            .child(button("pause", if self.paused { "▶ Resume" } else { "❚❚ Pause" }, GREEN).on_click(cx.listener(|this, _, _, cx| {
                this.toggle_pause();
                cx.notify();
            })))
            .child(button("step", "▶| Step", GREEN).on_click(cx.listener(|this, _, _, _| this.step())))
            .child(button("shot", "Screenshot", PURPLE).on_click(cx.listener(|this, _, _, _| this.screenshot())))
            .child(button("crash", "Crash GPU", RED).on_click(cx.listener(|this, _, _, _| this.crash_gpu())));

        // Where the game goes. Chromium's view is placed over this rectangle; nothing is drawn
        // here but a backdrop for the moment before the page paints.
        let stage =
            div().flex_1().relative().bg(rgb(0x000000)).child(canvas(move |bounds, _, _| game.set(Some(bounds)), |_, _, _, _| {}).absolute().size_full());

        let shortcuts = div()
            .flex()
            .flex_wrap()
            .gap_1()
            .child(button("f-three", "three.js", AMBER).on_click(cx.listener(|this, _, _, _| this.open("/fixtures/engines/three.html"))))
            .child(
                button("f-three-gpu", "three.js WebGPU", AMBER)
                    .on_click(cx.listener(|this, _, _, _| this.open("/fixtures/engines/three.html?renderer=webgpu"))),
            )
            .child(button("f-pixi", "PixiJS", AMBER).on_click(cx.listener(|this, _, _, _| this.open("/fixtures/engines/pixi.html"))))
            .child(button("f-phaser", "Phaser", AMBER).on_click(cx.listener(|this, _, _, _| this.open("/fixtures/engines/phaser.html"))))
            .child(button("f-babylon", "Babylon", AMBER).on_click(cx.listener(|this, _, _, _| this.open("/fixtures/engines/babylon.html"))))
            .child(button("f-workers", "Workers", AMBER).on_click(cx.listener(|this, _, _, _| this.open("/prototypes/app/pages/workers.html"))));

        let frames = card("Frame rate", GREEN)
            .child(
                div()
                    .flex()
                    .items_end()
                    .justify_between()
                    .child(div().text_3xl().text_color(rgb(GREEN)).child(if rate > 0.0 { format!("{rate:.0} fps") } else { "–".to_owned() }))
                    .child(div().text_xs().text_color(rgb(DIM)).child(if self.paused {
                        "paused"
                    } else if self.stale {
                        "no frames"
                    } else {
                        "running"
                    })),
            )
            .child(meter(30, ((rate / 120.0) * 30.0).round().clamp(0.0, 30.0) as usize, GREEN))
            .child(
                div()
                    .flex()
                    .items_end()
                    .h(px(48.0))
                    .gap(px(1.0))
                    .children(self.history.iter().map(|value| div().w(px(2.0)).h(px((value / peak * 46.0).max(1.0))).bg(tint(GREEN, 0.75)))),
            )
            .child(value_row("frame time", format!("{:.2} ms ± {:.2}", self.mean, self.spread)))
            .child(value_row("worst of the last 120", format!("{:.2} ms", self.worst)))
            .child(value_row("frames", self.frames.to_string()))
            .child(value_row("first frame after start", self.first_frame.map(|d| format!("{:.2} s", d.as_secs_f64())).unwrap_or_else(|| "–".to_owned())));

        let adapter = card("GPU", BLUE)
            .child(value_row("WebGL", self.webgl.clone()))
            .child(value_row("WebGPU", self.webgpu.clone()))
            .child(div().text_xs().text_color(rgb(DIM)).child(self.agent.clone()));

        let protocol = card("DevTools protocol, in process", PURPLE)
            .child(value_row("sent · received", format!("{} · {}", self.sent, self.received)))
            .child(value_row("last round trip", format!("{:.2} ms", self.round_trip.as_secs_f64() * 1000.0)))
            .children(self.checks.iter().map(|(name, said, ok)| {
                div()
                    .flex()
                    .gap_2()
                    .text_xs()
                    .child(div().text_color(rgb(if *ok { GREEN } else { RED })).child(if *ok { "●" } else { "○" }))
                    .child(div().text_color(rgb(TEXT)).child(name.clone()))
                    .child(div().text_color(rgb(DIM)).overflow_hidden().child(said.clone()))
            }))
            .child(value_row("attached targets", if self.attached.is_empty() { "none".to_owned() } else { self.attached.join(", ") }));

        let console = card("Console", AMBER).children(self.console.iter().rev().take(8).map(|line| {
            let colour = match line.level.as_ref() {
                "error" => RED,
                "warning" => AMBER,
                _ => TEXT,
            };

            div().text_xs().text_color(rgb(colour)).overflow_hidden().whitespace_nowrap().child(line.text.clone())
        }));

        let shot = card("Screenshot", PURPLE).child(match &self.screenshot {
            Some(image) => img(image.clone()).w_full().h(px(180.0)).into_any_element(),
            None => div().text_xs().text_color(rgb(DIM)).child("Press Screenshot.").into_any_element(),
        });

        let list = card("10,000 rows", BLUE).child(
            uniform_list(
                "rows",
                ROWS,
                cx.processor(|_, range: std::ops::Range<usize>, _, _| {
                    range
                        .map(|index| {
                            div()
                                .id(index)
                                .w_full()
                                .flex()
                                .justify_between()
                                .px_1()
                                .text_xs()
                                .bg(if index % 2 == 0 { tint(BLUE, 0.05) } else { tint(BLUE, 0.0) })
                                .child(div().text_color(rgb(DIM)).child(format!("draw {}", index + 1)))
                                .child(div().text_color(rgb(TEXT)).child(format!("{:.3} ms", ((index * 7919) % 1000) as f32 / 997.0)))
                        })
                        .collect()
                }),
            )
            .h(px(160.0)),
        );

        let panel = div()
            .id("panel")
            .w(px(PANEL_WIDTH))
            .flex()
            .flex_col()
            .gap_2()
            .p_2()
            .overflow_y_scroll()
            .border_l_1()
            .border_color(tint(DIM, 0.25))
            .child(shortcuts)
            .child(frames)
            .child(adapter)
            .child(protocol)
            .child(console)
            .child(shot)
            .child(list);

        let status = div()
            .flex()
            .items_center()
            .gap_3()
            .px_3()
            .h(px(26.0))
            .text_xs()
            .text_color(rgb(DIM))
            .border_t_1()
            .border_color(tint(DIM, 0.25))
            .child(div().size(px(8.0)).rounded_full().bg(rgb(if self.browser.is_some() { GREEN } else { AMBER })))
            .child(if self.loading { "loading".to_owned() } else { "loaded".to_owned() })
            .child(self.title.clone())
            .child(div().flex_1())
            .child(format!("frame {}", self.frames))
            .child("Chromium 156 · CEF 156.0.26");

        div()
            .size_full()
            .flex()
            .flex_col()
            .bg(rgb(WINDOW))
            .text_color(rgb(TEXT))
            .child(toolbar)
            .child(div().flex_1().flex().min_h_0().child(stage).child(panel))
            .child(status)
    }
}

// ── Start ─────────────────────────────────────────────────────────────────────────────────

pub fn run(args: cef::args::Args, mut app: cef::App) {
    Application::new().run(move |cx: &mut App| {
        // A second copy needs a cache of its own, or Chromium hands its start to the first.
        let cache =
            std::env::var_os("SCANLINE_PROTOTYPE_CACHE").map(std::path::PathBuf::from).unwrap_or_else(|| std::env::temp_dir().join("scanline-prototype-cache"));
        let settings = cef::Settings {
            no_sandbox: 1,
            external_message_pump: 1,
            root_cache_path: cef::CefString::from(cache.to_string_lossy().as_ref()),
            ..Default::default()
        };

        assert_eq!(cef::initialize(Some(args.as_main_args()), Some(&settings), Some(&mut app), std::ptr::null_mut()), 1, "CEF did not start");

        let bounds = Bounds::centered(None, size(px(1480.0), px(920.0)), cx);
        let window = cx
            .open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(bounds)),
                    titlebar: Some(gpui::TitlebarOptions { title: Some("Scanline prototype".into()), ..Default::default() }),
                    ..Default::default()
                },
                |window, cx| {
                    let view = match window.window_handle().map(|handle| handle.as_raw()) {
                        Ok(RawWindowHandle::AppKit(handle)) => handle.ns_view.as_ptr(),
                        _ => panic!("expected an AppKit window"),
                    };

                    cx.new(|cx| Prototype::new(view, cx.focus_handle()))
                },
            )
            .expect("a window");

        let entity = window.update(cx, |_, _, cx| cx.entity()).expect("the window's view");

        // The message pump: CEF's work, then whatever it delivered. CEF asks for work through
        // OnScheduleMessagePumpWork; for the prototype a steady 4 ms tick stands in.
        cx.spawn(async move |cx| {
            loop {
                cx.background_executor().timer(Duration::from_millis(4)).await;
                cef::do_message_loop_work();

                if entity.update(cx, |this, cx| this.tick(cx)).is_err() {
                    break;
                }
            }
        })
        .detach();

        cx.on_window_closed(|cx| {
            if cx.windows().is_empty() {
                // Chromium's helpers end when the browser process does.
                std::process::exit(0);
            }
        })
        .detach();

        cx.activate(true);
    });
}
