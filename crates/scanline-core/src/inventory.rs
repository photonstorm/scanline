//! The live inventory: every GPU object the page has created, one object in full, and memory.
//!
//! Sizes here are `estimated`: computed from dimensions and formats. No route gives the
//! bytes a driver really used for one texture (03-INSPECTION.md, section 8).

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use base64::Engine;
use serde_json::{Value, json};

use crate::commands::{SHORT, page_text, screenshot, status};
use crate::result;
use crate::session::{Instance, OBJECT_KINDS, ObjectRef, Session};

pub fn size(bytes: f64) -> String {
    let magnitude = bytes.abs();

    if magnitude >= 1024.0 * 1024.0 * 1024.0 {
        format!("{:.2} GB", bytes / (1024.0 * 1024.0 * 1024.0))
    } else if magnitude >= 1024.0 * 1024.0 {
        format!("{:.1} MB", bytes / (1024.0 * 1024.0))
    } else if magnitude >= 1024.0 {
        format!("{:.1} KB", bytes / 1024.0)
    } else {
        format!("{bytes:.0} B")
    }
}

/// A creation call site, shortened: the origin dropped from URLs, and one frame unless asked for all.
fn site(text: &str, full: bool) -> String {
    frames_of(text, if full { 3 } else { 1 })
}

fn frames_of(text: &str, keep: usize) -> String {
    let full = keep > 1;

    let mut frames: Vec<String> = text
        .split(" < ")
        .map(|frame| {
            // "name (http://host:port/path/file.js:10:5)" becomes "name (path/file.js:10:5)".
            match (frame.find("://"), frame.rfind('/')) {
                (Some(scheme), Some(_)) => {
                    let start = frame[..scheme].rfind(['(', ' ']).map(|i| i + 1).unwrap_or(0);
                    let after = &frame[scheme + 3..];
                    let path = after.find('/').map(|slash| &after[slash + 1..]).unwrap_or(after);

                    format!("{}{}", &frame[..start], path)
                }
                _ => frame.to_string(),
            }
        })
        .collect();

    frames.truncate(keep);

    page_text(&frames.join(" < "), if full { 400 } else { 110 })
}

fn kind_named(name: &str) -> Result<&'static str> {
    OBJECT_KINDS
        .iter()
        .find(|entry| entry.0 == name || entry.1 == name)
        .map(|entry| entry.0)
        .ok_or_else(|| anyhow!("Unknown kind \"{name}\". Kinds are: {}, context.", OBJECT_KINDS.iter().map(|entry| entry.0).collect::<Vec<_>>().join(", ")))
}

fn plural(kind: &str, count: u64) -> String {
    let noun = kind.replace('_', " ");

    match (count, kind) {
        (1, _) => format!("1 {noun}"),
        (_, "query") => format!("{count} queries"),
        _ => format!("{count} {noun}s"),
    }
}

fn describe_row(session: &Session, instance: &Instance, row: &Value, full: bool) -> (String, Value) {
    let kind = row["kind"].as_str().unwrap_or("");
    let handle = session.object_handle(instance, kind, row["id"].as_i64().unwrap_or(0));
    let mut text = handle.clone();

    if let Some(label) = row["label"].as_str() {
        text.push_str(&format!(" «{}»", page_text(label, 60)));
    }

    text.push_str(&format!("  {}", row["what"].as_str().unwrap_or("")));

    if row["bytes"].as_f64().unwrap_or(0.0) > 0.0 && kind != "shader" {
        text.push_str(&format!("  {}", size(row["bytes"].as_f64().unwrap_or(0.0))));
    }

    text.push_str(&format!("  created f{}", row["created"]));

    // "Last used" is exact for WebGL, where binding is observed. For WebGPU it is sampled:
    // a frame in sixteen, so "not seen in use" is weaker than "never used".
    if row["api"] == "webgl" && matches!(kind, "texture" | "buffer" | "program" | "framebuffer") {
        match row["used"].as_i64() {
            Some(frame) if frame >= 0 => text.push_str(&format!(", used f{frame}")),
            _ => text.push_str(", never used"),
        }
    } else if row["api"] == "webgpu" && matches!(kind, "texture" | "buffer" | "pipeline" | "bind_group" | "sampler" | "bundle") {
        match row["used"].as_i64() {
            Some(frame) if frame >= 0 => text.push_str(&format!(", used ~f{frame}")),
            _ => text.push_str(", not seen in use"),
        }
    }

    if row["alive"] == false {
        text.push_str(&format!(", DESTROYED f{}", row["destroyedAt"]));
    }

    let at = row["site"].as_str().unwrap_or("");

    if at != "(unknown)" && !at.is_empty() {
        text.push_str(&format!("  at {}", site(at, full)));
    }

    let mut data = row.clone();

    data["handle"] = json!(handle);

    (text, data)
}

pub async fn resources(session: &Arc<Session>, params: &Value) -> Result<Value> {
    let Some(kind) = params["kind"].as_str() else {
        // No kind: what there is to list.
        let (kinds, sites, _) = overview(session).await?;
        let mut lines = vec!["GPU objects alive now, by kind. Pass kind to list one:".to_string()];

        for (kind, _) in OBJECT_KINDS {
            if let Some((alive, bytes, created)) = kinds.get(*kind).filter(|entry| entry.2 > 0) {
                lines.push(format!(
                    "  {:<14} {alive} alive{}{}",
                    kind,
                    if *bytes > 0.0 { format!(", {}", size(*bytes)) } else { String::new() },
                    if created > alive { format!(" ({created} created in all)") } else { String::new() }
                ));
            }
        }

        lines.extend(growth(&kinds, &sites));
        lines.push("resources(kind: \"texture\") lists the textures, largest first; kind: \"context\" the rendering contexts.".into());

        return Ok(result(
            lines.join("\n"),
            json!({ "kinds": kinds.iter().map(|(kind, entry)| (kind.clone(), json!({ "alive": entry.0, "bytes": entry.1, "created": entry.2 }))).collect::<serde_json::Map<_, _>>(), "sites": sites }),
        ));
    };

    if kind == "context" {
        return status(session).await;
    }

    let kind = kind_named(kind)?;
    let limit = params["limit"].as_u64().unwrap_or(25).clamp(1, 200) as usize;
    let cursor = params["cursor"].as_u64().unwrap_or(0) as usize;
    let sort = params["sort"].as_str().unwrap_or("bytes");
    let full = params["detail"].as_str() == Some("full");
    let dead = params["dead"].as_bool().unwrap_or(false);

    if !["bytes", "created", "last_used"].contains(&sort) {
        bail!("sort must be bytes, created or last_used, not \"{sort}\".");
    }

    // Each probe returns its own best rows; the pages are merged here.
    let args = json!({ "kind": kind, "sort": sort, "filter": params["filter"], "dead": dead, "offset": 0, "limit": cursor + limit });
    let reports = session.probe_all("registry.list", args, SHORT).await;

    if reports.is_empty() {
        session.top()?;
    }

    let key = match sort {
        "created" => "created",
        "last_used" => "used",
        _ => "bytes",
    };

    let mut rows: Vec<(Instance, Value)> = Vec::new();
    let mut total = 0u64;

    for (instance, report) in &reports {
        total += report["total"].as_u64().unwrap_or(0);

        for row in report["rows"].as_array().into_iter().flatten() {
            rows.push((instance.clone(), row.clone()));
        }
    }

    // Ties go to the lower ID, except "newest first", where the higher ID is the newer.
    rows.sort_by(|a, b| {
        let by_id = a.1["id"].as_i64().cmp(&b.1["id"].as_i64());

        b.1[key].as_f64().unwrap_or(0.0).total_cmp(&a.1[key].as_f64().unwrap_or(0.0)).then(if sort == "created" { by_id.reverse() } else { by_id })
    });

    let page: Vec<(String, Value)> = rows.iter().skip(cursor).take(limit).map(|(instance, row)| describe_row(session, instance, row, full)).collect();
    let bytes: f64 = rows.iter().map(|(_, row)| row["bytes"].as_f64().unwrap_or(0.0)).sum();
    let filtered = params["filter"].as_str().map(|filter| format!(" matching \"{filter}\"")).unwrap_or_default();
    let order = match sort {
        "created" => "newest first",
        "last_used" => "most recently used first",
        _ => "largest first",
    };

    let mut lines = Vec::new();

    if total == 0 {
        lines.push(format!("No {}{filtered}{}.", plural(kind, 2).split_once(' ').unwrap().1, if dead { "" } else { " alive" }));
    } else {
        let shown = if (page.len() as u64) < total { format!(" Showing {}, {order}.", page.len()) } else { format!(" Listed {order}.") };
        let held = if kind == "shader" || bytes == 0.0 || (rows.len() as u64) < total { String::new() } else { format!(", {} estimated", size(bytes)) };

        lines.push(format!("{}{filtered}{}{held}.{shown}", plural(kind, total), if dead { " (destroyed ones included)" } else { " alive" }));
    }

    lines.extend(page.iter().map(|(text, _)| format!("  {text}")));

    let next = cursor + page.len();

    if (next as u64) < total {
        lines.push(format!(
            "total {total}, returned {}, next_cursor {next}. Narrow with filter: \"…\" (matches label, description and call site) or change sort.",
            page.len()
        ));
    }

    if total > 0 {
        lines.push("Call resource(handle) for one in full. Text between « » is from the page.".into());
    }

    // Many alive from one line of code, or many made and destroyed: say so here too.
    if let Ok((kinds, sites, _)) = overview(session).await {
        let (mine, here): (BTreeMap<String, (u64, f64, u64)>, Vec<Value>) =
            (kinds.into_iter().filter(|(name, _)| name == kind).collect(), sites.into_iter().filter(|site| site["kind"] == kind).collect());

        lines.extend(growth(&mine, &here));
    }

    Ok(result(
        lines.join("\n"),
        json!({
            "kind": kind,
            "rows": page.iter().map(|(_, data)| data.clone()).collect::<Vec<_>>(),
            "total": total,
            "returned": page.len(),
            "next_cursor": if (next as u64) < total { json!(next) } else { Value::Null },
            "provenance": "estimated",
        }),
    ))
}

// ---- One object ----

pub(crate) fn gl_name(value: &Value) -> String {
    // WebGPU's settings are already words.
    if let Some(word) = value.as_str() {
        return word.to_string();
    }

    let Some(code) = value.as_u64() else { return value.to_string() };

    let name = match code {
        0x0200 => "NEVER",
        0x0201 => "LESS",
        0x0202 => "EQUAL",
        0x0203 => "LEQUAL",
        0x0204 => "GREATER",
        0x0205 => "NOTEQUAL",
        0x0206 => "GEQUAL",
        0x0207 => "ALWAYS",
        0x0300 => "SRC_COLOR",
        0x0301 => "ONE_MINUS_SRC_COLOR",
        0x0302 => "SRC_ALPHA",
        0x0303 => "ONE_MINUS_SRC_ALPHA",
        0x0304 => "DST_ALPHA",
        0x0305 => "ONE_MINUS_DST_ALPHA",
        0x0306 => "DST_COLOR",
        0x0307 => "ONE_MINUS_DST_COLOR",
        0x0308 => "SRC_ALPHA_SATURATE",
        0x8001 => "CONSTANT_COLOR",
        0x8002 => "ONE_MINUS_CONSTANT_COLOR",
        0x8003 => "CONSTANT_ALPHA",
        0x8004 => "ONE_MINUS_CONSTANT_ALPHA",
        0x8006 => "FUNC_ADD",
        0x800A => "FUNC_SUBTRACT",
        0x800B => "FUNC_REVERSE_SUBTRACT",
        0x8007 => "MIN",
        0x8008 => "MAX",
        0x0404 => "FRONT",
        0x0405 => "BACK",
        0x0408 => "FRONT_AND_BACK",
        0x0900 => "CW",
        0x0901 => "CCW",
        0x1E00 => "KEEP",
        0x1E01 => "REPLACE",
        0x1E02 => "INCR",
        0x1E03 => "DECR",
        0x150A => "INVERT",
        0x8507 => "INCR_WRAP",
        0x8508 => "DECR_WRAP",
        0x1400 => "BYTE",
        0x1401 => "UNSIGNED_BYTE",
        0x1402 => "SHORT",
        0x1403 => "UNSIGNED_SHORT",
        0x1404 => "INT",
        0x1405 => "UNSIGNED_INT",
        0x1406 => "FLOAT",
        0x140B => "HALF_FLOAT",
        0x2600 => "NEAREST",
        0x2601 => "LINEAR",
        0x2700 => "NEAREST_MIPMAP_NEAREST",
        0x2701 => "LINEAR_MIPMAP_NEAREST",
        0x2702 => "NEAREST_MIPMAP_LINEAR",
        0x2703 => "LINEAR_MIPMAP_LINEAR",
        0x2901 => "REPEAT",
        0x812F => "CLAMP_TO_EDGE",
        0x8370 => "MIRRORED_REPEAT",
        0x0BE2 => "BLEND",
        0x0B44 => "CULL_FACE",
        0x0B71 => "DEPTH_TEST",
        0x0BD0 => "DITHER",
        0x8037 => "POLYGON_OFFSET_FILL",
        0x809E => "SAMPLE_ALPHA_TO_COVERAGE",
        0x80A0 => "SAMPLE_COVERAGE",
        0x0C11 => "SCISSOR_TEST",
        0x0B90 => "STENCIL_TEST",
        0x8C89 => "RASTERIZER_DISCARD",
        0x2800 => "MAG_FILTER",
        0x2801 => "MIN_FILTER",
        0x2802 => "WRAP_S",
        0x2803 => "WRAP_T",
        0x8072 => "WRAP_R",
        0x813D => "MAX_LEVEL",
        0x813C => "BASE_LEVEL",
        0x884C => "COMPARE_MODE",
        0x884D => "COMPARE_FUNC",
        0x84FE => "MAX_ANISOTROPY",
        _ => return format!("0x{code:04X}"),
    };

    name.to_string()
}

/// Blend factors 0 and 1 share their numbers with false and true, so they are named here.
pub(crate) fn factor(value: &Value) -> String {
    match value.as_u64() {
        Some(0) => "ZERO".into(),
        Some(1) => "ONE".into(),
        _ => gl_name(value),
    }
}

pub(crate) fn list(value: &Value) -> String {
    value.as_array().map(|items| items.iter().map(|item| item.to_string()).collect::<Vec<_>>().join(", ")).unwrap_or_default()
}

fn handle_of(session: &Session, instance: &Instance, kind: &str, id: &Value) -> String {
    match id.as_i64() {
        None => "none".into(),
        Some(0) => "(an object Scanline has no record of)".into(),
        Some(id) => session.object_handle(instance, kind, id),
    }
}

async fn context_state(session: &Arc<Session>, handle: &str, params: &Value) -> Result<Value> {
    let context = session.context(handle)?;

    if context.api == "webgpu" {
        bail!(
            "{handle} is a WebGPU context. WebGPU has no global state to show: the state of a draw is its pipeline and bind groups. Call resources(kind: \"pipeline\")."
        );
    }

    let state = session.probe(&context.instance, "registry.state", json!({ "context": context.local }), SHORT).await?;
    let named = |kind: &str, id: &Value| handle_of(session, &context.instance, kind, id);
    let on: Vec<String> = state["enabled"].as_array().into_iter().flatten().map(gl_name).collect();
    let blend = &state["blend"];
    let depth = &state["depth"];

    let mut lines = vec![format!("{handle} state now, from Scanline's mirror of it (no questions asked of the context):")];

    lines.push(format!(
        "  program {}, framebuffer {}, vertex array {}",
        named("program", &state["program"]),
        named("framebuffer", &state["framebuffer"]),
        named("vertex_array", &state["vertexArray"])
    ));
    lines.push(format!("  enabled: {}", if on.is_empty() { "nothing".into() } else { on.join(", ") }));
    lines.push(format!("  viewport {}; scissor {}", list(&state["viewport"]), list(&state["scissor"])));

    lines.push(format!(
        "  blend: rgb {} × {} + dst × {}, alpha {} × {} + dst × {}{}",
        gl_name(&blend["equationRgb"]),
        factor(&blend["srcRgb"]),
        factor(&blend["dstRgb"]),
        gl_name(&blend["equationAlpha"]),
        factor(&blend["srcAlpha"]),
        factor(&blend["dstAlpha"]),
        if on.iter().any(|cap| cap == "BLEND") { "" } else { " (blending is off)" }
    ));

    lines.push(format!(
        "  depth: func {}, write {}, range {}{}",
        gl_name(&depth["func"]),
        depth["mask"],
        list(&depth["range"]),
        if on.iter().any(|cap| cap == "DEPTH_TEST") { "" } else { " (depth test is off)" }
    ));

    lines.push(format!(
        "  cull {}, front face {}; colour mask {}",
        gl_name(&state["cull"]["face"]),
        gl_name(&state["cull"]["frontFace"]),
        list(&state["colorMask"])
    ));

    for unit in state["textures"].as_array().into_iter().flatten() {
        let bound: Vec<String> = [("t2d", "2D"), ("cube", "cube"), ("t3d", "3D"), ("array", "2D array")]
            .iter()
            .filter(|(key, _)| !unit[*key].is_null())
            .map(|(key, name)| format!("{name} {}", named("texture", &unit[*key])))
            .collect();

        lines.push(format!("  unit {}: {}", unit["unit"], bound.join(", ")));
    }

    for attribute in state["attributes"].as_array().into_iter().flatten() {
        lines.push(format!(
            "  attribute {}: {} × {}{} from {}, stride {}, offset {}{}",
            attribute["index"],
            attribute["size"],
            gl_name(&attribute["type"]),
            if attribute["normalized"] == true { " normalised" } else { "" },
            named("buffer", &attribute["buffer"]),
            attribute["stride"],
            attribute["offset"],
            if attribute["divisor"].as_u64().unwrap_or(0) > 0 { format!(", per instance (divisor {})", attribute["divisor"]) } else { String::new() }
        ));
    }

    let mut data = json!({ "context": handle, "state": state });

    if params["verify"] == true {
        // The mirror against the real context: dozens of round trips to the GPU process.
        let checks = session.probe(&context.instance, "registry.verify", json!({ "context": context.local }), Duration::from_secs(20)).await?;
        let check = &checks[0];
        let drift = check["drift"].as_array().cloned().unwrap_or_default();

        if drift.is_empty() {
            lines.push(format!("Verified: all {} values match what the context reports.", check["checked"]));
        } else {
            lines.push(format!(
                "Verify found {} of {} values differ from the context. A call the browser rejected, or a fault in Scanline's mirror:",
                drift.len(),
                check["checked"]
            ));

            for entry in drift.iter().take(12) {
                lines.push(format!(
                    "  {}: mirror {}, context {}",
                    entry["what"].as_str().unwrap_or(""),
                    entry["mirror"].as_str().unwrap_or(""),
                    entry["real"].as_str().unwrap_or("")
                ));
            }
        }

        data["verify"] = check.clone();
    } else {
        lines.push("Pass verify: true to check this against the context itself.".into());
    }

    Ok(result(lines.join("\n"), data))
}

/// Replaces `{ref: "shader", id: 3}` in a descriptor with the handle `"shd_3"`.
fn name_references(session: &Session, instance: &Instance, value: &mut Value) {
    match value {
        Value::Object(object) => {
            if let (Some(kind), Some(id)) = (object.get("ref").and_then(Value::as_str), object.get("id").and_then(Value::as_i64)) {
                let handle = if id == 0 { "(an object Scanline has no record of)".to_string() } else { session.object_handle(instance, kind, id) };

                *value = match object.get("view").filter(|view| !view.is_null()) {
                    Some(view) => json!({ "view of": handle, "descriptor": view }),
                    None => json!(handle),
                };

                return;
            }

            for child in object.values_mut() {
                name_references(session, instance, child);
            }
        }
        Value::Array(items) => {
            for child in items {
                name_references(session, instance, child);
            }
        }
        _ => {}
    }
}

fn numbered(source: &str) -> String {
    source.lines().enumerate().map(|(index, line)| format!("{:>4}  {line}", index + 1)).collect::<Vec<_>>().join("\n")
}

fn write_text(session: &Session, name: &str, text: &str) -> Result<std::path::PathBuf> {
    let dir = session.dir.join("shaders");

    std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;

    let path = dir.join(name);

    std::fs::write(&path, text).with_context(|| format!("writing {}", path.display()))?;

    Ok(path)
}

const INLINE_LINES: usize = 60;

fn describe_shader(session: &Session, object: &ObjectRef, detail: &Value, lines: &mut Vec<String>) -> Result<()> {
    let source = detail["source"].as_str().unwrap_or("");
    let webgpu = detail["api"] == "webgpu";

    if webgpu {
        let messages = detail["messages"].as_array().cloned().unwrap_or_default();

        lines.push(if messages.is_empty() {
            "Compiled with no messages.".into()
        } else {
            format!("{} compilation message{}:", messages.len(), if messages.len() == 1 { "" } else { "s" })
        });

        for message in messages.iter().take(20) {
            lines.push(format!(
                "  {} at {}:{}: «{}»",
                message["type"].as_str().unwrap_or(""),
                message["line"],
                message["column"],
                page_text(message["text"].as_str().unwrap_or(""), 300)
            ));
        }
    } else if detail["compiles"].as_u64().unwrap_or(0) == 0 {
        lines.push("Never compiled.".into());
    } else {
        // A deleted shader can no longer be asked whether it compiled. Deleting one after
        // linking is ordinary, and the program made from it goes on working.
        lines.push(if detail["compiled"] == true {
            "Compiled.".into()
        } else if detail["alive"] == false {
            "The page has deleted this shader, so its compile status and log can no longer be read. That is ordinary after linking: a program linked from it still works, and its source is below.".into()
        } else {
            "COMPILE FAILED.".into()
        });

        let log = detail["log"].as_str().unwrap_or("").trim();

        if !log.is_empty() {
            lines.push("Compile log:".into());
            lines.extend(log.lines().take(30).map(|line| format!("  «{}»", page_text(line, 300))));
        }
    }

    let extension = if webgpu { "wgsl" } else { "glsl" };
    let path = write_text(session, &format!("{}.{extension}", object.handle), source)?;
    let count = source.lines().count();

    lines.push(format!("Source ({count} lines, written to {}). Shader text is from the page:", path.display()));
    lines.push(numbered(&source.lines().take(INLINE_LINES).collect::<Vec<_>>().join("\n")));

    if count > INLINE_LINES {
        lines.push(format!("  … {} more lines in the file.", count - INLINE_LINES));
    }

    if let Some(translated) = detail["translated"].as_str().filter(|text| !text.is_empty()) {
        let path = write_text(session, &format!("{}.translated.{extension}", object.handle), translated)?;

        lines.push(format!("What the browser compiled it to (ANGLE's translation, {} lines): {}", translated.lines().count(), path.display()));
    }

    Ok(())
}

fn describe_program(session: &Session, object: &ObjectRef, detail: &Value, lines: &mut Vec<String>) {
    let shaders: Vec<String> = detail["shaders"].as_array().into_iter().flatten().map(|id| handle_of(session, &object.instance, "shader", id)).collect();

    lines.push(format!("Shaders: {}.", if shaders.is_empty() { "none attached".into() } else { shaders.join(", ") }));

    if detail["links"].as_u64().unwrap_or(0) == 0 {
        lines.push("Never linked.".into());

        return;
    }

    lines.push(match detail["linked"].as_bool() {
        Some(true) => "Linked.".into(),
        Some(false) => "LINK FAILED.".into(),
        // A destroyed program cannot be asked.
        None => format!(
            "Linked {}. It has since been destroyed, so its link status, log and uniforms can no longer be read.",
            if detail["links"] == 1 { "once".to_string() } else { format!("{} times", detail["links"]) }
        ),
    });

    let log = detail["log"].as_str().unwrap_or("").trim();

    if !log.is_empty() {
        lines.push("Link log:".into());
        lines.extend(log.lines().take(20).map(|line| format!("  «{}»", page_text(line, 300))));
    }

    let attributes = detail["attributes"].as_array().cloned().unwrap_or_default();

    if !attributes.is_empty() {
        lines.push(format!("{} active attribute{}:", attributes.len(), if attributes.len() == 1 { "" } else { "s" }));
        lines.extend(attributes.iter().map(|attribute| {
            format!("  location {}  {} {}", attribute["location"], attribute["type"].as_str().unwrap_or("?"), attribute["name"].as_str().unwrap_or(""))
        }));
    }

    let uniforms = detail["uniforms"].as_array().cloned().unwrap_or_default();

    if !uniforms.is_empty() {
        lines.push(format!("{} active uniform{}, with the value the page last set:", uniforms.len(), if uniforms.len() == 1 { "" } else { "s" }));

        for uniform in &uniforms {
            let value = match uniform["value"].as_array() {
                Some(values) => {
                    let shown: Vec<String> =
                        values.iter().take(16).map(|value| value.as_f64().map(|n| format!("{}", (n * 1e6).round() / 1e6)).unwrap_or_default()).collect();

                    format!("{}{}  (set f{})", shown.join(", "), if values.len() > 16 { ", …" } else { "" }, uniform["setAt"])
                }
                None => "never set since linking: holds its default (0)".into(),
            };

            let array = if uniform["size"].as_u64().unwrap_or(1) > 1 { format!("[{}]", uniform["size"]) } else { String::new() };

            lines.push(format!(
                "  {} {}{array} = {value}",
                uniform["type"].as_str().unwrap_or("?"),
                uniform["name"].as_str().unwrap_or("").trim_end_matches("[0]")
            ));
        }
    }
}

async fn describe_buffer(session: &Arc<Session>, object: &ObjectRef, params: &Value, lines: &mut Vec<String>, data: &mut Value) {
    let offset = params["offset"].as_u64().unwrap_or(0);
    let length = params["length"].as_u64().unwrap_or(64).clamp(1, 4096);

    match session.probe(&object.instance, "registry.readBuffer", json!({ "id": object.id, "offset": offset, "length": length }), Duration::from_secs(20)).await
    {
        Ok(read) => {
            let bytes = base64::engine::general_purpose::STANDARD.decode(read["data"].as_str().unwrap_or("")).unwrap_or_default();

            if bytes.is_empty() {
                lines.push("The buffer is empty.".into());

                return;
            }

            lines.push(format!(
                "Bytes {}–{} of {}, read back from the GPU (gpu-measured):",
                read["offset"],
                read["offset"].as_u64().unwrap_or(0) + bytes.len() as u64 - 1,
                read["size"]
            ));

            for (row, chunk) in bytes.chunks(16).take(8).enumerate() {
                lines.push(format!("  {:>6}  {}", offset as usize + row * 16, chunk.iter().map(|byte| format!("{byte:02x}")).collect::<Vec<_>>().join(" ")));
            }

            // The same bytes as the types vertex and index data usually have.
            let floats: Vec<String> =
                bytes.chunks_exact(4).take(16).map(|c| format!("{}", (f32::from_le_bytes([c[0], c[1], c[2], c[3]]) as f64 * 1e5).round() / 1e5)).collect();
            let shorts: Vec<String> = bytes.chunks_exact(2).take(16).map(|c| u16::from_le_bytes([c[0], c[1]]).to_string()).collect();

            lines.push(format!("  as float32: {}", floats.join(", ")));
            lines.push(format!("  as uint16:  {}", shorts.join(", ")));
            lines.push("Pass offset and length (up to 4096) for another part. Decoding by a draw's vertex layout comes with frame capture.".into());

            data["head"] = json!({ "offset": read["offset"], "bytes": bytes });
        }
        Err(error) => lines.push(format!("Contents not read: {error}")),
    }
}

/// Small pictures of many textures at once, for the Scanline app's gallery: a screenshot of
/// each (screenshot(source)), one after another. Up to 200 handles.
pub async fn thumbnails(session: &Arc<Session>, params: &Value) -> Result<Value> {
    let handles: Vec<String> = params["handles"].as_array().into_iter().flatten().filter_map(|handle| handle.as_str().map(str::to_string)).take(200).collect();
    let edge = params["max_edge"].as_u64().unwrap_or(160).clamp(16, 512);
    let mut rows = Vec::new();
    let mut made = 0;

    for handle in &handles {
        // A texture with mipmaps is read at the level nearest the picture's size, not whole.
        let detail = resource(session, &json!({ "handle": handle })).await.ok();
        let level = detail
            .as_ref()
            .map(|value| &value["data"]["detail"])
            .filter(|detail| {
                detail["levels"].as_u64().unwrap_or(1) > 1 && (detail["generatedMips"] == true || detail["immutable"] == true || detail["api"] == "webgpu")
            })
            .map(|detail| {
                let largest = detail["width"].as_u64().unwrap_or(1).max(detail["height"].as_u64().unwrap_or(1)) as f64;
                let wanted = (largest / edge as f64).log2().floor().max(0.0) as u64;

                wanted.min(detail["levels"].as_u64().unwrap_or(1) - 1)
            })
            .unwrap_or(0);

        match crate::commands::screenshot(session, &json!({ "source": handle, "max_edge": edge, "level": level })).await {
            Ok(shot) => {
                let image = &shot["images"][0];

                made += 1;
                rows.push(json!({ "handle": handle, "image": image["view"], "width": image["width"], "height": image["height"] }));
            }
            Err(error) => rows.push(json!({ "handle": handle, "error": format!("{error:#}") })),
        }
    }

    Ok(crate::result(format!("Pictures of {made} of {} textures, at most {edge} pixels on a side.", handles.len()), json!({ "thumbnails": rows })))
}

pub async fn resource(session: &Arc<Session>, params: &Value) -> Result<Value> {
    let Some(handle) = params["handle"].as_str() else {
        bail!("resource needs handle: an object such as tex_3 (from resources) or a context such as ctx_1 (from status).");
    };

    if handle.starts_with("ctx_") {
        return context_state(session, handle, params).await;
    }

    let object = session.object(handle)?;
    let detail = session.probe(&object.instance, "registry.get", json!({ "kind": object.kind, "id": object.id }), Duration::from_secs(20)).await?;
    let full = params["detail"].as_str() == Some("full");

    let mut headline = format!("{handle}");

    if let Some(label) = detail["label"].as_str() {
        headline.push_str(&format!(" «{}»", page_text(label, 80)));
    }

    headline.push_str(&format!(": {} ({}).", detail["what"].as_str().unwrap_or(""), if detail["api"] == "webgpu" { "WebGPU" } else { "WebGL" }));

    let mut lines = vec![headline];
    let mut life = format!("Created in frame {}", detail["created"]);

    if detail["alive"] == false {
        life.push_str(&format!(", DESTROYED in frame {}", detail["destroyedAt"]));
    }

    if detail["written"].as_i64().unwrap_or(-1) >= 0 {
        life.push_str(&format!(", contents last written in frame {}", detail["written"]));
    }

    if detail["used"].as_i64().unwrap_or(-1) >= 0 {
        if detail["api"] == "webgl" {
            life.push_str(&format!(", last used in frame {}", detail["used"]));
        } else {
            life.push_str(&format!(", last seen in use in frame {} (use is sampled, a frame in sixteen)", detail["used"]));
        }
    } else if detail["api"] == "webgpu" && matches!(object.kind, "texture" | "buffer" | "pipeline" | "bind_group" | "sampler" | "bundle") {
        life.push_str(", not seen in use (use is sampled, a frame in sixteen)");
    }

    life.push('.');

    if detail["bytes"].as_f64().unwrap_or(0.0) > 0.0 && object.kind != "shader" {
        life.push_str(&format!(" About {} (estimated).", size(detail["bytes"].as_f64().unwrap_or(0.0))));
    }

    lines.push(life);

    let at = detail["site"].as_str().unwrap_or("");

    if at != "(unknown)" && !at.is_empty() {
        lines.push(format!("Created at: {}", site(at, true)));
    }

    let mut data = json!({ "handle": handle, "detail": detail });
    let mut images = json!([]);

    match object.kind {
        "shader" => describe_shader(session, &object, &detail, &mut lines)?,
        "program" => describe_program(session, &object, &detail, &mut lines),
        "buffer" => {
            if detail["api"] == "webgpu" {
                lines.push(format!("Usage: {}.", detail["usage"].as_str().unwrap_or("")));
            }

            if detail["alive"] == true {
                describe_buffer(session, &object, params, &mut lines, &mut data).await;
            }
        }
        "texture" => {
            if detail["api"] == "webgpu" {
                lines.push(format!(
                    "Usage as the page asked for it: {}.{}",
                    detail["usage"].as_str().unwrap_or(""),
                    if detail["readable"] == true { "" } else { " Not readable back." }
                ));
            } else {
                let params_set: Vec<String> = detail["params"]
                    .as_object()
                    .into_iter()
                    .flatten()
                    .map(|(name, value)| format!("{} {}", gl_name(&json!(name.parse::<u64>().unwrap_or(0))), gl_name(value)))
                    .collect();

                lines.push(format!(
                    "Sampling parameters set: {}.",
                    if params_set.is_empty() {
                        "none (defaults: MIN_FILTER NEAREST_MIPMAP_LINEAR, MAG_FILTER LINEAR, REPEAT)".into()
                    } else {
                        params_set.join(", ")
                    }
                ));

                if detail["levels"].as_u64().unwrap_or(1) <= 1
                    && params_set.iter().all(|param| !param.starts_with("MIN_FILTER"))
                    && detail["width"].as_u64().unwrap_or(0) > 0
                {
                    lines.push("Note: the default MIN_FILTER uses mipmaps and this texture has one level, so it samples as black until mipmaps are generated or MIN_FILTER is set.".into());
                }
            }

            if !params["preview"].is_null() && params["preview"] != false {
                if detail["alive"] == true {
                    let mut options = if params["preview"].is_object() { params["preview"].clone() } else { json!({ "max_edge": 512 }) };

                    options["source"] = json!(handle);

                    match screenshot(session, &options).await {
                        Ok(shot) => {
                            lines.push(shot["summary"].as_str().unwrap_or("").to_string());
                            images = shot["images"].clone();
                        }
                        Err(error) => lines.push(format!("No preview: {error}")),
                    }
                }
            } else if detail["alive"] == true {
                lines.push(format!("Pass preview: true to see it, or use screenshot(source: \"{handle}\") and pixels(source: \"{handle}\", x, y)."));
            }
        }
        "framebuffer" => {
            for (point, attached) in detail["attachments"].as_object().into_iter().flatten() {
                let code = point.parse::<u64>().unwrap_or(0);
                let name = match code {
                    0x8D00 => "depth".to_string(),
                    0x8D20 => "stencil".to_string(),
                    0x821A => "depth and stencil".to_string(),
                    code if (0x8CE0..0x8CF0).contains(&code) => format!("colour {}", code - 0x8CE0),
                    code => format!("0x{code:04X}"),
                };

                let what = if attached["texture"].is_null() {
                    handle_of(session, &object.instance, "renderbuffer", &attached["renderbuffer"])
                } else {
                    format!("{} level {}", handle_of(session, &object.instance, "texture", &attached["texture"]), attached["level"])
                };

                lines.push(format!("  {name}: {what}"));
            }
        }
        _ => {
            // Descriptors and anything else, as compact JSON, with references to other
            // objects shown as their handles.
            let mut rest = detail.clone();

            name_references(session, &object.instance, &mut rest);

            if let Some(object) = rest.as_object_mut() {
                for key in ["id", "kind", "api", "context", "label", "what", "bytes", "created", "used", "written", "alive", "destroyedAt", "site", "device"] {
                    object.remove(key);
                }
            }

            let text = serde_json::to_string(&rest).unwrap_or_default();

            lines.push(page_text(&text, if full { 6000 } else { 1500 }));
        }
    }

    let mut value = result(lines.join("\n"), data);

    value["images"] = images;

    Ok(value)
}

// ---- Memory ----

async fn take_snapshot(session: &Arc<Session>) -> Result<Value> {
    let reports = session.probe_all("registry.snapshot", json!({}), SHORT).await;

    if reports.is_empty() {
        session.top()?;
    }

    let mut rows = serde_json::Map::new();

    for (instance, report) in &reports {
        for row in report["rows"].as_array().into_iter().flatten() {
            let kind = row[0].as_str().unwrap_or("");
            let handle = session.object_handle(instance, kind, row[1].as_i64().unwrap_or(0));

            rows.insert(handle, json!({ "kind": kind, "bytes": row[2], "site": row[3], "created": row[4], "what": row[5], "label": row[6] }));
        }
    }

    let frame = session.probe(&session.top()?, "status", json!({}), SHORT).await.map(|status| status["frame"].clone()).unwrap_or(Value::Null);

    Ok(json!({ "frame": frame, "objects": rows, "gpu_process_bytes": session.gpu_process_memory().await }))
}

fn snapshot_total(snapshot: &Value) -> (usize, f64) {
    let objects = snapshot["objects"].as_object();

    (objects.map_or(0, |objects| objects.len()), objects.into_iter().flatten().map(|(_, object)| object["bytes"].as_f64().unwrap_or(0.0)).sum())
}

async fn named_snapshot(session: &Arc<Session>, name: &str) -> Result<Value> {
    if name == "now" {
        return take_snapshot(session).await;
    }

    let state = session.state.lock().unwrap();

    state.snapshots.get(name).cloned().ok_or_else(|| {
        let known: Vec<&String> = state.snapshots.keys().collect();

        anyhow!(
            "No snapshot named \"{name}\". {} Take one with memory(snapshot: \"{name}\"); \"now\" always means the present.",
            if known.is_empty() {
                "None have been taken.".to_string()
            } else {
                format!("Snapshots: {}.", known.iter().map(|k| k.as_str()).collect::<Vec<_>>().join(", "))
            }
        )
    })
}

async fn memory_diff(session: &Arc<Session>, params: &Value) -> Result<Value> {
    let names: Vec<&str> = params["diff"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();

    if names.len() != 2 {
        bail!("diff needs two snapshot names, for example diff: [\"before\", \"now\"].");
    }

    let before = named_snapshot(session, names[0]).await?;
    let after = named_snapshot(session, names[1]).await?;
    let group_by = params["group_by"].as_str().unwrap_or("site");

    if !["site", "kind", "format"].contains(&group_by) {
        bail!("group_by must be site, kind or format, not \"{group_by}\".");
    }

    let empty = serde_json::Map::new();
    let old = before["objects"].as_object().unwrap_or(&empty);
    let new = after["objects"].as_object().unwrap_or(&empty);

    // Group what was created and is still alive.
    struct Group {
        count: u64,
        bytes: f64,
        kind: String,
        what: String,
        site: String,
        example: String,
        same_what: bool,
    }

    let mut groups: BTreeMap<String, Group> = BTreeMap::new();
    let (mut created, mut created_bytes, mut destroyed, mut destroyed_bytes) = (0u64, 0.0, 0u64, 0.0);

    for (handle, object) in new {
        if old.contains_key(handle) {
            continue;
        }

        let bytes = object["bytes"].as_f64().unwrap_or(0.0);
        let kind = object["kind"].as_str().unwrap_or("").to_string();
        let what = object["what"].as_str().unwrap_or("").to_string();
        let at = object["site"].as_str().unwrap_or("").to_string();

        created += 1;
        created_bytes += bytes;

        let key = match group_by {
            "kind" => kind.clone(),
            "format" => format!("{kind} {what}"),
            _ => format!("{kind} {at}"),
        };

        let group = groups.entry(key).or_insert_with(|| Group {
            count: 0,
            bytes: 0.0,
            kind: kind.clone(),
            what: what.clone(),
            site: at.clone(),
            example: handle.clone(),
            same_what: true,
        });

        group.count += 1;
        group.bytes += bytes;
        group.same_what &= group.what == what;
    }

    for (handle, object) in old {
        if !new.contains_key(handle) {
            destroyed += 1;
            destroyed_bytes += object["bytes"].as_f64().unwrap_or(0.0);
        }
    }

    let (_, before_bytes) = snapshot_total(&before);
    let (_, after_bytes) = snapshot_total(&after);
    let change = after_bytes - before_bytes;

    let mut lines = vec![format!(
        "From \"{}\" (frame {}) to \"{}\" (frame {}): estimated memory {} by {}, from {} to {}.",
        names[0],
        before["frame"],
        names[1],
        after["frame"],
        if change >= 0.0 { "grew" } else { "fell" },
        size(change.abs()),
        size(before_bytes),
        size(after_bytes)
    )];

    lines.push(format!("{created} created and still alive (+{}); {destroyed} destroyed (−{}).", size(created_bytes), size(destroyed_bytes)));

    let mut ordered: Vec<&Group> = groups.values().collect();

    ordered.sort_by(|a, b| b.bytes.total_cmp(&a.bytes).then(b.count.cmp(&a.count)));

    if !ordered.is_empty() {
        lines.push(format!("Created and not destroyed, by {group_by}, largest first:"));
    }

    for group in ordered.iter().take(15) {
        let mut text = format!("  +{}  {}", size(group.bytes), plural(&group.kind, group.count));

        if group.same_what && group_by != "kind" {
            text.push_str(&format!("  {}", group.what));
        }

        if group_by == "site" && !group.site.is_empty() && group.site != "(unknown)" {
            text.push_str(&format!("  at {}", frames_of(&group.site, 2)));
        }

        text.push_str(&format!("  (for example {})", group.example));
        lines.push(text);
    }

    if ordered.len() > 15 {
        lines.push(format!("  … and {} smaller groups.", ordered.len() - 15));
    }

    // One call site making many objects that are never destroyed is the usual shape of a leak.
    if let Some(suspect) = ordered.iter().find(|group| group_by == "site" && group.count >= 5 && group.same_what) {
        lines.push(format!(
            "Possible leak: one call site created {} identical {} between the snapshots and none were destroyed.",
            suspect.count,
            plural(&suspect.kind, 2).split_once(' ').unwrap().1
        ));
    }

    lines.push("Sizes are estimated from dimensions and formats.".into());

    // The process's own figure, to set beside the estimate: does the growth show there?
    let process = (before["gpu_process_bytes"].as_f64(), after["gpu_process_bytes"].as_f64());

    if let (Some(was), Some(is)) = process {
        let moved = is - was;
        let estimated = after_bytes - before_bytes;
        let megabyte = 1024.0 * 1024.0;

        lines.push(format!(
            "The browser's GPU process held {} at \"{}\" and holds {} at \"{}\": {}{} (os-measured: the whole process, which serves every page and the browser itself).",
            size(was),
            names[0],
            size(is),
            names[1],
            if moved >= 0.0 { "+" } else { "−" },
            size(moved.abs())
        ));

        if estimated > megabyte {
            lines.push(if moved > estimated * 0.5 {
                "That bears the estimate out: the growth is real memory, not an artefact of the sizes assumed.".to_string()
            } else if moved < estimated * 0.2 {
                "That is far less than the estimate. Either the objects have not been given storage yet (a texture never written to or drawn with costs little), or they are smaller on this GPU than their formats suggest.".to_string()
            } else {
                "That is some of the estimated growth, not all of it: part of what was created may not have storage yet.".to_string()
            });
        }
    }

    Ok(result(
        lines.join("\n"),
        json!({
            "from": names[0],
            "to": names[1],
            "gpu_process": { "before": process.0, "after": process.1, "provenance": "os-measured" },
            "bytes_before": before_bytes,
            "bytes_after": after_bytes,
            "created": created,
            "created_bytes": created_bytes,
            "destroyed": destroyed,
            "destroyed_bytes": destroyed_bytes,
            "groups": ordered.iter().take(50).map(|group| json!({ "count": group.count, "bytes": group.bytes, "kind": group.kind, "what": group.what, "site": group.site, "example": group.example })).collect::<Vec<_>>(),
            "provenance": "estimated",
        }),
    ))
}

/// Counts by kind (alive, bytes, created in all), the lines of code many live objects came
/// from, and the frame the page is on.
pub(crate) async fn overview(session: &Arc<Session>) -> Result<(BTreeMap<String, (u64, f64, u64)>, Vec<Value>, u64)> {
    let reports = session.probe_all("registry.summary", json!({}), SHORT).await;

    if reports.is_empty() {
        session.top()?;
    }

    let mut kinds: BTreeMap<String, (u64, f64, u64)> = BTreeMap::new();
    let mut sites = Vec::new();
    let mut frame = 0;

    for (_, report) in &reports {
        for (kind, entry) in report["byKind"].as_object().into_iter().flatten() {
            let total = kinds.entry(kind.clone()).or_default();

            total.0 += entry["alive"].as_u64().unwrap_or(0);
            total.1 += entry["bytes"].as_f64().unwrap_or(0.0);
            total.2 += entry["created"].as_u64().unwrap_or(0);
        }

        sites.extend(report["sites"].as_array().cloned().unwrap_or_default());
        frame = frame.max(report["frame"].as_u64().unwrap_or(0));
    }

    sites.sort_by_key(|site| std::cmp::Reverse(site["alive"].as_u64().unwrap_or(0)));

    Ok((kinds, sites, frame))
}

/// What the counts say about objects made again and again: kept (a leak) or thrown away (churn).
pub(crate) fn growth(kinds: &BTreeMap<String, (u64, f64, u64)>, sites: &[Value]) -> Vec<String> {
    let mut lines = Vec::new();

    for site in sites.iter().take(3) {
        let (alive, first, last) = (site["alive"].as_u64().unwrap_or(0), site["first"].as_u64().unwrap_or(0), site["last"].as_u64().unwrap_or(0));

        lines.push(format!(
            "LIKELY LEAK: {} still alive{} were all created by one line, over frames {first} to {last} (about {} a frame): {}. If that count keeps rising as the page runs, they are never destroyed.",
            plural(site["kind"].as_str().unwrap_or("object"), alive),
            if site["bytes"].as_f64().unwrap_or(0.0) > 0.0 { format!(" ({})", size(site["bytes"].as_f64().unwrap_or(0.0))) } else { String::new() },
            (alive as f64 / (last - first).max(1) as f64 * 10.0).round() / 10.0,
            frames_of(site["site"].as_str().unwrap_or(""), 3)
        ));
    }

    for (kind, (alive, _, created)) in kinds {
        if *created >= alive + 20 && *created >= alive * 3 {
            lines.push(format!(
                "CHURN: {created} {} have been created in all and {} destroyed: the page keeps making and discarding them{}. resources(kind: \"{kind}\", sort: \"created\", dead: true) shows the newest and the line that creates them.",
                plural(kind, *created).split_once(' ').map(|parts| parts.1).unwrap_or(kind),
                created - alive,
                if kind == "program" || kind == "shader" { ", and compiling and linking are slow" } else { "" }
            ));
        }
    }

    lines
}

pub async fn memory(session: &Arc<Session>, params: &Value) -> Result<Value> {
    if !params["diff"].is_null() {
        return memory_diff(session, params).await;
    }

    let reports = session.probe_all("registry.summary", json!({}), SHORT).await;

    if reports.is_empty() {
        session.top()?;
    }

    let mut categories: BTreeMap<String, f64> = BTreeMap::new();
    let mut kinds: BTreeMap<String, (u64, f64, u64)> = BTreeMap::new();

    for (_, report) in &reports {
        for (name, bytes) in report["categories"].as_object().into_iter().flatten() {
            *categories.entry(name.clone()).or_default() += bytes.as_f64().unwrap_or(0.0);
        }

        for (kind, entry) in report["byKind"].as_object().into_iter().flatten() {
            let total = kinds.entry(kind.clone()).or_default();

            total.0 += entry["alive"].as_u64().unwrap_or(0);
            total.1 += entry["bytes"].as_f64().unwrap_or(0.0);
            total.2 += entry["created"].as_u64().unwrap_or(0);
        }
    }

    let total: f64 = categories.values().sum();
    let mut lines = vec![format!("About {} of GPU memory, estimated from sizes and formats:", size(total))];

    for (key, label) in [
        ("textures", "textures"),
        ("renderTargets", "render targets"),
        ("buffers", "buffers"),
        ("renderbuffers", "renderbuffers"),
        ("canvases", "canvas drawing buffers"),
    ] {
        let bytes = categories.get(key).copied().unwrap_or(0.0);

        if bytes > 0.0 {
            lines.push(format!("  {:>10}  {label}", size(bytes)));
        }
    }

    let counts: Vec<String> = OBJECT_KINDS
        .iter()
        .filter_map(|(kind, _)| kinds.get(*kind).map(|entry| (kind, entry)))
        .filter(|(_, entry)| entry.2 > 0)
        .map(|(kind, entry)| if entry.2 > entry.0 { format!("{} ({} created in all)", plural(kind, entry.0), entry.2) } else { plural(kind, entry.0) })
        .collect();

    lines.push(format!("Alive now: {}.", if counts.is_empty() { "nothing".into() } else { counts.join(", ") }));

    let mut sites: Vec<Value> = reports.iter().flat_map(|(_, report)| report["sites"].as_array().cloned().unwrap_or_default()).collect();

    sites.sort_by_key(|site| std::cmp::Reverse(site["alive"].as_u64().unwrap_or(0)));
    lines.extend(growth(&kinds, &sites));

    let mut data = json!({
        "total_bytes": total,
        "categories": categories,
        "kinds": kinds.iter().map(|(kind, entry)| (kind.clone(), json!({ "alive": entry.0, "bytes": entry.1, "created": entry.2 }))).collect::<serde_json::Map<_, _>>(),
        "provenance": "estimated",
    });

    if let Some(name) = params["snapshot"].as_str() {
        if name == "now" {
            bail!("\"now\" always means the present and cannot be used as a snapshot name.");
        }

        let snapshot = take_snapshot(session).await?;
        let (count, bytes) = snapshot_total(&snapshot);

        lines.push(format!(
            "Snapshot \"{name}\" taken at frame {}: {count} objects holding memory, {}. Compare later with memory(diff: [\"{name}\", \"now\"]).",
            snapshot["frame"],
            size(bytes)
        ));

        data["snapshot"] = json!({ "name": name, "frame": snapshot["frame"], "objects": count, "bytes": bytes });
        session.state.lock().unwrap().snapshots.insert(name.to_string(), snapshot);
    } else {
        lines.push("To find growth: memory(snapshot: \"before\"), let the page run, then memory(diff: [\"before\", \"now\"]). resources(kind: \"texture\") lists the largest.".into());
    }

    lines.push("The canvas figure assumes front and back buffers, plus depth and 4× multisample storage where the context asked for them.".into());

    // What the operating system says the GPU process holds: real, but not this page's alone.
    if let Some(bytes) = session.gpu_process_memory().await {
        lines.push(format!(
            "The browser's GPU process holds {} in all (os-measured: {}). That covers every page, the compositor and the process itself, so it is more than this page's; a diff of two snapshots shows how much it moved.",
            size(bytes as f64),
            scanline_browser::process_memory_measure()
        ));

        data["gpu_process_bytes"] = json!(bytes);
    }

    Ok(result(lines.join("\n"), data))
}
