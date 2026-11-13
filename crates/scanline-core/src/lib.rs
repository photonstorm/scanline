//! The Scanline host: sessions and the control API.
//!
//! Every capability is a command here. The MCP server, the command line and the window are
//! clients of this one API; no feature exists in only one of them (01-PRD.md, principle 2).
//!
//! A command takes a JSON object and returns `{ summary, data, images }`:
//! - `summary` is what an agent reads: a sentence or two, then compact rows.
//! - `data` is the same result, structured, for scripts.
//! - `images` lists files written for this result; `view` is the one sized for an agent.

mod analysis;
mod audio;
mod capture;
mod check;
mod commands;
mod handoff;
mod inventory;
mod keys;
mod network;
mod notes;
mod page;
mod patch;
mod runs;
mod session;
mod takes;
pub mod skills;
pub mod tiers;
mod tools;
mod trace;
mod viewer;
mod watch;

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use anyhow::{Result, anyhow, bail};
use serde_json::{Value, json};

pub use session::{Instance, Session, SessionOptions};
pub use tools::{TOOLS, Tool, help};

pub struct Host {
    /// Where artefacts and the runtime file live.
    pub home: PathBuf,
    /// Captures and their blobs.
    pub store: scanline_store::Store,
    /// What a client may do, fixed when the host starts (tiers.rs).
    pub tiers: tiers::Tiers,
    sessions: Mutex<BTreeMap<String, Arc<Session>>>,
    next_session: AtomicU32,
    /// Every command run, newest last: what the person follows the agent by.
    activity: Mutex<std::collections::VecDeque<Value>>,
    next_activity: std::sync::atomic::AtomicU64,
    /// Captures still being finished in the background (capture(quick: true)), by handle: the
    /// session finishing each, and what it ends with (an error's text, or nothing).
    finishing: Mutex<std::collections::HashMap<String, (String, Finished)>>,
}

/// How a capture's background work ended, once it has: Ok, or why not.
type Finished = tokio::sync::watch::Receiver<Option<std::result::Result<(), String>>>;

/// How many commands the activity log remembers.
const ACTIVITY: usize = 400;

/// The per-user directory Scanline keeps its files in. `SCANLINE_HOME` overrides it.
pub fn default_home() -> PathBuf {
    if let Some(home) = std::env::var_os("SCANLINE_HOME") {
        return PathBuf::from(home);
    }

    let user = PathBuf::from(std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).unwrap_or_default());

    if cfg!(target_os = "macos") {
        user.join("Library/Application Support/Scanline")
    } else if cfg!(target_os = "windows") {
        std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or(user).join("Scanline")
    } else {
        user.join(".local/share/scanline")
    }
}

fn clip_line(text: &str, most: usize) -> String {
    if text.chars().count() > most { format!("{}…", text.chars().take(most).collect::<String>()) } else { text.to_string() }
}

/// What a session is busy with (a capture, stage by stage), read from the host alone: the
/// page may be too busy to answer while it is.
fn progress(session: &session::Session) -> Value {
    let state = session.state.lock().unwrap();

    match &state.busy {
        None => result(format!("{} is not busy.", session.id), json!({ "busy": null })),
        Some(busy) => {
            let seconds = busy.started.elapsed().as_secs_f64();
            let detail = if busy.detail.is_empty() { String::new() } else { format!(" ({})", busy.detail) };

            result(
                format!("{}: {} for {seconds:.0} s. Now: {}{detail}.", session.id, busy.what, busy.stage),
                json!({ "busy": { "what": busy.what, "capture": busy.capture, "stage": busy.stage, "detail": busy.detail, "seconds": seconds, "stage_seconds": busy.stage_started.elapsed().as_secs_f64(), "done": busy.stages.iter().map(|(stage, ms)| json!({ "stage": stage, "ms": ms })).collect::<Vec<_>>() } }),
            )
        }
    }
}

pub fn result(summary: impl Into<String>, data: Value) -> Value {
    json!({ "summary": summary.into(), "data": data, "images": [] })
}

impl Host {
    /// A host with the tiers the environment asks for.
    pub fn new(home: PathBuf) -> Result<Arc<Self>> {
        Self::with_tiers(home, tiers::Tiers::from_env()?)
    }

    pub fn with_tiers(home: PathBuf, tiers: tiers::Tiers) -> Result<Arc<Self>> {
        let store = scanline_store::Store::open(home.join("artefacts"))?;

        Ok(Arc::new(Host {
            home,
            store,
            tiers,
            sessions: Mutex::new(BTreeMap::new()),
            next_session: AtomicU32::new(1),
            activity: Mutex::new(std::collections::VecDeque::new()),
            next_activity: std::sync::atomic::AtomicU64::new(1),
            finishing: Mutex::new(std::collections::HashMap::new()),
        }))
    }

    /// Notes that a capture is being finished in the background by a session; the sender is
    /// told how it ends.
    pub(crate) fn finishing(&self, handle: &str, session: &str) -> tokio::sync::watch::Sender<Option<std::result::Result<(), String>>> {
        let (send, receive) = tokio::sync::watch::channel(None);

        self.finishing.lock().unwrap().insert(handle.to_string(), (session.to_string(), receive));

        send
    }

    /// The capture's background work is over (its outcome is in the capture itself).
    pub(crate) fn finished(&self, handle: &str) {
        self.finishing.lock().unwrap().remove(handle);
    }

    /// Whether a capture is still being finished in the background.
    pub fn is_finishing(&self, handle: &str) -> bool {
        self.finishing.lock().unwrap().contains_key(handle)
    }

    /// Waits until a capture's textures are in and it has been replayed, where it was taken
    /// with quick: true and that is still under way. Anything that replays a capture or reads
    /// its blobs waits here first.
    pub(crate) async fn ready(&self, handle: &str) -> Result<()> {
        let waiting = self.finishing.lock().unwrap().get(handle).map(|(_, receiver)| receiver.clone());

        if let Some(mut receiver) = waiting {
            let outcome = receiver.wait_for(Option::is_some).await.map(|outcome| outcome.clone()).ok().flatten();

            if let Some(Err(error)) = outcome {
                bail!("{handle} could not be finished: {error}");
            }
        }

        Ok(())
    }

    /// Waits for every capture a session is still finishing: a session finishes one at a time.
    pub(crate) async fn settled(&self, session: &str) {
        let waiting: Vec<(String, Finished)> =
            self.finishing.lock().unwrap().iter().filter(|(_, (owner, _))| owner == session).map(|(handle, (_, receiver))| (handle.clone(), receiver.clone())).collect();

        for (_, mut receiver) in waiting {
            let _ = receiver.wait_for(Option::is_some).await;
        }
    }

    /// A session whose browser can replay a capture: the one named, or any that is open.
    /// A capture outlives its page, but replaying it needs a GPU to run on.
    pub(crate) fn replayer(&self, params: &Value) -> Result<Arc<Session>> {
        if params["session"].is_string() {
            let session = self.session(params)?;

            session.check_alive()?;

            return Ok(session);
        }

        let sessions = self.sessions.lock().unwrap();

        sessions.values().find(|session| session.check_alive().is_ok()).cloned().ok_or_else(|| {
            anyhow!(
                "Replaying a capture needs a browser to run it in, and no session is open. Call launch (any page will do, even about:blank), then ask again."
            )
        })
    }

    /// Runs one command of the control API, and notes it in the activity log.
    pub async fn call(self: &Arc<Self>, method: &str, params: Value) -> Result<Value> {
        let mut params = if params.is_null() { json!({}) } else { params };

        // Who asked: the agent, or the person through the viewer.
        let by = params
            .as_object_mut()
            .and_then(|object| object.remove("_by"))
            .and_then(|by| by.as_str().map(str::to_string))
            .unwrap_or_else(|| "agent".to_string());
        let started = std::time::Instant::now();
        let shown = params.clone();
        let outcome = self.run(method, params, &by).await;

        // The log is not logged, nor is the viewer's own keeping up to date.
        if !(method == "activity" || (by == "viewer")) {
            self.note(method, &shown, &outcome, started.elapsed(), &by);
        }

        outcome
    }

    fn note(&self, method: &str, params: &Value, outcome: &Result<Value>, took: std::time::Duration, by: &str) {
        let clip = |text: &str, most: usize| {
            if text.chars().count() > most { format!("{}…", text.chars().take(most).collect::<String>()) } else { text.to_string() }
        };
        let (ok, said) = match outcome {
            Ok(value) => (true, value["summary"].as_str().unwrap_or("").to_string()),
            Err(error) => (false, format!("{error:#}")),
        };

        let entry = json!({
            "seq": self.next_activity.fetch_add(1, Ordering::SeqCst),
            "at": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|since| since.as_millis() as u64).unwrap_or(0),
            "by": by,
            "command": method,
            "arguments": if params.as_object().is_some_and(|object| object.is_empty()) { String::new() } else { clip(&params.to_string(), 300) },
            "ok": ok,
            "result": clip(&said, 1200),
            "ms": (took.as_secs_f64() * 1000.0).round(),
            "images": outcome.as_ref().ok().map(|value| value["images"].as_array().map(Vec::len).unwrap_or(0)).unwrap_or(0),
        });

        let mut log = self.activity.lock().unwrap();

        log.push_back(entry);

        while log.len() > ACTIVITY {
            log.pop_front();
        }
    }

    /// The commands run since a place in the log.
    fn activity(&self, params: &Value) -> Value {
        let since = params["since"].as_u64().unwrap_or(0);
        let limit = params["limit"].as_u64().unwrap_or(50).clamp(1, ACTIVITY as u64) as usize;
        let log = self.activity.lock().unwrap();
        let all: Vec<&Value> = log.iter().filter(|entry| entry["seq"].as_u64().unwrap_or(0) > since).collect();
        let rows: Vec<Value> = all.iter().skip(all.len().saturating_sub(limit)).map(|entry| (*entry).clone()).collect();
        let next = log.back().and_then(|entry| entry["seq"].as_u64()).unwrap_or(since);

        let mut lines = vec![match rows.len() {
            0 => "No commands have been run since then.".to_string(),
            count => format!("{count} command{}, oldest first:", if count == 1 { "" } else { "s" }),
        }];

        for row in &rows {
            lines.push(format!(
                "  [{}] {}{} {}{}  {} ms{}",
                row["seq"],
                if row["by"] == "person" { "(person) " } else { "" },
                row["command"].as_str().unwrap_or(""),
                row["arguments"].as_str().unwrap_or(""),
                if row["ok"] == true { "" } else { "  FAILED" },
                row["ms"],
                match row["result"].as_str().unwrap_or("").lines().next() {
                    Some(first) if !first.is_empty() => format!("\n      {}", clip_line(first, 200)),
                    _ => String::new(),
                }
            ));
        }

        if !rows.is_empty() {
            lines.push(format!("Pass since: {next} for what is run after this."));
        }

        result(lines.join("\n"), json!({ "activity": rows, "next": next }))
    }

    async fn run(self: &Arc<Self>, method: &str, params: Value, by: &str) -> Result<Value> {
        if !params.is_object() {
            bail!("Arguments to {method} must be a JSON object.");
        }

        // A session whose browser has gone can still be read (console, events) and closed.
        // Everything else needs the page, and says plainly when it is not there.
        let live = || -> Result<Arc<Session>> {
            let session = self.session(&params)?;

            session.check_alive()?;

            Ok(session)
        };

        // The tiers bound what a client may ask. What the person does in the Scanline app
        // or the viewer is the person's own, and theirs to do.
        if by != "person" {
            tiers::check(self, method, &params, self.session(&params).ok().as_ref())?;
        }

        // One owner of the input at a time. While the person has it, the agent may look but
        // may not move time or send input: that would fight them for the game.
        if matches!(method, "input" | "step" | "run_until" | "resume" | "navigate" | "replay_run" | "policy") || (method == "take" && params["action"] == "play") {
            if let Ok(session) = self.session(&params) {
                let state = session.state.lock().unwrap();

                // Input sent as the person's own is the person's, whoever typed the command, and
                // what the person does through the app's toolbar is theirs too.
                if state.owner == "human" && by != "person" && !(method == "input" && params["as_person"] == true) {
                    let asked = state.request.as_ref().map(|request| format!(" ({}: «{}»)", request.id, request.instruction)).unwrap_or_default();

                    return Err(anyhow!(
                        "The person has the input{asked}, so {method} is not available. Wait for their Debug press with wait(session: \"{}\", request: …), press it yourself with debug, or call take_control to take the input back.",
                        session.id
                    ));
                }
            }
        }

        match method {
            "launch" => commands::launch(self, &params).await,
            "status" => commands::status(&live()?).await,
            "sessions" => Ok(self.list()),
            "activity" => Ok(self.activity(&params)),
            "viewer" => viewer::viewer(self, &live()?, &params).await,
            "progress" => Ok(progress(&*self.session(&params)?)),
            "video" => handoff::video(self, &live()?, &params).await,
            // The Scanline app's texture gallery.
            "thumbnails" => inventory::thumbnails(&live()?, &params).await,
            // The Scanline app's Send to agent button, as the viewer's.
            "send_to_agent" => Ok(viewer::send_to_agent(&*live()?, &params)),
            "navigate" => commands::navigate(&live()?, &params).await,
            "close" => self.close(&params).await,
            "pause" => commands::pause(&live()?).await,
            "emulate" => commands::emulate(&live()?, &params).await,
            "resume" => commands::resume(&live()?, &params).await,
            "step" => commands::step(&live()?, &params).await,
            "run_until" => commands::run_until(&live()?, &params).await,
            "input" => commands::input(&live()?, &params).await,
            "screenshot" if params["capture"].is_string() => capture::screenshot(self, &params).await,
            "pixels" if params["capture"].is_string() => capture::pixels(self, &params).await,
            "screenshot" => commands::screenshot(&live()?, &params).await,
            "pixels" => commands::pixels(&live()?, &params).await,
            "console" => commands::console(&self.session(&params)?, &params).await,
            "stats" => commands::stats(&live()?, &params).await,
            "trace" => trace::trace(&live()?, &params).await,
            "capture" if params["recording"].is_string() => handoff::frame_capture(self, &params).await,
            "capture" if !params["when"].is_null() => handoff::capture_when(self, &live()?, &params).await,
            "capture" => capture::capture(self, &live()?, &params).await,
            "request_human" => handoff::request_human(&live()?, &params).await,
            "take_control" => handoff::take_control(&live()?, &params).await,
            "debug" => handoff::debug(self, &live()?, &params).await,
            "recording" => handoff::recording(self, &params).await,
            "strip" => handoff::strip(&live()?, &params).await,
            "patch_draws" | "patch_state" | "patch_uniform" | "patch_shader" => patch::apply(&live()?, method, &params).await,
            "patch_texture" => patch::apply(&live()?, method, &patch::with_image(self, &params)?).await,
            "patches" => patch::patches(&live()?, &params).await,
            "experiment" => patch::experiment(&live()?, &params).await,
            "policy" => commands::policy(&live()?, &params).await,
            "page" => page::page(&live()?, &params).await,
            "live_view" => page::live_view(&live()?, &params).await,
            "save_run" => runs::save_run(self, &live()?).await,
            "replay_run" => runs::replay_run(self, &live()?, &params).await,
            "take" if matches!(params["action"].as_str(), Some("remove" | "rename")) => takes::take(self, &self.session(&params).or_else(|_| live())?, &params).await,
            "take" => takes::take(self, &live()?, &params).await,
            "takes" => takes::takes(self),
            "note" if params["id"].is_string() => notes::note(self, None, &params).await,
            "note" => notes::note(self, Some(&live()?), &params).await,
            "notes" => notes::notes(self),
            "captures" => capture::captures(self, &params),
            "export" => capture::export(self, &params).await,
            "import" => capture::import(self, &params),
            "pass_tree" => capture::pass_tree(self, &params),
            "attachments" => capture::attachments(self, &params).await,
            "draw_list" => capture::draw_list(self, &params),
            "draw" => capture::draw(self, &params).await,
            "draw_diff" => capture::draw_diff(self, &params),
            "pixel_source" => capture::pixel_source(self, &params).await,
            "query" => capture::query(self, &params),
            "compare" => analysis::compare(self, &params).await,
            "pixel_history" => analysis::pixel_history(self, &params).await,
            "geometry" => analysis::geometry(self, &params).await,
            "shader_analysis" => analysis::shader_analysis(self, &params).await,
            "lint" => analysis::lint(self, &params).await,
            "view" => analysis::view(self, &params).await,
            "profile" => analysis::profile(self, &params).await,
            "resources" => inventory::resources(&live()?, &params).await,
            "resource" => inventory::resource(&live()?, &params).await,
            "memory" => inventory::memory(&live()?, &params).await,
            "region_stats" => commands::region_stats(&live()?, &params).await,
            // Two image files can be compared with no session at all.
            "diff" => commands::diff(self, live().ok().as_ref(), &params).await,
            "assert" => check::assert(self, &live()?, &params).await,
            "eval" => commands::eval(&live()?, &params).await,
            "watch" => watch::watch(&live()?, &params).await,
            "unwatch" => watch::unwatch(&live()?, &params).await,
            "watches" => watch::watches(&live()?, &params).await,
            "watch_set" => watch::watch_set(&live()?, &params).await,
            "watchable" => watch::watchable(&live()?, &params).await,
            "audio" => audio::audio(&live()?, &params).await,
            "audio_node" => audio::audio_node(&live()?, &params).await,
            "audio_patch" => audio::audio_patch(&live()?, &params).await,
            "audio_clip" => audio::audio_clip(self, &live()?, &params).await,
            "events" => commands::events(&self.session(&params)?, &params).await,
            "wait" => commands::wait(&self.session(&params)?, &params).await,
            "help" if params["skill"].is_string() => {
                let name = params["skill"].as_str().unwrap_or("");

                match skills::find(name) {
                    Some(skill) => Ok(result(skill.body(), json!({ "skill": skill.name }))),
                    None => Err(anyhow!("There is no skill \"{name}\".\n\n{}", skills::list())),
                }
            }
            // What is in force on this host is part of the answer about security.
            "help" if params["topic"] == "security" => Ok(result(
                format!("{}\n\nIn force on this host:\n{}", help(Some("security")), self.tiers.describe()),
                json!({ "tiers": { "read": true, "control": self.tiers.control, "patch": self.tiers.patch, "remote_patch": self.tiers.remote_patch, "files": self.tiers.files, "navigate": self.tiers.navigate } }),
            )),
            "help" => Ok(result(help(params["topic"].as_str()), json!({}))),
            other => {
                let names: Vec<&str> = TOOLS.iter().map(|tool| tool.name).collect();

                Err(anyhow!("Unknown command \"{other}\". Commands are: {}. Call help for how they fit together.", names.join(", ")))
            }
        }
    }

    pub fn artefacts(&self) -> PathBuf {
        self.home.join("artefacts")
    }

    pub(crate) fn new_session_id(&self) -> String {
        format!("ses_{}", self.next_session.fetch_add(1, Ordering::SeqCst))
    }

    pub(crate) fn add(&self, session: Arc<Session>) {
        self.sessions.lock().unwrap().insert(session.id.clone(), session);
    }

    fn describe_open(&self) -> String {
        let sessions = self.sessions.lock().unwrap();

        if sessions.is_empty() {
            "No sessions are open. Call launch with a url to start one.".to_string()
        } else {
            format!("Open sessions: {}.", sessions.values().map(|session| format!("{} ({})", session.id, session.url())).collect::<Vec<_>>().join(", "))
        }
    }

    /// The session a command names. With one session open, the name may be left out.
    fn session(&self, params: &Value) -> Result<Arc<Session>> {
        let sessions = self.sessions.lock().unwrap();

        match params["session"].as_str() {
            Some(id) => sessions.get(id).cloned().ok_or_else(|| {
                drop(sessions);
                anyhow!("No session \"{id}\". {}", self.describe_open())
            }),
            None if sessions.len() == 1 => Ok(sessions.values().next().unwrap().clone()),
            None => {
                drop(sessions);
                Err(anyhow!("No session named. {} Pass session: \"ses_N\".", self.describe_open()))
            }
        }
    }

    fn list(&self) -> Value {
        let sessions = self.sessions.lock().unwrap();
        let rows: Vec<Value> = sessions
            .values()
            .map(|session| json!({ "session": session.id, "url": session.url(), "profile": session.profile.name(), "display": session.display }))
            .collect();

        let summary = if rows.is_empty() {
            "No sessions are open. Call launch with a url to start one.".to_string()
        } else {
            format!(
                "{} open:\n{}",
                rows.len(),
                sessions
                    .values()
                    .map(|session| format!("  {}  {}  ({} profile)", session.id, session.url(), session.profile.name()))
                    .collect::<Vec<_>>()
                    .join("\n")
            )
        };

        result(summary, json!({ "sessions": rows }))
    }

    async fn close(&self, params: &Value) -> Result<Value> {
        let session = self.session(params)?;

        self.sessions.lock().unwrap().remove(&session.id);
        session.close().await;

        Ok(result(format!("{} closed. Images it wrote remain in {}.", session.id, session.dir.join("images").display()), json!({ "session": session.id })))
    }

    /// Drops a session whose browser has gone for good, closing what is left of it.
    pub async fn forget(&self, id: &str, reason: &str) {
        let session = self.sessions.lock().unwrap().remove(id);

        if let Some(session) = session {
            session.state.lock().unwrap().dead = Some(reason.to_string());
            session.close().await;
        }
    }

    /// Closes every browser. Called when the host stops.
    pub async fn shutdown(&self) {
        let sessions: Vec<Arc<Session>> = std::mem::take(&mut *self.sessions.lock().unwrap()).into_values().collect();

        for session in sessions {
            session.close().await;
        }
    }
}
