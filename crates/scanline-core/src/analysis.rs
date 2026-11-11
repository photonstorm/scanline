//! Analysis of captures (04-AGENT-INTERFACE.md, section 3.6): comparing two frames, the
//! history of a pixel, views such as overdraw, and what can be said of a shader by reading it.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use scanline_image::Image;
use serde_json::{Value, json};

use scanline_store::Sql;

use crate::capture::{LONG, about, describe_event, draw_state, flatten, load_into, rows_as_objects, runs, target_of, the_capture};
use crate::commands::page_text;
use crate::inventory::{gl_name, list};
use crate::{Host, result};

const COLUMNS: &str = "draw, kind, method, pass, target, mode, count, instances, indexed, program, blend, blend_src, blend_dst, depth_test, depth_write, depth_func, stencil_test, cull, scissor, viewport, textures, gl_error, target_width, target_height, pixels_changed, changed_box";

/// What makes an event the event it is: its kind and the state it is drawn with, but not
/// where it lands or the values it is given, which differ between any two frames of a
/// scene that moves.
fn shape(row: &serde_json::Map<String, Value>) -> String {
    [
        "kind",
        "method",
        "target",
        "mode",
        "count",
        "instances",
        "program",
        "blend",
        "blend_src",
        "blend_dst",
        "depth_test",
        "depth_write",
        "depth_func",
        "stencil_test",
        "cull",
        "textures",
    ]
    .iter()
    .map(|key| row.get(*key).map(Value::to_string).unwrap_or_default())
    .collect::<Vec<_>>()
    .join("|")
}

/// The same without the textures bound: enough to know an event again when it has moved,
/// since what is left bound from the draw before depends on where in the frame it is.
fn loose(row: &serde_json::Map<String, Value>) -> String {
    [
        "kind",
        "method",
        "target",
        "mode",
        "count",
        "instances",
        "program",
        "blend",
        "blend_src",
        "blend_dst",
        "depth_test",
        "depth_write",
        "depth_func",
        "stencil_test",
        "cull",
    ]
    .iter()
    .map(|key| row.get(*key).map(Value::to_string).unwrap_or_default())
    .collect::<Vec<_>>()
    .join("|")
}

/// The longest run of events two frames have in common, in order: pairs of positions.
fn align(a: &[String], b: &[String]) -> Vec<(usize, usize)> {
    let (n, m) = (a.len(), b.len());
    let mut table = vec![0u32; (n + 1) * (m + 1)];
    let at = |i: usize, j: usize| i * (m + 1) + j;

    for i in (0..n).rev() {
        for j in (0..m).rev() {
            table[at(i, j)] = if a[i] == b[j] { table[at(i + 1, j + 1)] + 1 } else { table[at(i + 1, j)].max(table[at(i, j + 1)]) };
        }
    }

    let (mut i, mut j) = (0, 0);
    let mut pairs = Vec::new();

    while i < n && j < m {
        if a[i] == b[j] {
            pairs.push((i, j));
            i += 1;
            j += 1;
        } else if table[at(i + 1, j)] >= table[at(i, j + 1)] {
            i += 1;
        } else {
            j += 1;
        }
    }

    pairs
}

fn events(host: &Host, handle: &str) -> Result<Vec<serde_json::Map<String, Value>>> {
    let rows = host.store.query(handle, &format!("SELECT {COLUMNS} FROM draws ORDER BY draw"), &[], 100_000)?;

    Ok(rows_as_objects(&rows).into_iter().filter_map(|row| row.as_object().cloned()).collect())
}

/// One event in a few words, without its number.
fn brief(row: &serde_json::Map<String, Value>) -> String {
    describe_event(row).trim_start().split_once("  ").map(|parts| parts.1.to_string()).unwrap_or_default()
}

/// Two captures against each other: which events one has that the other lacks, which have
/// moved, which are drawn with different state or values, and how the final pictures differ.
pub fn compare(host: &Arc<Host>, params: &Value) -> Result<Value> {
    let (Some(a), Some(b)) = (params["a"].as_str(), params["b"].as_str()) else {
        bail!("compare needs a and b: two capture handles, such as a frame that looks wrong and one that looks right.");
    };

    let (meta_a, meta_b) = (host.store.meta(a)?, host.store.meta(b)?);
    let (events_a, events_b) = (events(host, a)?, events(host, b)?);

    if events_a.len().max(events_b.len()) > 4000 {
        bail!(
            "These captures have {} and {} events, too many to line up against each other. Compare parts of them with query.",
            events_a.len(),
            events_b.len()
        );
    }

    let (shapes_a, shapes_b): (Vec<String>, Vec<String>) = (events_a.iter().map(shape).collect(), events_b.iter().map(shape).collect());
    let pairs = align(&shapes_a, &shapes_b);
    let paired_a: BTreeSet<usize> = pairs.iter().map(|pair| pair.0).collect();
    let paired_b: BTreeSet<usize> = pairs.iter().map(|pair| pair.1).collect();
    let mut only_a: Vec<usize> = (0..events_a.len()).filter(|index| !paired_a.contains(index)).collect();
    let mut only_b: Vec<usize> = (0..events_b.len()).filter(|index| !paired_b.contains(index)).collect();

    let describe = |meta: &Value, handle: &str| format!("{handle} (frame {} of {})", meta["frame"], page_text(meta["url"].as_str().unwrap_or(""), 70));

    let mut lines = vec![format!("a is {}; b is {}.", describe(&meta_a, a), describe(&meta_b, b))];
    let mut data = json!({ "a": a, "b": b, "events": [events_a.len(), events_b.len()], "aligned": pairs.len() });

    // An event in one frame only, whose like is in the other frame only, has moved.
    let mut moved = Vec::new();

    only_a.retain(|index| match only_b.iter().position(|other| loose(&events_b[*other]) == loose(&events_a[*index])) {
        Some(found) => {
            moved.push((*index, only_b.remove(found)));
            false
        }
        None => true,
    });

    lines.push(if only_a.is_empty() && only_b.is_empty() && moved.is_empty() {
        format!("Both issue the same {} events in the same order, with the same programs, blending, depth and culling.", events_a.len())
    } else {
        format!("a has {} events and b has {}; {} line up in order.", events_a.len(), events_b.len(), pairs.len())
    });

    for (from, to) in &moved {
        lines.push(format!("  MOVED: a's event {from} is b's event {to}: {}", brief(&events_a[*from])));

        if events_a[*from].get("textures") != events_b[*to].get("textures") {
            lines.push(format!(
                "    Textures bound: {} in a, {} in b.",
                events_a[*from].get("textures").and_then(Value::as_str).filter(|text| !text.is_empty()).unwrap_or("none"),
                events_b[*to].get("textures").and_then(Value::as_str).filter(|text| !text.is_empty()).unwrap_or("none")
            ));
        }

        // What it now comes before or after that it did not.
        let (first, last) = if from < to { (from + 1, *to) } else { (*to, from - 1) };
        let passed: Vec<i64> = pairs.iter().filter(|pair| pair.0 >= first.min(last) && pair.0 <= first.max(last)).map(|pair| pair.0 as i64).collect();

        if !passed.is_empty() {
            lines.push(format!(
                "    In a it is drawn {} a's event{} {}; in b it is drawn {} them.",
                if from < to { "before" } else { "after" },
                if passed.len() == 1 { "" } else { "s" },
                runs(&passed),
                if from < to { "after" } else { "before" }
            ));
        }
    }

    for (name, only, list) in [("a", &only_a, &events_a), ("b", &only_b, &events_b)] {
        for index in only.iter().take(12) {
            lines.push(format!("  ONLY IN {name}: event {index}: {}", brief(&list[*index])));
        }

        if only.len() > 12 {
            lines.push(format!("  … and {} more events only in {name}.", only.len() - 12));
        }
    }

    data["moved"] = json!(moved.iter().map(|(from, to)| json!({ "a": from, "b": to })).collect::<Vec<_>>());
    data["only_a"] = json!(only_a);
    data["only_b"] = json!(only_b);

    // Events that line up: what differs in how they are drawn, and in what they did.
    let mut state_changes = Vec::new();
    let mut value_names: BTreeMap<String, Vec<i64>> = BTreeMap::new();
    let mut effect_changes = Vec::new();

    for (i, j) in &pairs {
        let (mut left, mut right) = (BTreeMap::new(), BTreeMap::new());

        flatten("", &draw_state(host, a, &json!(i))?, &mut left);
        flatten("", &draw_state(host, b, &json!(j))?, &mut right);

        let keys: BTreeSet<&String> = left.keys().chain(right.keys()).collect();
        let missing = "(absent)".to_string();

        for key in keys {
            let (was, is) = (left.get(key).unwrap_or(&missing), right.get(key).unwrap_or(&missing));

            if was == is || ["command", "pass", "changedBox"].contains(&key.as_str()) {
                continue;
            }

            if key == "pixelsChanged" {
                // A few pixels either way is a thing that moved. All or nothing, or a
                // quarter more or less, is worth a line.
                let (before, after) = (was.parse::<f64>().unwrap_or(0.0), is.parse::<f64>().unwrap_or(0.0));

                if (before == 0.0) != (after == 0.0) || (before - after).abs() > (before.max(after) * 0.25).max(50.0) {
                    effect_changes.push(format!("a's event {i} changed {was} pixels; b's event {j} changed {is}"));
                }
            } else if let Some(name) = key.strip_prefix("uniforms.") {
                value_names.entry(name.to_string()).or_default().push(*i as i64);
            } else {
                state_changes.push(format!("event {i} ↔ {j}: {key}: {} → {}", page_text(was, 80), page_text(is, 80)));
            }
        }
    }

    if !state_changes.is_empty() {
        lines.push(format!(
            "{} difference{} in state between events that line up (a → b):",
            state_changes.len(),
            if state_changes.len() == 1 { "" } else { "s" }
        ));
        lines.extend(state_changes.iter().take(20).map(|change| format!("  {change}")));

        if state_changes.len() > 20 {
            lines.push(format!("  … and {} more.", state_changes.len() - 20));
        }
    }

    if !value_names.is_empty() {
        lines.push("Uniform values that differ between events that line up (a's event numbers):".into());
        lines.extend(value_names.iter().take(12).map(|(name, events)| format!("  {name}: event{} {}", if events.len() == 1 { "" } else { "s" }, runs(events))));
        lines.push("  draw_diff shows two events of one capture side by side; draw(capture, draw) gives the values.".into());
    }

    if !effect_changes.is_empty() {
        lines.push("What the events did differs:".into());
        lines.extend(effect_changes.iter().take(12).map(|change| format!("  {change}")));

        if effect_changes.len() > 12 {
            lines.push(format!("  … and {} more.", effect_changes.len() - 12));
        }
    }

    data["state_changes"] = json!(state_changes);
    data["uniforms"] = json!(value_names);

    // What the frames used.
    let objects = |handle: &str| -> Result<BTreeMap<String, String>> {
        let rows = host.store.query(handle, "SELECT handle, what FROM objects", &[], 100_000)?;

        Ok(rows.rows.iter().map(|row| (row[0].as_str().unwrap_or("").to_string(), row[1].as_str().unwrap_or("").to_string())).collect())
    };
    let (objects_a, objects_b) = (objects(a)?, objects(b)?);
    let gone: Vec<&String> = objects_a.keys().filter(|handle| !objects_b.contains_key(*handle)).collect();
    let new: Vec<&String> = objects_b.keys().filter(|handle| !objects_a.contains_key(*handle)).collect();
    let resized: Vec<String> = objects_a
        .iter()
        .filter_map(|(handle, what)| objects_b.get(handle).filter(|other| *other != what).map(|other| format!("{handle}: {what} → {other}")))
        .collect();

    let some = |handles: &[&String]| {
        let shown: Vec<&str> = handles.iter().take(12).map(|handle| handle.as_str()).collect();

        format!("{}{}", shown.join(", "), if handles.len() > 12 { format!(" and {} more", handles.len() - 12) } else { String::new() })
    };

    if !gone.is_empty() {
        lines.push(format!("Used by a and not by b: {}.", some(&gone)));
    }

    if !new.is_empty() {
        lines.push(format!("Used by b and not by a: {}.", some(&new)));
    }

    for change in resized.iter().take(8) {
        lines.push(format!("Not the same in both: {change}"));
    }

    // The pictures the two frames ended with.
    let picture = |handle: &str| -> Result<Image> {
        let path = host.store.capture_dir(handle).join("final.png");

        Image::from_png(&std::fs::read(&path).with_context(|| format!("reading {}", path.display()))?)
    };

    let mut images = json!([]);

    match (picture(a), picture(b)) {
        (Ok(image_a), Ok(image_b)) => match image_a.difference(&image_b, 0) {
            Ok(difference) if difference.changed == 0 => lines.push("Their final pictures are identical.".into()),
            Ok(difference) => {
                let (x, y, w, h) = difference.bounds.unwrap_or((0, 0, 0, 0));
                let path = host.store.capture_dir(b).join(format!("against-{a}.png"));

                std::fs::write(&path, difference.heat.to_png()?).with_context(|| format!("writing {}", path.display()))?;

                lines.push(format!(
                    "Their final pictures differ in {} of {} pixels, by up to {} in a channel, within x {x} y {y} {w}×{h}{}.",
                    difference.changed,
                    difference.pixels,
                    difference.max,
                    if difference.areas.len() > 1 { format!(", in {} separate areas", difference.areas.len()) } else { String::new() }
                ));

                for (x, y, w, h, changed) in difference.areas.iter().take(5) {
                    lines.push(format!("  x {x} y {y} {w}×{h}: {changed} pixels"));
                }

                lines.push(format!("  Heat map (a in grey, differences from dark red to yellow): {}", path.display()));
                images = json!([{ "view": path, "original": path, "width": difference.heat.width, "height": difference.heat.height, "scale": 1.0, "space": "canvas_px" }]);
                data["picture"] = json!({ "changed": difference.changed, "max": difference.max, "bounds": { "x": x, "y": y, "w": w, "h": h } });
            }
            Err(error) => lines.push(format!("Their final pictures cannot be compared: {error}")),
        },
        _ => lines.push("One of the captures has no final picture on disk, so the pictures were not compared.".into()),
    }

    let mut value = result(lines.join("\n"), data);

    value["images"] = images;

    Ok(value)
}

/// The history of a pixel: every event that covered it, in order, whether or not it
/// changed it, and for a draw that did not, which test turned its fragments away.
pub async fn pixel_history(host: &Arc<Host>, params: &Value) -> Result<Value> {
    let (handle, meta) = the_capture(host, params)?;
    let (Some(x), Some(y)) = (params["x"].as_i64(), params["y"].as_i64()) else {
        bail!("pixel_history needs x and y, in pixels from the top-left of the target.")
    };
    let (target, target_name) = target_of(host, &handle, params)?;
    let session = host.replayer(params)?;

    load_into(host, &session, &handle).await?;

    let reply = session.replay("history", &json!({ "key": handle, "x": x, "y": y, "target": target }), LONG).await?;

    if reply["unsupported"].is_string() {
        bail!(
            "pixel_history is built for WebGL captures. For a WebGPU capture, pixel_source lists the events that changed a pixel, and draw_list marks events that changed nothing."
        );
    }

    let float = reply["float"] == true;
    let show = |value: &Value| match value.as_array() {
        Some(channels) => format!(
            "({})",
            channels
                .iter()
                .map(|channel| if float { format!("{}", (channel.as_f64().unwrap_or(0.0) * 1e4).round() / 1e4) } else { channel.to_string() })
                .collect::<Vec<_>>()
                .join(", ")
        ),
        None => "(nothing)".to_string(),
    };

    let rows = reply["rows"].as_array().cloned().unwrap_or_default();
    let queries = reply["queries"] == true;
    let mut lines = vec![format!("{} pixel ({x}, {y}) of {target_name}: its history through the frame. gpu-measured.", about(host, params, &handle, &meta))];
    let mut out = Vec::new();
    let (mut shown, mut missed) = (0, 0);

    for row in &rows {
        let index = row["draw"].as_i64().unwrap_or(0);
        let state = draw_state(host, &handle, &json!(index))?;
        let changed = row["before"] != row["after"];
        let what = host
            .store
            .query(&handle, "SELECT kind, mode, count, program, blend FROM draws WHERE draw = ?1", &[Sql::Integer(index)], 1)?
            .rows
            .first()
            .map(|event| {
                if event[0] == "draw" {
                    format!(
                        "{} ×{} with {}{}",
                        event[1].as_str().unwrap_or(""),
                        event[2],
                        event[3].as_str().unwrap_or("?"),
                        if event[4] == 1 { ", blended" } else { "" }
                    )
                } else {
                    event[0].as_str().unwrap_or("").to_string()
                }
            })
            .unwrap_or_default();

        // What became of it.
        let outcome = if changed {
            format!("{} → {}", show(&row["before"]), show(&row["after"]))
        } else if row["kind"] != "draw" {
            if row["scissor"] == false { "left it alone: the pixel is outside the scissor box".to_string() } else { "left it as it was".to_string() }
        } else if row["covered"] == false {
            // No fragment landed on the pixel, or the shader discarded every one that did.
            missed += 1;
            continue;
        } else if row["covered"].is_null() {
            // No occlusion queries: all that is known is that the value did not change.
            missed += 1;
            continue;
        } else {
            let mut reasons = Vec::new();

            if row["scissor"] == false {
                reasons.push(format!("it is outside the scissor box ({})", list(&state["scissor"])));
            }

            if row["cull"] == false {
                reasons.push(format!("its triangle is culled (cull {}, front face {})", gl_name(&state["cull"]), gl_name(&state["frontFace"])));
            }

            if row["stencil"] == false {
                reasons.push("it fails the stencil test".to_string());
            }

            if row["depth"] == false {
                reasons.push(format!("it fails the depth test ({})", gl_name(&state["depth"]["func"])));
            }

            if state["colorMask"].as_array().is_some_and(|mask| mask.iter().all(|channel| channel == false)) {
                reasons.push("the colour mask lets nothing through".to_string());
            }

            if !state["glError"].is_null() {
                reasons.push(format!("the browser rejected the call ({})", page_text(state["glError"].as_str().unwrap_or(""), 80)));
            }

            if reasons.is_empty() {
                "covered the pixel and passed every test, but left its value as it was (blending, or it wrote the same colour)".to_string()
            } else {
                format!("REJECTED: {}", reasons.join("; "))
            }
        };

        shown += 1;
        lines.push(format!("  event {index:>4}  {outcome}   [{what}]"));
        out.push(json!({
            "draw": index,
            "kind": row["kind"],
            "before": row["before"],
            "after": row["after"],
            "changed": changed,
            "covered": row["covered"],
            "passes": { "scissor": row["scissor"], "cull": row["cull"], "depth": row["depth"], "stencil": row["stencil"] },
        }));
    }

    if shown == 0 {
        lines.push("  No event on this target touched the pixel.".into());
    }

    lines.push(if queries {
        format!(
            "{missed} other draw{} on this target did not reach the pixel: no fragment of theirs landed on it, or their shader discarded every one that did (the two cannot be told apart).",
            if missed == 1 { "" } else { "s" }
        )
    } else {
        "This is a WebGL 1 capture, which has no occlusion queries: only events that changed the pixel are listed, and a draw a test rejected is not.".to_string()
    });

    if let Some(last) = out.iter().rev().find(|row| row["changed"] == true) {
        lines.push(format!(
            "Its final value {} was produced by event {}. draw(capture: \"{handle}\", draw: {}) gives that event in full.",
            show(&last["after"]),
            last["draw"],
            last["draw"]
        ));
    }

    if meta["replay_matches"] != true {
        lines.push("Warning: this capture's replay did not match the original frame, so this may be wrong.".into());
    }

    Ok(result(
        lines.join("\n"),
        json!({ "capture": handle, "x": x, "y": y, "target": target_name, "history": out, "not_reaching": missed, "provenance": "gpu-measured", "ms": reply["ms"] }),
    ))
}

// ---- Reading a shader ----

const SAMPLERS: &[&str] = &[
    // GLSL
    "texture",
    "texture2D",
    "textureCube",
    "textureLod",
    "texture2DLod",
    "textureCubeLod",
    "textureGrad",
    "texelFetch",
    "textureProj",
    "texture2DProj",
    "textureOffset",
    "textureLodOffset",
    "textureProjLod",
    "texelFetchOffset",
    "textureGather",
    // WGSL
    "textureSample",
    "textureSampleLevel",
    "textureSampleBias",
    "textureSampleGrad",
    "textureSampleCompare",
    "textureSampleCompareLevel",
    "textureLoad",
    "textureSampleBaseClampToEdge",
    "textureGatherCompare",
];

const MATHS: &[&str] = &[
    "pow",
    "exp",
    "exp2",
    "log",
    "log2",
    "sin",
    "cos",
    "tan",
    "asin",
    "acos",
    "atan",
    "atan2",
    "sqrt",
    "inversesqrt",
    "inverseSqrt",
    "normalize",
    "length",
    "distance",
    "reflect",
    "refract",
    "smoothstep",
];

const DERIVATIVES: &[&str] = &["dFdx", "dFdy", "fwidth", "dpdx", "dpdy", "dpdxFine", "dpdyFine", "dpdxCoarse", "dpdyCoarse", "fwidthFine", "fwidthCoarse"];

/// A shader's text as words and punctuation, comments left out.
fn tokens(source: &str) -> Vec<String> {
    let bytes: Vec<char> = source.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;

    while i < bytes.len() {
        let c = bytes[i];

        if c == '/' && bytes.get(i + 1) == Some(&'/') {
            while i < bytes.len() && bytes[i] != '\n' {
                i += 1;
            }
        } else if c == '/' && bytes.get(i + 1) == Some(&'*') {
            i += 2;

            while i + 1 < bytes.len() && !(bytes[i] == '*' && bytes[i + 1] == '/') {
                i += 1;
            }

            i += 2;
        } else if c.is_alphanumeric() || c == '_' {
            let start = i;

            while i < bytes.len() && (bytes[i].is_alphanumeric() || bytes[i] == '_' || bytes[i] == '.') {
                i += 1;
            }

            out.push(bytes[start..i].iter().collect());
        } else {
            if !c.is_whitespace() {
                out.push(c.to_string());
            }

            i += 1;
        }
    }

    out
}

/// What can be said of a shader from its text alone: how much it samples, loops and branches.
fn read_shader(source: &str) -> Value {
    let words = tokens(source);
    let is_call = |index: usize| words.get(index + 1).is_some_and(|next| next == "(");
    let wgsl = words.iter().any(|word| word == "fn") && !words.iter().any(|word| word == "void");

    // Loops, each with the braces that hold its body and what is sampled inside.
    let mut loops: Vec<Value> = Vec::new();
    let mut open: Vec<(usize, usize)> = Vec::new(); // (brace depth of the body, index into loops)
    let mut pending: Option<usize> = None;
    let mut depth = 0usize;
    let (mut samples, mut samples_in_loops, mut branches, mut discards, mut derivatives) = (0, 0, 0, 0, 0);
    let mut maths: BTreeMap<String, u64> = BTreeMap::new();

    for (index, word) in words.iter().enumerate() {
        match word.as_str() {
            "for" | "while" | "loop" if word == "loop" || is_call(index) => {
                // The header, as written, and a count if it is a plain counted loop.
                let header: Vec<&str> = words[index..].iter().take_while(|next| *next != "{").take(24).map(String::as_str).collect();
                let bound =
                    header.windows(2).find(|pair| pair[0] == "<" || pair[0] == "<=").and_then(|pair| pair[1].trim_end_matches(['u', 'i']).parse::<u64>().ok());

                loops.push(json!({ "header": header.join(" "), "passes": bound, "samples": 0 }));
                pending = Some(loops.len() - 1);
            }
            "{" => {
                depth += 1;

                if let Some(which) = pending.take() {
                    open.push((depth, which));
                }
            }
            "}" => {
                if open.last().is_some_and(|entry| entry.0 == depth) {
                    open.pop();
                }

                depth = depth.saturating_sub(1);
            }
            "if" => branches += 1,
            "discard" => discards += 1,
            name if is_call(index) && SAMPLERS.contains(&name) => {
                samples += 1;

                if !open.is_empty() {
                    samples_in_loops += 1;

                    for (_, which) in &open {
                        loops[*which]["samples"] = json!(loops[*which]["samples"].as_u64().unwrap_or(0) + 1);
                    }
                }
            }
            name if is_call(index) && DERIVATIVES.contains(&name) => derivatives += 1,
            name if is_call(index) && MATHS.contains(&name) => *maths.entry(name.to_string()).or_default() += 1,
            _ => {}
        }
    }

    // Inputs that are declared and then never mentioned again.
    let mut unused = Vec::new();

    for (index, word) in words.iter().enumerate() {
        let name = match word.as_str() {
            // GLSL: uniform [precision] type name
            "uniform" | "attribute" | "varying" if !wgsl => words[index + 1..].iter().take_while(|next| *next != ";" && *next != "{" && *next != "[").last(),
            // WGSL: var<uniform> name, or var name after a binding
            "var" if wgsl && depth_at(&words, index) == 0 => {
                let mut at = index + 1;

                if words.get(at).is_some_and(|next| next == "<") {
                    while at < words.len() && words[at] != ">" {
                        at += 1;
                    }

                    at += 1;
                }

                words.get(at)
            }
            _ => None,
        };

        if let Some(name) = name.filter(|name| name.chars().next().is_some_and(|c| c.is_alphabetic() || c == '_')) {
            let root = name.split('.').next().unwrap_or(name);
            let uses = words.iter().filter(|other| other.split('.').next() == Some(root)).count();

            if uses <= 1 {
                unused.push(format!("{word} {name}"));
            }
        }
    }

    // The most samples one run of the shader could make, where loop counts can be read.
    let mut estimate = samples - samples_in_loops;
    let mut bounded = true;

    for entry in &loops {
        match entry["passes"].as_u64() {
            Some(passes) => estimate += entry["samples"].as_u64().unwrap_or(0) * passes,
            None if entry["samples"].as_u64().unwrap_or(0) > 0 => bounded = false,
            None => {}
        }
    }

    json!({
        "language": if wgsl { "WGSL" } else { "GLSL" },
        "lines": source.lines().filter(|line| !line.trim().is_empty()).count(),
        "samples": samples,
        "samples_in_loops": samples_in_loops,
        "samples_per_run": if bounded { json!(estimate) } else { Value::Null },
        "loops": loops,
        "branches": branches,
        "discards": discards,
        "derivatives": derivatives,
        "maths": maths,
        "unused": unused,
    })
}

/// How deep in braces a word is.
fn depth_at(words: &[String], index: usize) -> usize {
    words[..index].iter().fold(0usize, |depth, word| match word.as_str() {
        "{" => depth + 1,
        "}" => depth.saturating_sub(1),
        _ => depth,
    })
}

fn describe_reading(name: &str, what: &str, figures: &Value) -> Vec<String> {
    let mut lines = vec![format!("{name}: {what}, {}, {} lines.", figures["language"].as_str().unwrap_or(""), figures["lines"])];
    let samples = figures["samples"].as_u64().unwrap_or(0);

    lines.push(match (samples, figures["samples_in_loops"].as_u64().unwrap_or(0)) {
        (0, _) => "  Samples no textures.".to_string(),
        (count, 0) => format!("  Texture samples: {count} call site{}, none in a loop: {count} a run at most.", if count == 1 { "" } else { "s" }),
        (count, looped) => format!(
            "  Texture samples: {count} call site{}, {looped} inside a loop: {}.",
            if count == 1 { "" } else { "s" },
            match figures["samples_per_run"].as_u64() {
                Some(most) => format!("up to {most} samples every time the shader runs"),
                None => "how many times it loops cannot be read from the text".to_string(),
            }
        ),
    });

    for entry in figures["loops"].as_array().into_iter().flatten() {
        lines.push(format!(
            "    loop «{}»{}{}",
            page_text(entry["header"].as_str().unwrap_or(""), 70),
            match entry["passes"].as_u64() {
                Some(passes) => format!(": up to {passes} passes"),
                None => String::new(),
            },
            match entry["samples"].as_u64().unwrap_or(0) {
                0 => String::new(),
                count => format!(", {count} sample{} each pass", if count == 1 { "" } else { "s" }),
            }
        ));
    }

    let maths: Vec<String> = figures["maths"].as_object().into_iter().flatten().map(|(name, count)| format!("{name} {count}")).collect();

    lines.push(format!(
        "  Branches: {}. discard: {}. Derivatives: {}. Costly maths calls: {}.",
        figures["branches"],
        if figures["discards"].as_u64().unwrap_or(0) > 0 { "yes" } else { "no" },
        figures["derivatives"],
        if maths.is_empty() { "none".to_string() } else { maths.join(", ") }
    ));

    let unused: Vec<&str> = figures["unused"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();

    if !unused.is_empty() {
        lines.push(format!("  Declared and never used: {}.", unused.join("; ")));
    }

    lines
}

/// Static figures for a shader, or for each shader of a program or pipeline. From a live
/// object, or from a capture's copy of it.
pub async fn shader_analysis(host: &Arc<Host>, params: &Value) -> Result<Value> {
    let handle =
        params["handle"].as_str().ok_or_else(|| anyhow!("shader_analysis needs handle: a shader (shd_2), a program (prg_1) or a pipeline (pip_3)."))?;
    let mut sources: Vec<(String, String, String)> = Vec::new(); // (handle, what, source)

    if let Some(capture) = params["capture"].as_str() {
        // The capture's own copy: still there when the page has gone.
        let detail = |name: &str| -> Result<Option<(String, Value, Option<String>)>> {
            let rows = host.store.query(capture, "SELECT kind, detail, source FROM objects WHERE handle = ?1", &[Sql::Text(name.to_string())], 1)?;

            Ok(rows.rows.first().map(|row| {
                (
                    row[0].as_str().unwrap_or("").to_string(),
                    serde_json::from_str(row[1].as_str().unwrap_or("{}")).unwrap_or(Value::Null),
                    row[2].as_str().map(str::to_string),
                )
            }))
        };

        let (kind, object, source) = detail(handle)?
            .ok_or_else(|| anyhow!("{handle} is not an object of {capture}. query(capture, \"select handle, kind from objects\") lists them."))?;
        let suffix = handle.split('_').nth(2).map(|tag| format!("_{tag}")).unwrap_or_default();

        // The shaders an object is made of, by ID.
        let mut wanted: Vec<i64> = Vec::new();

        match kind.as_str() {
            "shader" => sources.push((handle.to_string(), stage(&object), source.unwrap_or_default())),
            "program" => wanted.extend(object["shaders"].as_array().into_iter().flatten().filter_map(Value::as_i64)),
            "pipeline" => {
                for part in ["vertex", "fragment", "compute"] {
                    if let Some(id) = object["descriptor"][part]["module"]["id"].as_i64() {
                        if !wanted.contains(&id) {
                            wanted.push(id);
                        }
                    }
                }
            }
            other => bail!("{handle} is a {other}. shader_analysis reads shaders, programs and pipelines."),
        }

        for id in wanted {
            let name = format!("shd_{id}{suffix}");

            if let Some((_, object, source)) = detail(&name)? {
                sources.push((name, stage(&object), source.unwrap_or_default()));
            }
        }
    } else {
        let session = host.session(params)?;

        session.check_alive()?;

        let object = session.object(handle)?;
        let detail = session.probe(&object.instance, "registry.get", json!({ "kind": object.kind, "id": object.id }), Duration::from_secs(20)).await?;

        let mut wanted: Vec<i64> = Vec::new();

        match object.kind {
            "shader" => sources.push((handle.to_string(), stage(&detail), detail["source"].as_str().unwrap_or("").to_string())),
            "program" => wanted.extend(detail["shaders"].as_array().into_iter().flatten().filter_map(Value::as_i64)),
            "pipeline" => {
                for part in ["vertex", "fragment", "compute"] {
                    if let Some(id) = detail["descriptor"][part]["module"]["id"].as_i64() {
                        if !wanted.contains(&id) {
                            wanted.push(id);
                        }
                    }
                }
            }
            other => bail!("{handle} is a {}. shader_analysis reads shaders, programs and pipelines.", other.replace('_', " ")),
        }

        for id in wanted {
            let shader = session.probe(&object.instance, "registry.get", json!({ "kind": "shader", "id": id }), Duration::from_secs(20)).await?;

            sources.push((session.object_handle(&object.instance, "shader", id), stage(&shader), shader["source"].as_str().unwrap_or("").to_string()));
        }
    }

    if sources.is_empty() {
        bail!("{handle} has no shader source to read.");
    }

    let mut lines = Vec::new();
    let mut data = Vec::new();

    for (name, what, source) in &sources {
        let figures = read_shader(source);

        lines.extend(describe_reading(name, what, &figures));
        data.push(json!({ "handle": name, "stage": what, "figures": figures }));
    }

    lines.push("These figures are read from the source text: static, not measured. They say what a shader could cost, not what it did.".into());

    Ok(result(lines.join("\n"), json!({ "handle": handle, "shaders": data, "provenance": "static" })))
}

fn stage(object: &Value) -> String {
    // A capture holds WebGL's number for the stage; the live registry gives the word.
    match (object["type"].as_u64(), object["type"].as_str()) {
        (Some(0x8B31), _) | (_, Some("vertex")) => "vertex shader".to_string(),
        (Some(0x8B30), _) | (_, Some("fragment")) => "fragment shader".to_string(),
        _ => "shader module".to_string(),
    }
}

/// What is worth a look, worst first: for a capture, the facts found when it was taken; for
/// a live session, what its objects and its console say.
pub async fn lint(host: &Arc<Host>, params: &Value) -> Result<Value> {
    if params["capture"].is_string() {
        let (handle, meta) = the_capture(host, params)?;
        let mut found: Vec<String> = Vec::new();
        let errors = meta["counts"]["gl_errors"].as_u64().unwrap_or(0);

        if errors > 0 {
            let rows = host.store.query(
                &handle,
                "SELECT command, method, gl_error FROM commands WHERE gl_error IS NOT NULL AND gl_error NOT LIKE 'dropped with%' ORDER BY command",
                &[],
                8,
            )?;

            for row in &rows.rows {
                found.push(format!(
                    "The browser rejected call {} ({}): {}. Such a call does nothing.",
                    row[0],
                    row[1].as_str().unwrap_or(""),
                    page_text(row[2].as_str().unwrap_or(""), 200)
                ));
            }
        }

        if meta["replay_matches"] != true {
            found.push(format!(
                "Replaying this capture did not give the frame's own image ({}), so what replay says of it may be wrong.",
                meta["replay"].as_str().unwrap_or("?")
            ));
        }

        found.extend(meta["findings"].as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_string));

        let mut lines = vec![format!(
            "{}: {}.",
            about(host, params, &handle, &meta),
            match found.len() {
                0 => "nothing stands out".to_string(),
                1 => "1 thing worth a look".to_string(),
                count => format!("{count} things worth a look, the most serious first"),
            }
        )];

        lines.extend(found.iter().map(|finding| format!("  • {finding}")));
        lines.push("These are facts about the frame, not verdicts. What is checked: rejected calls, draws that changed nothing, a viewport that is not its target's size, clears clipped by a scissor box, blended draws under opaque ones, blending off on a translucent colour, textures that cannot be sampled, and what the frame created and deleted.".into());

        return Ok(result(lines.join("\n"), json!({ "capture": handle, "findings": found })));
    }

    let session = host.session(params)?;

    session.check_alive()?;

    let (kinds, sites, _) = crate::inventory::overview(&session).await?;
    let mut found = crate::inventory::growth(&kinds, &sites);

    session.settle().await;

    let errors: Vec<String> = {
        let state = session.state.lock().unwrap();

        state.console.iter().filter(|line| crate::commands::is_error(&line.level, &line.text)).map(|line| page_text(&line.text, 160)).collect()
    };

    if !errors.is_empty() {
        let mut distinct: Vec<&String> = Vec::new();

        for error in &errors {
            if !distinct.contains(&error) {
                distinct.push(error);
            }
        }

        found.insert(
            0,
            format!(
                "{} error{} logged ({} distinct). The first: «{}». console(level: \"error\") has them all.",
                errors.len(),
                if errors.len() == 1 { "" } else { "s" },
                distinct.len(),
                distinct[0]
            ),
        );
    }

    let mut lines = vec![format!(
        "{}: {}.",
        session.id,
        match found.len() {
            0 => "nothing stands out in the page's objects or its console".to_string(),
            1 => "1 thing worth a look".to_string(),
            count => format!("{count} things worth a look"),
        }
    )];

    lines.extend(found.iter().map(|finding| format!("  • {finding}")));
    lines.push("For what a frame itself does wrong, take a capture: its summary, and lint(capture), list what stands out in it.".into());

    Ok(result(lines.join("\n"), json!({ "session": session.id, "findings": found })))
}

// ---- Timing ----

/// GPU time of each draw of a capture, measured by replaying each one several times inside
/// a timer query, then ranked by draw, by program or by pass.
pub async fn profile(host: &Arc<Host>, params: &Value) -> Result<Value> {
    let (handle, meta) = the_capture(host, params)?;
    let by = params["by"].as_str().unwrap_or("draw");

    if !["draw", "shader", "pass"].contains(&by) {
        bail!("by must be draw, shader or pass, not \"{by}\".");
    }

    let top = params["top"].as_u64().unwrap_or(10).clamp(1, 100) as usize;
    let session = host.replayer(params)?;

    load_into(host, &session, &handle).await?;

    // Three runs, and the middle figure for each draw: one run can be thrown by whatever
    // else the GPU was doing.
    let mut samples: BTreeMap<i64, Vec<f64>> = BTreeMap::new();
    let mut times = 16;
    let mut disjoint = false;

    for _ in 0..3 {
        let reply = session.replay("profile", &json!({ "key": handle, "times": params["times"] }), LONG).await?;

        match reply["unsupported"].as_str() {
            Some("webgpu") => bail!("profile is built for WebGL captures. For a WebGPU page, stats() gives GPU time per pass while it runs."),
            Some(_) => bail!("This browser has no timer queries for WebGL 2 (EXT_disjoint_timer_query_webgl2), so GPU time cannot be measured by replay."),
            None => {}
        }

        times = reply["times"].as_u64().unwrap_or(16);
        disjoint |= reply["disjoint"] == true;

        for row in reply["rows"].as_array().into_iter().flatten() {
            samples.entry(row["draw"].as_i64().unwrap_or(-1)).or_default().push(row["ns"].as_f64().unwrap_or(0.0));
        }
    }

    if samples.is_empty() {
        bail!("The replay timed no draws. The capture may have none, or the timer gave no results.");
    }

    let measured: BTreeMap<i64, f64> = samples
        .into_iter()
        .map(|(draw, mut values)| {
            values.sort_by(f64::total_cmp);

            (draw, values[values.len() / 2])
        })
        .collect();
    let total: f64 = measured.values().sum();
    let events = events(host, &handle)?;
    let micro = |ns: f64| format!("{:.1} µs", ns / 1000.0);
    let share = |ns: f64| if total > 0.0 { format!("{:.0}%", ns * 100.0 / total) } else { "0%".to_string() };

    let mut lines = vec![format!(
        "{}: GPU time by {by}. {} draws took {} in all, each timed over {times} repeats, the middle of 3 runs. gpu-measured.",
        about(host, params, &handle, &meta),
        measured.len(),
        if total >= 1e6 { format!("{:.2} ms", total / 1e6) } else { micro(total) }
    )];
    let mut rows = Vec::new();

    if by == "draw" {
        let mut ranked: Vec<(&i64, &f64)> = measured.iter().collect();

        ranked.sort_by(|a, b| b.1.total_cmp(a.1));

        for (draw, ns) in ranked.iter().take(top) {
            let what = events.get(**draw as usize).map(brief).unwrap_or_default();

            lines.push(format!("  event {draw:>4}  {:>10}  {:>4}   {}", micro(**ns), share(**ns), page_text(&what, 150)));
            rows.push(json!({ "draw": draw, "ns": ns }));
        }

        if ranked.len() > top {
            lines.push(format!("  … and {} more draws. top: n shows more.", ranked.len() - top));
        }
    } else {
        // Summed by the program each draw uses, or by the pass it is in.
        let key = if by == "shader" { "program" } else { "pass" };
        let mut groups: BTreeMap<String, (f64, Vec<i64>)> = BTreeMap::new();

        for (draw, ns) in &measured {
            let name = events
                .get(*draw as usize)
                .and_then(|event| event.get(key))
                .map(|value| value.as_str().map(str::to_string).unwrap_or_else(|| value.to_string()))
                .unwrap_or_default();
            let group = groups.entry(name).or_default();

            group.0 += ns;
            group.1.push(*draw);
        }

        let mut ranked: Vec<(&String, &(f64, Vec<i64>))> = groups.iter().collect();

        ranked.sort_by(|a, b| b.1.0.total_cmp(&a.1.0));

        for (name, (ns, draws)) in ranked.iter().take(top) {
            lines.push(format!(
                "  {:<10} {:>10}  {:>4}   {} draw{}: event{} {}",
                if by == "pass" { format!("pass {name}") } else { name.to_string() },
                micro(*ns),
                share(*ns),
                draws.len(),
                if draws.len() == 1 { "" } else { "s" },
                if draws.len() == 1 { "" } else { "s" },
                runs(draws)
            ));
            rows.push(json!({ by: name, "ns": ns, "draws": draws }));
        }

        if by == "shader" {
            lines.push("  shader_analysis(handle, capture) reads what one of these programs does for each pixel.".into());
        }
    }

    lines.push("How it is measured: the frame is replayed, and each draw is issued 16 times in a row inside a timer query before the frame moves on. The figure is that time divided by 16. It ranks draws against each other well; it is not what the draw cost in the page, where it ran once among the others.".into());
    lines.push("A GPU that works a tile at a time (Apple's, and most phones') puts off shading until it must, so a draw's cost can be charged to a later draw or missed. Treat small differences as noise.".into());

    if disjoint {
        lines.push("Warning: the GPU reported a disjoint while timing (it was interrupted), so some of these figures are unreliable. Run it again.".into());
    }

    Ok(result(
        lines.join("\n"),
        json!({ "capture": handle, "by": by, "total_ns": total, "draws": measured.len(), "rows": rows, "provenance": "gpu-measured", "method": "amplified replay" }),
    ))
}

// ---- Views ----

/// A colour for a count of draws on one pixel: black for none, then blue, green, yellow,
/// red, and white for a great many.
fn heat(count: u8) -> [u8; 4] {
    match count {
        0 => [0, 0, 0, 255],
        1 => [24, 44, 110, 255],
        2 => [30, 120, 90, 255],
        3 => [120, 170, 40, 255],
        4 => [220, 190, 40, 255],
        5..=7 => [235, 120, 30, 255],
        8..=15 => [225, 50, 40, 255],
        _ => [255, 255, 255, 255],
    }
}

/// A capture seen another way: how many times each pixel was drawn (overdraw), or its
/// triangles as outlines (wireframe).
pub async fn view(host: &Arc<Host>, params: &Value) -> Result<Value> {
    let (handle, meta) = the_capture(host, params)?;
    let which = params["view"].as_str().ok_or_else(|| anyhow!("view needs view: \"overdraw\" or \"wireframe\"."))?;
    let session = host.replayer(params)?;

    load_into(host, &session, &handle).await?;

    let refuse = |reply: &Value| -> Result<()> {
        match reply["unsupported"].as_str() {
            Some("webgpu") => bail!("The {which} view is built for WebGL captures, and {handle} is a WebGPU capture."),
            Some("stencil") => {
                bail!("Overdraw is counted in the stencil buffer, and this frame uses the stencil test itself, so the two would get in each other's way.")
            }
            Some("no-stencil") => bail!("The browser would not give the replay a stencil buffer, which overdraw is counted in."),
            Some("no-polygon-mode") => bail!("This browser lacks WEBGL_polygon_mode, which the wireframe view draws with."),
            Some(other) => bail!("The {which} view cannot be made of this capture ({other})."),
            None => Ok(()),
        }
    };

    match which {
        "overdraw" => {
            let mut lines = vec![format!("{}: overdraw of the canvas. gpu-measured.", about(host, params, &handle, &meta))];
            let mut data = json!({ "capture": handle, "view": "overdraw", "provenance": "gpu-measured" });
            let mut images = Vec::new();

            // Twice: everything that was rasterised, and what survived the depth test.
            for (name, visible, what) in
                [("all", false, "Every fragment drawn, whether or not it passed the depth test"), ("visible", true, "Fragments that passed the depth test")]
            {
                let reply = session.replay("overdraw", &json!({ "key": handle, "visible": visible }), LONG).await?;

                refuse(&reply)?;

                let (width, height) = (reply["width"].as_u64().unwrap_or(0) as u32, reply["height"].as_u64().unwrap_or(0) as u32);
                let counts = crate::capture::unpack(reply["counts"].as_str().unwrap_or(""))?;

                if counts.is_empty() || counts.len() != (width * height) as usize {
                    bail!("The replay returned no overdraw counts.");
                }

                let top = reply["top"].as_u64().unwrap_or(64) as u8;
                let total: u64 = counts.iter().map(|count| *count as u64).sum();
                let most = *counts.iter().max().unwrap_or(&0);
                let pixels = counts.len() as f64;
                let share = |least: u8| counts.iter().filter(|count| **count >= least).count() as f64 * 100.0 / pixels;

                // Where it is worst: the box around the pixels at or near the most.
                let near = most.saturating_sub(most / 4).max(1);
                let (mut left, mut right, mut up, mut down) = (width, 0u32, height, 0u32);

                for (index, count) in counts.iter().enumerate() {
                    if *count >= near {
                        let (x, y) = (index as u32 % width, index as u32 / width);

                        left = left.min(x);
                        right = right.max(x);
                        up = up.min(y);
                        down = down.max(y);
                    }
                }

                lines.push(format!(
                    "{what}: {:.2} a pixel on average, {}{most} at most. {:.0}% of pixels drawn twice or more, {:.0}% four times or more.",
                    total as f64 / pixels,
                    if most >= top { "at least " } else { "" },
                    share(2),
                    share(4)
                ));

                if most > 1 {
                    lines.push(format!("  Worst ({near} or more) within x {left} y {up} {}×{}.", right - left + 1, down - up + 1));
                }

                let picture = Image::new(width, height, counts.iter().flat_map(|count| heat(*count)).collect())?;
                let path = host.store.capture_dir(&handle).join(format!("overdraw-{name}.png"));

                std::fs::write(&path, picture.to_png()?).with_context(|| format!("writing {}", path.display()))?;
                lines.push(format!("  Picture: {}", path.display()));
                images.push(json!({ "view": path, "original": path, "width": width, "height": height, "scale": 1.0, "space": "canvas_px" }));

                data[name] = json!({ "mean": total as f64 / pixels, "max": most, "twice_or_more": share(2), "four_or_more": share(4), "worst": { "x": left, "y": up, "w": right - left + 1, "h": down - up + 1 } });
            }

            lines.push("In the pictures: black is never drawn, then blue for once, green twice, yellow-green three times, yellow four, orange five to seven, red eight to fifteen, white more. A large gap between the two figures means a lot was drawn and then hidden: draw front to back, or cull what cannot be seen.".into());

            let mut value = result(lines.join("\n"), data);

            value["images"] = json!(images);

            Ok(value)
        }
        "wireframe" => {
            let reply = session.replay("wireframe", &json!({ "key": handle, "draw": params["at_draw"] }), LONG).await?;

            refuse(&reply)?;

            let picture = Image::new(
                reply["width"].as_u64().unwrap_or(0) as u32,
                reply["height"].as_u64().unwrap_or(0) as u32,
                crate::capture::unpack(reply["data"].as_str().unwrap_or(""))?,
            )?;
            let name = match params["at_draw"].as_i64() {
                Some(draw) => format!("wireframe-draw{draw}.png"),
                None => "wireframe.png".to_string(),
            };
            let path = host.store.capture_dir(&handle).join(name);

            std::fs::write(&path, picture.opaque().to_png()?).with_context(|| format!("writing {}", path.display()))?;

            let mut value = result(
                format!(
                    "{}: the frame{} with its triangles drawn as outlines, in their own colours. gpu-measured. {}",
                    about(host, params, &handle, &meta),
                    match params["at_draw"].as_i64() {
                        Some(draw) => format!(" up to event {draw}"),
                        None => String::new(),
                    },
                    path.display()
                ),
                json!({ "capture": handle, "view": "wireframe", "at_draw": params["at_draw"], "provenance": "gpu-measured" }),
            );

            value["images"] = json!([{ "view": path, "original": path, "width": picture.width, "height": picture.height, "scale": 1.0, "space": "canvas_px" }]);

            Ok(value)
        }
        other => bail!("There is no \"{other}\" view. Views are overdraw and wireframe."),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_glsl_shader_is_read_for_what_it_could_cost() {
        let figures = read_shader(
            r#"#version 300 es
            precision mediump float;
            uniform sampler2D scene;
            uniform sampler2D unusedMap;   // never sampled
            uniform vec2 direction;
            in vec2 uv;
            out vec4 colour;

            void main () {
                vec4 sum = texture(scene, uv);

                /* a blur: 64 taps */
                for (int i = 0; i < 64; i++) {
                    sum += texture(scene, uv + direction * float(i));

                    if (sum.a > 4.0) { discard; }
                }

                colour = vec4(pow(sum.rgb / 65.0, vec3(2.2)), 1.0);
            }"#,
        );

        assert_eq!(figures["language"], "GLSL");
        assert_eq!(figures["samples"], 2);
        assert_eq!(figures["samples_in_loops"], 1);
        assert_eq!(figures["samples_per_run"], 65, "one outside the loop, 64 passes of one inside");
        assert_eq!(figures["loops"][0]["passes"], 64);
        assert_eq!(figures["branches"], 1);
        assert_eq!(figures["discards"], 1);
        assert_eq!(figures["maths"]["pow"], 1);
        assert_eq!(figures["unused"], json!(["uniform unusedMap"]));
    }

    #[test]
    fn a_wgsl_module_is_read_too() {
        let figures = read_shader(
            r#"
            @group(0) @binding(0) var colourMap: texture_2d<f32>;
            @group(0) @binding(1) var smooth: sampler;
            @group(0) @binding(2) var<uniform> settings: vec4f;
            @group(0) @binding(3) var<uniform> spare: vec4f;

            @fragment fn fs (@location(0) uv: vec2f) -> @location(0) vec4f {
                var total = vec4f(0.0);

                for (var i = 0u; i < 8u; i++) {
                    total += textureSample(colourMap, smooth, uv + settings.xy * f32(i));
                }

                return total / 8.0;
            }"#,
        );

        assert_eq!(figures["language"], "WGSL");
        assert_eq!(figures["samples"], 1);
        assert_eq!(figures["samples_per_run"], 8);
        assert_eq!(figures["unused"], json!(["var spare"]));
    }

    #[test]
    fn events_are_lined_up_in_order() {
        let a: Vec<String> = ["clear", "ground", "glass", "crate", "crate", "hud"].iter().map(|s| s.to_string()).collect();
        let b: Vec<String> = ["clear", "ground", "crate", "crate", "glass", "hud"].iter().map(|s| s.to_string()).collect();

        assert_eq!(align(&a, &b), vec![(0, 0), (1, 1), (3, 2), (4, 3), (5, 5)]);
    }
}
