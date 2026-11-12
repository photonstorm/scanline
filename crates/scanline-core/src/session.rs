//! One debugging session: a browser, the page in it, and the probes inside the page.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use base64::Engine as _;
use scanline_browser::{Browser, LaunchOptions, Profile};
use scanline_cdp::{Client, Event};
use serde_json::{Value, json};
use tokio::sync::Notify;

/// The probe, built by `npm run build:probe` and embedded so host and probe always match.
const PROBE: &str = include_str!("../../../probe/dist/probe.js");

/// One copy of the probe: in a frame or in a worker.
#[derive(Debug, Clone, PartialEq)]
pub struct Instance {
    /// The flattened protocol session the instance is reached through.
    pub cdp_session: String,
    /// The execution context, for frames. Workers have one context and need none.
    pub context_id: Option<i64>,
    pub kind: String,
    pub top: bool,
    pub url: String,
    /// 0 for the top frame. Other frames and workers are numbered as they arrive, and the
    /// number is part of the handles of their objects (`tex_3_w2`).
    pub tag: u32,
}

/// The kinds of object the probe's registry holds, with the prefix of their handles.
pub const OBJECT_KINDS: &[(&str, &str)] = &[
    ("texture", "tex"),
    ("buffer", "buf"),
    ("shader", "shd"),
    ("program", "prg"),
    ("pipeline", "pip"),
    ("framebuffer", "fbo"),
    ("renderbuffer", "rbo"),
    ("sampler", "smp"),
    ("bind_group", "bgr"),
    ("vertex_array", "vao"),
    ("layout", "lay"),
    ("query", "qry"),
    ("bundle", "bnd"),
];

/// A live object an agent has been shown: which probe holds it, and its ID there.
#[derive(Debug, Clone)]
pub struct ObjectRef {
    pub handle: String,
    pub instance: Instance,
    pub kind: &'static str,
    pub id: i64,
}

/// A rendering context an agent can name: `ctx_3`.
#[derive(Debug, Clone)]
pub struct ContextRef {
    pub handle: String,
    pub instance: Instance,
    /// The context's ID inside its probe.
    pub local: i64,
    pub api: String,
}

/// A request to the person: an instruction, and where in the event queue it was made.
#[derive(Debug, Clone)]
pub struct Request {
    pub id: String,
    pub instruction: String,
    pub cursor: u64,
}

#[derive(Debug, Clone)]
pub struct ConsoleLine {
    pub seq: u64,
    pub level: String,
    pub text: String,
    /// Wall-clock milliseconds, as the protocol reports them.
    pub wall: f64,
    pub source: String,
}

#[derive(Debug, Clone)]
pub struct QueuedEvent {
    pub cursor: u64,
    pub kind: String,
    pub data: Value,
}

/// A long job under way on a session (a capture), stage by stage, for progress() to report
/// while the page is too busy to answer anything else.
pub struct Busy {
    pub what: String,
    pub stage: String,
    pub detail: String,
    pub started: std::time::Instant,
    pub stage_started: std::time::Instant,
    /// Each stage finished so far, with its milliseconds.
    pub stages: Vec<(String, u128)>,
    /// The capture being finished in the background, where that is the job.
    pub capture: Option<String>,
}

/// Ends the job when dropped, however it ends.
pub struct BusyGuard(Arc<Session>);

impl Drop for BusyGuard {
    fn drop(&mut self) {
        self.0.state.lock().unwrap().busy = None;
    }
}

#[derive(Default)]
pub struct State {
    /// A long job under way, for progress().
    pub busy: Option<Busy>,
    /// The size the page is given by emulate, where it has been.
    pub emulated: Option<Value>,
    /// What the agent last asked the Scanline app to show (viewer(show: …) in an app
    /// session), with a number that rises each time so the app can tell a new request.
    pub app_show: Option<Value>,
    pub instances: Vec<Instance>,
    pub contexts: Vec<ContextRef>,
    pub next_context: u32,
    pub console: VecDeque<ConsoleLine>,
    pub console_seq: u64,
    pub events: VecDeque<QueuedEvent>,
    pub event_seq: u64,
    /// Keys the agent is holding, by the name it gave.
    pub keys_down: Vec<String>,
    pub buttons: u32,
    pub pointer: (f64, f64),
    pub image_seq: u32,
    /// Object handles shown to an agent, and the probe each came from.
    pub objects: HashMap<String, Instance>,
    /// Named memory snapshots: the registry's live objects at an instant.
    pub snapshots: std::collections::BTreeMap<String, Value>,
    next_tag: u32,
    pub url: String,
    /// Why the session can no longer be used, once it cannot.
    pub dead: Option<String>,
    /// Who drives the page's input: "human", "agent", or "" for nobody in particular.
    pub owner: String,
    /// What the agent has asked the person to do, until Debug is pressed.
    pub request: Option<Request>,
    pub next_request: u32,
    /// The context the flight recorder is running on, while it runs.
    pub recorder: Option<ContextRef>,
    /// A video under way (video(action: "start")), and when it began.
    pub video: Option<std::time::Instant>,
    /// The browser's name for the probe script it runs in every new document of the page.
    probe_script: Option<String>,
    /// The control strip's protocol session, while its window is open.
    pub strip: Option<String>,
    /// Set while the strip's window is being opened: the next page target to appear is it.
    strip_pending: bool,
    /// What the person has pressed (the Debug key, a button on the strip), not yet acted on.
    pub actions: VecDeque<String>,
    /// What the strip says when nothing has been asked of the person: how the last press went.
    pub strip_note: Option<String>,
    /// The helper that holds the Debug key system-wide while a request is open (handoff.rs).
    pub hotkey: Option<std::process::Child>,
    /// Live patches made in this session: the handle shown, and the probe and number behind it.
    pub patches: std::collections::BTreeMap<String, (Instance, i64)>,
    /// Patches asked to outlast a reload: the command that made each, its arguments, and
    /// the handle it has now ("" while it has not been made again).
    pub kept_patches: Vec<(String, Value, String)>,
    /// States the page saved through the page protocol: the handle shown, the state as the
    /// page gave it, and the frame it was saved at.
    /// Whether the person can mark the frozen frame just now: after their Debug press,
    /// until the page moves on.
    /// Recorded network (network.rs): off, recording or replaying; the responses kept or
    /// being served; which have been used; requests waiting for their frame; and how many
    /// requests of a replay had no kept response.
    pub net_mode: u8,
    pub net_log: Vec<Value>,
    pub net_served: Vec<bool>,
    pub net_pending: Vec<(String, usize)>,
    pub net_missed: u64,
    /// A page load is under way and the new document's probe has not said hello yet.
    pub net_loading: bool,
    /// Kept responses a replay was due to give that the page never asked for.
    pub net_unasked: u64,
    /// The viewer's window, if it is open, and what it has asked for and not yet been given.
    pub viewer: Option<String>,
    pub viewer_calls: VecDeque<Value>,
    pub annotating: bool,
    /// The frame that is frozen for marking.
    pub annotating_frame: u64,
    pub checkpoints: HashMap<String, (String, u64)>,
    pub next_checkpoint: u64,
    worker_urls: HashMap<String, String>,
    /// Workers stopped at start, waiting for the instrumentation pause where the probe goes in.
    waiting_workers: HashSet<String>,
}

pub struct SessionOptions {
    pub url: String,
    /// The key that means "freeze and capture now" (a KeyboardEvent code or key), or "none".
    pub debug_key: Option<String>,
    /// Whether the probe grants pointer lock itself and delivers relative moves ("shim").
    pub pointer_lock_shim: bool,
    /// Stand in for pointer lock where the browser refuses it ("app"): what a session shown in
    /// the Scanline app gets, whose embedded browser refuses it always.
    pub pointer_lock_app: bool,
    pub profile: Profile,
    pub headless: bool,
    pub width: u32,
    pub height: u32,
    pub dpr: Option<f64>,
    pub level: String,
    pub start_paused: bool,
    pub unmodified: bool,
    pub deterministic: Option<(u32, f64)>,
    pub browser: Option<PathBuf>,
    /// Where the game is shown: "window" (a browser window), "headless" or "app" (the
    /// Scanline app, docs/APP.md), which is launched as the browser.
    pub display: String,
    /// More switches for the browser: the app is told its session and the host's home.
    pub extra_args: Vec<String>,
}

pub struct Session {
    pub id: String,
    pub profile: Profile,
    pub headless: bool,
    /// "window", "headless" or "app".
    pub display: String,
    pub level: String,
    pub unmodified: bool,
    pub dir: PathBuf,
    pub browser_version: String,
    pub state: Mutex<State>,
    /// Woken whenever an event is queued or an instance arrives.
    pub changed: Notify,
    /// Woken when the person presses the Debug key in the page.
    pub debug: Notify,
    browser: Browser,
    pub(crate) client: Client,
    pub(crate) page: String,
    /// One response is handed to the page at a time (network.rs).
    pub(crate) net_gate: tokio::sync::Mutex<()>,
    /// Whether this session fixes the clock and random numbers, and so keeps the network.
    pub(crate) deterministic: bool,
    /// The origin the session was launched on, which navigate keeps to (tiers.rs).
    pub(crate) launch_origin: String,
    /// The URL it was launched on: for a file, navigation keeps to its directory.
    pub(crate) launch_url: String,
    key: String,
    binding: String,
    source: String,
    /// The hidden page captures are replayed in, once one has been needed.
    replay: tokio::sync::Mutex<Option<ReplayPage>>,
    /// The `seq` of the last browser event the pump has dealt with.
    handled: std::sync::atomic::AtomicU64,
}

/// The replay page: a second, hidden target in the session's browser, on the same GPU.
struct ReplayPage {
    cdp_session: String,
    /// Captures whose stream and blobs it already holds.
    loaded: HashSet<String>,
    /// Blobs it already holds, by their hash in the store: a later capture that uses one is
    /// told its hash instead of being sent it again.
    hashes: HashSet<String>,
}

/// The control strip: its page, its address, the function it calls the host through, and
/// how tall its window's content is.
const STRIP: &str = include_str!("strip.html");
const STRIP_URL: &str = "https://strip.scanline.invalid/";
const STRIP_BINDING: &str = "scanlineStrip";
const STRIP_HEIGHT: i64 = 56;

/// The viewer: the window in which a person follows what the agent is doing, watches the
/// page's numbers and looks through captures. A page of the host's own, like the strip.
const VIEWER: &str = include_str!("viewer.html");
const VIEWER_URL: &str = "https://viewer.scanline.invalid/";
pub(crate) const VIEWER_BINDING: &str = "scanlineViewer";

/// Where the replay page lives. Nothing is fetched from it: the host answers the request.
const REPLAY_URL: &str = "https://replay.scanline.invalid/";

/// The replay page's script, built by `npm run build:replay`.
const REPLAY: &str = include_str!("../../../replay/dist/replay.js");

const CONSOLE_LIMIT: usize = 2000;
const EVENT_LIMIT: usize = 5000;

fn token() -> String {
    // Not a secret from the page (which shares the probe's world); it only has to be unguessable
    // enough that page code does not collide with it by accident.
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let address = &nanos as *const _ as usize as u128;

    format!("{:016x}", (nanos ^ (address << 17) ^ (std::process::id() as u128) << 40) as u64)
}

fn injectable(url: &str) -> bool {
    url.is_empty() || ["http:", "https:", "file:", "blob:", "data:", "about:"].iter().any(|scheme| url.starts_with(scheme))
}

/// How the probe's lines for the Scanline app begin (probe/src/pointerlock.ts).
const APP_WORD: &str = "\u{1}scanline:";

impl Session {
    /// Starts a long job: progress() reports it until the guard is dropped.
    pub fn begin(self: &Arc<Self>, what: &str, stage: &str) -> BusyGuard {
        self.begin_for(what, stage, None)
    }

    /// The same, for finishing a capture in the background.
    pub fn begin_for(self: &Arc<Self>, what: &str, stage: &str, capture: Option<String>) -> BusyGuard {
        let now = std::time::Instant::now();

        self.state.lock().unwrap().busy =
            Some(Busy { what: what.to_string(), stage: stage.to_string(), detail: String::new(), started: now, stage_started: now, stages: Vec::new(), capture });

        BusyGuard(self.clone())
    }

    /// The job moves on to another stage.
    pub fn stage(&self, stage: &str) {
        let mut state = self.state.lock().unwrap();

        if let Some(busy) = state.busy.as_mut() {
            let took = busy.stage_started.elapsed().as_millis();
            let finished = std::mem::replace(&mut busy.stage, stage.to_string());

            busy.stages.push((finished, took));
            busy.stage_started = std::time::Instant::now();
            busy.detail.clear();
        }
    }

    /// A word on how far the current stage has got ("40 of 338 MB").
    pub fn stage_detail(&self, detail: String) {
        if let Some(busy) = self.state.lock().unwrap().busy.as_mut() {
            busy.detail = detail;
        }
    }

    /// The stages finished so far, and the one under way, in milliseconds.
    pub fn stage_times(&self) -> Value {
        let state = self.state.lock().unwrap();

        match &state.busy {
            None => Value::Null,
            Some(busy) => {
                let mut stages: Vec<Value> = busy.stages.iter().map(|(stage, ms)| json!({ "stage": stage, "ms": ms })).collect();

                stages.push(json!({ "stage": busy.stage, "ms": busy.stage_started.elapsed().as_millis() }));
                json!(stages)
            }
        }
    }

    pub async fn launch(id: String, dir: PathBuf, options: SessionOptions) -> Result<Arc<Session>> {
        std::fs::create_dir_all(dir.join("images")).with_context(|| format!("creating {}", dir.display()))?;

        let browser = Browser::launch(LaunchOptions {
            url: "about:blank".into(),
            profile: options.profile,
            headless: options.headless,
            width: options.width,
            height: options.height,
            browser: options.browser.clone(),
            user_data_dir: dir.join("browser-profile"),
            extra_args: options.extra_args.clone(),
        })
        .await?;

        let client = browser.client.clone();
        let version = client.send("Browser.getVersion", json!({}), None).await?;
        let key = format!("scanline.{}", token());
        let binding = format!("__scanline_{}", token());

        let config = json!({
            "key": key,
            "binding": binding,
            "level": options.level,
            "unmodified": options.unmodified,
            "startPaused": options.start_paused,
            "deterministic": options.deterministic.map(|(seed, fixed_dt)| json!({ "seed": seed, "fixedDt": fixed_dt })),
            "debugKey": options.debug_key.clone().unwrap_or_else(|| "F9".to_string()),
            // A page shown in the app: CEF refuses pointer lock outright, so the probe stands
            // in when it does and the app holds the cursor (probe/src/pointerlock.ts).
            "pointerLock": if options.pointer_lock_shim { "shim" } else if options.pointer_lock_app || options.display == "app" { "app" } else { "native" },
            "probeVersion": env!("CARGO_PKG_VERSION"),
        });

        // The sourceURL names the probe's script, so the probe can tell its own stack frames from
        // the page's when it records where an object was created.
        let source = format!("(() => {{ const __SCANLINE_CONFIG__ = {config};\n{PROBE}\n}})();\n//# sourceURL=scanline-probe.js");

        // Find the page the browser opened and attach to it. The Scanline app makes its page
        // once its window is up, a moment after it first answers: it is waited for.
        let mut target = None;

        for _ in 0..100 {
            let targets = client.send("Target.getTargets", json!({}), None).await?;

            target = targets["targetInfos"]
                .as_array()
                .and_then(|list| list.iter().find(|info| info["type"] == "page"))
                .and_then(|info| info["targetId"].as_str())
                .map(str::to_string);

            if target.is_some() || options.display != "app" {
                break;
            }

            tokio::time::sleep(Duration::from_millis(50)).await;
        }

        let target = target.ok_or_else(|| anyhow!("The browser opened no page."))?;

        let attached = client.send("Target.attachToTarget", json!({ "targetId": target, "flatten": true }), None).await?;
        let page = attached["sessionId"].as_str().ok_or_else(|| anyhow!("The browser gave no session for its page."))?.to_string();

        let session = Arc::new(Session {
            id,
            profile: options.profile,
            headless: options.headless,
            display: options.display.clone(),
            level: options.level.clone(),
            unmodified: options.unmodified,
            dir,
            browser_version: version["product"].as_str().unwrap_or("unknown").to_string(),
            state: Mutex::new(State { url: options.url.clone(), ..State::default() }),
            launch_origin: crate::tiers::origin_of(&options.url),
            launch_url: options.url.clone(),
            changed: Notify::new(),
            debug: Notify::new(),
            browser,
            client: client.clone(),
            page: page.clone(),
            net_gate: tokio::sync::Mutex::new(()),
            deterministic: options.deterministic.is_some(),
            key,
            binding,
            source,
            replay: tokio::sync::Mutex::new(None),
            handled: std::sync::atomic::AtomicU64::new(0),
        });

        // Listen before anything can happen.
        let events = client.subscribe();

        // Events from before the pump was listening will never reach it.
        session.handled.store(client.last_event(), std::sync::atomic::Ordering::SeqCst);
        tokio::spawn(pump(session.clone(), events));

        let p = Some(page.as_str());

        client.send("Page.enable", json!({}), p).await?;
        // The probe opens a data channel and compiles run-until expressions; a page's
        // Content Security Policy must not stop it.
        client.send("Page.setBypassCSP", json!({ "enabled": true }), p).await?;
        let added = client.send("Page.addScriptToEvaluateOnNewDocument", json!({ "source": session.source }), p).await?;

        session.state.lock().unwrap().probe_script = added["identifier"].as_str().map(str::to_string);
        client.send("Runtime.enable", json!({}), p).await?;
        client.send("Runtime.addBinding", json!({ "name": session.binding }), p).await?;
        client.send("Log.enable", json!({}), p).await?;

        let auto = json!({ "autoAttach": true, "waitForDebuggerOnStart": true, "flatten": true });

        client.send("Target.setAutoAttach", auto.clone(), p).await?;
        // Shared and service workers are not children of the page target (spike S1).
        client.send("Target.setAutoAttach", auto, None).await?;

        if let Some(dpr) = options.dpr {
            client
                .send(
                    "Emulation.setDeviceMetricsOverride",
                    json!({ "width": options.width, "height": options.height, "deviceScaleFactor": dpr, "mobile": false }),
                    p,
                )
                .await?;
        }

        // A deterministic session keeps what the page is given from the network, so that a
        // run of it can be given the same again.
        if session.deterministic {
            crate::network::record(&session).await;
        }

        session.navigate(&options.url).await?;

        Ok(session)
    }

    /// Loads the page again with its first frame held, whatever the session was launched
    /// with: a run can only be replayed from a page that has not yet moved.
    pub async fn reload_paused(&self) -> Result<()> {
        let p = Some(self.page.as_str());
        let held = self.source.replacen("\"startPaused\":false", "\"startPaused\":true", 1);
        let usual = self.state.lock().unwrap().probe_script.take();

        if let Some(identifier) = &usual {
            self.client.send("Page.removeScriptToEvaluateOnNewDocument", json!({ "identifier": identifier }), p).await?;
        }

        let added = self.client.send("Page.addScriptToEvaluateOnNewDocument", json!({ "source": held }), p).await?;
        let url = self.url();
        let outcome = self.navigate(&url).await;

        // Later loads start as the session was launched to.
        if let Some(identifier) = added["identifier"].as_str() {
            let _ = self.client.send("Page.removeScriptToEvaluateOnNewDocument", json!({ "identifier": identifier }), p).await;
        }

        let again = self.client.send("Page.addScriptToEvaluateOnNewDocument", json!({ "source": self.source }), p).await?;

        self.state.lock().unwrap().probe_script = again["identifier"].as_str().map(str::to_string);

        outcome
    }

    /// Loads a URL and waits for its load event (or 30 seconds, whichever is first).
    pub async fn navigate(&self, url: &str) -> Result<()> {
        crate::network::reset(self);

        let events = self.client.subscribe();
        let page = self.page.clone();
        let reply = self.client.send("Page.navigate", json!({ "url": url }), Some(&self.page)).await?;

        if let Some(error) = reply["errorText"].as_str() {
            bail!("Could not load {url}: {error}. Is the server running?");
        }

        self.state.lock().unwrap().url = url.to_string();

        let loaded = self
            .client
            .wait_for(events, Duration::from_secs(30), |event| event.method == "Page.loadEventFired" && event.session.as_deref() == Some(page.as_str()))
            .await;

        if loaded.is_err() {
            self.queue("warning", json!({ "text": format!("{url} had not finished loading after 30 s. Carrying on.") }));
        }

        // The top frame's probe says hello as the document starts; make sure it has.
        for _ in 0..40 {
            if self.top().is_ok() {
                break;
            }

            tokio::time::sleep(Duration::from_millis(25)).await;
        }

        Ok(())
    }

    /// Waits until everything the browser has reported so far is in the session's records.
    ///
    /// A command's reply and the events it caused (an exception, a console line) arrive in
    /// order but are handled by different tasks, so a command that has just been answered
    /// can otherwise read the console before the error it raised has been written there.
    pub async fn settle(&self) {
        let reported = self.client.last_event();
        let give_up = tokio::time::Instant::now() + Duration::from_millis(300);

        while self.handled.load(std::sync::atomic::Ordering::SeqCst) < reported && tokio::time::Instant::now() < give_up {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    }

    pub fn url(&self) -> String {
        self.state.lock().unwrap().url.clone()
    }

    pub fn queue(&self, kind: &str, data: Value) {
        let mut state = self.state.lock().unwrap();

        state.event_seq += 1;

        let cursor = state.event_seq;

        state.events.push_back(QueuedEvent { cursor, kind: kind.to_string(), data });

        if state.events.len() > EVENT_LIMIT {
            state.events.pop_front();
        }

        drop(state);
        self.changed.notify_waiters();
    }

    /// An error if the browser has gone, saying so and what to do.
    pub fn check_alive(&self) -> Result<()> {
        match &self.state.lock().unwrap().dead {
            Some(reason) => bail!("{} is no longer usable: {reason} Call close, then launch again.", self.id),
            None => Ok(()),
        }
    }

    pub fn instances(&self) -> Vec<Instance> {
        self.state.lock().unwrap().instances.clone()
    }

    /// The probe in the page's top frame.
    pub fn top(&self) -> Result<Instance> {
        self.check_alive()?;

        self.state.lock().unwrap().instances.iter().find(|instance| instance.top).cloned().ok_or_else(|| {
            anyhow!("{} has no probe in its page yet. The page may still be loading, or may be a browser error page. Call status to check.", self.id)
        })
    }

    /// Calls a method of one probe.
    pub async fn probe(&self, instance: &Instance, method: &str, args: Value, timeout: Duration) -> Result<Value> {
        self.check_alive()?;

        let quote = |text: &str| Value::String(text.to_string()).to_string();
        let expression = format!("globalThis[Symbol.for({})]({}, {})", quote(&self.key), quote(method), quote(&args.to_string()));
        let mut params = json!({ "expression": expression, "awaitPromise": true, "returnByValue": true });

        if instance.kind == "window" {
            if let Some(context) = instance.context_id {
                params["contextId"] = json!(context);
            }
        }

        let reply = self.client.send_with_timeout("Runtime.evaluate", params, Some(&instance.cdp_session), timeout).await?;

        if let Some(details) = reply.get("exceptionDetails") {
            let what = details["exception"]["description"].as_str().or(details["text"].as_str()).unwrap_or("unknown error");

            bail!("The probe could not run {method}: {}", what.lines().next().unwrap_or(what));
        }

        let text = reply["result"]["value"].as_str().ok_or_else(|| anyhow!("The probe returned nothing for {method}."))?;
        let mut parsed: Value = serde_json::from_str(text).with_context(|| format!("reading the probe's reply to {method}"))?;

        if let Some(error) = parsed.get("error").and_then(Value::as_str) {
            bail!("{error}");
        }

        Ok(parsed["ok"].take())
    }

    /// Calls a method of every probe at once. Results come back in instance order; a probe
    /// that fails (its frame went away mid-call, say) is left out.
    pub async fn probe_all(self: &Arc<Self>, method: &str, args: Value, timeout: Duration) -> Vec<(Instance, Value)> {
        let mut tasks = tokio::task::JoinSet::new();

        for (index, instance) in self.instances().into_iter().enumerate() {
            let session = self.clone();
            let method = method.to_string();
            let args = args.clone();

            tasks.spawn(async move {
                let result = session.probe(&instance, &method, args, timeout).await;

                (index, instance, result)
            });
        }

        let mut results = Vec::new();

        while let Some(joined) = tasks.join_next().await {
            if let Ok((index, instance, Ok(value))) = joined {
                results.push((index, instance, value));
            }
        }

        results.sort_by_key(|entry| entry.0);
        results.into_iter().map(|(_, instance, value)| (instance, value)).collect()
    }

    /// Gives every context the probes report a stable handle, and returns the current set.
    pub fn register_contexts(&self, reports: &[(Instance, Value)]) -> Vec<(ContextRef, Value)> {
        let mut state = self.state.lock().unwrap();
        let mut current = Vec::new();

        for (instance, status) in reports {
            for context in status["contexts"].as_array().into_iter().flatten() {
                let local = context["id"].as_i64().unwrap_or(0);
                let existing = state.contexts.iter().find(|known| known.instance == *instance && known.local == local).cloned();

                let reference = existing.unwrap_or_else(|| {
                    state.next_context += 1;

                    let reference = ContextRef {
                        handle: format!("ctx_{}", state.next_context),
                        instance: instance.clone(),
                        local,
                        api: context["api"].as_str().unwrap_or("").to_string(),
                    };

                    state.contexts.push(reference.clone());

                    reference
                });

                current.push((reference, context.clone()));
            }
        }

        current
    }

    /// Resolves a context handle, or explains why it cannot be.
    pub fn context(&self, handle: &str) -> Result<ContextRef> {
        let state = self.state.lock().unwrap();

        match state.contexts.iter().find(|context| context.handle == handle) {
            Some(context) if state.instances.contains(&context.instance) => Ok(context.clone()),
            Some(_) => bail!("{handle} belongs to an earlier page load of {}. Call status to list current contexts.", self.id),
            None => bail!("No context \"{handle}\" in {}. Call status to list its contexts.", self.id),
        }
    }

    /// The handle for an object in a probe's registry: `tex_17`, or `tex_17_w2` for one that
    /// lives in a worker or another frame. Showing a handle is what makes it usable.
    pub fn object_handle(&self, instance: &Instance, kind: &str, id: i64) -> String {
        let prefix = OBJECT_KINDS.iter().find(|entry| entry.0 == kind).map(|entry| entry.1).unwrap_or("obj");
        let handle = if instance.tag == 0 { format!("{prefix}_{id}") } else { format!("{prefix}_{id}_w{}", instance.tag) };

        self.state.lock().unwrap().objects.insert(handle.clone(), instance.clone());

        handle
    }

    /// Resolves an object handle, or explains why it cannot be.
    pub fn object(&self, handle: &str) -> Result<ObjectRef> {
        let mut parts = handle.split('_');
        let prefix = parts.next().unwrap_or("");
        let id = parts.next().and_then(|id| id.parse::<i64>().ok());
        let Some(&(kind, _)) = OBJECT_KINDS.iter().find(|entry| entry.1 == prefix) else {
            bail!("\"{handle}\" is not an object handle. Handles look like tex_3, buf_7, shd_2, prg_1, pip_4, fbo_2; call resources(kind: …) to list them.");
        };
        let Some(id) = id else { bail!("\"{handle}\" is not an object handle: the number is missing. Call resources(kind: \"{kind}\") to list them.") };

        let state = self.state.lock().unwrap();

        match state.objects.get(handle) {
            Some(instance) if state.instances.contains(instance) => Ok(ObjectRef { handle: handle.to_string(), instance: instance.clone(), kind, id }),
            Some(_) => bail!("{handle} belongs to an earlier page load of {}. Call resources(kind: \"{kind}\") to list current ones.", self.id),
            // Not shown before, but a top-frame handle is predictable; accept it if the top frame is there.
            None => match state.instances.iter().find(|instance| instance.top) {
                Some(top) if !handle.contains("_w") => Ok(ObjectRef { handle: handle.to_string(), instance: top.clone(), kind, id }),
                _ => bail!("No object \"{handle}\" in {}. Call resources(kind: \"{kind}\") to list current ones.", self.id),
            },
        }
    }

    /// Evaluates an expression in the page's top frame.
    pub async fn evaluate(&self, expression: &str, await_promise: bool) -> Result<Value> {
        self.check_alive()?;

        let reply = self
            .client
            .send(
                "Runtime.evaluate",
                json!({ "expression": expression, "awaitPromise": await_promise, "returnByValue": true, "userGesture": true }),
                Some(&self.page),
            )
            .await?;

        if let Some(details) = reply.get("exceptionDetails") {
            let what = details["exception"]["description"].as_str().or(details["text"].as_str()).unwrap_or("unknown error");

            bail!("The expression threw: {what}");
        }

        Ok(reply["result"].get("value").cloned().unwrap_or_else(|| json!(reply["result"]["description"].as_str().unwrap_or("undefined"))))
    }

    /// A command on the page's own protocol session (input, screenshots).
    pub async fn page_command(&self, method: &str, params: Value) -> Result<Value> {
        self.check_alive()?;
        self.client.send_with_timeout(method, params, Some(&self.page), Duration::from_secs(10)).await
    }

    /// Sends one of the host's own pages (the replay page, the control strip) to an address
    /// that is never fetched: the request is answered here with the page's text. The address
    /// is https, so the page is a secure context.
    async fn serve(&self, cdp_session: &str, url: &str, html: &str) -> Result<()> {
        let s = Some(cdp_session);
        let paused = self.client.subscribe();
        let loaded = self.client.subscribe();

        self.client.send("Page.enable", json!({}), s).await?;
        self.client.send("Fetch.enable", json!({ "patterns": [{ "urlPattern": format!("{url}*") }] }), s).await?;
        self.client.post("Page.navigate", json!({ "url": url }), s)?;

        let mine = cdp_session.to_string();
        let request = self
            .client
            .wait_for(paused, Duration::from_secs(10), |event| event.method == "Fetch.requestPaused" && event.session.as_deref() == Some(mine.as_str()))
            .await?;

        self.client
            .send(
                "Fetch.fulfillRequest",
                json!({
                    "requestId": request.params["requestId"],
                    "responseCode": 200,
                    "responseHeaders": [{ "name": "Content-Type", "value": "text/html; charset=utf-8" }],
                    "body": base64::engine::general_purpose::STANDARD.encode(html),
                }),
                s,
            )
            .await?;

        let mine = cdp_session.to_string();

        self.client
            .wait_for(loaded, Duration::from_secs(10), |event| event.method == "Page.loadEventFired" && event.session.as_deref() == Some(mine.as_str()))
            .await?;

        self.client.send("Fetch.disable", json!({}), s).await?;

        Ok(())
    }

    /// Opens the control strip: a small window under the game's, in the same browser, that
    /// shows the person who is driving and what the agent asked, with a Debug button.
    /// Does nothing if it is already open.
    pub async fn open_strip(&self) -> Result<()> {
        // In the Scanline app the toolbar is the strip: it shows who has the input and has Debug.
        if self.display == "app" {
            return Ok(());
        }

        if self.state.lock().unwrap().strip.is_some() {
            return Ok(());
        }

        // Under the game's window, as wide as it is.
        let window = self.client.send("Browser.getWindowForTarget", json!({}), Some(&self.page)).await.unwrap_or(Value::Null);
        let bounds = &window["bounds"];
        let (left, top) = (bounds["left"].as_i64().unwrap_or(40), bounds["top"].as_i64().unwrap_or(40) + bounds["height"].as_i64().unwrap_or(720));
        let width = bounds["width"].as_i64().unwrap_or(900).clamp(620, 1600);

        // A popup has no tabs and no toolbar. It is opened from a world of the game's page
        // that the page's own scripts cannot see into, and with no link back to the page.
        let tree = self.page_command("Page.getFrameTree", json!({})).await?;
        let frame = tree["frameTree"]["frame"]["id"].as_str().ok_or_else(|| anyhow!("The page has no main frame."))?;
        let world = self.page_command("Page.createIsolatedWorld", json!({ "frameId": frame, "worldName": "scanline-strip" })).await?;

        self.state.lock().unwrap().strip_pending = true;

        let opened = self
            .page_command(
                "Runtime.evaluate",
                json!({
                    "expression": format!("window.open('about:blank', '_blank', 'popup,noopener,width={width},height={STRIP_HEIGHT},left={left},top={top}'); 0"),
                    "contextId": world["executionContextId"],
                    "userGesture": true,
                }),
            )
            .await;

        let mut strip = None;

        if opened.is_ok() {
            for _ in 0..80 {
                strip = self.state.lock().unwrap().strip.clone();

                if strip.is_some() {
                    break;
                }

                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        }

        self.state.lock().unwrap().strip_pending = false;

        // No popup came (a browser that blocks them): an ordinary window will do.
        let strip = match strip {
            Some(strip) => strip,
            None => {
                let target = self
                    .client
                    .send(
                        "Target.createTarget",
                        json!({ "url": "about:blank", "newWindow": true, "left": left, "top": top, "width": width, "height": STRIP_HEIGHT + 90 }),
                        None,
                    )
                    .await
                    .context("opening the control strip")?;
                let attached = self.client.send("Target.attachToTarget", json!({ "targetId": target["targetId"], "flatten": true }), None).await?;
                let strip = attached["sessionId"].as_str().ok_or_else(|| anyhow!("The browser gave no session for the control strip."))?.to_string();

                self.state.lock().unwrap().strip = Some(strip.clone());

                strip
            }
        };

        let outcome = async {
            self.serve(&strip, STRIP_URL, STRIP).await?;
            self.client.send("Runtime.enable", json!({}), Some(&strip)).await?;
            self.client.send("Runtime.addBinding", json!({ "name": STRIP_BINDING }), Some(&strip)).await?;

            Ok::<(), anyhow::Error>(())
        }
        .await;

        if let Err(error) = outcome {
            self.state.lock().unwrap().strip = None;

            return Err(error.context("loading the control strip"));
        }

        // Opening a window takes the keyboard. The person is about to play: give it back.
        let _ = self.page_command("Page.bringToFront", json!({})).await;

        // Whoever keeps the strip up to date should look now, not when it next happens to.
        self.debug.notify_one();

        Ok(())
    }

    /// Opens the viewer window, or says it is open already.
    pub async fn open_viewer(&self) -> Result<bool> {
        if self.state.lock().unwrap().viewer.is_some() {
            return Ok(false);
        }

        let target = self
            .client
            .send("Target.createTarget", json!({ "url": "about:blank", "newWindow": true, "width": 1180, "height": 820 }), None)
            .await
            .context("opening the viewer")?;
        let attached = self.client.send("Target.attachToTarget", json!({ "targetId": target["targetId"], "flatten": true }), None).await?;
        let viewer = attached["sessionId"].as_str().ok_or_else(|| anyhow!("The browser gave no session for the viewer."))?.to_string();

        self.state.lock().unwrap().viewer = Some(viewer.clone());

        let outcome = async {
            self.serve(&viewer, VIEWER_URL, VIEWER).await?;
            self.client.send("Runtime.enable", json!({}), Some(&viewer)).await?;
            self.client.send("Runtime.addBinding", json!({ "name": VIEWER_BINDING }), Some(&viewer)).await?;
            // The page was waiting for its way to the host before asking for anything.
            self.client.send("Runtime.evaluate", json!({ "expression": "start()" }), Some(&viewer)).await?;

            Ok::<(), anyhow::Error>(())
        }
        .await;

        if let Err(error) = outcome {
            self.state.lock().unwrap().viewer = None;

            return Err(error.context("loading the viewer"));
        }

        Ok(true)
    }

    /// Runs an expression in the viewer, waiting for a promise if it gives one. None if
    /// the viewer is not open.
    pub async fn viewer_eval(&self, expression: &str) -> Option<Value> {
        let viewer = self.state.lock().unwrap().viewer.clone()?;
        let reply = self
            .client
            .send_with_timeout(
                "Runtime.evaluate",
                json!({ "expression": expression, "returnByValue": true, "awaitPromise": true }),
                Some(&viewer),
                Duration::from_secs(20),
            )
            .await
            .ok()?;

        Some(reply["result"]["value"].clone())
    }

    /// A picture of the viewer as the person sees it.
    pub async fn viewer_picture(&self) -> Result<Vec<u8>> {
        let viewer = self.state.lock().unwrap().viewer.clone().ok_or_else(|| anyhow!("The viewer is not open."))?;
        let reply = self.client.send_with_timeout("Page.captureScreenshot", json!({ "format": "png" }), Some(&viewer), Duration::from_secs(10)).await?;

        base64::engine::general_purpose::STANDARD.decode(reply["data"].as_str().unwrap_or("")).context("decoding the viewer's picture")
    }

    /// Runs an expression in the control strip. None if the strip is not open.
    pub async fn strip_eval(&self, expression: &str) -> Option<Value> {
        let strip = self.state.lock().unwrap().strip.clone()?;
        let reply = self
            .client
            .send_with_timeout("Runtime.evaluate", json!({ "expression": expression, "returnByValue": true }), Some(&strip), Duration::from_secs(5))
            .await
            .ok()?;

        Some(reply["result"]["value"].clone())
    }

    /// A picture of the control strip as the person sees it.
    pub async fn strip_picture(&self) -> Result<Vec<u8>> {
        let strip = self.state.lock().unwrap().strip.clone().ok_or_else(|| anyhow!("The control strip is not open."))?;
        let reply = self.client.send_with_timeout("Page.captureScreenshot", json!({ "format": "png" }), Some(&strip), Duration::from_secs(10)).await?;

        base64::engine::general_purpose::STANDARD.decode(reply["data"].as_str().unwrap_or("")).context("decoding the strip's picture")
    }

    /// Calls a method of the replay page, opening the page first if this is the first call.
    pub async fn replay(&self, method: &str, args: &Value, timeout: Duration) -> Result<Value> {
        let mut page = self.replay.lock().await;

        self.replay_on(&mut page, method, args, timeout).await
    }

    async fn replay_on(&self, page: &mut Option<ReplayPage>, method: &str, args: &Value, timeout: Duration) -> Result<Value> {
        self.check_alive()?;

        if page.is_none() {
            // Hidden: it is seen through the protocol but has no window or tab.
            let target =
                self.client.send("Target.createTarget", json!({ "url": "about:blank", "hidden": true }), None).await.context("opening the replay page")?;
            let target = target["targetId"].as_str().ok_or_else(|| anyhow!("The browser gave no target for the replay page."))?;
            let attached = self.client.send("Target.attachToTarget", json!({ "targetId": target, "flatten": true }), None).await?;
            let cdp_session = attached["sessionId"].as_str().ok_or_else(|| anyhow!("The browser gave no session for the replay page."))?.to_string();

            // WebGPU exists only in a secure context, which about:blank is not.
            self.serve(&cdp_session, REPLAY_URL, "<!doctype html><title>Scanline replay</title>").await.context("opening the replay page")?;
            self.client.send("Runtime.evaluate", json!({ "expression": REPLAY }), Some(&cdp_session)).await.context("loading the replay script")?;

            *page = Some(ReplayPage { cdp_session, loaded: HashSet::new(), hashes: HashSet::new() });
        }

        let quote = |text: &str| Value::String(text.to_string()).to_string();
        let expression = format!("__scanlineReplay({}, {})", quote(method), quote(&args.to_string()));
        let cdp_session = page.as_ref().unwrap().cdp_session.clone();

        let reply = self
            .client
            .send_with_timeout(
                "Runtime.evaluate",
                json!({ "expression": expression, "awaitPromise": true, "returnByValue": true }),
                Some(&cdp_session),
                timeout,
            )
            .await;

        let reply = match reply {
            Ok(reply) => reply,
            Err(error) => {
                // The replay page may have crashed running a frame the game survived. Start afresh next time.
                *page = None;

                return Err(error.context("The replay page did not answer. It has been discarded; the next call opens a new one."));
            }
        };

        if let Some(details) = reply.get("exceptionDetails") {
            let what = details["exception"]["description"].as_str().or(details["text"].as_str()).unwrap_or("unknown error");

            bail!("The replay page failed in {method}: {}", what.lines().next().unwrap_or(what));
        }

        let text = reply["result"]["value"].as_str().ok_or_else(|| anyhow!("The replay page returned nothing for {method}."))?;
        let mut parsed: Value = serde_json::from_str(text).with_context(|| format!("reading the replay page's reply to {method}"))?;

        if let Some(error) = parsed.get("error").and_then(Value::as_str) {
            bail!("{error}");
        }

        Ok(parsed["ok"].take())
    }

    /// Gives the replay page a capture, unless it already has it. `stream` is the capture's
    /// description; `blob` fetches one of its blobs by index.
    pub async fn replay_load(&self, key: &str, stream: &Value, blob: &(dyn Fn(usize) -> Result<Vec<u8>> + Sync)) -> Result<()> {
        // A blob larger than this goes to the page in pieces of this size (a multiple of three
        // bytes, so each piece is base64 of its own).
        const PIECE: usize = 3 * 1024 * 1024;

        use base64::Engine;
        use std::io::Write;

        let mut page = self.replay.lock().await;

        if page.as_ref().is_some_and(|page| page.loaded.contains(key)) {
            return Ok(());
        }

        let pack = |bytes: &[u8]| -> Result<String> {
            let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());

            encoder.write_all(bytes)?;

            Ok(base64::engine::general_purpose::STANDARD.encode(encoder.finish()?))
        };

        let body = pack(&serde_json::to_vec(stream)?)?;

        self.replay_on(&mut page, "load", &json!({ "key": key, "body": body }), Duration::from_secs(60)).await?;

        // A few megabytes of blobs to a call, as plain base64: they rarely shrink under gzip,
        // and gzip at this size costs more than it saves. A blob the page already holds (from
        // an earlier capture of the same scene) is named by its hash instead.
        let count = stream["blobs"].as_array().map_or(0, Vec::len);
        let named: Vec<Option<String>> = (0..count).map(|index| stream["blob_hashes"][index].as_str().map(str::to_string)).collect();
        let mut from = 0;

        while from < count {
            let mut batch = Vec::new();
            let mut size = 0;

            while from + batch.len() < count && (batch.is_empty() || size < 6_000_000) {
                let index = from + batch.len();
                let held = named[index].as_ref().is_some_and(|hash| page.as_ref().is_some_and(|page| page.hashes.contains(hash)));

                if held {
                    batch.push(json!({ "hash": named[index] }));
                    continue;
                }

                let bytes = blob(index)?;

                // A large blob goes on its own, in pieces the page puts back together: one
                // script of tens of megabytes is more than a page takes in good time.
                if bytes.len() > PIECE {
                    if !batch.is_empty() {
                        break;
                    }

                    for (number, piece) in bytes.chunks(PIECE).enumerate() {
                        let encoded = base64::engine::general_purpose::STANDARD.encode(piece);

                        self.replay_on(
                            &mut page,
                            "piece",
                            &json!({ "key": key, "index": index, "hash": named[index], "total": bytes.len(), "offset": number * PIECE, "data": encoded }),
                            Duration::from_secs(60),
                        )
                        .await?;
                    }

                    batch.push(json!({ "hash": named[index], "pieced": true }));
                    break;
                }

                let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);

                size += encoded.len();
                batch.push(json!({ "hash": named[index], "data": encoded }));
            }

            let sent = batch.len();

            self.replay_on(&mut page, "blobs", &json!({ "key": key, "from": from, "blobs": batch, "encoding": "base64" }), Duration::from_secs(90)).await?;

            if let Some(page) = page.as_mut() {
                page.hashes.extend(named[from..from + sent].iter().flatten().cloned());
            }

            from += sent;
        }

        if let Some(page) = page.as_mut() {
            page.loaded.insert(key.to_string());
        }

        Ok(())
    }

    /// Resolves when the browser process exits, with its exit code if it had one.
    pub async fn wait_browser_exit(&self) -> Option<i32> {
        self.browser.wait_exit().await
    }

    pub fn browser_pid(&self) -> Option<u32> {
        self.browser.pid
    }

    /// The process ID of the browser's GPU process: what OS GPU counters are read by, and
    /// what a test kills to force a real context loss.
    pub async fn gpu_pid(&self) -> Option<i64> {
        let info = self.client.send_with_timeout("SystemInfo.getProcessInfo", json!({}), None, Duration::from_secs(5)).await.ok()?;

        info["processInfo"].as_array()?.iter().find(|process| process["type"] == "GPU")?["id"].as_i64()
    }

    /// Records a browser trace while `during` runs, and returns its events. The trace is
    /// the browser's own (the Tracing domain): every process, the categories asked for.
    pub async fn traced<F, T>(&self, categories: &[String], during: F) -> Result<(T, Vec<Value>)>
    where
        F: std::future::Future<Output = T>,
    {
        let mut events = self.client.subscribe();

        self.client
            .send_with_timeout(
                "Tracing.start",
                json!({ "transferMode": "ReportEvents", "traceConfig": { "recordMode": "recordUntilFull", "includedCategories": categories } }),
                None,
                Duration::from_secs(10),
            )
            .await
            .context("starting a browser trace")?;

        let outcome = during.await;

        self.client.post("Tracing.end", json!({}), None)?;

        let mut collected = Vec::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);

        loop {
            let event = match tokio::time::timeout_at(deadline, events.recv()).await {
                Ok(Ok(event)) => event,
                Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(_))) => continue,
                Ok(Err(_)) => bail!("The browser went away while the trace was being collected."),
                Err(_) => bail!("The browser did not finish handing over the trace within 30 s."),
            };

            match event.method.as_str() {
                "Tracing.dataCollected" => collected.extend(event.params["value"].as_array().cloned().unwrap_or_default()),
                "Tracing.tracingComplete" => break,
                _ => {}
            }
        }

        Ok((outcome, collected))
    }

    /// What the GPU process holds, by the operating system's count. It is the whole
    /// process: every page's GPU objects, the compositor's, and the process's own.
    pub async fn gpu_process_memory(&self) -> Option<u64> {
        scanline_browser::process_memory(self.gpu_pid().await?)
    }

    pub async fn close(&self) {
        self.release_hotkey();
        self.browser.close().await;
    }

    /// Stops the helper that holds the Debug key system-wide, if one is running.
    pub fn release_hotkey(&self) {
        if let Some(mut helper) = self.state.lock().unwrap().hotkey.take() {
            let _ = helper.kill();
            let _ = helper.wait();
        }
    }
}

/// Reads every event from the browser for the life of the session.
async fn pump(session: Arc<Session>, mut events: tokio::sync::broadcast::Receiver<Event>) {
    loop {
        let event = match events.recv().await {
            Ok(event) => event,
            Err(tokio::sync::broadcast::error::RecvError::Lagged(missed)) => {
                session.queue("warning", json!({ "text": format!("The host fell behind the browser and missed {missed} protocol events.") }));
                continue;
            }
            Err(_) => break,
        };

        if event.method == "Scanline.disconnected" {
            session.state.lock().unwrap().dead = Some("the browser exited.".into());
            session.state.lock().unwrap().instances.clear();
            session.queue("crashed", json!({ "what": "browser", "detail": "The browser process exited." }));
            break;
        }

        let seq = event.seq;

        handle(&session, event);
        session.handled.fetch_max(seq, std::sync::atomic::Ordering::SeqCst);
    }
}

fn handle(session: &Arc<Session>, event: Event) {
    let params = &event.params;

    match event.method.as_str() {
        "Runtime.bindingCalled" if params["name"] == session.binding.as_str() => {
            let Ok(payload) = serde_json::from_str::<Value>(params["payload"].as_str().unwrap_or("")) else { return };
            let Some(cdp_session) = event.session.clone() else { return };

            match payload["t"].as_str().unwrap_or("") {
                "hello" => {
                    let kind = payload["kind"].as_str().unwrap_or("window").to_string();
                    let mut state = session.state.lock().unwrap();

                    let url = if kind == "worker" {
                        state.worker_urls.get(&cdp_session).cloned().unwrap_or_default()
                    } else {
                        payload["url"].as_str().unwrap_or("").to_string()
                    };

                    let top = payload["top"] == true;

                    let tag = if top {
                        0
                    } else {
                        state.next_tag += 1;
                        state.next_tag
                    };

                    let instance = Instance { cdp_session, context_id: params["executionContextId"].as_i64(), kind, top, url, tag };

                    if instance.top {
                        // A new document in the top frame replaces the old one.
                        state.instances.retain(|other| !other.top);
                        state.net_loading = false;
                    }

                    state.instances.push(instance);
                    drop(state);
                    session.changed.notify_waiters();
                }
                "" => {}
                // The Debug key: the freeze and the capture are the host's to do.
                "debug-key" => {
                    session.state.lock().unwrap().actions.push_back("debug:key".into());
                    session.debug.notify_one();
                }
                // The browser refused the page the pointer lock. The words are the host's:
                // a page that finds the binding can raise this, and no more than this.
                "pointer-lock-refused" => {
                    session.queue(
                        "warning",
                        json!({
                            "frame": payload["frame"].as_i64(),
                            "text": "The page asked for the pointer lock and the browser refused. Its own lock needs the browser's window in front and a real click. An agent should launch with pointer_lock: \"shim\", which grants the lock and takes relative moves."
                        }),
                    );
                }
                // What the probe reports, and nothing else. The binding is in the page's own
                // world, so a page that finds it can call it: it must not be able to queue an
                // event that reads as the host's (capture_ready, owner_changed) or the person's.
                kind @ ("annotation" | "context" | "context-lost" | "context-restored" | "mark" | "probe-fault" | "stopped") => {
                    let mut data = payload.clone();

                    if let Some(object) = data.as_object_mut() {
                        object.remove("t");

                        // A mark on the picture is a place. Words come only from the control
                        // strip, which the page cannot reach.
                        if kind == "annotation" {
                            object.retain(|key, value| {
                                matches!(key.as_str(), "x" | "y" | "w" | "h" | "frame") && value.is_number() || key == "space" && value == "canvas_px"
                            });
                        }
                    }

                    session.queue(kind, data);
                }
                _ => {}
            }
        }

        // The viewer asking for something through the control API. It is answered by the
        // loop that has the host to hand (handoff::watch).
        "Runtime.bindingCalled" if params["name"] == VIEWER_BINDING => {
            let mut state = session.state.lock().unwrap();

            if state.viewer.as_deref() == event.session.as_deref() {
                if let Ok(asked) = serde_json::from_str::<Value>(params["payload"].as_str().unwrap_or("")) {
                    state.viewer_calls.push_back(asked);
                    drop(state);
                    session.debug.notify_one();
                }
            }
        }

        // A button on the control strip.
        "Runtime.bindingCalled" if params["name"] == STRIP_BINDING => {
            let mut state = session.state.lock().unwrap();

            if state.strip.as_deref() == event.session.as_deref() {
                if let Some(action) = serde_json::from_str::<Value>(params["payload"].as_str().unwrap_or("")).ok().and_then(|payload| {
                    // A note carries its text along with it.
                    match (payload["action"].as_str(), payload["text"].as_str()) {
                        (Some("note"), Some(text)) => Some(format!("note:{text}")),
                        (Some(action), _) => Some(action.to_string()),
                        _ => None,
                    }
                }) {
                    state.actions.push_back(action);
                    drop(state);
                    session.debug.notify_one();
                }
            }
        }

        // A request or response of the page's, held for a deterministic session (network.rs).
        "Fetch.requestPaused" if event.session.as_deref() == Some(session.page.as_str()) => crate::network::paused(session, params),

        "Target.attachedToTarget" => attached(session, params),

        "Debugger.paused" => {
            let Some(cdp_session) = event.session.as_deref() else { return };

            if params["reason"] == "instrumentation" && session.state.lock().unwrap().waiting_workers.remove(cdp_session) {
                // The worker is stopped before its first statement, its global complete.
                // Put the probe in, then switch the debugger off, which lets the worker run.
                let _ = session.client.post("Runtime.evaluate", json!({ "expression": session.source }), Some(cdp_session));
                let _ = session.client.post("Debugger.disable", json!({}), Some(cdp_session));
            }
        }

        "Target.detachedFromTarget" => {
            if let Some(gone) = params["sessionId"].as_str() {
                let mut state = session.state.lock().unwrap();

                state.instances.retain(|instance| instance.cdp_session != gone);

                // The person closed the strip's window.
                if state.strip.as_deref() == Some(gone) {
                    state.strip = None;
                }

                state.worker_urls.remove(gone);
                state.waiting_workers.remove(gone);
            }
        }

        "Runtime.executionContextDestroyed" => {
            if let (Some(cdp_session), Some(context)) = (event.session.as_deref(), params["executionContextId"].as_i64()) {
                session
                    .state
                    .lock()
                    .unwrap()
                    .instances
                    .retain(|instance| !(instance.cdp_session == cdp_session && instance.context_id == Some(context) && instance.kind == "window"));
            }
        }

        "Runtime.consoleAPICalled" => {
            let text = params["args"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|arg| match arg.get("value") {
                    Some(Value::String(text)) => text.clone(),
                    Some(value) => value.to_string(),
                    None => arg["description"].as_str().unwrap_or("").to_string(),
                })
                .collect::<Vec<_>>()
                .join(" ");

            // The probe's word to the Scanline app (pointer lock held or given back) is the
            // app's, not the page's.
            if !text.starts_with(APP_WORD) {
                console(session, params["type"].as_str().unwrap_or("log"), text, params["timestamp"].as_f64().unwrap_or(0.0), "console");
            }
        }

        "Runtime.exceptionThrown" => {
            let details = &params["exceptionDetails"];
            let text = details["exception"]["description"].as_str().or(details["text"].as_str()).unwrap_or("Uncaught exception").to_string();

            console(session, "exception", text, params["timestamp"].as_f64().unwrap_or(0.0), "page");
        }

        "Log.entryAdded" => {
            let entry = &params["entry"];

            console(
                session,
                entry["level"].as_str().unwrap_or("info"),
                entry["text"].as_str().unwrap_or("").to_string(),
                entry["timestamp"].as_f64().unwrap_or(0.0),
                entry["source"].as_str().unwrap_or("browser"),
            );
        }

        "Inspector.targetCrashed" | "Target.targetCrashed" => {
            session.queue(
                "crashed",
                json!({ "what": "renderer", "detail": "The page's renderer process crashed. Reload with navigate, or close and launch again." }),
            );
        }

        "Page.frameNavigated" if event.session.as_deref() == Some(session.page.as_str()) && params["frame"].get("parentId").is_none() => {
            let url = params["frame"]["url"].as_str().unwrap_or("").to_string();

            session.state.lock().unwrap().url = url.clone();
            session.queue("navigated", json!({ "url": url }));
        }

        _ => {}
    }
}

fn console(session: &Arc<Session>, level: &str, text: String, wall: f64, source: &str) {
    let mut state = session.state.lock().unwrap();

    state.console_seq += 1;

    let seq = state.console_seq;

    state.console.push_back(ConsoleLine { seq, level: level.to_string(), text, wall, source: source.to_string() });

    if state.console.len() > CONSOLE_LIMIT {
        state.console.pop_front();
    }
}

/// A new target was attached: a worker, or a frame in another process. Prepare it and let it
/// run. Nothing here waits for a reply: a target held at start answers only once released,
/// and the browser runs the commands in the order they were written (spike S1).
fn attached(session: &Arc<Session>, params: &Value) {
    let Some(cdp_session) = params["sessionId"].as_str() else { return };
    let kind = params["targetInfo"]["type"].as_str().unwrap_or("");
    let url = params["targetInfo"]["url"].as_str().unwrap_or("");
    let worker = matches!(kind, "worker" | "shared_worker" | "service_worker");
    let post = |method: &str, params: Value| {
        let _ = session.client.post(method, params, Some(cdp_session));
    };

    // The control strip's window, opened a moment ago: no probe goes into it.
    if kind == "page" {
        let mut state = session.state.lock().unwrap();

        if state.strip_pending && state.strip.is_none() {
            state.strip = Some(cdp_session.to_string());
            state.strip_pending = false;
        }
    }

    // The browser's own targets (its UI, extension workers) are released untouched.
    if injectable(url) && (worker || kind == "iframe") {
        if kind == "iframe" {
            post("Page.enable", json!({}));
            post("Page.setBypassCSP", json!({ "enabled": true }));
            post("Page.addScriptToEvaluateOnNewDocument", json!({ "source": session.source }));
        }

        post("Runtime.enable", json!({}));
        post("Runtime.addBinding", json!({ "name": session.binding }));

        if worker {
            let mut state = session.state.lock().unwrap();

            state.worker_urls.insert(cdp_session.to_string(), url.to_string());
            state.waiting_workers.insert(cdp_session.to_string());
            drop(state);

            // A worker held at start has no WebGPU interfaces yet and blocks on self.location,
            // so the probe goes in at its first statement instead (see Debugger.paused above).
            post("Debugger.enable", json!({}));
            post("Debugger.setInstrumentationBreakpoint", json!({ "instrumentation": "beforeScriptExecution" }));
        }

        // Auto-attach is not recursive: nested workers need it set on their parent.
        post("Target.setAutoAttach", json!({ "autoAttach": true, "waitForDebuggerOnStart": true, "flatten": true }));
    }

    post("Runtime.runIfWaitingForDebugger", json!({}));
}
