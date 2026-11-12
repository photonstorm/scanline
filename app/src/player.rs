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
use crate::{browser, platform};

const TOOLBAR: f32 = 52.0;
const STATUS: f32 = 28.0;
pub const PANEL: f32 = 470.0;
const RAIL: f32 = 66.0;
/// The bar between the game and the panels, dragged to share the window between them.
const DIVIDER: f32 = 6.0;

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
        ShowExperiments,
        ShowConsole,
        ShowAgent,
        ToggleWide,
        SlowDown,
        SpeedUp,
        Screenshot,
        ToggleVideo,
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
    crate::channel::home()
}

/// A copy of a file the host wrote, on the person's desktop, named for when it was made.
fn to_desktop(source: &std::path::Path, what: &str) -> Option<PathBuf> {
    let desktop = PathBuf::from(std::env::var_os("HOME")?).join("Desktop");
    let extension = source.extension()?.to_string_lossy().to_string();
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok()?.as_secs();
    let target = desktop.join(format!("Scanline {what} {stamp}.{extension}"));

    std::fs::copy(source, &target).ok()?;

    Some(target)
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
    /// A capture file opened from the Finder while this window was open.
    Import,
    Recording(String),
    Texel(String, (u32, u32)),
    /// How far a long job (a capture, a video) has got.
    Progress,
    Thumbnails,
    Shot,
    VideoStart,
    VideoStop,
    /// A switch the person turned on, by its key, and one turned off.
    Patched(String),
    Reverted,
    Patches,
    ExperimentPrograms,
    ExperimentTextures,
    Measure,
    View,
    /// A shader's source, to edit in the person's own editor.
    EditSource(String, String),
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
            Purpose::Progress => "progress",
            Purpose::Thumbnails => "thumbnails",
            Purpose::Patches => "patches",
            Purpose::ExperimentPrograms => "experiment-programs",
            Purpose::ExperimentTextures => "experiment-textures",
            _ => return None,
        })
    }
}

pub struct Player {
    pub focus: FocusHandle,
    /// The note sent with Send to agent, and whether it has the keyboard.
    pub note_focus: FocusHandle,
    pub note: String,
    pub noting: bool,
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
    pub experiments: panels::experiments::State,
    /// The panel's width: as the person dragged it, or half the window. panel_px is what it
    /// was drawn at, for the panels to lay themselves out by.
    pub panel_width: Option<f32>,
    pub panel_px: f32,
    dragging: bool,
    /// A long job under way (a capture, a video), as progress() describes it.
    pub busy: Value,
    shown_seq: u64,
    shown_title: String,
}

impl Player {
    fn new(options: Options, gpui_view: *mut c_void, cx: &mut Context<Self>) -> Self {
        let host = HostLink::open(&options.home);
        let recent = load_recent(&options.home);
        let panel_width = load_layout(&options.home);

        Player {
            focus: cx.focus_handle(),
            note_focus: cx.focus_handle(),
            note: String::new(),
            noting: false,
            gpui_view,
            content_view: platform::content_view(gpui_view),
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
            experiments: Default::default(),
            panel_width,
            panel_px: PANEL,
            dragging: false,
            busy: Value::Null,
            shown_seq: 0,
            shown_title: String::new(),
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

        let by = if matches!(
            purpose,
            Purpose::Action(_)
                | Purpose::Capture
                | Purpose::Import
                | Purpose::Shot
                | Purpose::VideoStart
                | Purpose::VideoStop
                | Purpose::Patched(_)
                | Purpose::Reverted
                | Purpose::Measure
                | Purpose::View
        ) {
            "person"
        } else {
            "viewer"
        };
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

        // A long job's progress, while one is under way.
        if self.pending.values().any(|purpose| matches!(purpose, Purpose::Capture | Purpose::VideoStop)) {
            if self.due("progress", Duration::from_millis(300)) {
                self.ask("progress", json!({}), Purpose::Progress);
            }
        } else if !self.busy.is_null() {
            self.busy = Value::Null;
        }

        if self.panel == Panel::Experiments {
            if self.due("patches", Duration::from_millis(1500)) {
                self.ask("patches", json!({}), Purpose::Patches);
            }

            if self.due("experiment-programs", Duration::from_millis(4000)) {
                let kind = if self.status["contexts"].as_array().and_then(|contexts| contexts.first()).is_some_and(|context| context["api"] == "webgpu") {
                    "pipeline"
                } else {
                    "program"
                };

                self.ask("resources", json!({ "kind": kind, "sort": "last_used", "limit": 200 }), Purpose::ExperimentPrograms);
            }

            if self.due("experiment-textures", Duration::from_millis(4000)) {
                self.ask("resources", json!({ "kind": "texture", "sort": "bytes", "limit": 200 }), Purpose::ExperimentTextures);
            }
        }

        // The gallery's pictures, a few at a time, so they arrive as they are made.
        if matches!(self.panel, Panel::Resources | Panel::Experiments) && !self.polling.contains("thumbnails") {
            if self.panel == Panel::Experiments && self.resources.list.is_empty() {
                self.resources.list = self.experiments.textures.clone();
            }

            let wanted = self.resources.wanted_thumbs(4);

            if !wanted.is_empty() {
                self.ask("thumbnails", json!({ "handles": wanted, "max_edge": 256 }), Purpose::Thumbnails);
            }
        }

        // A shader open in the person's editor: each save is tried in the game.
        self.watch_shader_edit();

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
            (Purpose::Activity, Ok(value)) => {
                let session = self.options.session.clone();

                self.agent.receive(&value["data"], session.as_deref());
            }
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
            (Purpose::Texel(handle, texel), reply) => {
                if self.resources.selected.as_deref() == Some(handle.as_str()) && self.resources.texel == Some(texel) {
                    // "tex_1 (1, 1) level 0: rgba 8-bit (255, 0, 0, 255). Format …": the part after the place.
                    self.resources.texel_value = Some(match reply {
                        Ok(value) => {
                            let first = value["summary"].as_str().unwrap_or("").lines().next().unwrap_or("").to_string();

                            first.split_once(": ").map(|(_, said)| said.to_string()).unwrap_or(first)
                        }
                        Err(error) => error,
                    });
                }
            }
            (Purpose::Progress, Ok(value)) => self.busy = value["data"]["busy"].clone(),
            (Purpose::Thumbnails, Ok(value)) => self.resources.got_thumbs(&value["data"]),
            (Purpose::Shot, Ok(value)) => {
                let path = value["images"][0]["original"].as_str().or(value["images"][0]["view"].as_str()).map(PathBuf::from);

                match path.as_deref().and_then(|path| to_desktop(path, "screenshot")) {
                    Some(saved) => self.say(
                        &format!("Screenshot saved to the desktop: {}", saved.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_default()),
                        false,
                    ),
                    None => self.say("The screenshot was taken but could not be copied to the desktop.", true),
                }
            }
            (Purpose::VideoStart, Ok(_)) => self.say("Recording a video: the last ten seconds are kept. Press Stop to save it.", false),
            (Purpose::VideoStop, Ok(value)) => match value["data"]["video"].as_str().map(PathBuf::from).as_deref().and_then(|path| to_desktop(path, "video")) {
                Some(saved) => self.say(
                    &format!("Video saved to the desktop: {}", saved.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_default()),
                    false,
                ),
                None => self.say(value["summary"].as_str().unwrap_or("No video was made.").lines().next().unwrap_or(""), true),
            },
            (Purpose::Patched(key), Ok(value)) => {
                self.experiments.waiting.remove(&key);

                if let Some(patch) = value["data"]["patch"].as_str() {
                    self.experiments.active.insert(key, patch.to_string());
                }

                self.say(value["summary"].as_str().unwrap_or("").lines().next().unwrap_or(""), false);
                self.last.remove("patches");
            }
            (Purpose::Patched(key), Err(error)) => {
                self.experiments.waiting.remove(&key);
                self.say(&error, true);
            }
            (Purpose::Reverted, Ok(_)) => {
                self.last.remove("patches");
            }
            (Purpose::View, Ok(value)) => {
                self.experiments.waiting.remove("view");

                match value["data"]["patch"].as_str() {
                    Some(patch) if !self.experiments.view.is_empty() => {
                        self.experiments.active.insert("view".to_string(), patch.to_string());
                    }
                    _ => {
                        self.experiments.active.remove("view");
                    }
                }

                self.last.remove("patches");
            }
            (Purpose::Patches, Ok(value)) => self.experiments.listed(&value["data"]),
            (Purpose::ExperimentPrograms, Ok(value)) => self.experiments.programs = value["data"]["rows"].as_array().cloned().unwrap_or_default(),
            (Purpose::ExperimentTextures, Ok(value)) => self.experiments.textures = value["data"]["rows"].as_array().cloned().unwrap_or_default(),
            (Purpose::Measure, Ok(value)) => {
                self.experiments.measuring = None;
                self.experiments.measured = Some(value);
            }
            (Purpose::Measure, Err(error)) => {
                self.experiments.measuring = None;
                self.say(&error, true);
            }
            (Purpose::EditSource(program, shader), Ok(value)) => self.open_shader_in_editor(program, shader, &value),
            (Purpose::Recording(recording), Ok(value)) => {
                if self.captures.recording.as_deref() == Some(recording.as_str()) {
                    self.captures.frames = Some(value);
                }
            }
            (Purpose::Import, Ok(value)) => {
                self.say(value["summary"].as_str().unwrap_or("Opened.").lines().next().unwrap_or(""), false);

                if let Some(capture) = value["data"]["capture"].as_str() {
                    self.open_capture(capture.to_string(), cx);
                }
            }
            (Purpose::Draw(capture, draw), Err(error)) | (Purpose::Target(capture, draw), Err(error)) => self.captures.failed(&capture, draw, error),
            (Purpose::Action(_), Ok(value)) => {
                let summary = value["summary"].as_str().unwrap_or("Done.").lines().next().unwrap_or("").to_string();

                self.say(&summary, false);
            }
            // Upkeep that fails (the host still registering the session, say) is tried again
            // on the next turn; only what the person did is worth telling them about.
            (
                Purpose::Action(_)
                | Purpose::Capture
                | Purpose::DrawList(_)
                | Purpose::Import
                | Purpose::Shot
                | Purpose::VideoStart
                | Purpose::VideoStop
                | Purpose::Reverted
                | Purpose::EditSource(_, _),
                Err(error),
            ) => self.say(&error, true),
            (Purpose::View, Err(error)) => {
                self.experiments.waiting.remove("view");
                self.experiments.view.clear();
                self.say(&error, true);
            }
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

        if let Some(recording) = shown["recording"].as_str() {
            self.open_recording(recording.to_string());
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
        platform::focus(self.browser_view);
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

    /// Runs the page for `frames` frames with the flight recorder on, then freezes it: a
    /// recording of them, and a capture of the last.
    pub fn record(&mut self, frames: u32) {
        self.say(&format!("Recording {frames} frames…"), false);
        self.ask("capture", json!({ "when": { "frames": frames }, "flight_frames": frames }), Purpose::Capture);
    }

    pub fn open_recording(&mut self, recording: String) {
        self.show(Panel::Captures);
        self.captures.opened = None;
        self.captures.recording = Some(recording.clone());
        self.captures.frames = None;
        self.ask("recording", json!({ "recording": recording }), Purpose::Recording(recording));
    }

    /// One frame of the open recording, made a capture.
    pub fn capture_frame(&mut self, frame: u64) {
        let Some(recording) = self.captures.recording.clone() else { return };

        self.captures.recording = None;
        self.say(&format!("Making frame {frame} of {recording} a capture…"), false);
        self.ask("capture", json!({ "recording": recording, "frame": frame }), Purpose::Capture);
    }

    pub fn debug(&mut self) {
        self.ask("debug", json!({}), Purpose::Action("debug"));
    }

    /// As much of the window for the panels as leaves the game usable, or back to the
    /// person's own width.
    pub fn toggle_wide(&mut self) {
        self.wide = !self.wide;
        self.panel_width = if self.wide { Some(f32::MAX) } else { load_layout(&self.options.home) };
    }

    /// A picture of the canvas as the GPU drew it, saved to the desktop.
    pub fn screenshot(&mut self) {
        self.ask("screenshot", json!({ "max_edge": 4096 }), Purpose::Shot);
    }

    pub fn video_running(&self) -> bool {
        self.status["video_seconds"].is_number()
    }

    /// Starts a video, or stops one and saves it to the desktop.
    pub fn toggle_video(&mut self) {
        if self.video_running() {
            self.say("Saving the video: replaying its frames and encoding them…", false);
            self.ask("video", json!({ "action": "stop" }), Purpose::VideoStop);
            self.status["video_seconds"] = Value::Null;
        } else {
            self.ask("video", json!({ "action": "start" }), Purpose::VideoStart);
            self.status["video_seconds"] = json!(0.0);
        }
    }

    // ── Experiments ─────────────────────────────────────────────────────────────────────

    /// A switch: makes the patch (method, params) if it is off, undoes it if it is on.
    pub fn toggle_patch(&mut self, key: String, method: &'static str, params: Value) {
        if let Some(patch) = self.experiments.active.remove(&key) {
            self.ask("patches", json!({ "revert": patch }), Purpose::Reverted);
        } else if self.experiments.waiting.insert(key.clone()) {
            self.ask(method, params, Purpose::Patched(key));
        }
    }

    pub fn revert_patch(&mut self, patch: String) {
        if patch == "all" {
            self.experiments.active.clear();
            self.experiments.view.clear();
        } else {
            self.experiments.active.retain(|_, made| *made != patch);
        }

        self.ask("patches", json!({ "revert": patch }), Purpose::Reverted);
    }

    /// The frame drawn another way: "" for the page's own.
    pub fn set_view(&mut self, view: &str) {
        // The view in force comes off first: one view at a time.
        if let Some(patch) = self.experiments.active.remove("view") {
            self.ask("patches", json!({ "revert": patch }), Purpose::Reverted);
        }

        self.experiments.view = view.to_string();

        if !view.is_empty() {
            self.experiments.waiting.insert("view".to_string());
            self.ask("live_view", json!({ "view": view }), Purpose::View);
        }
    }

    pub fn measure(&mut self, kind: &str) {
        if self.experiments.measuring.is_some() {
            return;
        }

        self.experiments.measuring = Some(kind.to_string());
        self.ask("experiment", json!({ "kind": kind, "frames": 30 }), Purpose::Measure);
    }

    /// Opens a program's shader in the person's own editor; each save is tried in the game.
    pub fn edit_shader(&mut self, program: String, shader: String) {
        self.ask("resource", json!({ "handle": shader, "detail": "full" }), Purpose::EditSource(program, shader));
    }

    fn open_shader_in_editor(&mut self, program: String, shader: String, value: &Value) {
        let source = value["data"]["detail"]["source"].as_str().unwrap_or("").to_string();
        let kind = value["data"]["detail"]["type"].as_str().unwrap_or("glsl");
        let folder = self.options.home.join("shader-edits");
        let path = folder.join(format!(
            "{program}-{shader}.{}",
            if kind == "vertex" {
                "vert"
            } else if kind == "fragment" {
                "frag"
            } else {
                "wgsl"
            }
        ));

        if std::fs::create_dir_all(&folder).is_err() || std::fs::write(&path, &source).is_err() {
            self.say(&format!("Could not write {} to edit.", path.display()), true);
            return;
        }

        let written = std::fs::metadata(&path).and_then(|meta| meta.modified()).ok();

        // The person's own text editor, as the system knows it.
        let _ =
            std::process::Command::new(if cfg!(windows) { "notepad" } else { "open" }).args(if cfg!(windows) { vec![] } else { vec!["-t"] }).arg(&path).spawn();

        self.experiments.editing = Some(panels::experiments::Edit { program, shader: shader.clone(), path, written });
        self.show(Panel::Experiments);
        self.say(&format!("{shader} is open in your editor. Save it to try it in the game."), false);
    }

    fn watch_shader_edit(&mut self) {
        if self.last.get("shader-edit").is_some_and(|at| at.elapsed() < Duration::from_millis(600)) {
            return;
        }

        self.last.insert("shader-edit", Instant::now());

        let Some(edit) = self.experiments.editing.clone() else { return };
        let written = std::fs::metadata(&edit.path).and_then(|meta| meta.modified()).ok();

        if written == edit.written || written.is_none() {
            return;
        }

        if let Some(editing) = self.experiments.editing.as_mut() {
            editing.written = written;
        }

        let Ok(source) = std::fs::read_to_string(&edit.path) else { return };
        let key = format!("edit:{}:{}", edit.program, edit.shader);

        // The last version comes off before the new one goes on.
        if let Some(patch) = self.experiments.active.remove(&key) {
            self.ask("patches", json!({ "revert": patch }), Purpose::Reverted);
        }

        self.experiments.waiting.insert(key.clone());
        self.ask("patch_shader", json!({ "handle": edit.program, "shader": edit.shader, "source": source }), Purpose::Patched(key));
    }

    pub fn stop_editing_shader(&mut self) {
        if let Some(edit) = self.experiments.editing.take() {
            if let Some(patch) = self.experiments.active.remove(&format!("edit:{}:{}", edit.program, edit.shader)) {
                self.ask("patches", json!({ "revert": patch }), Purpose::Reverted);
            }
        }
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

        if !self.note.trim().is_empty() {
            chosen["note"] = json!(self.note.trim());
        }

        self.note.clear();
        self.noting = false;

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

    /// A texel of the selected texture, read exactly, at the level shown.
    pub fn read_texel(&mut self, texel: (u32, u32)) {
        let Some(handle) = self.resources.selected.clone() else { return };

        self.resources.texel = Some(texel);
        self.resources.texel_value = None;

        let level = self.resources.level;

        self.ask("pixels", json!({ "source": handle, "x": texel.0, "y": texel.1, "level": level }), Purpose::Texel(handle, texel));
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
            platform::place(
                self.browser_view,
                f64::from(bounds.origin.x),
                f64::from(bounds.origin.y),
                f64::from(bounds.size.width),
                f64::from(bounds.size.height),
            );
        }

        // Capture files opened from the Finder while this window was open.
        let opened: Vec<String> = OPENED.lock().map(|mut opened| opened.drain(..).collect()).unwrap_or_default();

        for url in opened {
            if let Some(path) = crate::launcher::file_path(&url) {
                self.ask("import", json!({ "path": path.display().to_string() }), Purpose::Import);
            }
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

                platform::snapshot(self.gpui_view, &folder.join(format!("{name}.png")));

                // Where Chromium's view is, against where the game should be: a picture of
                // one's own window leaves out what the GPU process draws.
                let game = self.game.get().map(|b| [f32::from(b.origin.x), f32::from(b.origin.y), f32::from(b.size.width), f32::from(b.size.height)]);
                let placed = json!({ "game": game, "browser_view": platform::frame(self.browser_view), "content": platform::frame(self.content_view), "panel": format!("{:?}", self.panel) });

                let _ = std::fs::write(folder.join(format!("{name}.json")), placed.to_string());

                // And what to do, as the person would, one line each: <name>.do, read and removed.
                let script = folder.join(format!("{name}.do"));

                if let Ok(text) = std::fs::read_to_string(&script) {
                    let _ = std::fs::remove_file(&script);

                    for line in text.lines() {
                        self.act(line.trim(), window, cx);
                    }

                    changed = true;
                }
            }
        }

        let title = match (&self.options.session, self.title.is_empty()) {
            (Some(session), false) => format!("{} — {session}", self.title),
            (Some(session), true) => format!("Scanline — {session}"),
            (None, _) => "Scanline".to_string(),
        };

        if title != self.shown_title {
            window.set_window_title(&title);
            self.shown_title = title;
        }

        if self.menus_stale {
            self.menus_stale = false;
            menus(cx, &self.recent);
        }

        if changed {
            cx.notify();
        }
    }

    /// One thing the person could do, for checking the window without anyone at it
    /// (SCANLINE_APP_SNAPSHOTS): capture, screenshot, video, show <panel>, select <handle>,
    /// patch <key> <method> <json>, view <name>, measure <kind>, width <points>, kind <kind>,
    /// draw <n>, pixel <x> <y>.
    fn act(&mut self, line: &str, window: &mut Window, cx: &mut Context<Self>) {
        let mut words = line.splitn(2, ' ');
        let verb = words.next().unwrap_or("");
        let rest = words.next().unwrap_or("").trim();

        match verb {
            "capture" => self.capture(),
            "screenshot" => self.screenshot(),
            "video" => self.toggle_video(),
            "show" => self.show(match rest {
                "resources" => Panel::Resources,
                "captures" => Panel::Captures,
                "experiments" => Panel::Experiments,
                "console" => Panel::Console,
                "agent" => Panel::Agent,
                _ => Panel::Live,
            }),
            "select" => self.select_resource(rest.to_string()),
            "kind" => self.show_kind(rest.to_string()),
            "back" => {
                self.resources.selected = None;
                self.resources.detail = None;
            }
            "patch" => {
                let mut parts = rest.splitn(3, ' ');
                let (key, method, params) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""), parts.next().unwrap_or("{}"));
                let method: &'static str = match method {
                    "patch_draws" => "patch_draws",
                    "patch_state" => "patch_state",
                    "patch_texture" => "patch_texture",
                    _ => "patch_shader",
                };

                self.toggle_patch(key.to_string(), method, serde_json::from_str(params).unwrap_or(json!({})));
            }
            "view" => self.set_view(if rest == "normal" { "" } else { rest }),
            "measure" => self.measure(rest),
            "width" => self.panel_width = rest.parse().ok(),
            "draw" => {
                if let Ok(draw) = rest.parse() {
                    self.select_draw(draw, cx);
                }
            }
            "pixel" => {
                let numbers: Vec<u32> = rest.split_whitespace().filter_map(|word| word.parse().ok()).collect();

                if numbers.len() == 2 {
                    self.pick_pixel((numbers[0], numbers[1]));
                }
            }
            "address" => {
                self.address = rest.to_string();
                self.go();
            }
            _ => {}
        }

        let _ = window;
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

    /// Typing into the note sent with Send to agent.
    pub fn type_note(&mut self, event: &KeyDownEvent, cx: &mut Context<Self>) {
        let keystroke = &event.keystroke;

        if keystroke.modifiers.platform {
            match keystroke.key.as_str() {
                "v" => {
                    if let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) {
                        self.note.push_str(text.trim());
                    }
                }
                "a" | "backspace" => self.note.clear(),
                _ => return,
            }
        } else {
            match keystroke.key.as_str() {
                "enter" => self.send_to_agent(),
                "escape" => {
                    self.noting = false;
                    platform::focus(self.browser_view);
                }
                "backspace" => {
                    self.note.pop();
                }
                _ => {
                    if let Some(text) = &keystroke.key_char {
                        if self.note.chars().count() < 400 {
                            self.note.push_str(text);
                        }
                    }
                }
            }
        }

        cx.stop_propagation();
        cx.notify();
    }

    pub fn start_noting(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.noting = true;
        self.editing = false;
        platform::focus(self.gpui_view);
        window.focus(&self.note_focus);
        cx.notify();
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
                    platform::focus(self.browser_view);
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

        platform::focus(self.gpui_view);
        window.focus(&self.focus);
        cx.notify();
    }
}

/// The panel's width as the person last dragged it.
fn load_layout(home: &std::path::Path) -> Option<f32> {
    let text = std::fs::read_to_string(home.join("app-layout.json")).ok()?;

    serde_json::from_str::<Value>(&text).ok()?["panel"].as_f64().map(|width| width as f32)
}

fn save_layout(home: &std::path::Path, width: Option<f32>) {
    let _ = std::fs::write(home.join("app-layout.json"), json!({ "panel": width }).to_string());
}

fn load_recent(home: &std::path::Path) -> Vec<String> {
    std::fs::read_to_string(home.join("app-recent.json")).ok().and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default()
}

// ── Drawing ───────────────────────────────────────────────────────────────────────────────

impl Render for Player {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let game = self.game.clone();
        let window_width = f32::from(window.viewport_size().width);
        // Half the window by default: the numbers matter as much as the game. Dragged, as the
        // person left it, within what leaves both usable.
        let most = (window_width - RAIL - DIVIDER - 240.0).max(PANEL);
        let panel_width = self.panel_width.unwrap_or(((window_width - RAIL) * 0.5).max(PANEL)).clamp(360.0, most);

        self.panel_px = panel_width;

        // Where the game goes. Chromium's view is placed over this rectangle; nothing is drawn
        // here but a backdrop for the moment before the page paints.
        let stage = div()
            .flex_1()
            .min_w(px(200.0))
            .relative()
            .bg(rgb(0x000000))
            .child(canvas(move |bounds, _, _| game.set(Some(bounds)), |_, _, _, _| {}).absolute().size_full())
            .when(self.browser.is_none(), |stage| stage.child(div().size_full().flex().items_center().justify_center().child(note("Starting Chromium…"))));

        // The bar between the game and the panels: dragged to share the window between them,
        // double-clicked to go back to half and half.
        let dragging = self.dragging;
        let divider = div()
            .id("divider")
            .w(px(DIVIDER))
            .h_full()
            .flex_none()
            .cursor_col_resize()
            .bg(if dragging { tint(BLUE, 0.6) } else { tint(FAINT, 0.5) })
            .hover(|bar| bar.bg(tint(BLUE, 0.45)))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, event: &gpui::MouseDownEvent, _, cx| {
                    if event.click_count == 2 {
                        this.panel_width = None;
                        save_layout(&this.options.home, None);
                    } else {
                        this.dragging = true;
                    }

                    cx.stop_propagation();
                    cx.notify();
                }),
            );

        let progress = self.progress_card();

        div()
            .size_full()
            .flex()
            .flex_col()
            .bg(rgb(WINDOW))
            .text_color(rgb(TEXT))
            .on_action(cx.listener(|this, _: &OpenLocation, window, cx| this.start_editing(window, cx)))
            .on_mouse_move(cx.listener(move |this, event: &gpui::MouseMoveEvent, window, cx| {
                if this.dragging {
                    let width = f32::from(window.viewport_size().width) - f32::from(event.position.x) - RAIL - DIVIDER / 2.0;

                    this.panel_width = Some(width.max(360.0));
                    cx.notify();
                }
            }))
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(|this, _, _, cx| {
                    if this.dragging {
                        this.dragging = false;
                        save_layout(&this.options.home, this.panel_width);
                        cx.notify();
                    }
                }),
            )
            .child(self.toolbar(cx))
            .child(
                div().flex_1().flex().min_h_0().child(stage).child(divider).child(panels::rail(self, cx)).child(
                    div()
                        .w(px(panel_width))
                        .flex_none()
                        .h_full()
                        .min_h_0()
                        .flex()
                        .flex_col()
                        .bg(rgb(SIDEBAR))
                        .children(progress)
                        .child(div().flex_1().min_h_0().child(panels::render(self, window, cx))),
                ),
            )
            .child(self.status_bar())
    }
}

impl Player {
    /// A long job under way: what it is doing, how long it has taken, and its stages so far.
    fn progress_card(&self) -> Option<gpui::Div> {
        let capturing = self.pending.values().any(|purpose| matches!(purpose, Purpose::Capture));
        let saving = self.pending.values().any(|purpose| matches!(purpose, Purpose::VideoStop));

        if !capturing && !saving {
            return None;
        }

        let busy = &self.busy;
        let seconds = busy["seconds"].as_f64().unwrap_or(0.0);
        let stage = busy["stage"].as_str().unwrap_or(if saving { "Saving the video" } else { "Starting" }).to_string();
        let detail = busy["detail"].as_str().filter(|detail| !detail.is_empty()).map(|detail| format!(" ({detail})")).unwrap_or_default();
        let done: Vec<(String, f64)> = busy["done"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|stage| (stage["stage"].as_str().unwrap_or("").to_string(), stage["ms"].as_f64().unwrap_or(0.0)))
            .collect();
        // Eight stages make a capture; the bar moves as each is done.
        let fraction = ((done.len() as f32 + 0.5) / 8.0).min(0.97);
        let title = if saving { "Saving the video" } else { "Capturing a frame" };

        Some(
            div().p_2().child(
                card(format!("{title} · {seconds:.0} s"), PURPLE)
                    .child(meter(40, fraction, PURPLE))
                    .child(div().text_sm().text_color(rgb(TEXT)).child(format!("{stage}{detail}…")))
                    .children(done.into_iter().filter(|(_, ms)| *ms >= 50.0).map(|(stage, ms)| row(format!("✓ {stage}"), format!("{:.1} s", ms / 1000.0))))
                    .child(note(
                        "A capture keeps every texture and buffer the frame used, and replays it to check it. A heavy scene, hundreds of megabytes, takes several seconds.",
                    )),
            ),
        )
    }

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
            // Room for the window's buttons, which sit over the bar on a Mac.
            .pl(px(if cfg!(target_os = "macos") { 84.0 } else { 12.0 }))
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
            .child(button("shot", "Screenshot", BLUE).on_click(cx.listener(|this, _, _, cx| {
                this.screenshot();
                cx.notify();
            })))
            .child({
                let running = self.video_running();
                let seconds = self.status["video_seconds"].as_f64().unwrap_or(0.0);

                button("video", if running { format!("■  Stop {:.0}:{:02.0}", (seconds / 60.0).floor(), seconds % 60.0) } else { "◉  Video".to_string() }, RED)
                    .when(running, |button| button.bg(tint(RED, 0.35)).border_color(tint(RED, 0.9)).shadow(glow(RED, 0.6)))
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.toggle_video();
                        cx.notify();
                    }))
            })
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

/// Files the system asked this process to open, for the window to take on its next turn.
static OPENED: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

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
                MenuItem::action("Screenshot to the Desktop", Screenshot),
                MenuItem::action("Start or Stop a Video", ToggleVideo),
                MenuItem::action("Debug (answer the agent)", Debug),
            ],
        },
        Menu {
            name: "View".into(),
            items: vec![
                MenuItem::action("Live", ShowLive),
                MenuItem::action("Resources", ShowResources),
                MenuItem::action("Captures", ShowCaptures),
                MenuItem::action("Experiments", ShowExperiments),
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
        KeyBinding::new("cmd-4", ShowExperiments, None),
        KeyBinding::new("cmd-5", ShowConsole, None),
        KeyBinding::new("cmd-6", ShowAgent, None),
        KeyBinding::new("cmd-shift-s", Screenshot, None),
        KeyBinding::new("cmd-shift-v", ToggleVideo, None),
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
    cx.on_action(|_: &ShowExperiments, cx| with_current(cx, |this, _| this.show(Panel::Experiments)));
    cx.on_action(|_: &Screenshot, cx| with_current(cx, |this, _| this.screenshot()));
    cx.on_action(|_: &ToggleVideo, cx| with_current(cx, |this, _| this.toggle_video()));
    cx.on_action(|_: &ShowConsole, cx| with_current(cx, |this, _| this.show(Panel::Console)));
    cx.on_action(|_: &ShowAgent, cx| with_current(cx, |this, _| this.show(Panel::Agent)));
    // Wide: three quarters of the window for the panels, or back to the person's own width.
    cx.on_action(|_: &ToggleWide, cx| with_current(cx, |this, _| this.toggle_wide()));
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
    let application = Application::new();

    application.on_open_urls(|urls| OPENED.lock().unwrap().extend(urls));
    application.run(move |cx: &mut App| {
        let cache = options.cache.clone().unwrap_or_else(|| std::env::temp_dir().join("scanline-app-cache"));
        let settings = cef::Settings {
            // On macOS the helpers enter Chromium's sandbox themselves (main.rs). On Windows the
            // sandbox library is not linked yet.
            no_sandbox: if cfg!(windows) { 1 } else { 0 },
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
                    // On a Mac the bar is the toolbar, with the window's buttons over it. Windows
                    // keeps its own title bar, with its own buttons.
                    titlebar: Some(TitlebarOptions {
                        title: Some("Scanline".into()),
                        appears_transparent: cfg!(target_os = "macos"),
                        traffic_light_position: Some(point(px(16.0), px(18.0))),
                    }),
                    window_min_size: Some(size(px(900.0), px(520.0))),
                    ..Default::default()
                },
                move |window, cx| {
                    let view = match window.window_handle().map(|handle| handle.as_raw()) {
                        Ok(RawWindowHandle::AppKit(handle)) => handle.ns_view.as_ptr(),
                        Ok(RawWindowHandle::Win32(handle)) => handle.hwnd.get() as *mut std::ffi::c_void,
                        _ => panic!("expected an AppKit or a Win32 window"),
                    };

                    cx.new(|cx| Player::new(options, view, cx))
                },
            )
            .expect("a window");

        cx.set_global(Current(window));

        // The message pump: CEF's work when it asks for it (OnScheduleMessagePumpWork), and at
        // least every 20 ms; then the window's own turn.
        cx.spawn(async move |cx| {
            let mut worked = Instant::now();

            loop {
                cx.background_executor().timer(Duration::from_millis(4)).await;

                if browser::work_due(worked, Duration::from_millis(20)) {
                    browser::work_done();
                    cef::do_message_loop_work();
                    worked = Instant::now();
                }

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
