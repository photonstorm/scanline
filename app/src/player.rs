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
use crate::device::{self, Size};
use crate::icons::icon;
use crate::projects::{self, Project};
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
        ToggleMute,
        ShowProjects,
        ChooseSize,
        LeaveFullscreen,
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
    // The local date and time, as the system's own screenshots are named.
    let stamp = std::process::Command::new("date")
        .arg("+%Y-%m-%d at %H.%M.%S")
        .output()
        .ok()
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .filter(|stamp| !stamp.is_empty())
        .unwrap_or_else(|| std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|since| since.as_secs().to_string()).unwrap_or_default());
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
    /// A capture's events, a page at a time: the capture, and the cursor of the page.
    DrawList(String, u64),
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
    /// The page given a size (emulate), or its own again.
    Sized,
    /// Every attachment of a draw's target, after it.
    Attachments(String, i64),
    /// GPU time by draw for a capture (profile).
    Profile(String),
    /// The magnifier's region after the draw (false) or before it (true), and what changed.
    Magnified(u64, bool),
    MagnifiedDiff(u64),
    /// A picture of a pass's target as the pass left it; its depth, for a target with no colour.
    PassPicture(String, i64, i64, String),
    PassDepth(String, i64),
    /// A picture of the game for the projects page, by its key.
    Picture(String),
    /// The watches' values and history, for the Objects tab.
    Watches,
}

impl Purpose {
    /// Polls of one kind are not stacked: a new one waits for the last.
    fn poll_key(&self) -> Option<&'static str> {
        Some(match self {
            Purpose::Status => "status",
            Purpose::Stats => "stats",
            Purpose::Memory => "memory",
            Purpose::Watches => "watches",
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
            Purpose::Picture(_) => "picture",
            _ => return None,
        })
    }
}

pub struct Player {
    pub focus: FocusHandle,
    /// The note sent with Send to agent, and whether it has the keyboard.
    pub note_focus: FocusHandle,
    /// The Objects tab's fields: a new watch, or a watched value being set.
    pub watch_focus: FocusHandle,
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
    /// The games opened in the app, newest first (projects.rs), and the one in the window, by
    /// projects::key ("" for a page of the app's own).
    pub projects: Vec<Project>,
    game_key: String,
    /// The game's sound off, as the person left it for this game.
    pub muted: bool,
    /// The size the page is given in place of its view's own (device.rs), and whether the
    /// chooser is open.
    pub size: Option<Size>,
    pub choosing_size: bool,
    /// What the page was last given: the game area it was fitted to, and the size.
    sized_for: Option<((f32, f32), Option<Size>)>,
    /// When the game's picture is next taken, for the projects page.
    picture_due: Option<Instant>,
    /// The page has an element fullscreen (in the game's view; Esc leaves).
    pub fullscreen: bool,
    /// The game has the pointer (its stand-in lock): the cursor is held until Esc.
    pub pointer_held: bool,
    /// The tab chosen in each panel that has tabs, by the panel's id.
    pub tabs: HashMap<&'static str, usize>,
}

impl Player {
    fn new(options: Options, gpui_view: *mut c_void, cx: &mut Context<Self>) -> Self {
        let host = HostLink::open(&options.home);
        let projects = projects::load(&options.home);
        let recent = recent_of(&projects);
        let panel_width = load_layout(&options.home);

        Player {
            focus: cx.focus_handle(),
            note_focus: cx.focus_handle(),
            watch_focus: cx.focus_handle(),
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
            projects,
            game_key: String::new(),
            muted: false,
            size: None,
            choosing_size: false,
            sized_for: None,
            picture_due: None,
            fullscreen: false,
            pointer_held: false,
            tabs: HashMap::new(),
        }
    }

    /// The tab chosen in a panel (0 until one is chosen).
    pub fn tab(&self, panel: &str) -> usize {
        self.tabs.get(panel).copied().unwrap_or(0)
    }

    pub fn set_tab(&mut self, panel: &'static str, index: usize) {
        self.tabs.insert(panel, index);
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
                | Purpose::Sized
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

        if self.panel == Panel::Live && self.tab("live") == 2 && self.due("watches", Duration::from_millis(250)) {
            self.ask("watches", json!({ "history": 120 }), Purpose::Watches);
        }

        if self.panel == Panel::Live && self.due("memory", Duration::from_millis(1500)) {
            self.ask("memory", json!({}), Purpose::Memory);
        }

        if self.panel == Panel::Captures && self.due("captures", Duration::from_millis(2000)) {
            self.ask("captures", json!({ "limit": 100 }), Purpose::Captures);
        }

        // A long job's progress, while one is under way: in the foreground, or a capture
        // finishing in the background.
        if self.pending.values().any(|purpose| matches!(purpose, Purpose::Capture | Purpose::VideoStop)) || self.busy["capture"].is_string() {
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

        // Pictures of the textures the chosen draw has bound, for its bound-resources table.
        if self.panel == Panel::Captures && !self.polling.contains("thumbnails") {
            let wanted: Vec<String> =
                self.captures.bound_textures().into_iter().filter(|handle| !self.resources.thumbs.contains_key(handle)).take(4).collect();

            if !wanted.is_empty() {
                for handle in &wanted {
                    self.resources.thumbs.insert(handle.clone(), panels::resources::Thumb::Waiting);
                }

                self.ask("thumbnails", json!({ "handles": wanted, "max_edge": 128 }), Purpose::Thumbnails);
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
            (Purpose::Watches, Ok(value)) => self.live.watches = value["data"].clone(),
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
                    // A quick capture still bringing its textures: progress is followed until
                    // it is done.
                    if value["data"]["finishing"].is_object() {
                        self.busy = json!({ "capture": capture, "stage": "Fetching textures" });
                    }

                    self.captures.made(&value["data"]);
                    self.open_capture(capture.to_string(), cx);
                }
            }
            (Purpose::DrawList(capture, cursor), Ok(value)) => {
                let data = &value["data"];

                // The rest, a page at a time; the draw to show and the passes' pictures once
                // the list is whole.
                if let Some(next) = data["next_cursor"].as_u64() {
                    self.captures.page(&capture, data, cursor == 0);
                    self.ask("draw_list", json!({ "capture": capture, "limit": 200, "cursor": next }), Purpose::DrawList(capture.clone(), next));
                    return;
                }

                self.captures.page(&capture, data, cursor == 0);

                let first = self.captures.events(&capture);

                // A picture of each pass's target, for the navigator.
                for (pass, last, target) in self.captures.wanted_pass_pictures() {
                    self.ask(
                        "screenshot",
                        json!({ "capture": capture, "at_draw": last, "target": target, "max_edge": 200 }),
                        Purpose::PassPicture(capture.clone(), pass, last, target.clone()),
                    );
                }

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
            (Purpose::Progress, Ok(value)) => {
                let finishing = self.busy["capture"].as_str().map(str::to_string);
                let busy = value["data"]["busy"].clone();

                // A capture finished in the background: what it now knows (each draw's effect,
                // the replay check) is shown.
                if let Some(capture) = finishing.filter(|capture| busy["capture"].as_str() != Some(capture.as_str())) {
                    if self.captures.opened.as_deref() == Some(capture.as_str()) {
                        self.ask("draw_list", json!({ "capture": capture, "limit": 200 }), Purpose::DrawList(capture.clone(), 0));

                        // The draw in view, with its effect now.
                        if let Some(draw) = self.captures.selected {
                            self.ask("draw", json!({ "capture": capture, "draw": draw }), Purpose::Draw(capture.clone(), draw));
                        }
                    }

                    self.last.remove("captures");
                }

                self.busy = busy;
            }
            (Purpose::Thumbnails, Ok(value)) => self.resources.got_thumbs(&value["data"]),
            (Purpose::Shot, Ok(value)) => {
                let path = value["images"][0]["original"].as_str().or(value["images"][0]["view"].as_str()).map(PathBuf::from);

                match path.as_deref().and_then(|path| to_desktop(path, "screenshot")) {
                    Some(saved) => self.say(
                        &format!("Saved {}", saved.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_default()),
                        false,
                    ),
                    None => self.say("Could not save the screenshot to the desktop.", true),
                }
            }
            (Purpose::Magnified(seq, before), Ok(value)) => self.magnified(seq, before, &value),
            (Purpose::MagnifiedDiff(seq), Ok(value)) => self.magnified_diff(seq, &value),
            (Purpose::Magnified(seq, _), Err(error)) | (Purpose::MagnifiedDiff(seq), Err(error)) => {
                if let Some(magnifier) = self.captures.magnifier.as_mut().filter(|magnifier| magnifier.seq == seq) {
                    magnifier.error = Some(error);
                }
            }
            (Purpose::Profile(capture), Ok(value)) => self.captures.got_timing(&capture, &value["data"]),
            (Purpose::Profile(capture), Err(error)) => {
                if self.captures.opened.as_deref() == Some(capture.as_str()) {
                    self.captures.measuring = false;
                }

                self.say(&format!("Timing failed: {error}"), true);
            }
            (Purpose::Attachments(capture, draw), Ok(value)) => self.captures.got_attachments(&capture, draw, &value["data"]),
            (Purpose::Attachments(capture, draw), Err(error)) => {
                self.captures.got_attachments(&capture, draw, &json!({ "attachments": [{ "attachment": "Attachments", "handle": "", "error": error }] }))
            }
            (Purpose::PassPicture(capture, pass, _, _), Ok(value)) | (Purpose::PassDepth(capture, pass), Ok(value)) => {
                self.captures.got_pass_picture(&capture, pass, &value)
            }
            // A shadow map's pass, say: no colour to read, so its depth.
            (Purpose::PassPicture(capture, pass, last, target), Err(_)) => {
                self.ask("view", json!({ "capture": capture, "view": "depth", "at_draw": last, "target": target }), Purpose::PassDepth(capture, pass));
            }
            (Purpose::Picture(key), Ok(value)) => {
                let made = value["images"][0]["view"].as_str().or(value["images"][0]["original"].as_str()).map(PathBuf::from);
                let folder = projects::pictures(&self.options.home);
                let name = projects::picture_name(&key);

                if let Some(made) = made {
                    let _ = std::fs::create_dir_all(&folder);

                    if std::fs::copy(&made, folder.join(&name)).is_ok() {
                        let url = self.projects.iter().find(|project| projects::key(&project.url) == key).map(|project| project.url.clone());

                        if let Some(url) = url {
                            projects::touch(&mut self.projects, &url, false).picture = Some(name);
                            self.projects_changed();
                        }
                    }
                }
            }
            // The size button and status bar show it.
            (Purpose::Sized, Ok(_)) => {}
            (Purpose::Sized, Err(error)) => {
                self.sized_for = None;
                self.size = None;
                self.say(&error, true);
            }
            (Purpose::VideoStart, Ok(_)) => self.say("Recording", false),
            (Purpose::VideoStop, Ok(value)) => match value["data"]["video"].as_str().map(PathBuf::from).as_deref().and_then(|path| to_desktop(path, "video")) {
                Some(saved) => self.say(
                    &format!("Saved {}", saved.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_default()),
                    false,
                ),
                None => self.say(value["summary"].as_str().unwrap_or("No video.").lines().next().unwrap_or(""), true),
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
                | Purpose::DrawList(..)
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

        // A file's path, as typed or dropped, is a file:// address; anything else without a
        // scheme is a web address.
        if address.starts_with('/') {
            address = projects::file_url(std::path::Path::new(&address));
        } else if !address.contains("://") && !address.starts_with("about:") {
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
        self.say("Capturing…", false);
        // Quick: the capture opens once its calls and state are in, and its textures follow
        // in the background (the progress card says how far).
        self.ask("capture", json!({ "quick": true }), Purpose::Capture);
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
        self.say(&format!("Capturing frame {frame}…"), false);
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
            self.say("Saving the video…", false);
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
        self.say(&format!("{shader} opened. Save to apply."), false);
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
        self.ask("draw_list", json!({ "capture": capture, "limit": 200 }), Purpose::DrawList(capture, 0));
    }

    /// A box dragged on the capture's picture: a short one is a click (the pixel's history),
    /// a larger one is magnified.
    pub fn finish_drag(&mut self) {
        let Some(region) = self.captures.dragged() else { return };
        let start = self.captures.drag.map(|(start, _)| start);

        self.captures.drag = None;

        match region {
            (_, _, w, h) if w <= 2 && h <= 2 => {
                if self.captures.enlarged.is_none() {
                    if let Some(pixel) = start {
                        self.pick_pixel(pixel);
                    }
                }
            }
            region => self.magnify(region),
        }
    }

    /// Magnifies a region of the chosen draw's target (or of the attachment shown large): as
    /// the draw left it, as it was before, and what it changed, by the host's screenshot and
    /// diff, as an agent would ask for them.
    pub fn magnify(&mut self, (x, y, w, h): (u32, u32, u32, u32)) {
        let (Some(capture), Some(draw)) = (self.captures.opened.clone(), self.captures.selected) else { return };
        let enlarged = self.captures.enlarged.and_then(|index| self.captures.attachments.as_ref()?["attachments"][index]["handle"].as_str().map(str::to_string));
        let target = enlarged
            .or_else(|| self.captures.draw.as_ref().and_then(|draw| draw["state"]["targetName"].as_str().map(str::to_string)))
            .unwrap_or_else(|| "canvas".into());
        // At most 128 a side, enlarged to about 480 points, never past the host's 2,048.
        let (w, h) = (w.clamp(1, 128), h.clamp(1, 128));
        let zoom = (480 / w.max(h)).clamp(1, 32).min(2048 / w.max(h));
        let seq = self.captures.next_magnifier + 1;

        self.captures.next_magnifier = seq;
        self.captures.magnifier = Some(panels::captures::Magnifier {
            seq,
            draw,
            target: target.clone(),
            region: (x, y, w, h),
            zoom,
            after: None,
            before: None,
            changed: None,
            summary: None,
            unchanged: false,
            showing: panels::captures::Showing::After,
            hover: None,
            error: None,
            place: Default::default(),
        });

        let shot = |at: i64| json!({ "capture": capture, "at_draw": at, "target": target, "region": { "x": x, "y": y, "w": w, "h": h }, "zoom": zoom, "grid": zoom >= 8 });

        self.ask("screenshot", shot(draw), Purpose::Magnified(seq, false));

        if draw > 0 {
            self.ask("screenshot", shot(draw - 1), Purpose::Magnified(seq, true));
        }
    }

    /// One of the magnifier's pictures arrived; with both, what changed between them.
    fn magnified(&mut self, seq: u64, before: bool, value: &Value) {
        let Some(magnifier) = self.captures.magnifier.as_mut().filter(|magnifier| magnifier.seq == seq) else { return };
        let image = &value["images"][0];
        let (Some(view), Some(original)) = (image["view"].as_str(), image["original"].as_str()) else { return };
        let shot = panels::captures::Shot {
            view: PathBuf::from(view),
            original: PathBuf::from(original),
            pixels: ::image::open(original).ok().map(|picture| picture.to_rgba8()),
        };

        if before {
            magnifier.before = Some(shot);
        } else {
            magnifier.after = Some(shot);
        }

        let pair = match (&magnifier.before, &magnifier.after) {
            (Some(before), Some(after)) => Some((before.original.clone(), after.original.clone())),
            _ => None,
        };

        if magnifier.draw == 0 && magnifier.after.is_some() {
            magnifier.summary = Some("First event: nothing to compare.".into());
        }

        if let Some((a, b)) = pair {
            self.ask("diff", json!({ "a": a.display().to_string(), "b": b.display().to_string() }), Purpose::MagnifiedDiff(seq));
        }
    }

    /// What changed: the host's heat map, enlarged as the pictures are, with no smoothing.
    fn magnified_diff(&mut self, seq: u64, value: &Value) {
        let folder = self.options.home.join("magnifier");
        let Some(magnifier) = self.captures.magnifier.as_mut().filter(|magnifier| magnifier.seq == seq) else { return };

        let identical = value["data"]["changed"].as_u64() == Some(0) || value["summary"].as_str().is_some_and(|summary| summary.starts_with("No difference"));

        magnifier.summary = if identical {
            Some("No change".into())
        } else {
            value["summary"].as_str().and_then(|summary| summary.lines().next()).map(|line| {
                // "a.png against b.png (20×20): 200 of 400 pixels differ (50.00%)." → from the counts.
                let counts = line.split_once("): ").map(|(_, counts)| counts.to_string()).unwrap_or_else(|| line.to_string());

                counts
            })
        };
        magnifier.unchanged = identical;

        let heat = value["images"][0]["original"].as_str().and_then(|path| ::image::open(path).ok());

        if let Some(heat) = heat {
            let zoom = magnifier.zoom.max(1);
            let large = ::image::imageops::resize(&heat.to_rgba8(), heat.width() * zoom, heat.height() * zoom, ::image::imageops::FilterType::Nearest);
            let _ = std::fs::create_dir_all(&folder);
            let path = folder.join(format!("changed-{seq}.png"));

            if large.save(&path).is_ok() {
                magnifier.changed = Some(path);
            }
        }
    }

    /// Times every draw of the open capture on the GPU, for its timeline.
    pub fn measure_capture(&mut self) {
        let Some(capture) = self.captures.opened.clone() else { return };

        if !self.captures.measuring {
            self.captures.measuring = true;
            self.ask("profile", json!({ "capture": capture, "top": 10 }), Purpose::Profile(capture));
        }
    }

    pub fn select_draw(&mut self, draw: i64, _cx: &mut Context<Self>) {
        let Some(capture) = self.captures.opened.clone() else { return };

        self.captures.select(draw);
        // now: its state at once, while a capture finishes; its effect when it has.
        self.ask("draw", json!({ "capture": capture, "draw": draw, "now": true }), Purpose::Draw(capture.clone(), draw));
        self.ask("attachments", json!({ "capture": capture, "draw": draw, "max_edge": 480 }), Purpose::Attachments(capture.clone(), draw));
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
        if !projects::worth_keeping(url) {
            return;
        }

        projects::touch(&mut self.projects, url, true);
        self.projects_changed();
    }

    fn projects_changed(&mut self) {
        projects::save(&self.options.home, &self.projects);

        let recent = recent_of(&self.projects);

        if recent != self.recent {
            self.recent = recent;
            self.menus_stale = true;
        }
    }

    /// The window shows another page: the game it is, what is remembered for it put back
    /// (its sound, its size), and a picture of it due.
    fn arrived(&mut self, url: &str) {
        let key = if projects::worth_keeping(url) { projects::key(url) } else { String::new() };

        if key == self.game_key {
            return;
        }

        self.game_key = key.clone();

        // A new page cannot have the pointer the last one took.
        if self.pointer_held {
            platform::hold_pointer(false);
            self.pointer_held = false;
        }

        if key.is_empty() {
            self.muted = false;
            self.size = None;
            self.picture_due = None;
        } else {
            let project = projects::touch(&mut self.projects, url, true);
            let (muted, size) = (project.muted, project.size.as_deref().and_then(Size::from_name));

            self.muted = muted;
            self.size = size;
            self.picture_due = Some(Instant::now() + Duration::from_secs(6));
            self.projects_changed();
        }

        self.apply_mute();
    }

    fn apply_mute(&self) {
        if let Some(host) = self.browser.as_ref().and_then(|browser| browser.host()) {
            host.set_audio_muted(self.muted as i32);
        }
    }

    /// The game's sound off or on, remembered for this game.
    pub fn toggle_mute(&mut self) {
        self.muted = !self.muted;
        self.apply_mute();

        if !self.game_key.is_empty() {
            let url = self.projects.iter().find(|project| projects::key(&project.url) == self.game_key).map(|project| project.url.clone());

            if let Some(url) = url {
                projects::touch(&mut self.projects, &url, false).muted = self.muted;
                self.projects_changed();
            }
        }

        self.say(if self.muted { "Muted" } else { "Sound on" }, false);
    }

    /// The page given a size (or its own again), remembered for this game.
    pub fn set_size(&mut self, size: Option<Size>) {
        self.size = size;
        self.choosing_size = false;

        if !self.game_key.is_empty() {
            let url = self.projects.iter().find(|project| projects::key(&project.url) == self.game_key).map(|project| project.url.clone());

            if let Some(url) = url {
                projects::touch(&mut self.projects, &url, false).size = size.map(|size| size.name());
                self.projects_changed();
            }
        }
    }

    /// Gives the page its size again when the size or the game area has changed.
    fn keep_size(&mut self) {
        let Some(bounds) = self.game.get() else { return };
        let area = (f32::from(bounds.size.width), f32::from(bounds.size.height));
        let same = |(old, size): &((f32, f32), Option<Size>)| *size == self.size && (old.0 - area.0).abs() < 2.0 && (old.1 - area.1).abs() < 2.0;

        if self.browser.is_none() || self.sized_for.as_ref().is_some_and(same) || (self.sized_for.is_none() && self.size.is_none()) {
            return;
        }

        // While the divider is dragged, not every step of the way.
        if !self.due("size", Duration::from_millis(150)) {
            return;
        }

        self.last.insert("size", Instant::now());
        self.sized_for = Some((area, self.size));

        match self.size {
            Some(size) => self.ask("emulate", size.emulate(area), Purpose::Sized),
            None => {
                self.sized_for = None;
                self.ask("emulate", json!({ "reset": true }), Purpose::Sized);
            }
        }
    }

    /// The projects page: every game opened, with a picture of each.
    pub fn show_projects(&mut self) {
        let me = std::env::current_exe().unwrap_or_default();

        match projects::start_page(&self.options.home, &me) {
            Some(page) => {
                self.editing = false;
                self.address.clear();
                self.ask("navigate", json!({ "url": projects::file_url(&page) }), Purpose::Action("navigate"));
            }
            None => self.say("Projects page missing: reinstall Scanline.", true),
        }
    }

    /// A picture of the game now and then, for its card on the projects page.
    fn keep_picture(&mut self) {
        if self.browser.is_none() || self.game_key.is_empty() || !self.picture_due.is_some_and(|due| Instant::now() >= due) {
            return;
        }

        self.picture_due = Some(Instant::now() + Duration::from_secs(90));
        self.ask("screenshot", json!({ "max_edge": 640 }), Purpose::Picture(self.game_key.clone()));
    }

    /// Esc while the page has the pointer or the screen: it gets them back, as in Chrome.
    pub fn leave_fullscreen(&mut self) {
        if let Some(browser) = self.browser.as_ref() {
            browser::release(browser);
        }
    }

    // ── Each turn of the message pump ───────────────────────────────────────────────────

    fn tick(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let mut changed = false;
        let mut created = None;
        let mut ready = false;
        let mut closed = false;
        let mut arrived = None;
        let mut pointer = None;

        browser::INBOX.with(|inbox| {
            let mut inbox = inbox.borrow_mut();

            ready = inbox.context_ready;
            created = inbox.created.take();
            closed = inbox.closed;

            if let Some(title) = inbox.title.take() {
                self.title = title.into();
                changed = true;
            }

            if let Some(held) = inbox.pointer.take() {
                pointer = Some(held);
            }

            if let Some(fullscreen) = inbox.fullscreen.take() {
                self.fullscreen = fullscreen;
                changed = true;
            }

            if let Some(address) = inbox.address.clone() {
                arrived = Some(address);
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
            self.apply_mute();
            changed = true;
        }

        if let Some(url) = arrived {
            self.arrived(&url);
        }

        // The game's title, for its card on the projects page.
        if !self.game_key.is_empty() && !self.title.is_empty() {
            let title = self.title.to_string();
            let key = self.game_key.clone();

            if let Some(project) = self.projects.iter_mut().find(|project| projects::key(&project.url) == key && project.title != title) {
                project.title = title;
                self.projects_changed();
            }
        }

        self.keep_size();
        self.keep_picture();

        // The game took the pointer or let it go. The cursor is held only while the window is
        // in front, and never kept from the person when it is not.
        match pointer {
            Some(true) if window.is_window_active() => {
                platform::hold_pointer(true);
                self.pointer_held = true;
                changed = true;
            }
            Some(true) => self.leave_fullscreen(),
            Some(false) => {
                platform::hold_pointer(false);
                self.pointer_held = false;
                changed = true;
            }
            None => {}
        }

        if self.pointer_held && !window.is_window_active() {
            self.leave_fullscreen();
            self.pointer_held = false;
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
            "mute" => self.toggle_mute(),
            "timeline" => self.measure_capture(),
            // tab captures 1: a panel's tab by number, from 0.
            "tab" => {
                let mut words = rest.split_whitespace();

                if let (Some(panel), Some(index)) = (words.next(), words.next().and_then(|word| word.parse::<usize>().ok())) {
                    let panel: &'static str = match panel {
                        "live" => "live",
                        "captures" => "captures",
                        "experiments" => "experiments",
                        _ => "game",
                    };

                    self.set_tab(panel, index);
                }
            }
            // magnify x y w h: a region of the chosen draw's target, as a drag would.
            "magnify" => {
                let numbers: Vec<u32> = rest.split_whitespace().filter_map(|word| word.parse().ok()).collect();

                if let [x, y, w, h] = numbers[..] {
                    self.magnify((x, y, w, h));
                }
            }
            "showing" => {
                if let Some(magnifier) = self.captures.magnifier.as_mut() {
                    magnifier.showing = match rest {
                        "before" => panels::captures::Showing::Before,
                        "changed" => panels::captures::Showing::Changed,
                        _ => panels::captures::Showing::After,
                    };
                }
            }
            "projects" => self.show_projects(),
            "release" => self.leave_fullscreen(),
            "sizes" => self.choosing_size = !self.choosing_size,
            // size 1080p @2x, size iPhone 15 landscape, size fit
            "size" => self.set_size(Size::from_name(rest)),
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

    /// Starts typing into one of the Objects tab's fields, with what it holds now.
    pub fn start_watch_entry(&mut self, entry: panels::live::Entry, current: String, window: &mut Window, cx: &mut Context<Self>) {
        self.live.entry = Some(entry);
        self.live.typed = current;
        self.editing = false;
        self.noting = false;
        platform::focus(self.gpui_view);
        window.focus(&self.watch_focus);
        cx.notify();
    }

    pub fn type_watch(&mut self, event: &KeyDownEvent, cx: &mut Context<Self>) {
        let keystroke = &event.keystroke;

        if self.live.entry.is_none() {
            return;
        }

        if keystroke.modifiers.platform {
            match keystroke.key.as_str() {
                "v" => {
                    if let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) {
                        self.live.typed.push_str(text.trim());
                    }
                }
                "a" | "backspace" => self.live.typed.clear(),
                _ => return,
            }
        } else {
            match keystroke.key.as_str() {
                "enter" => self.commit_watch_entry(),
                "escape" => {
                    self.live.entry = None;
                    self.live.typed.clear();
                    platform::focus(self.browser_view);
                }
                "backspace" => {
                    self.live.typed.pop();
                }
                _ => {
                    if let Some(text) = &keystroke.key_char {
                        if self.live.typed.chars().count() < 400 {
                            self.live.typed.push_str(text);
                        }
                    }
                }
            }
        }

        cx.stop_propagation();
        cx.notify();
    }

    /// Adds the watch typed, or sets the value typed.
    pub fn commit_watch_entry(&mut self) {
        let typed = std::mem::take(&mut self.live.typed);

        match self.live.entry.take() {
            Some(panels::live::Entry::Value { name, prop }) => {
                self.ask("watch_set", json!({ "name": name, "prop": prop, "value": panels::live::typed_value(&typed) }), Purpose::Action("watch_set"));
            }
            _ if !typed.trim().is_empty() => {
                self.ask("watch", json!({ "expression": typed.trim(), "break": self.live.break_new }), Purpose::Action("watch"));
            }
            _ => {}
        }

        // Read again at once, not at the next turn.
        self.last.remove("watches");
        platform::focus(self.browser_view);
    }

    pub fn remove_watch(&mut self, name: &str) {
        self.ask("unwatch", json!({ "name": name }), Purpose::Action("unwatch"));
        self.last.remove("watches");
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

/// The Open Recent menu: the last ten games.
fn recent_of(projects: &[Project]) -> Vec<String> {
    projects.iter().filter(|project| projects::worth_keeping(&project.url)).take(10).map(|project| project.url.clone()).collect()
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
        let sizes = self.size_card(cx);

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
                        .children(sizes)
                        .children(progress)
                        .child(div().flex_1().min_h_0().child(panels::render(self, window, cx))),
                ),
            )
            .child(self.status_bar())
    }
}

/// A capture's stages as the host names them: each with its share of a typical capture's time
/// (spider's, on the Mac's release build) and its typical length in seconds.
const CAPTURE_STAGES: &[(&str, f32, f32)] = &[
    ("Waiting for a frame", 0.03, 0.5),
    ("Reading textures and buffers", 0.04, 0.5),
    ("Fetching data", 0.30, 4.0),
    ("Reading the picture", 0.01, 0.1),
    ("Loading the replay", 0.30, 3.5),
    ("Checking the replay", 0.06, 0.8),
    ("Measuring draws", 0.24, 3.5),
    ("Building tables", 0.01, 0.1),
    ("Writing", 0.01, 0.1),
];

/// What a quick capture does in the background, likewise.
const FINISHING_STAGES: &[(&str, f32, f32)] = &[
    ("Fetching textures", 0.36, 4.0),
    ("Loading the replay", 0.30, 3.5),
    ("Checking the replay", 0.07, 0.8),
    ("Measuring draws", 0.25, 3.5),
    ("Building tables", 0.01, 0.1),
    ("Writing", 0.01, 0.1),
];

/// How far a long job has got, from 0 to 1: the stages done, and the one under way by its own
/// count ("120 of 313 MB") or, where it gives none, by its time against a typical one, so the
/// bar never stands still.
fn progress_fraction(busy: &Value, stages: &[(&str, f32, f32)]) -> f32 {
    let total: f32 = stages.iter().map(|(_, share, _)| share).sum::<f32>().max(f32::EPSILON);
    let done: Vec<&str> = busy["done"].as_array().into_iter().flatten().filter_map(|stage| stage["stage"].as_str()).collect();
    let finished: f32 = stages.iter().filter(|(name, _, _)| done.contains(name)).map(|(_, share, _)| share).sum();
    let current = busy["stage"].as_str().unwrap_or("");
    let within = busy["detail"]
        .as_str()
        .and_then(|detail| detail.trim_end_matches(" MB").split_once(" of "))
        .and_then(|(have, all)| Some(have.trim().parse::<f32>().ok()? / all.trim().parse::<f32>().ok()?.max(1.0)))
        .unwrap_or_else(|| {
            let typical = stages.iter().find(|(name, _, _)| *name == current).map_or(1.0, |(_, _, seconds)| *seconds);
            let elapsed = busy["stage_seconds"].as_f64().unwrap_or(0.0) as f32;

            0.95 * (1.0 - (-elapsed / typical.max(0.1)).exp())
        });
    let share = stages.iter().find(|(name, _, _)| *name == current).map_or(0.0, |(_, share, _)| *share);

    ((finished + share * within.clamp(0.0, 1.0)) / total).clamp(0.02, 0.98)
}

impl Player {
    /// The sizes the game can be given, open from the toolbar's size button. Chromium's view
    /// covers the game area, so the chooser is drawn over the panels.
    fn size_card(&self, cx: &mut Context<Self>) -> Option<gpui::Div> {
        if !self.choosing_size {
            return None;
        }

        let current = self.size;
        let area = self.game.get().map(|bounds| (f32::from(bounds.size.width), f32::from(bounds.size.height))).unwrap_or((800.0, 600.0));
        let retina = current.is_some_and(|size| size.retina);
        let landscape = current.is_some_and(|size| size.landscape);
        let chip = |id: String, label: String, on: bool, colour: u32| {
            button(SharedString::from(id), label, if on { colour } else { TEXT }).when(on, |button| button.bg(tint(colour, 0.25)).border_color(tint(colour, 0.9)))
        };

        let mut card = card("Size", AMBER)
            .child(
                div().flex().flex_wrap().gap_1().child(chip("size-fit".into(), "Fit".into(), current.is_none(), AMBER).on_click(cx.listener(|this, _, _, cx| {
                    this.set_size(None);
                    cx.notify();
                }))),
            );

        for group in ["Desktop", "Phone", "Tablet"] {
            let mut chips = div().flex().flex_wrap().gap_1();

            for (index, preset) in device::PRESETS.iter().enumerate().filter(|(_, preset)| preset.group == group) {
                let on = current.is_some_and(|size| size.preset == index);
                let chosen = Size { preset: index, retina, landscape };
                let label = if preset.mobile { preset.name.to_string() } else { format!("{} {}×{}", preset.name, preset.width, preset.height) };

                chips = chips.child(chip(format!("size-{index}"), label, on, AMBER).on_click(cx.listener(move |this, _, _, cx| {
                    this.choosing_size = true;
                    this.set_size(Some(chosen));
                    cx.notify();
                })));
            }

            card = card.child(div().text_xs().text_color(rgb(DIM)).mt_1().child(group)).child(chips);
        }

        let toggles = div()
            .flex()
            .gap_1()
            .mt_1()
            .child(chip("size-retina".into(), "Retina".into(), retina, CYAN).on_click(cx.listener(|this, _, _, cx| {
                if let Some(size) = this.size.filter(|size| !size.preset().mobile) {
                    this.set_size(Some(Size { retina: !size.retina, ..size }));
                    this.choosing_size = true;
                }

                cx.notify();
            })))
            .child(chip("size-landscape".into(), "Landscape".into(), landscape, CYAN).on_click(cx.listener(|this, _, _, cx| {
                if let Some(size) = this.size.filter(|size| size.preset().mobile) {
                    this.set_size(Some(Size { landscape: !size.landscape, ..size }));
                    this.choosing_size = true;
                }

                cx.notify();
            })))
            .child(div().flex_1())
            .child(button("size-done", "Done", DIM).on_click(cx.listener(|this, _, _, cx| {
                this.choosing_size = false;
                cx.notify();
            })));

        card = card.child(toggles);

        if let Some(size) = current {
            card = card.child(row("Now", size.detail(area)));
        }

        Some(div().p_2().child(card))
    }

    /// A long job under way: what it is doing, how long it has taken, and its stages so far.
    fn progress_card(&self) -> Option<gpui::Div> {
        let capturing = self.pending.values().any(|purpose| matches!(purpose, Purpose::Capture));
        let saving = self.pending.values().any(|purpose| matches!(purpose, Purpose::VideoStop));

        if !capturing && !saving {
            return self.finishing_card();
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
        // A capture still finishing in the background has stages of its own.
        let stages = if busy["capture"].is_string() { FINISHING_STAGES } else { CAPTURE_STAGES };
        let fraction = if saving { ((done.len() as f32 + 0.5) / 4.0).min(0.97) } else { progress_fraction(busy, stages) };
        let title = if saving { "Saving video" } else { "Capturing" };

        Some(
            div().p_2().child(
                card(format!("{title} · {seconds:.0} s"), PURPLE)
                    .child(meter(40, fraction, PURPLE))
                    .child(div().text_sm().text_color(rgb(TEXT)).child(format!("{stage}{detail}…")))
                    .children(done.into_iter().filter(|(_, ms)| *ms >= 50.0).map(|(stage, ms)| row(format!("✓ {stage}"), format!("{:.1} s", ms / 1000.0)))),
            ),
        )
    }

    /// A capture finishing in the background: its textures on their way, then its replay.
    fn finishing_card(&self) -> Option<gpui::Div> {
        let busy = &self.busy;
        let capture = busy["capture"].as_str()?;
        let stage = busy["stage"].as_str().unwrap_or("Fetching textures");
        let detail = busy["detail"].as_str().unwrap_or("");
        let done = busy["done"].as_array().map_or(0, Vec::len);
        let fraction = progress_fraction(busy, FINISHING_STAGES);
        let what = if done == 0 { "Textures" } else { "Replay" };
        let detail = if detail.is_empty() { String::new() } else { format!(" ({detail})") };

        Some(
            div().p_2().child(
                card(format!("{what} · {capture} · {:.0} s", busy["seconds"].as_f64().unwrap_or(0.0)), CYAN)
                    .child(meter(40, fraction, CYAN))
                    .child(div().text_sm().text_color(rgb(TEXT)).child(format!("{stage}{detail}…"))),
            ),
        )
    }

    fn toolbar(&mut self, cx: &mut Context<Self>) -> impl IntoElement {
        let paused = self.paused();
        let scale = self.time_scale();
        let human = self.status["owner"] == "human";
        let request = self.status["request"]["instruction"].as_str().map(str::to_string);
        let shown = if self.address.is_empty() && !self.editing { "Address".to_string() } else { self.address.clone() };
        let running = self.video_running();
        let seconds = self.status["video_seconds"].as_f64().unwrap_or(0.0);
        let capturing = self.pending.values().any(|purpose| matches!(purpose, Purpose::Capture)) || self.busy["capture"].is_string();

        div()
            .flex()
            .flex_none()
            .items_center()
            .gap_2()
            .h(px(TOOLBAR))
            // Room for the window's buttons, which sit over the bar on a Mac.
            .pl(px(if cfg!(target_os = "macos") { 84.0 } else { 12.0 }))
            .pr_3()
            .bg(rgb(SIDEBAR))
            .border_b_1()
            .border_color(rgb(LINE))
            .on_mouse_down(MouseButton::Left, |event, window, _| {
                if event.click_count == 2 {
                    window.titlebar_double_click();
                } else {
                    window.start_window_move();
                }
            })
            // Where: the projects page, reload, the address.
            .child(
                group()
                    .child(icon_button("projects", "home", TEXT, false).on_click(cx.listener(|this, _, _, cx| {
                        this.show_projects();
                        cx.notify();
                    })))
                    .child(icon_button("reload", "reload", TEXT, false).on_click(cx.listener(|this, _, _, cx| {
                        this.reload();
                        cx.notify();
                    }))),
            )
            .child(
                div()
                    .id("address")
                    .track_focus(&self.focus)
                    .flex()
                    .items_center()
                    .gap_2()
                    .flex_1()
                    .min_w(px(160.0))
                    .h(px(34.0))
                    .px_2p5()
                    .rounded(px(8.0))
                    .text_sm()
                    .bg(rgb(FIELD))
                    .border_1()
                    .border_color(if self.editing { tint(BLUE, 0.8) } else { rgb(LINE) })
                    .when(self.editing, |field| field.shadow(glow(BLUE, 0.35)))
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
                    .child(icon(if self.loading { "timer" } else { "search" }, 13.0, tint(DIM, 1.0)))
                    .child(div().overflow_hidden().child(format!("{shown}{}", if self.editing { "▏" } else { "" }))),
            )
            // Time: run or pause, step, speed.
            .child(
                group()
                    .child(icon_button("pause", if paused { "play" } else { "pause" }, GREEN, paused).on_click(cx.listener(|this, _, _, cx| {
                        this.toggle_pause();
                        cx.notify();
                    })))
                    .child(icon_button("step", "step", GREEN, false).on_click(cx.listener(|this, _, _, cx| {
                        this.step(1);
                        cx.notify();
                    })))
                    .child(tool_button("scale", "speed", format!("{}×", trim(scale)), CYAN, (scale - 1.0).abs() > 1e-6).on_click(cx.listener(|this, _, _, cx| {
                        let next = match this.time_scale() {
                            s if s < 0.3 => 0.5,
                            s if s < 0.6 => 1.0,
                            s if s < 1.5 => 2.0,
                            _ => 0.25,
                        };

                        this.set_time_scale(next);
                        cx.notify();
                    }))),
            )
            // The game: its size, its sound.
            .child(
                group()
                    .child(
                        tool_button("size", "size", self.size.map(|size| size.name()).unwrap_or_else(|| "Fit".into()), AMBER, self.size.is_some() || self.choosing_size)
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.choosing_size = !this.choosing_size;
                                cx.notify();
                            })),
                    )
                    .child(icon_button("mute", if self.muted { "mute" } else { "sound" }, RED, self.muted).on_click(cx.listener(|this, _, _, cx| {
                        this.toggle_mute();
                        cx.notify();
                    }))),
            )
            // Looking inside: capture (the main thing), a picture, a video.
            .child(
                div()
                    .id("capture")
                    .flex()
                    .flex_none()
                    .items_center()
                    .gap_1p5()
                    .h(px(34.0))
                    .px_3()
                    .rounded(px(8.0))
                    .text_sm()
                    .font_weight(gpui::FontWeight::MEDIUM)
                    .cursor_pointer()
                    .text_color(rgb(0xffffff))
                    .bg(tint(PURPLE, if capturing { 0.55 } else { 0.32 }))
                    .border_1()
                    .border_color(tint(PURPLE, 0.85))
                    .shadow(glow(PURPLE, if capturing { 0.8 } else { 0.35 }))
                    .hover(|style| style.bg(tint(PURPLE, 0.45)))
                    .active(|style| style.bg(tint(PURPLE, 0.6)))
                    .child(icon("capture", 15.0, rgb(0xffffff)))
                    .child(if capturing { "Capturing" } else { "Capture" })
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.capture();
                        cx.notify();
                    })),
            )
            .child(
                group()
                    .child(icon_button("shot", "screenshot", BLUE, false).on_click(cx.listener(|this, _, _, cx| {
                        this.screenshot();
                        cx.notify();
                    })))
                    .child(
                        tool_button("video", "video", if running { format!("{:.0}:{:02.0}", (seconds / 60.0).floor(), seconds % 60.0) } else { "Rec".to_string() }, RED, running)
                            .when(running, |button| button.shadow(glow(RED, 0.6)))
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.toggle_video();
                                cx.notify();
                            })),
                    ),
            )
            .when_some(request, |bar, _| {
                bar.child(icon_label("debug", "flag", "Debug", RED).h(px(30.0)).shadow(glow(RED, 0.5)).on_click(cx.listener(|this, _, _, cx| {
                    this.debug();
                    cx.notify();
                })))
            })
            // Who has the input.
            .child(
                div()
                    .id("owner")
                    .flex()
                    .flex_none()
                    .items_center()
                    .gap_1p5()
                    .h(px(28.0))
                    .px_2()
                    .rounded_full()
                    .text_xs()
                    .cursor_pointer()
                    .bg(if human { tint(AMBER, 0.14) } else { rgb(FIELD) })
                    .border_1()
                    .border_color(if human { tint(AMBER, 0.6) } else { rgb(LINE) })
                    .text_color(rgb(if human { AMBER } else { DIM }))
                    .child(icon(if human { "user" } else { "agent" }, 13.0, rgb(if human { AMBER } else { DIM })))
                    .child(if human { "You" } else { "Agent" })
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.take_input(!human);
                        cx.notify();
                    })),
            )
    }

    fn status_bar(&self) -> impl IntoElement {
        let connected = self.host.connected();
        let frame = self.status["frame"].as_u64().map(|frame| format!("{frame}")).unwrap_or_default();
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
        let chip = |name: &'static str, text: String, colour: u32| {
            div()
                .flex()
                .flex_none()
                .items_center()
                .gap_1()
                .px_1p5()
                .py(px(1.0))
                .rounded(px(4.0))
                .bg(tint(colour, 0.12))
                .text_color(rgb(colour))
                .child(icon(name, 11.0, rgb(colour)))
                .child(text)
        };
        let item = |name: &'static str, text: String| div().flex().flex_none().items_center().gap_1().child(icon(name, 11.0, tint(DIM, 0.9))).child(text);

        div()
            .flex()
            .flex_none()
            .items_center()
            .gap_3()
            .px_3()
            .h(px(STATUS))
            .text_xs()
            .text_color(rgb(DIM))
            .bg(rgb(SIDEBAR))
            .border_t_1()
            .border_color(rgb(LINE))
            .child(div().size(px(7.0)).rounded_full().bg(rgb(if connected { GREEN } else { AMBER })).shadow(glow(if connected { GREEN } else { AMBER }, 0.6)))
            .child(if connected { self.options.session.clone().unwrap_or_else(|| "no session".into()) } else { "host not reachable".into() })
            .when(!frame.is_empty(), |bar| bar.child(item("timer", format!("frame {frame}")).font_family(MONO)))
            .child(state)
            .when_some(context, |bar, context| bar.child(item("program", context)))
            .child(self.status["profile"].as_str().unwrap_or("").to_string())
            .child(browser)
            .when_some(self.size.zip(self.game.get()), |bar, (size, bounds)| {
                bar.child(chip("size", format!("{} {}", size.name(), size.detail((f32::from(bounds.size.width), f32::from(bounds.size.height)))), AMBER))
            })
            .when(self.muted, |bar| bar.child(chip("mute", "muted".into(), RED)))
            .when(self.fullscreen, |bar| bar.child(chip("fullscreen", "fullscreen · Esc".into(), CYAN)))
            .when(self.pointer_held, |bar| bar.child(chip("pointer", "pointer locked · Esc".into(), CYAN)))
            .child(div().flex_1())
            .when_some(self.message.clone(), |bar, (text, error)| {
                bar.child(
                    div()
                        .flex()
                        .items_center()
                        .gap_1p5()
                        .max_w(px(560.0))
                        .overflow_hidden()
                        .whitespace_nowrap()
                        .text_color(rgb(if error { RED } else { TEXT }))
                        .child(icon(if error { "error" } else { "info" }, 11.0, rgb(if error { RED } else { DIM })))
                        .child(text),
                )
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
        opened.push(MenuItem::action("None", OpenRecent9));
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
                MenuItem::action("Projects", ShowProjects),
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
                MenuItem::action("Mute", ToggleMute),
                MenuItem::action("Size…", ChooseSize),
                MenuItem::action("Release Pointer", LeaveFullscreen),
                MenuItem::separator(),
                MenuItem::action("Pause", TogglePause),
                MenuItem::action("Step", StepFrame),
                MenuItem::action("Step 10", StepTen),
                MenuItem::action("Slower", SlowDown),
                MenuItem::action("Faster", SpeedUp),
                MenuItem::separator(),
                MenuItem::action("Capture", Capture),
                MenuItem::action("Screenshot", Screenshot),
                MenuItem::action("Record", ToggleVideo),
                MenuItem::action("Debug", Debug),
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
                MenuItem::action("Wide", ToggleWide),
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
        KeyBinding::new("cmd-shift-m", ToggleMute, None),
        KeyBinding::new("cmd-shift-h", ShowProjects, None),
        KeyBinding::new("cmd-shift-e", ChooseSize, None),
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
    cx.on_action(|_: &ToggleMute, cx| with_current(cx, |this, _| this.toggle_mute()));
    cx.on_action(|_: &ShowProjects, cx| with_current(cx, |this, _| this.show_projects()));
    cx.on_action(|_: &ChooseSize, cx| with_current(cx, |this, _| this.choosing_size = !this.choosing_size));
    cx.on_action(|_: &LeaveFullscreen, cx| with_current(cx, |this, _| this.leave_fullscreen()));
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
    let application = Application::new().with_assets(crate::icons::Assets);

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_moves_through_a_stage_by_its_count_and_never_stands_still() {
        let busy = |stage: &str, detail: &str, seconds: f64, done: &[&str]| {
            json!({ "stage": stage, "detail": detail, "stage_seconds": seconds, "done": done.iter().map(|name| json!({ "stage": name, "ms": 0 })).collect::<Vec<_>>() })
        };
        let start = progress_fraction(&busy("Loading the replay", "0 of 287 MB", 0.0, &["Fetching textures"]), FINISHING_STAGES);
        let half = progress_fraction(&busy("Loading the replay", "143 of 287 MB", 0.0, &["Fetching textures"]), FINISHING_STAGES);
        let checking = progress_fraction(&busy("Checking the replay", "", 0.4, &["Fetching textures", "Loading the replay"]), FINISHING_STAGES);
        let later = progress_fraction(&busy("Checking the replay", "", 3.0, &["Fetching textures", "Loading the replay"]), FINISHING_STAGES);

        assert!((start - 0.36).abs() < 0.01, "{start}");
        assert!((half - 0.51).abs() < 0.01, "{half}");
        assert!(checking > half && later > checking && later < 0.74, "{checking} {later}");
    }
}
