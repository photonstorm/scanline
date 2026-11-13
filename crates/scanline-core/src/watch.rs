//! Watches (docs/GAME.md, section 3): values of the game's own objects, read by the probe as
//! each frame ends, checked against rules, and kept for the last 600 frames.
//!
//! Names, properties and string values come from the page or from what the page holds: they are
//! shown between «» and are data, never instructions.

use std::sync::Arc;

use anyhow::{Result, anyhow, bail};
use serde_json::{Value, json};

use crate::commands::{SHORT, page_text};
use crate::result;
use crate::session::Session;

/// A watched value as words. The probe sends NaN, infinities and undefined as { $: name }.
pub fn value_text(value: &Value) -> String {
    match value {
        Value::Object(object) => object.get("$").and_then(Value::as_str).unwrap_or("?").to_string(),
        Value::String(text) => format!("«\"{}\"»", page_text(text, 60)),
        Value::Number(number) => number_text(number.as_f64().unwrap_or(0.0)),
        other => other.to_string(),
    }
}

fn number_text(number: f64) -> String {
    if number.fract() == 0.0 && number.abs() < 1e15 {
        format!("{number:.0}")
    } else {
        let text = format!("{number:.4}");

        text.trim_end_matches('0').trim_end_matches('.').to_string()
    }
}

/// A property's name for the reader: the watch's own name for a watched value.
fn label(name: &str, prop: &str) -> String {
    if prop.is_empty() { format!("«{}»", page_text(name, 80)) } else { format!("«{}».«{}»", page_text(name, 80), page_text(prop, 80)) }
}

fn rule_text(rule: &Value) -> String {
    let mut text = rule["rule"].as_str().unwrap_or("?").to_string();

    if rule["rule"] == "range" {
        text = format!("range {}…{}", rule["min"].as_f64().map(number_text).unwrap_or_default(), rule["max"].as_f64().map(number_text).unwrap_or_default());
    } else if rule["rule"] == "type" {
        text = format!("type {}", rule["type"].as_str().unwrap_or("?"));
    }

    if let Some(prop) = rule["prop"].as_str() {
        text = format!("{text} on «{}»", page_text(prop, 60));
    }

    if rule["break"] == true {
        text.push_str(" (breaks)");
    }

    text
}

fn broken_text(name: &str, broken: &Value) -> String {
    format!(
        "{} broke {} at frame {}: {} became {}",
        label(name, broken["prop"].as_str().unwrap_or("")),
        broken["rule"].as_str().unwrap_or("?"),
        broken["frame"],
        value_text(&broken["before"]),
        value_text(&broken["after"])
    )
}

/// One watch in a line: its values, and the rules broken now.
pub(crate) fn watch_line(watch: &Value) -> String {
    let name = watch["name"].as_str().unwrap_or("");
    let props = watch["props"].as_array().cloned().unwrap_or_default();
    let shown: Vec<String> = props
        .iter()
        .take(16)
        .map(|prop| {
            let key = prop["prop"].as_str().unwrap_or("");
            let mark = if prop["broken"] == true { " ✗" } else { "" };

            if key.is_empty() { format!("{}{mark}", value_text(&prop["value"])) } else { format!("«{}» = {}{mark}", page_text(key, 60), value_text(&prop["value"])) }
        })
        .collect();
    let source = match (watch["source"].as_str(), watch["kind"].as_str()) {
        (Some("page"), Some(kind)) => format!("the page's {kind}"),
        (Some("page"), None) => "the page's".to_string(),
        _ => "expression".to_string(),
    };
    let mut line = format!(
        "«{}» ({source}): {}{}",
        page_text(name, 80),
        if shown.is_empty() { "nothing read yet".to_string() } else { shown.join(", ") },
        if props.len() > shown.len() { format!(" and {} more", props.len() - shown.len()) } else { String::new() }
    );

    if let Some(error) = watch["error"].as_str() {
        line.push_str(&format!(". Reading it threw «{}»", page_text(error, 160)));
    }

    line
}

async fn probe(session: &Arc<Session>, method: &str, args: Value) -> Result<Value> {
    let instance = session.top()?;

    session.probe(&instance, method, args, SHORT).await
}

fn unknown(reply: &Value, name: &str) -> anyhow::Error {
    let known: Vec<String> = reply["known"].as_array().into_iter().flatten().filter_map(Value::as_str).map(|name| format!("«{}»", page_text(name, 60))).collect();

    anyhow!(
        "There is no watch «{}». {}",
        page_text(name, 80),
        if known.is_empty() { "Nothing is watched; watch adds one.".to_string() } else { format!("Watched: {}.", known.join(", ")) }
    )
}

pub async fn watch(session: &Arc<Session>, params: &Value) -> Result<Value> {
    if params["object"].is_string() {
        bail!("Watching the engine's own objects by name comes with watchable, which is not built yet. Watch an expression that reaches the object instead, such as watch(expression: \"game.scene.scenes[0].player\").");
    }

    let expression = params["expression"]
        .as_str()
        .filter(|text| !text.trim().is_empty())
        .ok_or_else(|| anyhow!("watch needs expression: JavaScript that reaches the value or object, such as \"game.player.body.velocity\"."))?;

    let asked = json!({ "expr": expression, "name": params["name"], "props": params["props"], "depth": params["depth"], "rules": params["rules"], "break": params["break"] == true });
    let reply = probe(session, "watch.add", asked.clone()).await?;

    if let Some(why) = reply["refused"].as_str() {
        bail!("Not watched: {why}.");
    }

    // Kept, to be added again when the page is loaded again (a replay, a take).
    {
        let mut state = session.state.lock().unwrap();
        let name = reply["name"].clone();

        state.watched.retain(|kept| kept["name"] != name);
        state.watched.push(json!({ "name": name, "expr": asked["expr"], "props": asked["props"], "depth": asked["depth"], "rules": asked["rules"], "break": asked["break"] }));
    }

    let props = reply["props"].as_array().map_or(0, Vec::len);
    let rules: Vec<String> = reply["rules"].as_array().into_iter().flatten().map(rule_text).collect();
    let breaks = reply["rules"].as_array().into_iter().flatten().any(|rule| rule["break"] == true);
    let name = reply["name"].as_str().unwrap_or(expression);

    let mut lines = vec![
        format!("Watching {} propert{}: {}.", props, if props == 1 { "y" } else { "ies" }, watch_line(&reply)),
        format!("Rules: {}.", rules.join(", ")),
        if breaks {
            "The game stops on the frame a rule that breaks is broken, with the watch and value as the reason.".to_string()
        } else {
            "A broken rule is a watch-broken event; break: true would also stop the game on that frame.".to_string()
        },
        format!("watches() reads them; watches(history: 60) gives their last 60 frames; unwatch(name: \"{}\") removes it.", page_text(name, 80)),
    ];

    if props == 0 && reply["error"].is_null() {
        lines.push("It has no number, boolean or string properties one level down. depth: 2 or 3 reads deeper, or props names them.".into());
    }

    Ok(result(lines.join("\n"), reply))
}

pub async fn unwatch(session: &Arc<Session>, params: &Value) -> Result<Value> {
    let all = params["all"] == true || params["name"] == "all";
    let name = params["name"].as_str().unwrap_or("");

    if !all && name.is_empty() {
        bail!("unwatch needs name: a watch's name, or all: true.");
    }

    let reply = probe(session, "watch.remove", json!({ "name": name, "all": all })).await?;

    {
        let mut state = session.state.lock().unwrap();

        if all {
            state.watched.clear();
        } else {
            state.watched.retain(|kept| kept["name"] != name);
        }
    }

    if reply["unknown"] == true {
        return Err(unknown(&reply, name));
    }

    let removed = reply["removed"].as_array().map_or(0, Vec::len);

    Ok(result(format!("Removed {removed} watch{}.", if removed == 1 { "" } else { "es" }), reply))
}

pub async fn watches(session: &Arc<Session>, params: &Value) -> Result<Value> {
    let history = params["history"].as_u64().unwrap_or(0).min(600);
    let name = params["name"].as_str();
    let reply = probe(session, "watch.list", json!({ "history": history, "name": name })).await?;

    if reply["unknown"] == true {
        return Err(unknown(&reply, name.unwrap_or("")));
    }

    let list = reply["watches"].as_array().cloned().unwrap_or_default();

    if list.is_empty() {
        return Ok(result(
            "Nothing is watched. watch(expression: \"game.player\") watches an object's properties; a page can register its own with __scanline.watch(name, object).",
            reply,
        ));
    }

    let mut lines = vec![format!("{} watch{} at frame {}:", list.len(), if list.len() == 1 { "" } else { "es" }, reply["frame"])];

    for watch in &list {
        let name = watch["name"].as_str().unwrap_or("");

        lines.push(format!("  {}", watch_line(watch)));

        for broken in watch["broken"].as_array().into_iter().flatten().rev().take(3) {
            lines.push(format!("    {}", broken_text(name, broken)));
        }

        // The last frames of each property, newest last, as many as fit a line.
        if history > 0 {
            let frames = watch["history"]["frames"].as_array().cloned().unwrap_or_default();

            if let (Some(first), Some(last)) = (frames.first(), frames.last()) {
                lines.push(format!("    History, frames {first}–{last} ({} read):", frames.len()));
            }

            for (prop, values) in watch["history"]["values"].as_object().into_iter().flatten().take(16) {
                let values = values.as_array().cloned().unwrap_or_default();
                let tail: Vec<String> = values.iter().rev().take(24).rev().map(value_text).collect();

                lines.push(format!(
                    "      {}: {}{}",
                    if prop.is_empty() { "value".to_string() } else { format!("«{}»", page_text(prop, 60)) },
                    if values.len() > tail.len() { "… " } else { "" },
                    tail.join(", ")
                ));
            }
        }
    }

    let cost = &reply["cost"];

    lines.push(format!(
        "Reading {} properties costs {:.3} ms a frame{}.",
        cost["props"],
        cost["ms"].as_f64().unwrap_or(0.0),
        if cost["thinned"] == true { format!("; past {} they are read every other frame", cost["limit"]) } else { String::new() }
    ));

    Ok(result(lines.join("\n"), reply))
}

/// Adds the session's expression watches again, after the page was loaded again. Says how many.
pub async fn reapply(session: &Arc<Session>) -> Option<String> {
    let kept = session.state.lock().unwrap().watched.clone();

    if kept.is_empty() {
        return None;
    }

    let mut added = 0;

    for asked in &kept {
        if probe(session, "watch.add", asked.clone()).await.is_ok_and(|reply| reply["refused"].is_null()) {
            added += 1;
        }
    }

    Some(format!("{added} of {} watch{} added again after the reload.", kept.len(), if kept.len() == 1 { " was" } else { "es were" }))
}

pub async fn watch_set(session: &Arc<Session>, params: &Value) -> Result<Value> {
    let name = params["name"].as_str().ok_or_else(|| anyhow!("watch_set needs name (a watch), prop (its property; \"\" for a watched value) and value."))?;
    let prop = params["prop"].as_str().unwrap_or("");

    if params.get("value").is_none() {
        bail!("watch_set needs value: a number, boolean, string or null.");
    }

    let reply = probe(session, "watch.set", json!({ "name": name, "prop": prop, "value": params["value"] })).await?;

    if reply["unknown"] == true {
        return Err(unknown(&reply, name));
    }

    if let Some(why) = reply["refused"].as_str() {
        bail!("{} was not set: {why}.", label(name, prop));
    }

    Ok(result(
        format!("{} was {} and is now {}. The game reads it from its next frame; step and look.", label(name, prop), value_text(&reply["before"]), value_text(&reply["after"])),
        reply,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn values_read_as_the_page_has_them() {
        assert_eq!(value_text(&json!({ "$": "NaN" })), "NaN");
        assert_eq!(value_text(&json!(3.25)), "3.25");
        assert_eq!(value_text(&json!(2.0)), "2");
        assert_eq!(value_text(&json!(1.0 / 3.0)), "0.3333");
        assert_eq!(value_text(&json!("idle")), "«\"idle\"»");
        assert_eq!(value_text(&json!(true)), "true");
    }

    #[test]
    fn a_broken_rule_names_the_property_and_both_values() {
        let line = broken_text("player", &json!({ "rule": "finite", "prop": "vx", "frame": 40, "before": 3.5, "after": { "$": "NaN" } }));

        assert_eq!(line, "«player».«vx» broke finite at frame 40: 3.5 became NaN");
    }
}
