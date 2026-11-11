//! The viewer (01-PRD.md, UI-2 to UI-4): a window in which the person at the machine
//! follows what the agent is doing (the activity log), watches the page's numbers (live
//! graphs), and looks through a capture (draw list, state, targets with zoom and pixel
//! values, shaders).
//!
//! It is a page of the host's own, shown in a window of the supervised browser, and it has
//! no door of its own: everything it shows it asks for through the control API, the same
//! commands an agent uses. What it asks for is marked as the viewer's or the person's, so
//! the activity log shows the agent's work and the person's, and not the viewer's upkeep.

use std::sync::Arc;

use anyhow::{Context, Result, bail};
use base64::Engine;
use serde_json::{Value, json};

use crate::session::Session;
use crate::{Host, result};

/// An image is sent to the viewer inside the reply. One larger than this is left as a path.
const IMAGE_LIMIT: u64 = 12 * 1024 * 1024;

/// What the viewer may ask for unprompted, to keep itself up to date. Anything else it
/// asks for is the person's doing, and is logged as theirs.
const UPKEEP: &[&str] = &["activity", "status", "stats", "memory", "captures", "sessions"];

/// Answers one request from the viewer's page: runs the command and hands the result back.
pub(crate) fn answer(host: Arc<Host>, session: Arc<Session>, asked: Value) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> {
    // Boxed: the viewer can ask for a launch, which starts the loop that calls this.
    Box::pin(answer_now(host, session, asked))
}

async fn answer_now(host: Arc<Host>, session: Arc<Session>, asked: Value) {
    let id = asked["id"].as_u64().unwrap_or(0);
    let method = asked["command"].as_str().unwrap_or("").to_string();
    let mut params = if asked["arguments"].is_object() { asked["arguments"].clone() } else { json!({}) };

    // The viewer looks and does not launch, close or steer: those are the agent's and the
    // strip's. A capture is looked at through this session's browser.
    let outcome = if matches!(method.as_str(), "launch" | "close" | "navigate" | "viewer" | "eval" | "policy") {
        Err(anyhow::anyhow!("The viewer does not run {method}."))
    } else {
        params["_by"] = json!(if asked["person"] == true && !UPKEEP.contains(&method.as_str()) { "person" } else { "viewer" });

        if params["session"].is_null() && !matches!(method.as_str(), "captures" | "sessions" | "activity" | "help") {
            params["session"] = json!(session.id);
        }

        host.call(&method, params).await
    };

    let reply = match outcome {
        Ok(mut value) => {
            // The viewer's page cannot open a file. Its pictures go to it in the reply.
            if let Some(images) = value["images"].as_array_mut() {
                for image in images {
                    let path = image["original"].as_str().or(image["view"].as_str()).map(str::to_string);

                    if let Some(path) = path {
                        let small = std::fs::metadata(&path).is_ok_and(|file| file.len() <= IMAGE_LIMIT);

                        if small {
                            if let Ok(bytes) = std::fs::read(&path) {
                                image["data"] = json!(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)));
                            }
                        }
                    }
                }
            }

            json!({ "ok": true, "result": value })
        }
        Err(error) => json!({ "ok": false, "error": format!("{error:#}") }),
    };

    let _ = session.viewer_eval(&format!("receive({id}, {reply})")).await;
}

/// Opens the viewer, says what it is showing, or shows something in it as the person would.
pub async fn viewer(_host: &Arc<Host>, session: &Arc<Session>, params: &Value) -> Result<Value> {
    let opened = session.open_viewer().await?;
    let mut lines = Vec::new();

    if opened {
        lines.push("The viewer is open in a window of this session's browser. The person can follow every command there (Activity), watch frame time, GPU time, draws and memory (Live), and look through a capture (Capture).".to_string());
    }

    // Show a tab, and a capture or an event of it, as a click would.
    if let Some(tab) = params["show"].as_str() {
        if !["activity", "live", "capture"].contains(&tab) {
            bail!("The viewer has three tabs: activity, live and capture. There is no \"{tab}\".");
        }

        let shown = session
            .viewer_eval(&format!(
                "show({}, {}, {}, {})",
                Value::String(tab.to_string()),
                if params["capture"].is_string() { params["capture"].clone() } else { Value::Null },
                if params["draw"].is_number() { params["draw"].clone() } else { Value::Null },
                if params["pane"].is_string() { params["pane"].clone() } else { Value::Null }
            ))
            .await;

        if shown.is_none() {
            bail!("The viewer did not answer. Close its window and call viewer again.");
        }
    }

    let showing = session.viewer_eval("shown()").await.unwrap_or(Value::Null);

    lines.push(format!(
        "The viewer shows the {} tab{}.",
        showing["tab"].as_str().unwrap_or("?"),
        match showing["tab"].as_str() {
            Some("activity") => format!(": {} commands listed, the latest «{}»", showing["rows"], showing["latest"].as_str().unwrap_or("")),
            Some("live") => format!(": {} samples drawn; {}", showing["samples"], showing["status"].as_str().unwrap_or("")),
            Some("capture") => format!(
                ": {}{}",
                match showing["capture"].as_str() {
                    Some(capture) => format!("{capture}, {} events listed", showing["events"]),
                    None => "no capture chosen".to_string(),
                },
                match showing["draw"].as_i64() {
                    Some(draw) => format!(", event {draw} selected{}", if showing["picture"] == true { " with its target shown" } else { "" }),
                    None => String::new(),
                }
            ),
            _ => String::new(),
        }
    ));

    let mut value = result(lines.join("\n"), json!({ "open": true, "showing": showing }));

    if params["output"] == true {
        let path = session.dir.join("images").join("viewer.png");

        std::fs::create_dir_all(session.dir.join("images")).ok();
        std::fs::write(&path, session.viewer_picture().await?).with_context(|| format!("writing {}", path.display()))?;
        value["images"] = json!([{ "view": path, "original": path, "space": "viewer_px" }]);
    }

    Ok(value)
}
