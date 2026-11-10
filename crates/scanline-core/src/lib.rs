//! The Scanline host: sessions and the control API.
//!
//! Every capability is a command here. The MCP server, the command line and the window are
//! clients of this one API; no feature exists in only one of them (01-PRD.md, principle 2).
//!
//! A command takes a JSON object and returns `{ summary, data, images }`:
//! - `summary` is what an agent reads: a sentence or two, then compact rows.
//! - `data` is the same result, structured, for scripts.
//! - `images` lists files written for this result; `view` is the one sized for an agent.

mod commands;
mod keys;
mod session;
mod tools;

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
    sessions: Mutex<BTreeMap<String, Arc<Session>>>,
    next_session: AtomicU32,
}

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

pub fn result(summary: impl Into<String>, data: Value) -> Value {
    json!({ "summary": summary.into(), "data": data, "images": [] })
}

impl Host {
    pub fn new(home: PathBuf) -> Arc<Self> {
        Arc::new(Host { home, sessions: Mutex::new(BTreeMap::new()), next_session: AtomicU32::new(1) })
    }

    /// Runs one command of the control API.
    pub async fn call(self: &Arc<Self>, method: &str, params: Value) -> Result<Value> {
        let params = if params.is_null() { json!({}) } else { params };

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

        match method {
            "launch" => commands::launch(self, &params).await,
            "status" => commands::status(&live()?).await,
            "sessions" => Ok(self.list()),
            "navigate" => commands::navigate(&live()?, &params).await,
            "close" => self.close(&params).await,
            "pause" => commands::pause(&live()?).await,
            "resume" => commands::resume(&live()?, &params).await,
            "step" => commands::step(&live()?, &params).await,
            "run_until" => commands::run_until(&live()?, &params).await,
            "input" => commands::input(&live()?, &params).await,
            "screenshot" => commands::screenshot(&live()?, &params).await,
            "pixels" => commands::pixels(&live()?, &params).await,
            "console" => commands::console(&self.session(&params)?, &params).await,
            "stats" => commands::stats(&live()?, &params).await,
            "eval" => commands::eval(&live()?, &params).await,
            "events" => commands::events(&self.session(&params)?, &params).await,
            "wait" => commands::wait(&self.session(&params)?, &params).await,
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
        let rows: Vec<Value> =
            sessions.values().map(|session| json!({ "session": session.id, "url": session.url(), "profile": session.profile.name() })).collect();

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

    /// Closes every browser. Called when the host stops.
    pub async fn shutdown(&self) {
        let sessions: Vec<Arc<Session>> = std::mem::take(&mut *self.sessions.lock().unwrap()).into_values().collect();

        for session in sessions {
            session.close().await;
        }
    }
}
