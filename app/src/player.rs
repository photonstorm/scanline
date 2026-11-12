//! The window for one session: the toolbar, the game in Chromium's own view, the panels and
//! the status bar. Everything the panels show, and everything the toolbar does, goes through
//! the host's control API (docs/APP.md, principle 2): the window keeps itself up to date as
//! the "viewer", which the host does not log, and acts as the "person", which it does.

use std::cell::Cell;
use std::collections::{HashMap, HashSet};
use std::ffi::c_void;
use std::path::PathBuf;
use std::rc::Rc;
use std::time::{Duration, Instant};

use cef::{ImplBrowser, ImplBrowserHost};
use gpui::{
    App, Application, Bounds, Context, FocusHandle, Global, KeyBinding, KeyDownEvent, Menu, MenuItem, MouseButton, Pixels, SharedString, SystemMenuType,
    TitlebarOptions, Window, WindowBounds, WindowHandle, WindowOptions, actions, canvas, div, point, prelude::*, px, rgb, size,
};
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use serde_json::{Value, json};

use crate::host::{HostLink, Reply};
use crate::panels::{self, Panel};
use crate::theme::*;
use crate::{browser, mac};

const TOOLBAR: f32 = 52.0;
const STATUS: f32 = 28.0;
pub const PANEL: f32 = 470.0;
const RAIL: f32 = 62.0;

actions!(
    scanline,
    [
        Quit,
        NewWindow,
        CloseWindow,
        OpenLocation,
        Reload,
        TogglePause,
        StepFrame,
        StepTen,
        Capture,
        Debug,
        ShowLive,
        ShowResources,
        ShowCaptures,
        ShowConsole,
        ShowAgent,
        ToggleWide,
        SlowDown,
        SpeedUp,
        OpenRecent0,
        OpenRecent1,
        OpenRecent2,
        OpenRecent3,
        OpenRecent4,
        OpenRecent5,
        OpenRecent6,
        OpenRecent7,
        OpenRecent8,
        OpenRecent9
    ]
);

/// The menu items for recent pages, in order.
fn recent_action(index: usize) -> Box<dyn gpui::Action> {
    match index {
        0 => Box::new(OpenRecent0),
        1 => Box::new(OpenRecent1),
        2 => Box::new(OpenRecent2),
        3 => Box::new(OpenRecent3),
        4 => Box::new(OpenRecent4),
        5 => Box::new(OpenRecent5),
        6 => Box::new(OpenRecent6),
        7 => Box::new(OpenRecent7),
        8 => Box::new(OpenRecent8),
        _ => Box::new(OpenRecent9),
    }
}

/// What the host started this window with: Chrome's switches and Scanline's own.
#[derive(Clone, Debug)]
pub struct Options {
    pub session: Option<String>,
    pub home: PathBuf,
    pub url: String,
    pub width: f32,
    pub height: f32,
    pub cache: Option<PathBuf>,
}

impl From<&Vec<String>> for Options {
    fn from(argv: &Vec<String>) -> Self {
        let value = |name: &str| argv.iter().find_map(|arg| arg.strip_prefix(&format!("--{name}=")).map(str::to_string));
        let (width, height) = value("window-size")
            .and_then(|size| size.split_once(',').and_then(|(w, h)| Some((w.parse::<f32>().ok()?, h.parse::<f32>().ok()?))))
            .unwrap_or((1280.0, 720.0));

        Options {
            session: value("scanline-session"),
            home: value("scanline-home").map(PathBuf::from).unwrap_or_else(default_home),
            url: value("app").unwrap_or_else(|| "about:blank".to_string()),
            width,
            height,
            cache: value("user-data-dir").map(PathBuf::from),
        }
    }
}

fn default_home() -> PathBuf {
    std::env::var_os("SCANLINE_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join("Library/Application Support/Scanline"))
}

/// What a reply from the host is for.
#[derive(Clone, Debug)]
pub enum Purpose {
    Status,
    Stats,
    Memory,
    Console,
    Activity,
    Captures,
    ResourceCounts,
    Resources(String),
    Resource(String),
    Capture,
    DrawList(String),
    Draw(String, i64),
    Target(String, i64),
    PixelSource(String, (u32, u32)),
    /// Something the person did, by the command's name: its summary goes in the status bar.
    #[allow(dead_code)]
    Action(&'static str),
}

impl Purpose {
    /// Polls of one kind are not stacked: a new one waits for the last.
    fn poll_key(&self) -> Option<&'static str> {
        Some(match self {
            Purpose::Status => "status",
            Purpose::Stats => "stats",
            Purpose::Memory => "memory",
            Purpose::Console => "console",
            Purpose::Activity => "activity",
            Purpose::Captures => "captures",
            Purpose::ResourceCounts => "resource-counts",
            Purpose::Resources(_) => "resources",
            _ => return None,
        })
    }
}

pub struct Player {
    pub focus: FocusHandle,
    gpui_view: *mut c_void,
    content_view: *mut c_void,
    game: Rc<Cell<Option<Bounds<Pixels>>>>,
    pub options: Options,

    browser: Option<cef::Browser>,
    browser_view: *mut c_void,
    requested: bool,

    pub host: HostLink,
    pending: HashMap<u64, Purpose>,
    polling: HashSet<&'static str>,
    last: HashMap<&'static str, Instant>,

    pub address: String,
    pub editing: bool,
    pub title: SharedString,
    pub loading: bool,
    pub message: Option<(String, bool)>,
    message_at: Instant,
    pub recent: Vec<String>,
    menus_stale: bool,

    pub status: Value,
    pub panel: Panel,
    pub wide: bool,
    pub live: panels::live::State,
    pub resources: panels::resources::State,
    pub captures: panels::captures::State,
    pub console: panels::console::State,
    pub agent: panels::agent::State,
    shown_seq: u64,
}

impl Player {
    fn new(options: Options, gpui_view: *mut c_void, cx: &mut Context<Self>) -> Self {
        let host = HostLink::open(&options.home);
        let recent = load_recent(&options.home);

        Player {
            focus: cx.focus_handle(),
            gpui_view,
            content_view: mac::content_view(gpui_view),
            game: Rc::new(Cell::new(None)),
            address: if options.url == "about:blank" { String::new() } else { options.url.clone() },
            options,
            browser: None,
            browser_view: std::ptr::null_mut(),
            requested: false,
            host,
            pending: HashMap::new(),
            polling: HashSet::new(),
            last: HashMap::new(),
            editing: false,
            title: "".into(),
            loading: true,
            message: None,
            message_at: Instant::now(),
            recent,
            menus_stale: true,
            status: Value::Null,
            panel: Panel::Live,
            wide: false,
            live: Default::default(),
            resources: Default::default(),
            captures: Default::default(),
            console: Default::default(),
            agent: Default::default(),
            shown_seq: 0,
        }
    }

    pub fn session(&self) -> Option<&str> {
        self.options.session.as_deref()
    }

    // ── Calls to the host ───────────────────────────────────────────────────────────────

    /// Calls the host about this session. Upkeep goes as the viewer; actions as the person.
    pub fn ask(&mut self, method: &str, mut params: Value, purpose: Purpose) {
        let Some(session) = self.options.session.clone() else { return };

        if let Some(key) = purpose.poll_key() {
            if !self.polling.insert(key) {
                return;
            }

            self.last.insert(key, Instant::now());
        }

        if !params.is_object() {
            params = json!({});
        }

        if params["session"].is_null() && !matches!(method, "captures" | "activity") {
            params["session"] = json!(session);
        }

        let by = if matches!(purpose, Purpose::Action(_) | Purpose::Capture) { "person" } else { "viewer" };
        let id = self.host.call(method, params, by);

        self.pending.insert(id, purpose);
    }

    fn due(&self, key: &'static str, every: Duration) -> bool {
        !self.polling.contains(key) && self.last.get(key).is_none_or(|at| at.elapsed() >= every)
    }

    fn poll(&mut self) {
        if self.session().is_none() {
            return;
        }

        if self.due("status", Duration::from_millis(400)) {
            self.ask("status", json!({}), Purpose::Status);
        }

        if self.due("stats", Duration::from_millis(500)) {
            self.ask("stats", json!({ "window_frames": 30 }), Purpose::Stats);
        }

        if self.due("console", Duration::from_millis(700)) {
            let since = self.console.next;

            self.ask("console", json!({ "since": since, "limit": 200 }), Purpose::Console);
        }

        if self.due("activity", Duration::from_millis(600)) {
            let since = self.agent.next;

            self.ask("activity", json!({ "since": since, "limit": 200 }), Purpose::Activity);
        }

        if self.panel == Panel::Live && self.due("memory", Duration::from_millis(1500)) {
            self.ask("memory", json!({}), Purpose::Memory);
        }

        if self.panel == Panel::Captures && self.due("captures", Duration::from_millis(2000)) {
            self.ask("captures", json!({ "limit": 100 }), Purpose::Captures);
        }

        if self.panel == Panel::Resources {
            if self.due("resource-counts", Duration::from_millis(2500)) {
                self.ask("resources", json!({}), Purpose::ResourceCounts);
            }

            if self.due("resources", Duration::from_millis(2500)) {
                let kind = self.resources.kind.clone();

                self.ask("resources", json!({ "kind": kind, "sort": "bytes", "limit": 1000 }), Purpose::Resources(kind));
            }
        }
    }

    fn receive(&mut self, id: u64, reply: Reply, cx: &mut Context<Self>) {
        let Some(purpose) = self.pending.remove(&id) else { return };

        if let Some(key) = purpose.poll_key() {
            self.polling.remove(key);
        }

        match (purpose, reply) {
            (Purpose::Status, Ok(value)) => {
                self.status = value["data"].clone();
                self.follow_agent(cx);
            }
            (Purpose::Status, Err(_)) => {}
            (Purpose::Stats, Ok(value)) => self.live.stats(&value["data"]),
            (Purpose::Memory, Ok(value)) => self.live.memory(&value),
            (Purpose::Console, Ok(value)) => self.console.receive(&value["data"]),
            (Purpose::Activity, Ok(value)) => self.agent.receive(&value["data"]),
            (Purpose::Captures, Ok(value)) => self.captures.list(&value["data"]),
            (Purpose::ResourceCounts, Ok(value)) => self.resources.counts(&value["data"]),
            (Purpose::Resources(kind), Ok(value)) => self.resources.rows(&kind, &value["data"]),
            (Purpose::Resource(handle), Ok(value)) => self.resources.detail(&handle, &value),
            (Purpose::Resource(handle), Err(error)) => self.resources.failed(&handle, error),
            (Purpose::Capture, Ok(value)) => {
                self.say(value["summary"].as_str().unwrap_or("Captured.").lines().next().unwrap_or(""), false);

                if let Some(capture) = value["data"]["capture"].as_str() {
                    self.captures.made(&value["data"]);
                    self.open_capture(capture.to_string(), cx);
                }
            }
            (Purpose::DrawList(capture), Ok(value)) => {
                let first = self.captures.events(&capture, &value["data"]);

                if let Some(draw) = first {
                    self.select_draw(draw, cx);
                }
            }
            (Purpose::Draw(capture, draw), Ok(value)) => self.captures.draw(&capture, draw, &value["data"]),
            (Purpose::Target(capture, draw), Ok(value)) => self.captures.target(&capture, draw, &value),
            (Purpose::PixelSource(capture, pixel), Ok(value)) => self.captures.story(&capture, pixel, &value),
            (Purpose::Draw(capture, draw), Err(error)) | (Purpose::Target(capture, draw), Err(error)) => self.captures.failed(&capture, draw, error),
            (Purpose::Action(_), Ok(value)) => {
                let summary = value["summary"].as_str().unwrap_or("Done.").lines().next().unwrap_or("").to_string();

                self.say(&summary, false);
            }
            // Upkeep that fails (the host still registering the session, say) is tried again
            // on the next turn; only what the person did is worth telling them about.
            (Purpose::Action(_) | Purpose::Capture | Purpose::DrawList(_), Err(error)) => self.say(&error, true),
            (_, Err(_)) => {}
        }

        cx.notify();
    }

    /// Shows what the agent asked the app to show (viewer(show: …) in an app session).
    fn follow_agent(&mut self, cx: &mut Context<Self>) {
        let shown = self.status["app_show"].clone();
        let seq = shown["seq"].as_u64().unwrap_or(0);

        if seq <= self.shown_seq {
            return;
        }

        self.shown_seq = seq;

        let panel = match shown["show"].as_str().unwrap_or("") {
            "live" => Panel::Live,
            "capture" => Panel::Captures,
            "console" => Panel::Console,
            "resources" => Panel::Resources,
            _ => Panel::Agent,
        };

        self.show(panel);

        if let Some(capture) = shown["capture"].as_str() {
            let capture = capture.to_string();
            let draw = shown["draw"].as_i64();

            self.captures.want_draw = draw;
            self.open_capture(capture, cx);
        }

        if let Some(handle) = shown["handle"].as_str() {
            let handle = handle.to_string();

            self.select_resource(handle);
        }
    }

    pub fn say(&mut self, text: &str, error: bool) {
        self.message = Some((text.to_string(), error));
        self.message_at = Instant::now();
    }

    // ── What the person does ────────────────────────────────────────────────────────────

    pub fn go(&mut self) {
        let mut address = self.address.trim().to_string();

        if address.is_empty() {
            return;
        }

        if !address.contains("://") && !address.starts_with("about:") && !address.starts_with('/') {
            address = format!("http://{address}");
        }

        self.editing = false;
        self.address = address.clone();
        self.remember(&address);
        self.ask("navigate", json!({ "url": address }), Purpose::Action("navigate"));
        mac::focus(self.browser_view);
    }

    pub fn reload(&mut self) {
        self.ask("navigate", json!({ "reload": true }), Purpose::Action("reload"));
    }

    pub fn paused(&self) -> bool {
        self.status["paused"] == true
    }

    pub fn toggle_pause(&mut self) {
        if self.paused() {
            self.ask("resume", json!({}), Purpose::Action("resume"));
        } else {
            self.ask("pause", json!({}), Purpose::Action("pause"));
        }

        // Shown at once; the next status confirms it.
        self.status["paused"] = json!(!self.paused());
    }

    pub fn step(&mut self, frames: u32) {
        self.ask("step", json!({ "frames": frames }), Purpose::Action("step"));
    }

    pub fn time_scale(&self) -> f64 {
        self.status["time_scale"].as_f64().unwrap_or(1.0)
    }

    pub fn set_time_scale(&mut self, scale: f64) {
        self.ask("resume", json!({ "time_scale": scale }), Purpose::Action("resume"));
        self.status["time_scale"] = json!(scale);
        self.status["paused"] = json!(false);
    }

    pub fn capture(&mut self) {
        self.say("Capturing the next frame…", false);
        self.ask("capture", json!({}), Purpose::Capture);
    }

    pub fn debug(&mut self) {
        self.ask("debug", json!({}), Purpose::Action("debug"));
    }

    pub fn take_input(&mut self, release: bool) {
        self.ask("take_control", json!({ "release": release }), Purpose::Action("take_control"));
    }

    pub fn show(&mut self, panel: Panel) {
        self.panel = panel;

        // A panel shown is brought up to date at once.
        for key in ["memory", "captures", "resources", "resource-counts"] {
            self.last.remove(key);
        }
    }

    pub fn open_capture(&mut self, capture: String, _cx: &mut Context<Self>) {
        self.show(Panel::Captures);
        self.captures.open(&capture);
        self.last.remove("captures");
        self.ask("draw_list", json!({ "capture": capture, "limit": 5000 }), Purpose::DrawList(capture));
    }

    pub fn select_draw(&mut self, draw: i64, _cx: &mut Context<Self>) {
        let Some(capture) = self.captures.opened.clone() else { return };

        self.captures.select(draw);
        self.ask("draw", json!({ "capture": capture, "draw": draw }), Purpose::Draw(capture.clone(), draw));
        self.ask("screenshot", json!({ "capture": capture, "at_draw": draw }), Purpose::Target(capture, draw));
    }

    /// A pixel of the capture's target clicked: what made it, event by event.
    pub fn pick_pixel(&mut self, pixel: (u32, u32)) {
        let Some(capture) = self.captures.opened.clone() else { return };

        self.captures.pixel = Some(pixel);
        self.captures.story = None;
        self.ask("pixel_source", json!({ "capture": capture, "x": pixel.0, "y": pixel.1 }), Purpose::PixelSource(capture, pixel));
    }

    pub fn send_to_agent(&mut self) {
        let Some(capture) = self.captures.opened.clone() else { return };
        let mut chosen = json!({ "capture": capture });

        if let Some(draw) = self.captures.selected {
            chosen["draw"] = json!(draw);
        }

        if let Some((x, y)) = self.captures.pixel {
            chosen["pixel"] = json!({ "x": x, "y": y });
        }

        self.ask("send_to_agent", chosen, Purpose::Action("send_to_agent"));
    }

    pub fn select_resource(&mut self, handle: String) {
        let kind = crate::panels::resources::kind_of(&handle);

        // An object of another kind (one an agent pointed at) brings its kind's list up.
        if kind != "other" && kind != self.resources.kind {
            self.show_kind(kind.to_string());
        }

        self.resources.select(&handle);
        self.fetch_resource();
    }

    pub fn fetch_resource(&mut self) {
        let Some(handle) = self.resources.selected.clone() else { return };
        let params = self.resources.request(&handle);

        self.ask("resource", params, Purpose::Resource(handle));
    }

    pub fn show_kind(&mut self, kind: String) {
        self.resources.kind = kind;
        self.resources.list.clear();
        self.last.remove("resources");
    }

    fn remember(&mut self, url: &str) {
        if url.starts_with("file:") || url.starts_with("about:") || url.starts_with("data:") {
            return;
        }

        self.recent.retain(|known| known != url);
        self.recent.insert(0, url.to_string());
        self.recent.truncate(10);
        self.menus_stale = true;

        let _ = std::fs::write(self.options.home.join("app-recent.json"), serde_json::to_string_pretty(&self.recent).unwrap_or_default());
    }

    // ── Each turn of the message pump ───────────────────────────────────────────────────

    fn tick(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let mut changed = false;
        let mut created = None;
        let mut ready = false;
        let mut closed = false;

        browser::INBOX.with(|inbox| {
            let mut inbox = inbox.borrow_mut();

            ready = inbox.context_ready;
            created = inbox.created.take();
            closed = inbox.closed;

            if let Some(title) = inbox.title.take() {
                self.title = title.into();
                changed = true;
            }

            if let Some(address) = inbox.address.take() {
                if !self.editing && !address.starts_with("file:") && address != "about:blank" {
                    self.address = address;
                } else if !self.editing && address.starts_with("file:") {
                    self.address.clear();
                }

                changed = true;
            }

            if let Some(loading) = inbox.loading.take() {
                self.loading = loading;
                changed = true;
            }
        });

        // The host closed the session (Browser.close): the window goes with it.
        if closed {
            std::process::exit(0);
        }

        if ready && !self.requested && !self.content_view.is_null() && self.game.get().is_some() {
            self.requested = true;
            self.create_browser();
        }

        if let Some(browser) = created {
            self.browser_view = browser.host().map(|host| host.window_handle()).unwrap_or(std::ptr::null_mut());
            self.browser = Some(browser);
            changed = true;
        }

        if let Some(bounds) = self.game.get() {
            mac::place(self.browser_view, f64::from(bounds.origin.x), f64::from(bounds.origin.y), f64::from(bounds.size.width), f64::from(bounds.size.height));
        }

        for (id, reply) in self.host.drain() {
            self.receive(id, reply, cx);
        }

        self.poll();

        if self.message.is_some() && self.message_at.elapsed() > Duration::from_secs(8) {
            self.message = None;
            changed = true;
        }

        // SCANLINE_APP_SNAPSHOTS=<folder>: a picture of the window there every two seconds,
        // for checking the window with no one at the screen.
        if let Some(folder) = std::env::var_os("SCANLINE_APP_SNAPSHOTS") {
            if self.last.get("snapshot").is_none_or(|at| at.elapsed() >= Duration::from_secs(2)) {
                self.last.insert("snapshot", Instant::now());

                let folder = PathBuf::from(folder);
                let _ = std::fs::create_dir_all(&folder);

                let name = self.options.session.as_deref().unwrap_or("window").to_string();

                mac::snapshot(self.gpui_view, &folder.join(format!("{name}.png")));

                // Where Chromium's view is, against where the game should be: a picture of
                // one's own window leaves out what the GPU process draws.
                let game = self.game.get().map(|b| [f32::from(b.origin.x), f32::from(b.origin.y), f32::from(b.size.width), f32::from(b.size.height)]);
                let placed = json!({ "game": game, "browser_view": mac::frame(self.browser_view), "content": mac::frame(self.content_view), "panel": format!("{:?}", self.panel) });

                let _ = std::fs::write(folder.join(format!("{name}.json")), placed.to_string());
            }
        }

        let title = match (&self.options.session, self.title.is_empty()) {
            (Some(session), false) => format!("{} — {session}", self.title),
            (Some(session), true) => format!("Scanline — {session}"),
            (None, _) => "Scanline".to_string(),
        };

        window.set_window_title(&title);

        if self.menus_stale {
            self.menus_stale = false;
            menus(cx, &self.recent);
        }

        if changed {
            cx.notify();
        }
    }

    /// Opens a page from the recent list.
    pub fn open_recent(&mut self, index: usize) {
        if let Some(url) = self.recent.get(index).cloned() {
            self.address = url;
            self.go();
        }
    }

    fn create_browser(&mut self) {
        let bounds = self.game.get();
        let rect = cef::Rect {
            x: bounds.map(|b| f32::from(b.origin.x) as i32).unwrap_or(0),
            y: bounds.map(|b| f32::from(b.origin.y) as i32).unwrap_or(TOOLBAR as i32),
            width: bounds.map(|b| f32::from(b.size.width) as i32).unwrap_or(800),
            height: bounds.map(|b| f32::from(b.size.height) as i32).unwrap_or(600),
        };
        let info = cef::WindowInfo { runtime_style: cef::RuntimeStyle::ALLOY, ..Default::default() }.set_as_child(self.content_view, &rect);
        let mut client = browser::client();

        cef::browser_host_create_browser(
            Some(&info),
            Some(&mut client),
            Some(&cef::CefString::from(self.options.url.as_str())),
            Some(&cef::BrowserSettings::default()),
            None,
            None,
        );
    }

    fn type_key(&mut self, event: &KeyDownEvent, cx: &mut Context<Self>) {
        let keystroke = &event.keystroke;

        if keystroke.modifiers.platform {
            match keystroke.key.as_str() {
                "v" => {
                    if let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) {
                        self.address.push_str(text.trim());
                    }
                }
                "a" | "backspace" => self.address.clear(),
                _ => return,
            }
        } else if keystroke.modifiers.alt && keystroke.key == "backspace" {
            let trimmed = self.address.trim_end_matches(|c: char| c.is_alphanumeric()).len();

            self.address.truncate(if trimmed == self.address.len() { self.address.len().saturating_sub(1) } else { trimmed });
        } else {
            match keystroke.key.as_str() {
                "enter" => self.go(),
                "escape" => {
                    self.editing = false;
                    mac::focus(self.browser_view);
                }
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

        cx.stop_propagation();
        cx.notify();
    }

    pub fn start_editing(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.editing {
            self.editing = true;
            self.address.clear();
        }

        mac::focus(self.gpui_view);
        window.focus(&self.focus);
        cx.notify();
    }
}

fn load_recent(home: &std::path::Path) -> Vec<String> {
    std::fs::read_to_string(home.join("app-recent.json")).ok().and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default()
}

// ── Drawing ───────────────────────────────────────────────────────────────────────────────

impl Render for Player {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let game = self.game.clone();
        let panel_width = if self.wide { (f32::from(window.viewport_size().width) * 0.62).max(PANEL) } else { PANEL };

        // Where the game goes. Chromium's view is placed over this rectangle; nothing is drawn
        // here but a backdrop for the moment before the page paints.
        let stage = div()
            .flex_1()
            .min_w(px(200.0))
            .relative()
            .bg(rgb(0x000000))
            .child(canvas(move |bounds, _, _| game.set(Some(bounds)), |_, _, _, _| {}).absolute().size_full())
            .when(self.browser.is_none(), |stage| stage.child(div().size_full().flex().items_center().justify_center().child(note("Starting Chromium…"))));

        div()
            .size_full()
            .flex()
            .flex_col()
            .bg(rgb(WINDOW))
            .text_color(rgb(TEXT))
            .on_action(cx.listener(|this, _: &OpenLocation, window, cx| this.start_editing(window, cx)))
            .child(self.toolbar(cx))
            .child(
                div()
                    .flex_1()
                    .flex()
                    .min_h_0()
                    .child(stage)
                    .child(panels::rail(self, cx))
                    .child(div().w(px(panel_width)).flex_none().h_full().min_h_0().bg(rgb(SIDEBAR)).child(panels::render(self, window, cx))),
            )
            .child(self.status_bar())
    }
}

impl Player {
    fn toolbar(&mut self, cx: &mut Context<Self>) -> impl IntoElement {
        let paused = self.paused();
        let scale = self.time_scale();
        let human = self.status["owner"] == "human";
        let request = self.status["request"]["instruction"].as_str().map(str::to_string);
        let field = if self.editing { BLUE } else { FAINT };
        let shown = if self.address.is_empty() && !self.editing { "Type an address, or ⌘L".to_string() } else { self.address.clone() };

        div()
            .flex()
            .flex_none()
            .items_center()
            .gap_2()
            .h(px(TOOLBAR))
            // Room for the window's buttons, which sit over the bar.
            .pl(px(84.0))
            .pr_3()
            .border_b_1()
            .border_color(tint(FAINT, 0.6))
            .on_mouse_down(MouseButton::Left, |event, window, _| {
                if event.click_count == 2 {
                    window.titlebar_double_click();
                } else {
                    window.start_window_move();
                }
            })
            .child(button("reload", "↻", TEXT).text_base().on_click(cx.listener(|this, _, _, cx| {
                this.reload();
                cx.notify();
            })))
            .child(
                div()
                    .id("address")
                    .track_focus(&self.focus)
                    .flex_1()
                    .min_w(px(160.0))
                    .px_2()
                    .py(px(5.0))
                    .rounded_md()
                    .text_sm()
                    .bg(rgb(FIELD))
                    .border_1()
                    .border_color(tint(field, 0.8))
                    .text_color(if self.address.is_empty() && !self.editing { rgb(DIM) } else { rgb(TEXT) })
                    .overflow_hidden()
                    .whitespace_nowrap()
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(|this, _, window, cx| {
                            cx.stop_propagation();
                            this.start_editing(window, cx);
                        }),
                    )
                    .on_key_down(cx.listener(|this, event: &KeyDownEvent, _, cx| this.type_key(event, cx)))
                    .child(format!("{shown}{}", if self.editing { "▏" } else { "" })),
            )
            .child(div().w(px(6.0)))
            .child(button("pause", if paused { "▶  Run" } else { "❚❚  Pause" }, GREEN).on_click(cx.listener(|this, _, _, cx| {
                this.toggle_pause();
                cx.notify();
            })))
            .child(button("step", "▶|  Step", GREEN).on_click(cx.listener(|this, _, _, cx| {
                this.step(1);
                cx.notify();
            })))
            .child(button("scale", format!("{}×", trim(scale)), CYAN).on_click(cx.listener(|this, _, _, cx| {
                let next = match this.time_scale() {
                    s if s < 0.3 => 0.5,
                    s if s < 0.6 => 1.0,
                    s if s < 1.5 => 2.0,
                    _ => 0.25,
                };

                this.set_time_scale(next);
                cx.notify();
            })))
            .child(div().w(px(6.0)))
            .child(button("capture", "●  Capture", PURPLE).on_click(cx.listener(|this, _, _, cx| {
                this.capture();
                cx.notify();
            })))
            .when_some(request, |bar, _| {
                bar.child(button("debug", "⚑  Debug", RED).on_click(cx.listener(|this, _, _, cx| {
                    this.debug();
                    cx.notify();
                })))
            })
            .child(
                div()
                    .id("owner")
                    .px_2()
                    .py(px(3.0))
                    .rounded_md()
                    .text_xs()
                    .cursor_pointer()
                    .border_1()
                    .border_color(tint(if human { AMBER } else { DIM }, 0.5))
                    .text_color(rgb(if human { AMBER } else { DIM }))
                    .child(if human { "You have the input" } else { "Agent may drive" })
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.take_input(!human);
                        cx.notify();
                    })),
            )
    }

    fn status_bar(&self) -> impl IntoElement {
        let connected = self.host.connected();
        let frame = self.status["frame"].as_u64().map(|frame| format!("frame {frame}")).unwrap_or_default();
        let state = if self.status.is_null() {
            "".to_string()
        } else if self.paused() {
            "paused".to_string()
        } else {
            format!("running at {}×", trim(self.time_scale()))
        };
        let context = self.status["contexts"].as_array().and_then(|contexts| contexts.first()).map(|context| {
            format!(
                "{} {}×{}",
                match context["api"].as_str().unwrap_or("") {
                    "webgl2" => "WebGL 2",
                    "webgl" => "WebGL",
                    "webgpu" => "WebGPU",
                    other => other,
                },
                context["width"],
                context["height"]
            )
        });
        let browser = self.status["browser"].as_str().map(|browser| browser.replace("Chrome/", "Chromium ")).unwrap_or_default();

        div()
            .flex()
            .flex_none()
            .items_center()
            .gap_3()
            .px_3()
            .h(px(STATUS))
            .text_xs()
            .text_color(rgb(DIM))
            .border_t_1()
            .border_color(tint(FAINT, 0.6))
            .child(div().size(px(8.0)).rounded_full().bg(rgb(if connected { GREEN } else { AMBER })).shadow(glow(if connected { GREEN } else { AMBER }, 0.6)))
            .child(if connected { self.options.session.clone().unwrap_or_else(|| "no session".into()) } else { "host not reachable".into() })
            .child(div().font_family(MONO).child(frame))
            .child(state)
            .when_some(context, |bar, context| bar.child(context))
            .child(self.status["profile"].as_str().unwrap_or("").to_string())
            .child(browser)
            .child(div().flex_1())
            .when_some(self.message.clone(), |bar, (text, error)| {
                bar.child(div().max_w(px(560.0)).overflow_hidden().whitespace_nowrap().text_color(rgb(if error { RED } else { TEXT })).child(text))
            })
    }
}

pub fn trim(value: f64) -> String {
    let text = format!("{value:.2}");

    text.trim_end_matches('0').trim_end_matches('.').to_string()
}

// ── Start ─────────────────────────────────────────────────────────────────────────────────

/// The one window this process has, for the menu bar's actions.
struct Current(WindowHandle<Player>);

impl Global for Current {}

/// Acts on this process's window, from where only the app is to hand (menus, list rows).
pub fn with_current(cx: &mut App, f: impl FnOnce(&mut Player, &mut Context<Player>)) {
    let Some(handle) = cx.try_global::<Current>().map(|current| current.0) else { return };

    let _ = handle.update(cx, |this, _, cx| {
        f(this, cx);
        cx.notify();
    });
}

fn menus(cx: &mut App, recent: &[String]) {
    let mut opened: Vec<MenuItem> = recent
        .iter()
        .take(10)
        .enumerate()
        .map(|(index, url)| MenuItem::Action { name: url.clone().into(), action: recent_action(index), os_action: None })
        .collect();

    if opened.is_empty() {
        opened.push(MenuItem::action("No pages yet", OpenRecent9));
    }

    cx.set_menus(vec![
        Menu {
            name: "Scanline".into(),
            items: vec![MenuItem::os_submenu("Services", SystemMenuType::Services), MenuItem::separator(), MenuItem::action("Quit Scanline", Quit)],
        },
        Menu {
            name: "File".into(),
            items: vec![
                MenuItem::action("New Window", NewWindow),
                MenuItem::action("Open Location…", OpenLocation),
                MenuItem::submenu(Menu { name: "Open Recent".into(), items: opened }),
                MenuItem::separator(),
                MenuItem::action("Close Window", CloseWindow),
            ],
        },
        Menu {
            name: "Game".into(),
            items: vec![
                MenuItem::action("Reload", Reload),
                MenuItem::separator(),
                MenuItem::action("Pause or Run", TogglePause),
                MenuItem::action("Step One Frame", StepFrame),
                MenuItem::action("Step Ten Frames", StepTen),
                MenuItem::action("Slower", SlowDown),
                MenuItem::action("Faster", SpeedUp),
                MenuItem::separator(),
                MenuItem::action("Capture Frame", Capture),
                MenuItem::action("Debug (answer the agent)", Debug),
            ],
        },
        Menu {
            name: "View".into(),
            items: vec![
                MenuItem::action("Live", ShowLive),
                MenuItem::action("Resources", ShowResources),
                MenuItem::action("Captures", ShowCaptures),
                MenuItem::action("Console", ShowConsole),
                MenuItem::action("Agent", ShowAgent),
                MenuItem::separator(),
                MenuItem::action("Wide Panel", ToggleWide),
            ],
        },
        Menu { name: "Window".into(), items: vec![MenuItem::action("New Window", NewWindow), MenuItem::action("Close Window", CloseWindow)] },
    ]);
}

fn bind(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("cmd-q", Quit, None),
        KeyBinding::new("cmd-n", NewWindow, None),
        KeyBinding::new("cmd-w", CloseWindow, None),
        KeyBinding::new("cmd-l", OpenLocation, None),
        KeyBinding::new("cmd-r", Reload, None),
        KeyBinding::new("cmd-.", TogglePause, None),
        KeyBinding::new("cmd-'", StepFrame, None),
        KeyBinding::new("cmd-shift-'", StepTen, None),
        KeyBinding::new("cmd-[", SlowDown, None),
        KeyBinding::new("cmd-]", SpeedUp, None),
        KeyBinding::new("cmd-shift-c", Capture, None),
        KeyBinding::new("cmd-shift-d", Debug, None),
        KeyBinding::new("cmd-1", ShowLive, None),
        KeyBinding::new("cmd-2", ShowResources, None),
        KeyBinding::new("cmd-3", ShowCaptures, None),
        KeyBinding::new("cmd-4", ShowConsole, None),
        KeyBinding::new("cmd-5", ShowAgent, None),
        KeyBinding::new("cmd-\\", ToggleWide, None),
    ]);

    cx.on_action(|_: &Quit, _| std::process::exit(0));
    cx.on_action(|_: &CloseWindow, _| std::process::exit(0));
    cx.on_action(|_: &NewWindow, _| {
        // A new window is a new session: the launcher asks the host for one.
        if let Ok(me) = std::env::current_exe() {
            let _ = std::process::Command::new(me).spawn();
        }
    });
    cx.on_action(|_: &OpenLocation, cx| {
        let Some(handle) = cx.try_global::<Current>().map(|current| current.0) else { return };

        let _ = handle.update(cx, |this, window, cx| this.start_editing(window, cx));
    });
    cx.on_action(|_: &Reload, cx| with_current(cx, |this, _| this.reload()));
    cx.on_action(|_: &TogglePause, cx| with_current(cx, |this, _| this.toggle_pause()));
    cx.on_action(|_: &StepFrame, cx| with_current(cx, |this, _| this.step(1)));
    cx.on_action(|_: &StepTen, cx| with_current(cx, |this, _| this.step(10)));
    cx.on_action(|_: &SlowDown, cx| with_current(cx, |this, _| this.set_time_scale((this.time_scale() / 2.0).max(0.125))));
    cx.on_action(|_: &SpeedUp, cx| with_current(cx, |this, _| this.set_time_scale((this.time_scale() * 2.0).min(4.0))));
    cx.on_action(|_: &Capture, cx| with_current(cx, |this, _| this.capture()));
    cx.on_action(|_: &Debug, cx| with_current(cx, |this, _| this.debug()));
    cx.on_action(|_: &ShowLive, cx| with_current(cx, |this, _| this.show(Panel::Live)));
    cx.on_action(|_: &ShowResources, cx| with_current(cx, |this, _| this.show(Panel::Resources)));
    cx.on_action(|_: &ShowCaptures, cx| with_current(cx, |this, _| this.show(Panel::Captures)));
    cx.on_action(|_: &ShowConsole, cx| with_current(cx, |this, _| this.show(Panel::Console)));
    cx.on_action(|_: &ShowAgent, cx| with_current(cx, |this, _| this.show(Panel::Agent)));
    cx.on_action(|_: &ToggleWide, cx| with_current(cx, |this, _| this.wide = !this.wide));
    cx.on_action(|_: &OpenRecent0, cx| with_current(cx, |this, _| this.open_recent(0)));
    cx.on_action(|_: &OpenRecent1, cx| with_current(cx, |this, _| this.open_recent(1)));
    cx.on_action(|_: &OpenRecent2, cx| with_current(cx, |this, _| this.open_recent(2)));
    cx.on_action(|_: &OpenRecent3, cx| with_current(cx, |this, _| this.open_recent(3)));
    cx.on_action(|_: &OpenRecent4, cx| with_current(cx, |this, _| this.open_recent(4)));
    cx.on_action(|_: &OpenRecent5, cx| with_current(cx, |this, _| this.open_recent(5)));
    cx.on_action(|_: &OpenRecent6, cx| with_current(cx, |this, _| this.open_recent(6)));
    cx.on_action(|_: &OpenRecent7, cx| with_current(cx, |this, _| this.open_recent(7)));
    cx.on_action(|_: &OpenRecent8, cx| with_current(cx, |this, _| this.open_recent(8)));
    cx.on_action(|_: &OpenRecent9, cx| with_current(cx, |this, _| this.open_recent(9)));
}

pub fn run(args: cef::args::Args, mut app: cef::App, options: Options) {
    Application::new().run(move |cx: &mut App| {
        let cache = options.cache.clone().unwrap_or_else(|| std::env::temp_dir().join("scanline-app-cache"));
        let settings = cef::Settings {
            no_sandbox: 1,
            external_message_pump: 1,
            root_cache_path: cef::CefString::from(cache.to_string_lossy().as_ref()),
            ..Default::default()
        };

        assert_eq!(cef::initialize(Some(args.as_main_args()), Some(&settings), Some(&mut app), std::ptr::null_mut()), 1, "CEF did not start");

        bind(cx);

        // The game at the size the host asked for, with the bars and the panel around it,
        // within the screen.
        let screen = cx.primary_display().map(|display| display.bounds().size).unwrap_or(size(px(1600.0), px(1000.0)));
        let width = (options.width + RAIL + PANEL).min(f32::from(screen.width) - 40.0).max(900.0);
        let height = (options.height + TOOLBAR + STATUS + 28.0).min(f32::from(screen.height) - 60.0).max(560.0);
        let bounds = Bounds::centered(None, size(px(width), px(height)), cx);
        let options = options.clone();

        let window = cx
            .open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(bounds)),
                    titlebar: Some(TitlebarOptions {
                        title: Some("Scanline".into()),
                        appears_transparent: true,
                        traffic_light_position: Some(point(px(16.0), px(18.0))),
                    }),
                    window_min_size: Some(size(px(900.0), px(520.0))),
                    ..Default::default()
                },
                move |window, cx| {
                    let view = match window.window_handle().map(|handle| handle.as_raw()) {
                        Ok(RawWindowHandle::AppKit(handle)) => handle.ns_view.as_ptr(),
                        _ => panic!("expected an AppKit window"),
                    };

                    cx.new(|cx| Player::new(options, view, cx))
                },
            )
            .expect("a window");

        cx.set_global(Current(window));

        // The message pump: CEF's work, then the window's. CEF asks for work through
        // OnScheduleMessagePumpWork; a steady 4 ms turn serves as well and keeps input prompt.
        cx.spawn(async move |cx| {
            loop {
                cx.background_executor().timer(Duration::from_millis(4)).await;
                cef::do_message_loop_work();

                let turned = window.update(cx, |this, window, cx| this.tick(window, cx));

                if turned.is_err() {
                    break;
                }
            }
        })
        .detach();

        // Closing the window ends the session: the host sees a clean exit and forgets it.
        cx.on_window_closed(|cx| {
            if cx.windows().is_empty() {
                std::process::exit(0);
            }
        })
        .detach();

        cx.activate(true);
    });
}
