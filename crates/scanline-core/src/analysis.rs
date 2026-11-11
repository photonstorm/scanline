//! Analysis of captures (04-AGENT-INTERFACE.md, section 3.6): comparing two frames, the
//! history of a pixel, views such as overdraw, and what can be said of a shader by reading it.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use anyhow::{Context, Result, bail};
use scanline_image::Image;
use serde_json::{Value, json};

use crate::capture::{describe_event, draw_state, flatten, rows_as_objects, runs};
use crate::commands::page_text;
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
