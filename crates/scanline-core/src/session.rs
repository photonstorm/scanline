//! One debugging session: a browser, the page in it, and the probes inside the page.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
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

#[derive(Default)]
pub struct State {
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
    worker_urls: HashMap<String, String>,
    /// Workers stopped at start, waiting for the instrumentation pause where the probe goes in.
    waiting_workers: HashSet<String>,
}

pub struct SessionOptions {
    pub url: String,
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
}

pub struct Session {
    pub id: String,
    pub profile: Profile,
    pub headless: bool,
    pub level: String,
    pub unmodified: bool,
    pub dir: PathBuf,
    pub browser_version: String,
    pub state: Mutex<State>,
    /// Woken whenever an event is queued or an instance arrives.
    pub changed: Notify,
    browser: Browser,
    client: Client,
    page: String,
    key: String,
    binding: String,
    source: String,
    /// The hidden page captures are replayed in, once one has been needed.
    replay: tokio::sync::Mutex<Option<ReplayPage>>,
}

/// The replay page: a second, hidden target in the session's browser, on the same GPU.
struct ReplayPage {
    cdp_session: String,
    /// Captures whose stream and blobs it already holds.
    loaded: HashSet<String>,
}

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

impl Session {
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
            extra_args: Vec::new(),
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
            "probeVersion": env!("CARGO_PKG_VERSION"),
        });

        // The sourceURL names the probe's script, so the probe can tell its own stack frames from
        // the page's when it records where an object was created.
        let source = format!("(() => {{ const __SCANLINE_CONFIG__ = {config};\n{PROBE}\n}})();\n//# sourceURL=scanline-probe.js");

        // Find the page the browser opened and attach to it.
        let targets = client.send("Target.getTargets", json!({}), None).await?;
        let target = targets["targetInfos"]
            .as_array()
            .and_then(|list| list.iter().find(|info| info["type"] == "page"))
            .and_then(|info| info["targetId"].as_str())
            .ok_or_else(|| anyhow!("The browser opened no page."))?
            .to_string();

        let attached = client.send("Target.attachToTarget", json!({ "targetId": target, "flatten": true }), None).await?;
        let page = attached["sessionId"].as_str().ok_or_else(|| anyhow!("The browser gave no session for its page."))?.to_string();

        let session = Arc::new(Session {
            id,
            profile: options.profile,
            headless: options.headless,
            level: options.level.clone(),
            unmodified: options.unmodified,
            dir,
            browser_version: version["product"].as_str().unwrap_or("unknown").to_string(),
            state: Mutex::new(State { url: options.url.clone(), ..State::default() }),
            changed: Notify::new(),
            browser,
            client: client.clone(),
            page: page.clone(),
            key,
            binding,
            source,
            replay: tokio::sync::Mutex::new(None),
        });

        // Listen before anything can happen.
        tokio::spawn(pump(session.clone(), client.subscribe()));

        let p = Some(page.as_str());

        client.send("Page.enable", json!({}), p).await?;
        // The probe opens a data channel and compiles run-until expressions; a page's
        // Content Security Policy must not stop it.
        client.send("Page.setBypassCSP", json!({ "enabled": true }), p).await?;
        client.send("Page.addScriptToEvaluateOnNewDocument", json!({ "source": session.source }), p).await?;
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

        session.navigate(&options.url).await?;

        Ok(session)
    }

    /// Loads a URL and waits for its load event (or 30 seconds, whichever is first).
    pub async fn navigate(&self, url: &str) -> Result<()> {
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

            self.client.send("Runtime.evaluate", json!({ "expression": REPLAY }), Some(&cdp_session)).await.context("loading the replay script")?;

            *page = Some(ReplayPage { cdp_session, loaded: HashSet::new() });
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

        // A few megabytes of blobs to a call.
        let count = stream["blobs"].as_array().map_or(0, Vec::len);
        let mut from = 0;

        while from < count {
            let mut batch = Vec::new();
            let mut size = 0;

            while from + batch.len() < count && (batch.is_empty() || size < 6_000_000) {
                let packed = pack(&blob(from + batch.len())?)?;

                size += packed.len();
                batch.push(packed);
            }

            let sent = batch.len();

            self.replay_on(&mut page, "blobs", &json!({ "key": key, "from": from, "blobs": batch }), Duration::from_secs(60)).await?;
            from += sent;
        }

        if let Some(page) = page.as_mut() {
            page.loaded.insert(key.to_string());
        }

        Ok(())
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

    pub async fn close(&self) {
        self.browser.close().await;
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

        handle(&session, event);
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
                    }

                    state.instances.push(instance);
                    drop(state);
                    session.changed.notify_waiters();
                }
                "" => {}
                kind => {
                    let mut data = payload.clone();

                    if let Some(object) = data.as_object_mut() {
                        object.remove("t");
                    }

                    session.queue(kind, data);
                }
            }
        }

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

            console(session, params["type"].as_str().unwrap_or("log"), text, params["timestamp"].as_f64().unwrap_or(0.0), "console");
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
