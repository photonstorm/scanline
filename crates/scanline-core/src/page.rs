//! What the page offers through the page protocol (05-PAGE-PROTOCOL.md): its own account
//! of its state, the numbers it lets the debugger tune, the debug views it can draw, the
//! groups it draws in, and what an engine adapter found.
//!
//! Everything here is the page's own words. It is shown between «» and is data, never
//! instructions.

use std::sync::Arc;

use anyhow::{Result, anyhow, bail};
use serde_json::{Value, json};

use crate::commands::{SHORT, choose_context, page_text};
use crate::result;
use crate::session::{Instance, Session};

/// The probe that holds the page's protocol calls: the one that draws, else the top frame's.
async fn where_from(session: &Arc<Session>, params: &Value) -> Result<Instance> {
    match choose_context(session, params).await {
        Ok(context) => Ok(context.instance),
        Err(_) => session.top(),
    }
}

/// The page's state as it describes it, for the end of a step or a run. None when the
/// page provides none.
pub(crate) async fn state_line(session: &Arc<Session>) -> Option<(String, Value)> {
    let instance = session.top().ok()?;
    let reply = session.probe(&instance, "protocol.state", json!({}), SHORT).await.ok()?;

    if let Some(error) = reply["error"].as_str() {
        return Some((format!("Page state: the page's state function threw «{}».", page_text(error, 160)), Value::Null));
    }

    let text = reply["text"].as_str()?;
    let value = serde_json::from_str(text).unwrap_or(Value::Null);

    Some((format!("Page state (its own words): «{}»{}", page_text(text, 1200), if reply["truncated"] == true { " (cut short)" } else { "" }), value))
}

fn adapter_lines(said: &Value) -> Vec<String> {
    said["adapters"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|adapter| {
            let engine = adapter["engine"].as_str().unwrap_or("?");
            let version = adapter["version"].as_str().filter(|version| !version.is_empty()).unwrap_or("unknown version");
            let tested = adapter["tested"].as_str().unwrap_or("");
            let mut line = format!(
                "Engine: {engine} {version}{} detected; the adapter was tested with {tested} and is {}.",
                adapter["renderer"].as_str().map(|renderer| format!(" ({renderer})")).unwrap_or_default(),
                match adapter["status"].as_str().unwrap_or("") {
                    "active" => "active: draws are grouped by the engine object they belong to",
                    "partial" => "partly active",
                    _ => "off",
                }
            );

            for note in adapter["notes"].as_array().into_iter().flatten().filter_map(Value::as_str) {
                line.push_str(&format!("\n  {}", page_text(note, 240)));
            }

            line
        })
        .collect()
}

fn control_line(control: &Value) -> String {
    let id = control["id"].as_str().unwrap_or("");
    let kind = control["type"].as_str().unwrap_or("");
    let takes = match kind {
        "number" => match (control["min"].as_f64(), control["max"].as_f64()) {
            (Some(min), Some(max)) => format!("number {min} to {max}"),
            (Some(min), None) => format!("number from {min}"),
            (None, Some(max)) => format!("number up to {max}"),
            _ => "number".to_string(),
        },
        "enum" => format!("one of {}", page_text(&control["options"].to_string(), 120)),
        other => other.to_string(),
    };

    format!(
        "  «{}» = {}  ({takes})  «{}»{}",
        page_text(id, 60),
        page_text(&control["value"].to_string(), 80),
        page_text(control["label"].as_str().unwrap_or(""), 80),
        control["error"].as_str().map(|error| format!("  its get() threw «{}»", page_text(error, 100))).unwrap_or_default()
    )
}

fn group_lines(groups: &Value, most: usize) -> Vec<String> {
    let rows: Vec<&Value> = groups["rows"].as_array().into_iter().flatten().collect();
    let mut lines: Vec<String> = rows
        .iter()
        .take(most)
        .map(|row| {
            format!(
                "  {}«{}»  {} draw{}{}{}",
                "  ".repeat(row["depth"].as_u64().unwrap_or(0) as usize),
                page_text(row["name"].as_str().unwrap_or(""), 60),
                row["draws"],
                if row["draws"] == 1 { "" } else { "s" },
                if row["entity"].is_object() { format!("  of {}", crate::capture::entity_text(&row["entity"])) } else { String::new() },
                if row["open"] == true { "  (left open at the end of the frame)" } else { "" }
            )
        })
        .collect();

    let total = groups["total"].as_u64().unwrap_or(rows.len() as u64) as usize;

    if total > lines.len() {
        lines.push(format!("  … and {} more groups. A capture has them all: capture, then pass_tree.", total - lines.len()));
    }

    lines
}

/// Everything the page has said, or one part of it, or a change to it.
pub async fn page(session: &Arc<Session>, params: &Value) -> Result<Value> {
    let instance = where_from(session, params).await?;
    let call = params["call"].as_str().unwrap_or("all");

    match call {
        "set_control" => return set_control(session, &instance, params).await,
        "checkpoint" => return checkpoint(session, &instance).await,
        "restore" => return restore(session, &instance, params).await,
        "time" => return time(session, &instance, params).await,
        "all" | "state" | "controls" | "views" | "groups" | "passes" | "marks" => {}
        other => bail!(
            "page has no call \"{other}\". Calls are state, controls, set_control, views, groups, passes, marks, time, checkpoint and restore; with none, everything the page offers is listed."
        ),
    }

    let said = session.probe(&instance, "protocol.describe", json!({ "groups": 400 }), SHORT).await?;
    let want = |part: &str| call == "all" || call == part;
    let mut lines = Vec::new();

    if call == "all" {
        if said["present"] != true {
            lines.push("This session is unmodified, so the page protocol's global is not defined and no engine adapter is installed: the page runs as it would outside Scanline.".to_string());
        } else {
            let used = said["used"].as_array().map(Vec::len).unwrap_or(0);

            lines.push(if used > 0 {
                format!(
                    "The page uses the page protocol (version {}): {} of its calls so far. What follows is the page's own account, in «».",
                    said["version"], used
                )
            } else {
                format!("The page has made no page-protocol calls (the __scanline global, version {}, is there for it to use).", said["version"])
            });
        }

        lines.extend(adapter_lines(&said));

        for engine in said["engine"].as_array().into_iter().flatten() {
            if let Some(text) = engine["text"].as_str() {
                lines.push(format!("  What {} says of itself: «{}»", engine["engine"].as_str().unwrap_or("the engine"), page_text(text, 1500)));
            }
        }
    }

    if want("state") {
        match (said["state"]["text"].as_str(), said["state"]["error"].as_str()) {
            (Some(text), _) => {
                lines.push(format!("State: «{}»{}", page_text(text, 3000), if said["state"]["truncated"] == true { " (cut short)" } else { "" }));

                if said["stateSchema"].is_object() {
                    lines.push(format!("  What the fields mean: «{}»", page_text(&said["stateSchema"].to_string(), 1200)));
                }
            }
            (None, Some(error)) => lines.push(format!("State: the page's state function threw «{}».", page_text(error, 200))),
            _ if call == "state" => lines.push("The page provides no state (state.provide). eval(expression) reads anything it keeps on a global.".into()),
            _ => {}
        }
    }

    if want("controls") {
        let controls: Vec<&Value> = said["controls"].as_array().into_iter().flatten().collect();

        if !controls.is_empty() {
            lines.push(format!("Controls ({}). Set one with page(call: \"set_control\", id, value):", controls.len()));
            lines.extend(controls.iter().map(|control| control_line(control)));
        } else if call == "controls" {
            lines.push("The page registered no controls (controls.register). patch_uniform changes a shader input directly.".into());
        }

        let exposed: Vec<&Value> = said["exposed"].as_array().into_iter().flatten().collect();

        if !exposed.is_empty() {
            lines.push("Uniforms the page says are safe and meaningful to override (patch_uniform):".into());

            for entry in exposed.iter().take(20) {
                let handle = session.object_handle(&instance, entry["kind"].as_str().unwrap_or("program"), entry["id"].as_i64().unwrap_or(0));

                lines.push(format!(
                    "  {handle}: «{}»",
                    if entry["names"] == true { "all of them".to_string() } else { page_text(&entry["names"].to_string(), 200) }
                ));
            }
        }
    }

    if want("views") {
        let views: Vec<&Value> = said["views"].as_array().into_iter().flatten().collect();

        if !views.is_empty() {
            lines.push(format!("Debug views the page can draw ({}). Switch one with live_view(view, on):", views.len()));

            for view in &views {
                lines.push(format!(
                    "  «{}» {}  «{}»{}",
                    page_text(view["id"].as_str().unwrap_or(""), 60),
                    if view["on"] == true { "ON " } else { "off" },
                    page_text(view["label"].as_str().unwrap_or(""), 80),
                    view["description"].as_str().filter(|text| !text.is_empty()).map(|text| format!(": «{}»", page_text(text, 200))).unwrap_or_default()
                ));
            }
        } else if call == "views" {
            lines.push("The page registered no debug views (views.register). view(capture, kind) draws overdraw and wireframe from a capture.".into());
        }
    }

    if want("passes") {
        if let Some(passes) = said["passes"].as_array().filter(|passes| !passes.is_empty()) {
            lines.push("The frame's passes, as the page describes them:".into());

            for pass in passes.iter().take(40) {
                lines.push(format!(
                    "  «{}»{}{}",
                    page_text(pass["name"].as_str().unwrap_or(&pass.to_string()), 60),
                    pass["purpose"].as_str().map(|text| format!(": «{}»", page_text(text, 200))).unwrap_or_default(),
                    if pass["targets"].is_null() {
                        String::new()
                    } else {
                        format!("  → «{}»", page_text(&pass["targets"].to_string().replace('"', ""), 80))
                    }
                ));
            }
        } else if call == "passes" {
            lines.push("The page described no passes (passes.describe). A capture's pass_tree shows the passes it really made.".into());
        }
    }

    if want("groups") {
        let groups = &said["groups"];

        if groups["total"].as_u64().unwrap_or(0) > 0 {
            lines.push(format!(
                "Last frame's draws by named group ({} group{}{}):",
                groups["total"],
                if groups["total"] == 1 { "" } else { "s" },
                match groups["loose"].as_u64().unwrap_or(0) {
                    0 => String::new(),
                    loose => format!("; {loose} draw{} in none", if loose == 1 { "" } else { "s" }),
                }
            ));
            lines.extend(group_lines(groups, if call == "groups" { 200 } else { 30 }));
        } else if call == "groups" {
            lines.push("No draw of the last frame was in a named group: the page names none (group, push/pop) and no engine adapter is active.".into());
        }
    }

    if want("marks") {
        let marks: Vec<&Value> = said["marks"].as_array().into_iter().flatten().collect();

        if !marks.is_empty() {
            lines.push(format!("Marks the page has made (latest {}). run_until(until: {{event: \"name\"}}) runs to the next one of a name:", marks.len()));

            for mark in marks.iter().rev().take(if call == "marks" { 50 } else { 8 }).rev() {
                lines.push(format!(
                    "  frame {:>5}  «{}»{}",
                    mark["frame"],
                    page_text(mark["name"].as_str().unwrap_or(""), 80),
                    if mark["data"].is_null() { String::new() } else { format!("  «{}»", page_text(&mark["data"].to_string(), 160)) }
                ));
            }
        } else if call == "marks" {
            lines.push("The page has made no marks (mark).".into());
        }
    }

    if call == "all" {
        let time: Vec<&str> = said["time"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();

        if !time.is_empty() {
            lines.push(format!(
                "The engine offers its own time control: {}. Scanline's pause and step hold the browser's frames and clock and do not need it; page(call: \"time\", action) calls one.",
                time.join(", ")
            ));
        }

        if said["checkpoint"]["save"] == true {
            lines.push(format!(
                "The page can save its state{}: page(call: \"checkpoint\") keeps one, page(call: \"restore\", checkpoint: \"chk_N\") puts it back.",
                if said["checkpoint"]["restore"] == true { " and restore it" } else { " (it offers no restore)" }
            ));
        }

        if said["explicitFrames"].as_u64().unwrap_or(0) > 0 {
            lines.push(format!(
                "The page marks its own frames (frame.end called {} times). Scanline still counts frames by the browser's frame callbacks and timers.",
                said["explicitFrames"]
            ));
        }
    }

    Ok(result(lines.join("\n"), said))
}

async fn set_control(session: &Arc<Session>, instance: &Instance, params: &Value) -> Result<Value> {
    let id = params["id"]
        .as_str()
        .ok_or_else(|| anyhow!("page(call: \"set_control\") needs id: the control's name, and value. page(call: \"controls\") lists them."))?;

    if params["value"].is_null() {
        bail!("page(call: \"set_control\") needs value: what to set «{}» to.", page_text(id, 60));
    }

    let reply = session.probe(instance, "protocol.set", json!({ "id": id, "value": params["value"] }), SHORT).await?;

    if reply["unknown"] == true {
        let known: Vec<String> =
            reply["known"].as_array().into_iter().flatten().filter_map(Value::as_str).map(|name| format!("«{}»", page_text(name, 60))).collect();

        bail!(
            "The page has no control «{}». {}",
            page_text(id, 60),
            if known.is_empty() { "It registered none.".to_string() } else { format!("It has: {}.", known.join(", ")) }
        );
    }

    if let Some(why) = reply["refused"].as_str() {
        bail!("«{}» was not set: {why}.\n{}", page_text(id, 60), control_line(&reply["control"]));
    }

    Ok(result(
        format!(
            "«{}» was {} and is now {}. It holds from the next frame; step and look.\n{}",
            page_text(id, 60),
            page_text(&reply["before"].to_string(), 80),
            page_text(&reply["control"]["value"].to_string(), 80),
            control_line(&reply["control"])
        ),
        reply,
    ))
}

async fn checkpoint(session: &Arc<Session>, instance: &Instance) -> Result<Value> {
    let reply = session.probe(instance, "protocol.save", json!({}), SHORT).await?;

    if reply["unknown"] == true {
        bail!("The page offers no checkpoints (checkpoint.provide). save_run and replay_run go back to an earlier frame by playing the input again.");
    }

    let Some(state) = reply["state"].as_str() else { bail!("The page's save() returned nothing that can be kept.") };
    let handle = {
        let mut held = session.state.lock().unwrap();

        held.next_checkpoint += 1;

        let handle = format!("chk_{}", held.next_checkpoint);

        held.checkpoints.insert(handle.clone(), (state.to_string(), reply["frame"].as_u64().unwrap_or(0)));
        handle
    };

    Ok(result(
        format!(
            "{handle}: the page's state at frame {} ({} bytes), as its save() gave it. page(call: \"restore\", checkpoint: \"{handle}\") puts it back. It is the game's state as the page chose to save it, not the GPU's.",
            reply["frame"],
            state.len()
        ),
        json!({ "checkpoint": handle, "frame": reply["frame"], "bytes": state.len() }),
    ))
}

async fn restore(session: &Arc<Session>, instance: &Instance, params: &Value) -> Result<Value> {
    let handle = params["checkpoint"]
        .as_str()
        .ok_or_else(|| anyhow!("page(call: \"restore\") needs checkpoint: a handle such as chk_1, from page(call: \"checkpoint\")."))?;
    let (state, frame) = session
        .state
        .lock()
        .unwrap()
        .checkpoints
        .get(handle)
        .cloned()
        .ok_or_else(|| anyhow!("There is no checkpoint {handle} in this session. page(call: \"checkpoint\") makes one."))?;
    let reply = session.probe(instance, "protocol.restore", json!({ "state": state }), SHORT).await?;

    if reply["unknown"] == true {
        bail!("The page offers no restore (checkpoint.provide gave save only).");
    }

    Ok(result(
        format!(
            "The page's restore() was given {handle} (saved at frame {frame}). The frame number is now {}: the page's state went back, the browser's clock did not. Step and look.",
            reply["frame"]
        ),
        json!({ "checkpoint": handle, "saved_at": frame, "frame": reply["frame"] }),
    ))
}

async fn time(session: &Arc<Session>, instance: &Instance, params: &Value) -> Result<Value> {
    let action = params["action"]
        .as_str()
        .ok_or_else(|| anyhow!("page(call: \"time\") needs action: pause, resume, step or setScale (with value), as the engine provided them."))?;
    let reply = session.probe(instance, "protocol.time", json!({ "call": action, "value": params["value"] }), SHORT).await?;

    if reply["unknown"] == true {
        let known: Vec<&str> = reply["known"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();

        bail!(
            "The engine provides no \"{action}\". {}",
            if known.is_empty() {
                "It provided no time control (time.provide); pause, step and resume work on any page.".to_string()
            } else {
                format!("It provides: {}.", known.join(", "))
            }
        );
    }

    Ok(result(
        format!(
            "Called the engine's own {action}({}). This is the engine's time, apart from Scanline's pause and step, which hold the browser's frames.",
            if params["value"].is_null() { String::new() } else { params["value"].to_string() }
        ),
        reply,
    ))
}

/// A debug view the page registered, switched on or off.
pub async fn live_view(session: &Arc<Session>, params: &Value) -> Result<Value> {
    let instance = where_from(session, params).await?;
    let said = session.probe(&instance, "protocol.describe", json!({ "groups": 0 }), SHORT).await?;
    let views: Vec<&Value> = said["views"].as_array().into_iter().flatten().collect();
    let listed = || {
        views
            .iter()
            .map(|view| format!("«{}» ({})", page_text(view["id"].as_str().unwrap_or(""), 60), if view["on"] == true { "on" } else { "off" }))
            .collect::<Vec<_>>()
            .join(", ")
    };

    let Some(wanted) = params["view"].as_str() else {
        return Ok(result(
            if views.is_empty() {
                "live_view(view) draws the running page another way: overdraw, wireframe, draw_id or depth. view: \"off\" switches it off. The page registered no debug views of its own (views.register).".to_string()
            } else {
                format!(
                    "Views the page can draw: {}. live_view(view: \"id\") switches one on; on: false, or view: \"off\" for all, switches off. Scanline's own, on any page: overdraw, wireframe, draw_id, depth.",
                    listed()
                )
            },
            json!({ "views": said["views"] }),
        ));
    };

    if wanted == "off" {
        let mut switched = Vec::new();

        for view in views.iter().filter(|view| view["on"] == true) {
            let id = view["id"].as_str().unwrap_or("");

            session.probe(&instance, "protocol.view", json!({ "id": id, "on": false }), SHORT).await?;
            switched.push(format!("«{}»", page_text(id, 60)));
        }

        let own = crate::patch::views_off(session).await;

        if own > 0 {
            switched.push(format!("{own} of Scanline's own"));
        }

        return Ok(result(
            if switched.is_empty() { "No view was on.".to_string() } else { format!("Switched off: {}. It shows from the next frame.", switched.join(", ")) },
            json!({ "off": switched.len() }),
        ));
    }

    // Scanline's own views need nothing from the page. A page's view of the same name comes first.
    if !views.iter().any(|view| view["id"] == wanted) {
        if ["overdraw", "wireframe", "draw_id", "depth"].contains(&wanted) {
            if params["on"] == false {
                let own = crate::patch::views_off(session).await;

                return Ok(result(
                    if own > 0 { "Switched off. It shows from the next frame." } else { "No view of Scanline's own was on." },
                    json!({ "off": own }),
                ));
            }

            // One at a time: two would draw over each other.
            crate::patch::views_off(session).await;

            return crate::patch::view(session, params, wanted).await;
        }

        if ["stencil", "mip", "nan"].contains(&wanted) {
            bail!(
                "The {wanted} view reads a finished frame and is not drawn on the running page. view(capture, view: \"{wanted}\") draws it from a capture. On the running page: overdraw, wireframe, draw_id, depth{}.",
                if views.is_empty() { String::new() } else { format!(", and the page's own views: {}", listed()) }
            );
        }
    }

    let on = params["on"].as_bool().unwrap_or(true);
    let reply = session.probe(&instance, "protocol.view", json!({ "id": wanted, "on": on }), SHORT).await?;

    if reply["unknown"] == true {
        bail!(
            "The page has no view «{}». {}",
            page_text(wanted, 60),
            if views.is_empty() { "It registered none.".to_string() } else { format!("It has: {}.", listed()) }
        );
    }

    Ok(result(
        format!(
            "«{}» is {}: «{}». The page draws it itself, from the next frame; step and take a screenshot. live_view(view: \"off\") switches every view off.",
            page_text(wanted, 60),
            if on { "on" } else { "off" },
            page_text(reply["description"].as_str().filter(|text| !text.is_empty()).or(reply["label"].as_str()).unwrap_or(""), 200)
        ),
        reply,
    ))
}
