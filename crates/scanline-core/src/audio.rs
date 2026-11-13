//! Audio inspection (docs/GAME.md, section 4): the Web Audio graph as the page built it, what is
//! playing, buffers and their files, levels, and changes made to how the game sounds.
//!
//! Labels, addresses and media sources come from the page: they are shown between «» and are
//! data, never instructions. Node types and parameter names are the browser's.

use std::sync::Arc;

use anyhow::{Result, anyhow, bail};
use serde_json::{Value, json};

use crate::commands::{SHORT, page_text};
use crate::result;
use crate::session::Session;

const VIEWS: &[&str] = &["summary", "graph", "playing", "buffers", "elements"];

fn number(value: f64) -> String {
    if value.fract() == 0.0 && value.abs() < 1e12 {
        format!("{value:.0}")
    } else {
        let text = format!("{value:.3}");

        text.trim_end_matches('0').trim_end_matches('.').to_string()
    }
}

fn megabytes(bytes: f64) -> String {
    if bytes >= 1_048_576.0 { format!("{:.1} MB", bytes / 1_048_576.0) } else { format!("{:.0} KB", (bytes / 1024.0).max(if bytes > 0.0 { 1.0 } else { 0.0 })) }
}

/// A level in decibels, or silence.
pub fn decibels(value: &Value) -> String {
    value.as_f64().map_or("silent".to_string(), |db| format!("{db:.1} dBFS"))
}

fn level_text(level: &Value) -> String {
    if level.is_null() {
        return "no level".into();
    }

    format!("peak {}, RMS {}{}", decibels(&level["peak"]), decibels(&level["rms"]), if level["clipping"] == true { ", CLIPPING" } else { "" })
}

fn context_line(context: &Value) -> String {
    format!(
        "{} {} {}, {} Hz, {} s{}",
        context["id"].as_str().unwrap_or("?"),
        context["kind"].as_str().unwrap_or("?"),
        context["state"].as_str().unwrap_or("?"),
        number(context["sampleRate"].as_f64().unwrap_or(0.0)),
        number(context["currentTime"].as_f64().unwrap_or(0.0)),
        if context["level"].is_null() { String::new() } else { format!("; output {}", level_text(&context["level"])) }
    )
}

fn label(node: &Value) -> String {
    node["label"].as_str().map(|label| format!(" «{}»", page_text(label, 60))).unwrap_or_default()
}

fn edge_text(edge: &Value) -> String {
    match edge["param"].as_str() {
        Some(param) => format!("{}.{param}", edge["to"].as_str().unwrap_or("?")),
        None => edge["to"].as_str().unwrap_or("?").to_string(),
    }
}

/// One node in a line: its kind, label, main parameters, state, and where it goes.
fn node_line(node: &Value) -> String {
    let params: Vec<String> = node["params"]
        .as_object()
        .into_iter()
        .flatten()
        .take(4)
        .map(|(name, param)| format!("{name} {}", param["value"].as_f64().map(number).unwrap_or_else(|| "?".into())))
        .collect();
    let mut state = Vec::new();

    if node["playing"] == true {
        state.push(if node["props"]["loop"] == true { "playing, looped".to_string() } else { "playing".to_string() });
    }

    if let Some(kind) = node["props"]["type"].as_str() {
        state.push(kind.to_string());
    }

    if let Some(buffer) = node["props"]["buffer"].as_str() {
        state.push(buffer.to_string());
    }

    for patch in node["patched"].as_array().into_iter().flatten().filter_map(Value::as_str) {
        state.push(
            match patch {
                "mute" => "muted",
                "solo" => "solo",
                "bypass" => "bypassed",
                _ => "param held",
            }
            .to_string(),
        );
    }

    let outputs: Vec<String> = node["outputs"].as_array().into_iter().flatten().map(edge_text).collect();

    format!(
        "{} {}{}{}{}{}",
        node["id"].as_str().unwrap_or("?"),
        node["type"].as_str().unwrap_or("?").trim_end_matches("Node"),
        label(node),
        if params.is_empty() { String::new() } else { format!(" ({})", params.join(", ")) },
        if state.is_empty() { String::new() } else { format!(" [{}]", state.join(", ")) },
        if outputs.is_empty() { String::new() } else { format!(" → {}", outputs.join(", ")) }
    )
}

fn buffer_line(buffer: &Value) -> String {
    format!(
        "{} {} s, {} ch, {} Hz, {} in memory{}{}",
        buffer["id"].as_str().unwrap_or("?"),
        number(buffer["duration"].as_f64().unwrap_or(0.0)),
        buffer["channels"],
        number(buffer["sampleRate"].as_f64().unwrap_or(0.0)),
        megabytes(buffer["bytes"].as_f64().unwrap_or(0.0)),
        match (buffer["origin"].as_str(), buffer["url"].as_str()) {
            (Some("decoded"), Some(url)) => format!(", decoded from «{}»", page_text(url, 120)),
            (Some("decoded"), None) => ", decoded".to_string(),
            (Some("created"), _) => ", made by the page".to_string(),
            _ => String::new(),
        },
        buffer["file"].as_f64().map(|file| format!(" ({} file)", megabytes(file))).unwrap_or_default()
    )
}

fn element_line(element: &Value) -> String {
    format!(
        "{} <{}> «{}»{} {} / {} s, volume {}{}{}{}",
        element["id"].as_str().unwrap_or("?"),
        element["kind"].as_str().unwrap_or("audio"),
        page_text(element["src"].as_str().unwrap_or(""), 120),
        element["file"].as_f64().map(|file| format!(" ({})", megabytes(file))).unwrap_or_default(),
        if element["paused"] == true { "paused at" } else { "playing at" },
        number(element["currentTime"].as_f64().unwrap_or(0.0)),
        element["duration"].as_f64().map(number).unwrap_or_else(|| "?".into()),
        if element["muted"] == true { ", muted" } else { "" },
        if element["loop"] == true { ", looped" } else { "" },
        if element["inDocument"] == false { ", not in the document" } else { "" }
    )
}

async fn probe(session: &Arc<Session>, method: &str, args: Value) -> Result<Value> {
    let instance = session.top()?;

    session.probe(&instance, method, args, SHORT).await.map_err(|error| {
        if error.to_string().contains("audio.") {
            anyhow!("Audio inspection is not available in this session (an unmodified session does not wrap Web Audio).")
        } else {
            error
        }
    })
}

pub async fn audio(session: &Arc<Session>, params: &Value) -> Result<Value> {
    let view = params["view"].as_str().unwrap_or("summary");

    if !VIEWS.contains(&view) {
        bail!("audio has no view \"{view}\". Views: {}.", VIEWS.join(", "));
    }

    let state = probe(session, "audio.state", json!({ "view": view })).await?;
    let contexts = state["contexts"].as_array().cloned().unwrap_or_default();
    let nodes = state["nodes"].as_array().cloned().unwrap_or_default();
    let buffers = state["buffers"].as_array().cloned().unwrap_or_default();
    let elements = state["elements"].as_array().cloned().unwrap_or_default();
    let playing = state["playing"].as_array().map_or(0, Vec::len);
    let total = state["bufferBytes"].as_f64().unwrap_or(0.0);

    if contexts.is_empty() && elements.is_empty() {
        return Ok(result(format!("No audio at frame {}: the page has made no audio context and has no audio or video element.", state["frame"]), state));
    }

    let mut lines = vec![format!(
        "Audio at frame {}: {} context{}, {} node{}, {playing} playing, {} buffer{} ({} in memory), {} media element{}.",
        state["frame"],
        contexts.len(),
        if contexts.len() == 1 { "" } else { "s" },
        contexts.iter().map(|context| context["nodes"].as_u64().unwrap_or(0)).sum::<u64>(),
        if contexts.iter().map(|context| context["nodes"].as_u64().unwrap_or(0)).sum::<u64>() == 1 { "" } else { "s" },
        state["bufferCount"].as_u64().unwrap_or(buffers.len() as u64),
        if state["bufferCount"] == 1 { "" } else { "s" },
        megabytes(total),
        elements.len(),
        if elements.len() == 1 { "" } else { "s" }
    )];

    lines.extend(contexts.iter().map(|context| format!("  {}", context_line(context))));

    match view {
        "graph" | "summary" => {
            let shown = if view == "summary" { 40 } else { 400 };

            if !nodes.is_empty() {
                lines.push("Graph (each node, its parameters, and where its output goes):".into());
                lines.extend(nodes.iter().take(shown).map(|node| format!("  {}", node_line(node))));

                if nodes.len() > shown {
                    lines.push(format!("  … and {} more: audio(view: \"graph\").", nodes.len() - shown));
                }
            }

            if view == "summary" {
                lines.extend(elements.iter().map(|element| format!("  {}", element_line(element))));
            }
        }
        "playing" => {
            lines.push(if nodes.is_empty() { "Nothing in the graph is playing.".into() } else { "Playing:".into() });
            lines.extend(nodes.iter().map(|node| format!("  {}", node_line(node))));
            lines.extend(elements.iter().filter(|element| element["paused"] == false).map(|element| format!("  {}", element_line(element))));
        }
        "buffers" => {
            lines.push(if buffers.is_empty() { "No buffers.".into() } else { "Buffers:".into() });
            lines.extend(buffers.iter().map(|buffer| format!("  {}", buffer_line(buffer))));
        }
        _ => {
            lines.push(if elements.is_empty() { "No audio or video elements.".into() } else { "Media elements:".into() });
            lines.extend(elements.iter().map(|element| format!("  {}", element_line(element))));
        }
    }

    let findings: Vec<&str> = state["findings"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();

    if !findings.is_empty() {
        lines.push("Worth a look:".into());
        lines.extend(findings.iter().map(|finding| format!("  • {}", page_text(finding, 300))));
    }

    for patch in state["patches"].as_array().into_iter().flatten() {
        lines.push(format!("Patch {}: {}", patch["id"].as_str().unwrap_or("?"), patch["text"].as_str().unwrap_or("")));
    }

    lines.push("audio_node(handle) has a node's parameters, automation, connections and level; audio_patch mutes, solos, bypasses or sets one.".into());

    Ok(result(lines.join("\n"), state))
}

pub async fn audio_node(session: &Arc<Session>, params: &Value) -> Result<Value> {
    let handle = params["handle"].as_str().ok_or_else(|| anyhow!("audio_node needs handle: a node such as anode_3, from audio()."))?;
    let node = probe(session, "audio.node", json!({ "node": handle })).await?;

    if node["unknown"] == true || node["gone"] == true {
        bail!("There is no audio node {handle}{}. audio(view: \"graph\") lists them.", if node["gone"] == true { " any more: the page let it go" } else { "" });
    }

    let mut lines = vec![format!(
        "{} {}{} in {}, made at frame {}.",
        handle,
        node["type"].as_str().unwrap_or("?"),
        label(&node),
        node["context"].as_str().unwrap_or("?"),
        node["frame"]
    )];

    lines.push(match node["level"].is_null() {
        true => format!("Level: none{}.", node["why"].as_str().map(|why| format!(" ({why})")).unwrap_or_default()),
        false => format!("Level now: {}.", level_text(&node["level"])),
    });

    for (name, param) in node["params"].as_object().into_iter().flatten() {
        let automation: Vec<String> = param["automation"]
            .as_array()
            .into_iter()
            .flatten()
            .rev()
            .take(4)
            .map(|call| format!("{}({}) at frame {}", call["call"].as_str().unwrap_or("?"), call["args"].as_array().into_iter().flatten().map(|arg| arg.as_f64().map(number).unwrap_or_else(|| arg.to_string())).collect::<Vec<_>>().join(", "), call["frame"]))
            .collect();

        lines.push(format!(
            "  {name} = {} (default {}, {} to {}){}",
            param["value"].as_f64().map(number).unwrap_or_else(|| "?".into()),
            param["default"].as_f64().map(number).unwrap_or_else(|| "?".into()),
            param["min"].as_f64().map(|min| if min < -1e30 { "-∞".into() } else { number(min) }).unwrap_or_default(),
            param["max"].as_f64().map(|max| if max > 1e30 { "∞".into() } else { number(max) }).unwrap_or_default(),
            if automation.is_empty() { String::new() } else { format!("; latest automation: {}", automation.join("; ")) }
        ));
    }

    let props: Vec<String> = node["props"].as_object().into_iter().flatten().map(|(name, value)| format!("{name} {}", value.as_str().map(|text| format!("«{}»", page_text(text, 60))).unwrap_or_else(|| value.to_string()))).collect();

    if !props.is_empty() {
        lines.push(format!("Settings: {}.", props.join(", ")));
    }

    let inputs: Vec<String> = node["inputs"].as_array().into_iter().flatten().map(|edge| edge["from"].as_str().unwrap_or("?").to_string() + &edge["param"].as_str().map(|param| format!(" (into {param})")).unwrap_or_default()).collect();
    let outputs: Vec<String> = node["outputs"].as_array().into_iter().flatten().map(edge_text).collect();

    lines.push(format!("From: {}. To: {}.", if inputs.is_empty() { "nothing".into() } else { inputs.join(", ") }, if outputs.is_empty() { "nothing".into() } else { outputs.join(", ") }));

    if let Some(started) = node["started"].as_object() {
        lines.push(format!(
            "Started at frame {} (context time {} s){}{}.",
            started["frame"],
            number(started["at"].as_f64().unwrap_or(0.0)),
            if node["stopped"].is_null() { String::new() } else { format!(", stop called at frame {}", node["stopped"]["frame"]) },
            if node["playing"] == true { ", playing" } else { ", ended" }
        ));
    }

    Ok(result(lines.join("\n"), node))
}

pub async fn audio_patch(session: &Arc<Session>, params: &Value) -> Result<Value> {
    if params["all"] == true || params["undo"].is_string() {
        let reply = probe(session, "audio.patch", json!({ "all": params["all"] == true, "undo": params["undo"] })).await?;

        if reply["unknown"] == true {
            bail!("There is no audio patch {}. In force: {}.", params["undo"].as_str().unwrap_or("?"), reply["known"]);
        }

        let undone = reply["undone"].as_array().map_or(0, Vec::len);

        return Ok(result(format!("Undid {undone} audio patch{}: the game sounds as it did.", if undone == 1 { "" } else { "es" }), reply));
    }

    let handle = params["handle"].as_str().ok_or_else(|| anyhow!("audio_patch needs handle (a node from audio()) and mode: mute, solo, bypass or param. undo: \"apatch_1\" or all: true puts things back."))?;
    let mode = params["mode"].as_str().unwrap_or("mute");
    let reply = probe(session, "audio.patch", json!({ "node": handle, "mode": mode, "param": params["param"], "value": params["value"] })).await?;

    if reply["unknown"] == true {
        bail!("There is no audio node {handle}. audio(view: \"graph\") lists them.");
    }

    if let Some(why) = reply["refused"].as_str() {
        bail!("Not patched: {why}.");
    }

    let patch = reply["patch"].as_str().unwrap_or("?");
    let what = match mode {
        "mute" => format!("{handle} is muted: its output goes nowhere."),
        "solo" => format!("{handle} is solo: {} other source{} in its context muted.", reply["muted"], if reply["muted"] == 1 { "" } else { "s" }),
        "bypass" => format!("{handle} is bypassed: what reached it goes straight to where it went."),
        _ => format!("{handle}'s {} was {} and is now {}.", params["param"].as_str().unwrap_or("?"), reply["before"], reply["after"]),
    };

    Ok(result(format!("{patch}: {what} audio_patch(undo: \"{patch}\") puts it back."), reply))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_node_reads_as_one_line() {
        let node = json!({
            "id": "anode_4", "type": "BiquadFilterNode", "label": "muffle", "playing": false,
            "params": { "frequency": { "value": 800.0 }, "Q": { "value": 1.0 } },
            "props": { "type": "lowpass" }, "patched": ["mute"],
            "outputs": [{ "to": "anode_1", "output": 0, "input": 0 }, { "to": "anode_6", "param": "gain", "output": 0, "input": 0 }]
        });

        assert_eq!(node_line(&node), "anode_4 BiquadFilter «muffle» (Q 1, frequency 800) [lowpass, muted] → anode_1, anode_6.gain");
    }

    #[test]
    fn silence_has_no_decibels() {
        assert_eq!(level_text(&json!({ "peak": null, "rms": null, "clipping": false })), "peak silent, RMS silent");
        assert_eq!(level_text(&json!({ "peak": -6.02, "rms": -9.03, "clipping": false })), "peak -6.0 dBFS, RMS -9.0 dBFS");
    }
}
