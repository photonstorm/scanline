//! Frame capture and what can be asked of one (04-AGENT-INTERFACE.md, section 3.5).
//!
//! A capture is one frame: every call, the state at each draw, and the contents of what the
//! frame used. It is written to disk, never changes, and outlives the page it came from.
//!
//! Questions about what the frame says (the draw list, a draw's state, SQL) are answered
//! from the capture's database. Questions about what the frame did (the picture after a
//! draw, which draws changed a pixel) are answered by running it again in a hidden page of
//! a live browser, on the same GPU: those answers are `gpu-measured`.

use std::io::Read;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use base64::Engine;
use scanline_image::Image;
use scanline_store::{Sql, Table};
use serde_json::{Value, json};

use crate::commands::{SHORT, choose_context, decode_grab, page_text, primary, save};
use crate::inventory::{factor, gl_name, list, size};
use crate::session::{OBJECT_KINDS, Session};
use crate::{Host, result};

const LONG: Duration = Duration::from_secs(60);

fn unpack(text: &str) -> Result<Vec<u8>> {
    let packed = base64::engine::general_purpose::STANDARD.decode(text).context("decoding data from the page")?;
    let mut bytes = Vec::new();

    flate2::read::GzDecoder::new(packed.as_slice()).read_to_end(&mut bytes).context("decompressing data from the page")?;

    Ok(bytes)
}

fn handle_for(kind: &str, id: &Value, tag: u64) -> Option<String> {
    let id = id.as_i64()?;

    if id == 0 {
        return Some("(untracked)".into());
    }

    let prefix = OBJECT_KINDS.iter().find(|entry| entry.0 == kind).map(|entry| entry.1).unwrap_or("obj");

    Some(if tag == 0 { format!("{prefix}_{id}") } else { format!("{prefix}_{id}_w{tag}") })
}

fn text(value: Option<String>) -> Sql {
    value.map(Sql::Text).unwrap_or(Sql::Null)
}

fn int(value: &Value) -> Sql {
    value.as_i64().map(Sql::Integer).unwrap_or(Sql::Null)
}

fn mode_name(mode: &Value) -> Option<String> {
    Some(
        match mode.as_u64()? {
            0 => "POINTS",
            1 => "LINES",
            2 => "LINE_LOOP",
            3 => "LINE_STRIP",
            4 => "TRIANGLES",
            5 => "TRIANGLE_STRIP",
            6 => "TRIANGLE_FAN",
            _ => return Some(format!("0x{:04X}", mode.as_u64()?)),
        }
        .to_string(),
    )
}

/// Where an event drew: the canvas, or the texture that is its framebuffer's first colour attachment.
fn target_name(row: &Value, tag: u64) -> String {
    match row["target"].as_i64() {
        Some(texture) if texture > 0 => {
            let handle = handle_for("texture", &json!(texture), tag).unwrap_or_default();
            let level = row["targetLevel"].as_i64().unwrap_or(0);

            if level > 0 { format!("{handle} level {level}") } else { handle }
        }
        _ if row["framebuffer"].as_i64().unwrap_or(0) > 0 => {
            // A framebuffer with no colour texture: depth only, or a renderbuffer.
            handle_for("framebuffer", &row["framebuffer"], tag).unwrap_or_default()
        }
        _ => "canvas".to_string(),
    }
}

fn describe_object(object: &Value) -> (String, i64) {
    let kind = object["kind"].as_str().unwrap_or("");

    match kind {
        "texture" => {
            let bytes = object["data"].as_array().map_or(0, |parts| parts.len() as i64)
                * object["width"].as_i64().unwrap_or(0)
                * object["height"].as_i64().unwrap_or(0)
                * 4;

            (
                if object["width"].as_i64().unwrap_or(0) > 0 {
                    format!(
                        "{}×{} {}{}{}",
                        object["width"],
                        object["height"],
                        object["format"].as_str().unwrap_or("?"),
                        if object["levels"].as_i64().unwrap_or(1) > 1 { format!(", {} levels", object["levels"]) } else { String::new() },
                        if object["renderTarget"] == true { ", render target" } else { "" }
                    )
                } else {
                    "no storage".to_string()
                },
                bytes,
            )
        }
        "buffer" => (format!("{} bytes{}", object["size"], if object["element"] == true { ", index" } else { "" }), object["size"].as_i64().unwrap_or(0)),
        "shader" => (
            format!("{} shader, {} characters", if object["type"] == 0x8B31 { "vertex" } else { "fragment" }, object["source"].as_str().map_or(0, str::len)),
            0,
        ),
        "program" => (format!("{} shaders", object["shaders"].as_array().map_or(0, Vec::len)), 0),
        "framebuffer" => (format!("{} attachments", object["attachments"].as_object().map_or(0, |map| map.len())), 0),
        "renderbuffer" => (format!("{}×{}", object["width"], object["height"]), 0),
        _ => (String::new(), 0),
    }
}

/// Builds the tables a capture's queries read, from the capture as the probe sent it.
fn tables(body: &Value, tag: u64) -> (Vec<Table>, Value) {
    let named = |kind: &str, id: &Value| text(handle_for(kind, id, tag));
    let draws = body["draws"].as_array().cloned().unwrap_or_default();

    let mut draw_rows = Vec::new();
    let mut uniform_rows = Vec::new();
    let mut binding_rows = Vec::new();
    let mut attribute_rows = Vec::new();
    let mut pass_rows: Vec<Vec<Sql>> = Vec::new();
    let mut event_of_command = std::collections::HashMap::new();

    // A pass is a run of events on one target.
    let mut pass: i64 = -1;
    let mut pass_target = String::new();
    let (mut first, mut count, mut clears) = (0i64, 0i64, 0i64);

    let close = |pass: i64, target: &str, first: i64, last: i64, count: i64, clears: i64, rows: &mut Vec<Vec<Sql>>| {
        if pass >= 0 {
            rows.push(vec![
                Sql::Integer(pass),
                Sql::Text(target.to_string()),
                Sql::Integer(first),
                Sql::Integer(last),
                Sql::Integer(count),
                Sql::Integer(clears),
            ]);
        }
    };

    for (index, row) in draws.iter().enumerate() {
        let index = index as i64;
        let target = target_name(row, tag);

        if pass < 0 || target != pass_target {
            close(pass, &pass_target, first, index - 1, count, clears, &mut pass_rows);
            pass += 1;
            pass_target = target.clone();
            first = index;
            count = 0;
            clears = 0;
        }

        let kind = row["kind"].as_str().unwrap_or("draw");

        if kind == "draw" {
            count += 1;
        } else if kind == "clear" {
            clears += 1;
        }

        event_of_command.insert(row["command"].as_i64().unwrap_or(-1), index);

        let textures: Vec<String> = row["textures"]
            .as_array()
            .into_iter()
            .flatten()
            .flat_map(|unit| ["t2d", "cube", "t3d", "array"].into_iter().filter_map(move |key| handle_for("texture", &unit[key], tag)))
            .collect();

        draw_rows.push(vec![
            Sql::Integer(index),
            int(&row["command"]),
            Sql::Text(kind.to_string()),
            Sql::Text(row["method"].as_str().unwrap_or("").to_string()),
            Sql::Integer(pass),
            Sql::Text(target),
            text(mode_name(&row["mode"])),
            int(&row["count"]),
            int(&row["instances"]),
            Sql::Integer(row["indexType"].is_number() as i64),
            named("program", &row["program"]),
            named("vertex_array", &row["vertexArray"]),
            named("framebuffer", &row["framebuffer"]),
            Sql::Integer(row["blend"].is_object() as i64),
            text(row["blend"]["srcRgb"].as_u64().map(|_| factor(&row["blend"]["srcRgb"]))),
            text(row["blend"]["dstRgb"].as_u64().map(|_| factor(&row["blend"]["dstRgb"]))),
            Sql::Integer(row["depth"].is_object() as i64),
            Sql::Integer((row["depth"]["write"] == true) as i64),
            text(row["depth"]["func"].as_u64().map(|_| gl_name(&row["depth"]["func"]))),
            Sql::Integer(row["stencil"].is_object() as i64),
            text(row["cull"].as_u64().map(|_| gl_name(&row["cull"]))),
            text(row["scissor"].as_array().map(|_| list(&row["scissor"]))),
            Sql::Text(list(&row["viewport"])),
            Sql::Text(list(&row["colorMask"])),
            Sql::Text(textures.join(" ")),
            Sql::Text(row.to_string()),
        ]);

        for (name, value) in row["uniforms"].as_object().into_iter().flatten() {
            uniform_rows.push(vec![Sql::Integer(index), Sql::Text(name.clone()), Sql::Text(list(value))]);
        }

        for unit in row["textures"].as_array().into_iter().flatten() {
            for (key, target) in [("t2d", "2D"), ("cube", "cube"), ("t3d", "3D"), ("array", "2D array")] {
                if let Some(handle) = handle_for("texture", &unit[key], tag) {
                    binding_rows.push(vec![
                        Sql::Integer(index),
                        int(&unit["unit"]),
                        Sql::Text(target.into()),
                        Sql::Text(handle),
                        named("sampler", &unit["sampler"]),
                    ]);
                }
            }
        }

        for attribute in row["attributes"].as_array().into_iter().flatten() {
            attribute_rows.push(vec![
                Sql::Integer(index),
                int(&attribute["index"]),
                named("buffer", &attribute["buffer"]),
                int(&attribute["size"]),
                Sql::Text(gl_name(&attribute["type"])),
                Sql::Integer((attribute["normalized"] == true) as i64),
                int(&attribute["stride"]),
                int(&attribute["offset"]),
                int(&attribute["divisor"]),
            ]);
        }
    }

    close(pass, &pass_target, first, draws.len() as i64 - 1, count, clears, &mut pass_rows);

    // The capture carries its own table of method names.
    let methods: Vec<String> = body["methods"].as_array().into_iter().flatten().map(|name| name.as_str().unwrap_or("").to_string()).collect();

    let command_rows: Vec<Vec<Sql>> = body["commands"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
        .map(|(index, command)| {
            let method = command[0].as_u64().and_then(|id| methods.get(id as usize)).cloned().unwrap_or_default();
            let mut args = command[1].to_string();

            if args.len() > 400 {
                args = format!("{}…", args.chars().take(400).collect::<String>());
            }

            vec![
                Sql::Integer(index as i64),
                Sql::Text(method),
                Sql::Text(args),
                event_of_command.get(&(index as i64)).map(|draw| Sql::Integer(*draw)).unwrap_or(Sql::Null),
            ]
        })
        .collect();

    let mut texture_bytes = 0i64;
    let mut buffer_bytes = 0i64;

    let object_rows: Vec<Vec<Sql>> = body["objects"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|object| {
            let kind = object["kind"].as_str().unwrap_or("");
            let (what, bytes) = describe_object(object);

            match kind {
                "texture" => texture_bytes += bytes,
                "buffer" => buffer_bytes += bytes,
                _ => {}
            }

            // The detail leaves out contents, which are blobs, and source, which has its own column.
            let mut detail = object.clone();

            if let Some(map) = detail.as_object_mut() {
                map.remove("data");
                map.remove("source");
            }

            vec![
                text(handle_for(kind, &object["id"], tag)),
                Sql::Text(kind.to_string()),
                int(&object["id"]),
                text(object["label"].as_str().map(str::to_string)),
                Sql::Text(what),
                Sql::Integer(bytes),
                int(&object["created"]),
                text(object["source"].as_str().map(str::to_string)),
                Sql::Text(detail.to_string()),
            ]
        })
        .collect();

    let event_count = |kind: &str| draws.iter().filter(|row| row["kind"] == kind).count();

    let counts = json!({
        "draws": event_count("draw"),
        "clears": event_count("clear"),
        "blits": event_count("blit"),
        "passes": pass_rows.len(),
        "commands": command_rows.len(),
        "objects": object_rows.len(),
        "textures": body["objects"].as_array().into_iter().flatten().filter(|object| object["kind"] == "texture").count(),
        "buffers": body["objects"].as_array().into_iter().flatten().filter(|object| object["kind"] == "buffer").count(),
        "texture_bytes": texture_bytes,
        "buffer_bytes": buffer_bytes,
    });

    let tables = vec![
        Table {
            name: "draws",
            columns: vec![
                "draw INTEGER PRIMARY KEY",
                "command INTEGER",
                "kind TEXT",
                "method TEXT",
                "pass INTEGER",
                "target TEXT",
                "mode TEXT",
                "count INTEGER",
                "instances INTEGER",
                "indexed INTEGER",
                "program TEXT",
                "vertex_array TEXT",
                "framebuffer TEXT",
                "blend INTEGER",
                "blend_src TEXT",
                "blend_dst TEXT",
                "depth_test INTEGER",
                "depth_write INTEGER",
                "depth_func TEXT",
                "stencil_test INTEGER",
                "cull TEXT",
                "scissor TEXT",
                "viewport TEXT",
                "color_mask TEXT",
                "textures TEXT",
                "state TEXT",
            ],
            rows: draw_rows,
        },
        Table {
            name: "passes",
            columns: vec!["pass INTEGER PRIMARY KEY", "target TEXT", "first_draw INTEGER", "last_draw INTEGER", "draws INTEGER", "clears INTEGER"],
            rows: pass_rows,
        },
        Table {
            name: "objects",
            columns: vec![
                "handle TEXT",
                "kind TEXT",
                "id INTEGER",
                "label TEXT",
                "what TEXT",
                "bytes INTEGER",
                "created INTEGER",
                "source TEXT",
                "detail TEXT",
            ],
            rows: object_rows,
        },
        Table { name: "commands", columns: vec!["command INTEGER PRIMARY KEY", "method TEXT", "args TEXT", "draw INTEGER"], rows: command_rows },
        Table { name: "uniforms", columns: vec!["draw INTEGER", "name TEXT", "value TEXT"], rows: uniform_rows },
        Table { name: "bindings", columns: vec!["draw INTEGER", "unit INTEGER", "target TEXT", "texture TEXT", "sampler TEXT"], rows: binding_rows },
        Table {
            name: "attributes",
            columns: vec![
                "draw INTEGER",
                "location INTEGER",
                "buffer TEXT",
                "size INTEGER",
                "type TEXT",
                "normalized INTEGER",
                "stride INTEGER",
                "offset INTEGER",
                "divisor INTEGER",
            ],
            rows: attribute_rows,
        },
    ];

    (tables, counts)
}

/// Gives a session's replay page a capture from the store.
async fn load_into(host: &Arc<Host>, session: &Arc<Session>, handle: &str) -> Result<Value> {
    let stream = host.store.stream(handle)?;
    let hashes: Vec<String> = stream["blob_hashes"].as_array().into_iter().flatten().filter_map(|hash| hash.as_str().map(str::to_string)).collect();
    let store = &host.store;

    session.replay_load(handle, &stream, &|index| store.get_blob(hashes.get(index).ok_or_else(|| anyhow!("The capture names no blob {index}."))?)).await?;

    Ok(stream)
}

fn replay_image(reply: &Value) -> Result<Image> {
    Image::new(reply["width"].as_u64().unwrap_or(0) as u32, reply["height"].as_u64().unwrap_or(0) as u32, unpack(reply["data"].as_str().unwrap_or(""))?)
}

fn the_capture(host: &Host, params: &Value) -> Result<(String, Value)> {
    let Some(handle) = params["capture"].as_str() else {
        let known = host.store.handles();

        bail!(
            "No capture named. {}",
            match known.last() {
                Some(latest) => format!("Pass capture: \"{latest}\" (the most recent of {}).", known.len()),
                None => "Call capture with a session to take one.".to_string(),
            }
        );
    };

    Ok((handle.to_string(), host.store.meta(handle)?))
}

// ---- Taking a capture ----

pub async fn capture(host: &Arc<Host>, session: &Arc<Session>, params: &Value) -> Result<Value> {
    let context = choose_context(session, params).await?;

    if context.api == "webgpu" {
        bail!("{} is a WebGPU context, and capturing WebGPU frames is not built yet. WebGL 1 and WebGL 2 frames can be captured.", context.handle);
    }

    let top = session.top()?;
    let was_running = session.probe(&top, "status", json!({}), SHORT).await?["paused"] == false;

    // The state read when the capture is armed must be the state the frame begins with.
    session.probe_all("pause", json!({}), SHORT).await;

    let armed = session.probe(&context.instance, "capture.arm", json!({ "context": context.local }), SHORT).await?;
    let id = armed["capture"].clone();
    let stepped = session.probe_all("step", json!({ "frames": 1 }), Duration::from_secs(20)).await;
    let taken = session.probe(&context.instance, "capture.take", json!({ "capture": id }), LONG).await;

    let taken = match taken {
        Ok(taken) => taken,
        Err(error) => {
            if was_running {
                session.probe_all("resume", json!({}), SHORT).await;
            }

            let idle = primary(&stepped).ok().is_some_and(|stop| stop["reason"] == "idle");

            return Err(if idle { anyhow!("Nothing to capture: the page issued no frame. {error}") } else { error });
        }
    };

    let mut body: Value = serde_json::from_slice(&unpack(taken["body"].as_str().unwrap_or(""))?).context("reading the capture the page sent")?;

    // Blobs: stored by content, so a texture this capture shares with an earlier one costs nothing.
    let count = taken["blobs"].as_u64().unwrap_or(0);
    let mut hashes = Vec::with_capacity(count as usize);
    let mut from = 0u64;

    while from < count {
        let part = session.probe(&context.instance, "capture.blobs", json!({ "capture": id, "from": from }), LONG).await?;

        for blob in part["blobs"].as_array().into_iter().flatten() {
            hashes.push(host.store.put_blob(&unpack(blob.as_str().unwrap_or(""))?)?);
        }

        from = part["next"].as_u64().unwrap_or(count);
    }

    let _ = session.probe(&context.instance, "capture.release", json!({ "capture": id }), SHORT).await;

    // The frame's own final image, as the page drew it.
    let original = decode_grab(&session.probe(&context.instance, "image.grab", json!({ "context": context.local }), Duration::from_secs(20)).await?)?;

    if was_running {
        session.probe_all("resume", json!({}), SHORT).await;
    }

    let handle = host.store.next_handle();
    let tag = context.instance.tag as u64;
    let (capture_tables, counts) = tables(&body, tag);

    body["blob_hashes"] = json!(hashes);

    // Run it again and compare. If the replay does not match the frame, every answer that
    // comes from replay is suspect, and says so.
    let store = &host.store;

    session.replay_load(&handle, &body, &|index| store.get_blob(&hashes[index])).await?;

    let replayed = session.replay("image", &json!({ "key": handle }), LONG).await?;
    let difference = original.difference(&replay_image(&replayed)?, 0);

    let mut notes: Vec<String> = replayed["notes"].as_array().into_iter().flatten().filter_map(|note| note.as_str().map(str::to_string)).collect();

    for note in body["header"]["notes"].as_array().into_iter().flatten() {
        match note.as_str() {
            Some("image-source") => {
                notes.push("An image or video the frame uploaded was copied through a 2D canvas, which can change translucent pixels by one step.".into())
            }
            Some("unreadable-texture") => {}
            Some(other) => notes.push(other.to_string()),
            None => {}
        }
    }

    let fidelity = match &difference {
        Ok(difference) if difference.changed == 0 => "identical".to_string(),
        Ok(difference) => format!("{} of {} pixels differ, by up to {}", difference.changed, difference.pixels, difference.max),
        Err(error) => format!("could not be compared: {error}"),
    };

    let header = &body["header"];

    let meta = json!({
        "capture": handle,
        "session": session.id,
        "url": session.url(),
        "context": context.handle,
        "instance_tag": tag,
        "api": header["api"],
        "width": header["width"],
        "height": header["height"],
        "frame": header["frame"],
        "profile": session.profile.name(),
        "browser": session.browser_version,
        "replay": fidelity,
        "replay_matches": fidelity == "identical",
        "notes": notes,
        "counts": counts,
        "blob_bytes": taken["blobBytes"],
    });

    host.store.write_capture(&handle, &body, &meta, capture_tables)?;

    let final_path = host.store.capture_dir(&handle).join("final.png");

    std::fs::write(&final_path, original.to_png()?).with_context(|| format!("writing {}", final_path.display()))?;

    let mut value = describe_capture(host, &handle, &meta)?;
    let (view, factor) = original.opaque().fit(params["max_edge"].as_u64().unwrap_or(512).clamp(16, 4096) as u32);
    let view_path = if factor == 1 { final_path.clone() } else { save(session, &format!("{handle}-final-view"), &view)? };

    value["images"] =
        json!([{ "view": view_path, "original": final_path, "width": view.width, "height": view.height, "scale": 1.0 / factor as f64, "space": "canvas_px" }]);
    value["summary"] = json!(format!(
        "{}\nNext: draw_list(capture: \"{handle}\"), pixel_source(capture: \"{handle}\", x, y), draw(capture: \"{handle}\", draw: n).",
        value["summary"].as_str().unwrap_or("")
    ));

    Ok(value)
}

fn describe_capture(host: &Host, handle: &str, meta: &Value) -> Result<Value> {
    let counts = &meta["counts"];
    let passes = host.store.query(handle, "SELECT pass, target, draws, clears FROM passes ORDER BY pass", &[], 12)?;

    let mut lines = vec![format!(
        "{handle}: frame {} of {} ({} {}×{}), {} profile.",
        meta["frame"],
        meta["context"].as_str().unwrap_or("?"),
        meta["api"].as_str().unwrap_or("?"),
        meta["width"],
        meta["height"],
        meta["profile"].as_str().unwrap_or("?")
    )];

    let some = |count: &Value, noun: &str| format!("{count} {noun}{}", if count == 1 { "" } else { "s" });

    lines.push(format!(
        "{}, {}{} in {} pass{}; {} calls.",
        some(&counts["draws"], "draw"),
        some(&counts["clears"], "clear"),
        if counts["blits"].as_u64().unwrap_or(0) > 0 { format!(", {} blits", counts["blits"]) } else { String::new() },
        counts["passes"],
        if counts["passes"] == 1 { "" } else { "es" },
        counts["commands"]
    ));

    for row in &passes.rows {
        lines.push(format!("  pass {}: {}, {} to {}", row[0], some(&row[2], "draw"), some(&row[3], "clear"), row[1].as_str().unwrap_or("?")));
    }

    if passes.truncated {
        lines.push("  … more passes; call pass_tree.".into());
    }

    lines.push(format!(
        "Uses {} textures ({}) and {} buffers ({}).",
        counts["textures"],
        size(counts["texture_bytes"].as_f64().unwrap_or(0.0)),
        counts["buffers"],
        size(counts["buffer_bytes"].as_f64().unwrap_or(0.0))
    ));

    lines.push(if meta["replay_matches"] == true {
        "Replay check: replaying the capture gives an image identical to the frame's own, so answers from replay can be trusted.".to_string()
    } else {
        format!(
            "Replay check FAILED: {}. Answers that come from replay (pixel_source, screenshots at a draw) may be wrong for this capture.",
            meta["replay"].as_str().unwrap_or("?")
        )
    });

    for note in meta["notes"].as_array().into_iter().flatten() {
        lines.push(format!("Note: {}", page_text(note.as_str().unwrap_or(""), 300)));
    }

    Ok(result(lines.join("\n"), meta.clone()))
}

pub fn captures(host: &Arc<Host>, params: &Value) -> Result<Value> {
    let handles = host.store.handles();
    let limit = params["limit"].as_u64().unwrap_or(25).clamp(1, 200) as usize;
    let shown: Vec<&String> = handles.iter().rev().take(limit).collect();

    if handles.is_empty() {
        return Ok(result("No captures on disk. Call capture with a session to take one.", json!({ "captures": [] })));
    }

    let mut lines = vec![format!(
        "{} capture{} on disk, newest first{}:",
        handles.len(),
        if handles.len() == 1 { "" } else { "s" },
        if shown.len() < handles.len() { format!(" (showing {})", shown.len()) } else { String::new() }
    )];
    let mut rows = Vec::new();

    for handle in shown {
        let meta = host.store.meta(handle)?;

        lines.push(format!(
            "  {handle}  frame {} of {} {}×{}, {} draws, replay {}  «{}»",
            meta["frame"],
            meta["api"].as_str().unwrap_or("?"),
            meta["width"],
            meta["height"],
            meta["counts"]["draws"],
            meta["replay"].as_str().unwrap_or("?"),
            page_text(meta["url"].as_str().unwrap_or(""), 80)
        ));

        rows.push(meta);
    }

    Ok(result(lines.join("\n"), json!({ "captures": rows, "total": handles.len() })))
}

// ---- What the frame says: answered from the capture's tables ----

pub fn pass_tree(host: &Arc<Host>, params: &Value) -> Result<Value> {
    let (handle, _) = the_capture(host, params)?;
    let passes = host.store.query(&handle, "SELECT pass, target, first_draw, last_draw, draws, clears FROM passes ORDER BY pass", &[], 500)?;
    let mut lines =
        vec![format!("{handle}: {} pass{}. A pass is a run of events on one target.", passes.rows.len(), if passes.rows.len() == 1 { "" } else { "es" })];

    for row in &passes.rows {
        let some = |count: &Value, noun: &str| format!("{count} {noun}{}", if count == 1 { "" } else { "s" });

        lines.push(format!(
            "  pass {}  → {}  events {}–{} ({}, {})",
            row[0],
            row[1].as_str().unwrap_or("?"),
            row[2],
            row[3],
            some(&row[4], "draw"),
            some(&row[5], "clear")
        ));
    }

    lines.push(format!("draw_list(capture: \"{handle}\", filter: \"pass = n\") lists a pass's events."));

    Ok(result(lines.join("\n"), json!({ "capture": handle, "passes": rows_as_objects(&passes) })))
}

fn rows_as_objects(rows: &scanline_store::Rows) -> Vec<Value> {
    rows.rows.iter().map(|row| Value::Object(rows.columns.iter().cloned().zip(row.iter().cloned()).collect())).collect()
}

fn describe_event(row: &serde_json::Map<String, Value>) -> String {
    let get = |key: &str| row.get(key).cloned().unwrap_or(Value::Null);
    let word = |key: &str| get(key).as_str().unwrap_or("").to_string();
    let mut text = format!("{:>4}  ", get("draw").as_i64().unwrap_or(0));

    match word("kind").as_str() {
        "clear" => text.push_str(&format!("clear          → {}", word("target"))),
        "blit" => text.push_str(&format!("blit           → {}", word("target"))),
        _ => {
            let instances = get("instances").as_i64().unwrap_or(1);

            text.push_str(&format!(
                "{} ×{}{}{}  {} → {}",
                word("mode"),
                get("count"),
                if get("indexed") == 1 { " indexed" } else { "" },
                if instances != 1 { format!(", {instances} instances") } else { String::new() },
                word("program"),
                word("target")
            ));

            if get("blend") == 1 {
                text.push_str(&format!("  blend {}/{}", word("blend_src"), word("blend_dst")));
            }

            if get("depth_test") == 1 {
                text.push_str(&format!("  depth {}{}", word("depth_func"), if get("depth_write") == 1 { "" } else { " (no write)" }));
            }

            if !word("cull").is_empty() {
                text.push_str(&format!("  cull {}", word("cull")));
            }

            if !word("scissor").is_empty() {
                text.push_str(&format!("  scissor {}", word("scissor")));
            }

            if !word("textures").is_empty() {
                text.push_str(&format!("  textures {}", word("textures")));
            }
        }
    }

    text
}

pub fn draw_list(host: &Arc<Host>, params: &Value) -> Result<Value> {
    let (handle, _) = the_capture(host, params)?;
    let limit = params["limit"].as_u64().unwrap_or(25).clamp(1, 200);
    let cursor = params["cursor"].as_u64().unwrap_or(0);
    let filter = params["filter"].as_str().map(str::trim).filter(|filter| !filter.is_empty());

    // The filter is a SQL condition on the draws table. The database is read-only.
    let condition = filter.map(|filter| format!(" WHERE ({filter})")).unwrap_or_default();
    let columns = "draw, kind, method, pass, target, mode, count, instances, indexed, program, blend, blend_src, blend_dst, depth_test, depth_write, depth_func, cull, scissor, textures";

    let explain = |error: anyhow::Error| {
        anyhow!(
            "{error}. filter is a SQL condition on the draws table, for example \"blend = 1 and depth_test = 0\" or \"program = 'prg_2'\". help(topic: \"sql\") lists the columns."
        )
    };

    let total = host.store.query(&handle, &format!("SELECT count(*) FROM draws{condition}"), &[], 1).map_err(explain)?.rows[0][0].as_u64().unwrap_or(0);
    let rows = host
        .store
        .query(&handle, &format!("SELECT {columns} FROM draws{condition} ORDER BY draw LIMIT {limit} OFFSET {cursor}"), &[], limit as usize)
        .map_err(explain)?;

    let objects = rows_as_objects(&rows);
    let matching = filter.map(|filter| format!(" matching \"{filter}\"")).unwrap_or_default();
    let mut lines = vec![format!("{handle}: {total} event{}{matching} (draws, clears and blits, in order).", if total == 1 { "" } else { "s" })];

    lines.extend(objects.iter().filter_map(Value::as_object).map(describe_event));

    let next = cursor + objects.len() as u64;

    if next < total {
        lines.push(format!("total {total}, returned {}, next_cursor {next}. Narrow with filter (a SQL condition on draws: pass, target, program, blend, depth_test, textures …).", objects.len()));
    }

    if total > 0 {
        lines.push(format!("draw(capture: \"{handle}\", draw: n) gives one in full."));
    }

    Ok(result(
        lines.join("\n"),
        json!({ "capture": handle, "events": objects, "total": total, "returned": objects.len(), "next_cursor": if next < total { json!(next) } else { Value::Null } }),
    ))
}

fn draw_state(host: &Host, handle: &str, draw: &Value) -> Result<Value> {
    let Some(index) = draw.as_i64() else { bail!("A draw is named by its number in the capture, from 0. Call draw_list to see them.") };
    let rows = host.store.query(handle, "SELECT state, pass, target, program FROM draws WHERE draw = ?1", &[Sql::Integer(index)], 1)?;

    let Some(row) = rows.rows.first() else {
        let total = host.store.query(handle, "SELECT count(*) FROM draws", &[], 1)?.rows[0][0].clone();

        bail!("{handle} has {total} events, numbered from 0; there is no draw {index}.");
    };

    let mut state: Value = serde_json::from_str(row[0].as_str().unwrap_or("{}")).context("reading the draw's state")?;

    state["pass"] = row[1].clone();
    state["targetName"] = row[2].clone();
    state["programName"] = row[3].clone();

    Ok(state)
}

pub async fn draw(host: &Arc<Host>, params: &Value) -> Result<Value> {
    let (handle, meta) = the_capture(host, params)?;
    let index = params["draw"].as_i64().ok_or_else(|| anyhow!("draw needs draw: the event's number in the capture, from 0. Call draw_list to see them."))?;
    let state = draw_state(host, &handle, &params["draw"])?;
    let tag = meta["instance_tag"].as_u64().unwrap_or(0);
    let named = |kind: &str, id: &Value| handle_for(kind, id, tag).unwrap_or_else(|| "none".into());
    let kind = state["kind"].as_str().unwrap_or("draw");

    let mut lines = vec![format!(
        "{handle} event {index}: {} to {} (pass {}, call {}).",
        state["method"].as_str().unwrap_or(""),
        state["targetName"].as_str().unwrap_or("?"),
        state["pass"],
        state["command"]
    )];

    if kind == "clear" {
        lines.push(format!(
            "  clears to colour {}, depth {}, stencil {}; mask 0x{:X}",
            list(&state["clearColor"]),
            state["clearDepth"],
            state["clearStencil"],
            state["mask"].as_u64().unwrap_or(0)
        ));
    } else if kind == "draw" {
        lines.push(format!(
            "  {} × {}{}{}",
            mode_name(&state["mode"]).unwrap_or_default(),
            state["count"],
            if state["indexType"].is_number() {
                format!(", indexed ({} from {} at byte {})", gl_name(&state["indexType"]), named("buffer", &state["elementBuffer"]), state["indexOffset"])
            } else {
                format!(", from vertex {}", state["first"])
            },
            if state["instances"].as_i64().unwrap_or(1) != 1 { format!(", {} instances", state["instances"]) } else { String::new() }
        ));

        lines.push(format!("  program {}, vertex array {}", named("program", &state["program"]), named("vertex_array", &state["vertexArray"])));
    }

    lines.push(format!(
        "  viewport {}; scissor {}; colour mask {}",
        list(&state["viewport"]),
        if state["scissor"].is_array() { list(&state["scissor"]) } else { "off".into() },
        list(&state["colorMask"])
    ));

    if kind == "draw" {
        lines.push(match state["blend"].as_object() {
            Some(_) => format!(
                "  blend: rgb {} × {} + dst × {}, alpha {} × {} + dst × {}",
                gl_name(&state["blend"]["equationRgb"]),
                factor(&state["blend"]["srcRgb"]),
                factor(&state["blend"]["dstRgb"]),
                gl_name(&state["blend"]["equationAlpha"]),
                factor(&state["blend"]["srcAlpha"]),
                factor(&state["blend"]["dstAlpha"])
            ),
            None => "  blend: off (the draw replaces what is there)".to_string(),
        });

        lines.push(match state["depth"].as_object() {
            Some(_) => format!("  depth: test {}, write {}", gl_name(&state["depth"]["func"]), state["depth"]["write"]),
            None => "  depth: test off".to_string(),
        });

        if state["stencil"].is_object() {
            let front = &state["stencil"]["front"];

            lines.push(format!(
                "  stencil: {} ref {} mask 0x{:X}; fail {}, depth fail {}, pass {}",
                gl_name(&front["func"]),
                front["ref"],
                front["mask"].as_u64().unwrap_or(0),
                gl_name(&front["fail"]),
                gl_name(&front["zfail"]),
                gl_name(&front["zpass"])
            ));
        }

        lines.push(match state["cull"].as_u64() {
            Some(_) => format!("  cull {}, front face {}", gl_name(&state["cull"]), gl_name(&state["frontFace"])),
            None => "  cull: off".to_string(),
        });

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

        let uniforms = state["uniforms"].as_object().cloned().unwrap_or_default();

        if !uniforms.is_empty() {
            lines.push(format!("  {} uniform{} set (those never set hold their default):", uniforms.len(), if uniforms.len() == 1 { "" } else { "s" }));

            for (name, value) in uniforms.iter().take(40) {
                let values: Vec<String> = value
                    .as_array()
                    .into_iter()
                    .flatten()
                    .take(16)
                    .map(|number| number.as_f64().map(|n| format!("{}", (n * 1e6).round() / 1e6)).unwrap_or_default())
                    .collect();

                lines.push(format!("    {name} = {}{}", values.join(", "), if value.as_array().map_or(0, Vec::len) > 16 { ", …" } else { "" }));
            }
        }
    }

    let mut value = result("", json!({ "capture": handle, "draw": index, "state": state }));

    // What the event did to its target, measured by running the frame to just before and just after it.
    if let Ok(session) = host.replayer(params) {
        match effect(host, &session, &handle, index, params).await {
            Ok((line, data, images)) => {
                lines.push(line);
                value["data"]["effect"] = data;
                value["images"] = images;
            }
            Err(error) => lines.push(format!("  Its effect could not be measured: {error}")),
        }
    } else {
        lines.push("  Its effect on the target is measured by replay, which needs an open session.".into());
    }

    if meta["replay_matches"] != true {
        lines.push("  Warning: this capture's replay did not match the original frame, so the measured effect may be wrong.".into());
    }

    value["summary"] = json!(lines.join("\n"));

    Ok(value)
}

/// The difference an event made to its target: the target before it against the target after it.
async fn effect(host: &Arc<Host>, session: &Arc<Session>, handle: &str, index: i64, params: &Value) -> Result<(String, Value, Value)> {
    load_into(host, session, handle).await?;

    let after = replay_image(&session.replay("image", &json!({ "key": handle, "draw": index }), LONG).await?)?;

    // Before: the same target after the previous event. For the first event, the target as the frame found it.
    let before = if index > 0 {
        let state = draw_state(host, handle, &json!(index))?;
        let target = if state["target"].as_i64().unwrap_or(0) > 0 { json!({ "texture": state["target"], "level": state["targetLevel"] }) } else { Value::Null };

        replay_image(&session.replay("image", &json!({ "key": handle, "draw": index - 1, "target": target }), LONG).await?).ok()
    } else {
        None
    };

    let Some(before) = before.filter(|before| before.width == after.width && before.height == after.height) else {
        return Ok(("  It is the first event on its target, so there is nothing before it to compare with.".into(), json!({}), json!([])));
    };

    let difference = before.difference(&after, 0)?;

    if difference.changed == 0 {
        return Ok((
            "  Effect: it changed no pixels of its target (gpu-measured). Every fragment was rejected, clipped or wrote what was already there.".into(),
            json!({ "changed": 0 }),
            json!([]),
        ));
    }

    let (x, y, w, h) = difference.bounds.unwrap();
    let mut images = json!([]);
    let mut line = format!("  Effect: it changed {} pixels of its target, within x {x} y {y} {w}×{h} (gpu-measured).", difference.changed);

    if params["output"] == true {
        let (view, factor) = after.opaque().fit(params["max_edge"].as_u64().unwrap_or(512).clamp(16, 4096) as u32);
        let original = save(session, &format!("{handle}-draw{index}"), &after)?;
        let view_path = if factor == 1 { original.clone() } else { save(session, &format!("{handle}-draw{index}-view"), &view)? };

        line.push_str(&format!(" The target after it: {}", original.display()));
        images = json!([{ "view": view_path, "original": original, "width": view.width, "height": view.height, "scale": 1.0 / factor as f64, "space": "canvas_px" }]);
    } else {
        line.push_str(" Pass output: true to see the target after it.");
    }

    Ok((line, json!({ "changed": difference.changed, "bounds": { "x": x, "y": y, "w": w, "h": h } }), images))
}

fn flatten(prefix: &str, value: &Value, out: &mut std::collections::BTreeMap<String, String>) {
    match value {
        Value::Object(map) => {
            for (key, child) in map {
                flatten(&if prefix.is_empty() { key.clone() } else { format!("{prefix}.{key}") }, child, out);
            }
        }
        // Lists of numbers are one value; lists of objects (textures, attributes) are walked.
        Value::Array(items) if items.iter().any(Value::is_object) => {
            for (index, child) in items.iter().enumerate() {
                flatten(&format!("{prefix}[{index}]"), child, out);
            }
        }
        other => {
            out.insert(prefix.to_string(), named_value(prefix, other));
        }
    }
}

/// A state value for reading: WebGL's numbers for enumerated settings become their names.
fn named_value(key: &str, value: &Value) -> String {
    let leaf = key.rsplit(['.', ']']).next().unwrap_or(key);

    match leaf {
        "enabled" => value.as_array().map(|caps| format!("[{}]", caps.iter().map(gl_name).collect::<Vec<_>>().join(", "))).unwrap_or_else(|| value.to_string()),
        "srcRgb" | "dstRgb" | "srcAlpha" | "dstAlpha" if value.is_number() => factor(value),
        "equationRgb" | "equationAlpha" | "func" | "fail" | "zfail" | "zpass" | "cull" | "frontFace" | "indexType" | "type" if value.is_number() => {
            gl_name(value)
        }
        "mode" if value.is_number() => mode_name(value).unwrap_or_default(),
        _ => value.to_string(),
    }
}

pub fn draw_diff(host: &Arc<Host>, params: &Value) -> Result<Value> {
    let (handle, _) = the_capture(host, params)?;

    if !params["a"].is_i64() || !params["b"].is_i64() {
        bail!("draw_diff needs a and b: the numbers of two events in the capture.");
    }

    let (mut a, mut b) = (std::collections::BTreeMap::new(), std::collections::BTreeMap::new());

    flatten("", &draw_state(host, &handle, &params["a"])?, &mut a);
    flatten("", &draw_state(host, &handle, &params["b"])?, &mut b);

    let ignored = ["command", "pass"];
    let keys: std::collections::BTreeSet<&String> = a.keys().chain(b.keys()).filter(|key| !ignored.contains(&key.as_str())).collect();
    let missing = "(absent)".to_string();
    let mut rows = Vec::new();

    for key in keys {
        let (left, right) = (a.get(key).unwrap_or(&missing), b.get(key).unwrap_or(&missing));

        if left != right {
            rows.push(json!({ "what": key, "a": left, "b": right }));
        }
    }

    let mut lines = vec![if rows.is_empty() {
        format!("{handle}: events {} and {} have the same state, bindings and uniforms.", params["a"], params["b"])
    } else {
        format!("{handle}: events {} and {} differ in {} value{}.", params["a"], params["b"], rows.len(), if rows.len() == 1 { "" } else { "s" })
    }];

    for row in rows.iter().take(60) {
        lines.push(format!(
            "  {}: {} → {}",
            row["what"].as_str().unwrap_or(""),
            page_text(row["a"].as_str().unwrap_or(""), 120),
            page_text(row["b"].as_str().unwrap_or(""), 120)
        ));
    }

    if rows.len() > 60 {
        lines.push(format!("  … and {} more.", rows.len() - 60));
    }

    Ok(result(lines.join("\n"), json!({ "capture": handle, "a": params["a"], "b": params["b"], "differences": rows })))
}

pub fn query(host: &Arc<Host>, params: &Value) -> Result<Value> {
    let (handle, _) = the_capture(host, params)?;
    let sql = params["sql"].as_str().ok_or_else(|| anyhow!("query needs sql: one SELECT statement. help(topic: \"sql\") lists the tables."))?;
    let limit = params["limit"].as_u64().unwrap_or(50).clamp(1, 500) as usize;
    let rows = host.store.query(&handle, sql, &[], limit).map_err(|error| {
        anyhow!("{error}. Tables: draws, passes, objects, commands, uniforms, bindings, attributes, capture. help(topic: \"sql\") lists their columns.")
    })?;

    let mut lines = vec![format!(
        "{} row{}{}. Columns: {}",
        rows.rows.len(),
        if rows.rows.len() == 1 { "" } else { "s" },
        if rows.truncated { format!(" (the first {limit}; add LIMIT and OFFSET, or pass limit up to 500)") } else { String::new() },
        rows.columns.join(" | ")
    )];
    let mut used = 0;

    for row in &rows.rows {
        let line = row
            .iter()
            .map(|value| match value {
                Value::String(text) => page_text(text, 160),
                Value::Null => "∅".to_string(),
                other => other.to_string(),
            })
            .collect::<Vec<_>>()
            .join(" | ");

        used += line.len();

        // A result an agent can afford to read. The rest is in `data`, and on disk.
        if used > 6000 {
            lines.push("  … more rows than fit here. Select fewer columns, or add a WHERE.".into());
            break;
        }

        lines.push(format!("  {line}"));
    }

    Ok(result(lines.join("\n"), json!({ "capture": handle, "columns": rows.columns, "rows": rows.rows, "truncated": rows.truncated })))
}

// ---- What the frame did: answered by replay ----

/// The target a looking command means: the canvas, or a texture the frame drew to.
fn target_of(host: &Host, handle: &str, params: &Value) -> Result<(Value, String)> {
    match params["target"].as_str() {
        None | Some("canvas") => Ok((Value::Null, "the canvas".into())),
        Some(name) => {
            let rows = host.store.query(handle, "SELECT id FROM objects WHERE handle = ?1 AND kind = 'texture'", &[Sql::Text(name.to_string())], 1)?;

            match rows.rows.first() {
                Some(row) => Ok((json!({ "texture": row[0], "level": params["level"].as_u64().unwrap_or(0) }), name.to_string())),
                None => {
                    let targets = host.store.query(handle, "SELECT DISTINCT target FROM draws", &[], 20)?;
                    let known: Vec<&str> = targets.rows.iter().filter_map(|row| row[0].as_str()).collect();

                    bail!("\"{name}\" is not a texture in {handle}. Targets the frame drew to: {}.", known.join(", "))
                }
            }
        }
    }
}

pub async fn pixel_source(host: &Arc<Host>, params: &Value) -> Result<Value> {
    let (handle, meta) = the_capture(host, params)?;
    let (Some(x), Some(y)) = (params["x"].as_i64(), params["y"].as_i64()) else {
        bail!("pixel_source needs x and y, in pixels from the top-left of the target.")
    };
    let (target, target_name) = target_of(host, &handle, params)?;
    let session = host.replayer(params)?;

    load_into(host, &session, &handle).await?;

    let trace = session.replay("trace", &json!({ "key": handle, "x": x, "y": y, "target": target }), LONG).await?;
    let changes = trace["changes"].as_array().cloned().unwrap_or_default();
    let float = trace["float"] == true;

    let show = |value: &Value| match value.as_array() {
        Some(channels) => format!(
            "({})",
            channels
                .iter()
                .map(|channel| if float { format!("{}", (channel.as_f64().unwrap_or(0.0) * 1e4).round() / 1e4) } else { channel.to_string() })
                .collect::<Vec<_>>()
                .join(", ")
        ),
        None => "(nothing yet)".to_string(),
    };

    let mut lines = Vec::new();
    let mut rows = Vec::new();

    if changes.is_empty() {
        lines.push(format!("{handle}: nothing drew to {target_name} in this frame, so pixel ({x}, {y}) was never written."));
    } else {
        let last = changes.last().unwrap();

        lines.push(format!(
            "{handle} pixel ({x}, {y}) of {target_name}: its final value {} was produced by event {}. gpu-measured.",
            show(&last["after"]),
            last["draw"]
        ));

        lines.push(format!("{} of the {} events on that target changed it, in order:", changes.len(), trace["events"]));

        for change in &changes {
            let index = change["draw"].as_i64().unwrap_or(0);
            let row = host.store.query(&handle, "SELECT kind, mode, count, program, blend, textures FROM draws WHERE draw = ?1", &[Sql::Integer(index)], 1)?;
            let what = row.rows.first().map(|row| {
                if row[0] == "draw" {
                    format!(
                        "{} ×{} with {}{}{}",
                        row[1].as_str().unwrap_or(""),
                        row[2],
                        row[3].as_str().unwrap_or("?"),
                        if row[4] == 1 { ", blended" } else { "" },
                        if row[5].as_str().is_some_and(|t| !t.is_empty()) { format!(", textures {}", row[5].as_str().unwrap_or("")) } else { String::new() }
                    )
                } else {
                    row[0].as_str().unwrap_or("").to_string()
                }
            });

            lines.push(format!("  event {index:>4}  {} → {}   {}", show(&change["before"]), show(&change["after"]), what.unwrap_or_default()));
            rows.push(json!({ "draw": index, "before": change["before"], "after": change["after"] }));
        }

        lines.push("Events that drew there without changing the value (rejected by a test, or writing the same colour) are not listed; full pixel history is not built yet.".into());
        lines.push(format!("draw(capture: \"{handle}\", draw: {}) gives the state of the one that produced it.", last["draw"]));
    }

    if meta["replay_matches"] != true {
        lines.push("Warning: this capture's replay did not match the original frame, so this may be wrong.".into());
    }

    Ok(result(
        lines.join("\n"),
        json!({ "capture": handle, "x": x, "y": y, "target": target_name, "changes": rows, "events_on_target": trace["events"], "final": trace["final"], "provenance": "gpu-measured", "ms": trace["ms"] }),
    ))
}

/// A target of a capture after an event, read back from the replay.
async fn replayed(host: &Arc<Host>, params: &Value) -> Result<(Arc<Session>, String, Image, String, Value)> {
    let (handle, meta) = the_capture(host, params)?;
    let session = host.replayer(params)?;

    load_into(host, &session, &handle).await?;

    let mut args = json!({ "key": handle, "draw": params["at_draw"] });
    let mut what = handle.clone();

    if !params["target"].is_null() {
        let (target, name) = target_of(host, &handle, params)?;

        args["target"] = target;
        what.push_str(&format!(" {name}"));
    }

    match params["at_draw"].as_i64() {
        Some(draw) => what.push_str(&format!(" after event {draw}")),
        None => what.push_str(" at the end of the frame"),
    }

    let reply = session.replay("image", &args, LONG).await?;
    let image = replay_image(&reply)?;

    Ok((session, handle, image, what, meta))
}

pub async fn screenshot(host: &Arc<Host>, params: &Value) -> Result<Value> {
    let (session, handle, full, what, meta) = replayed(host, params).await?;
    let region = &params["region"];
    let (x, y) = (region["x"].as_u64().unwrap_or(0) as u32, region["y"].as_u64().unwrap_or(0) as u32);
    let original = full.crop(x, y, region["w"].as_u64().map(|w| w as u32).unwrap_or(full.width), region["h"].as_u64().map(|h| h as u32).unwrap_or(full.height));

    if original.width == 0 || original.height == 0 {
        bail!("The region is empty. The target is {}×{} pixels.", full.width, full.height);
    }

    let zoom = params["zoom"].as_u64().unwrap_or(1).clamp(1, 64) as u32;

    let (view, scale, how) = if zoom > 1 {
        if original.width * zoom > 2048 || original.height * zoom > 2048 {
            bail!(
                "A {}×{} region at {zoom}× is too large to be useful. Ask for a smaller region (up to {}×{} at this zoom).",
                original.width,
                original.height,
                2048 / zoom,
                2048 / zoom
            );
        }

        let grid = params["grid"].as_bool().unwrap_or(zoom >= 8);

        (original.opaque().zoom(zoom, grid), zoom as f64, format!("magnified {zoom}× with no smoothing{}", if grid { ", one grid cell per pixel" } else { "" }))
    } else {
        let (view, factor) = original.opaque().fit(params["max_edge"].as_u64().unwrap_or(1024).clamp(16, 4096) as u32);

        (view, 1.0 / factor as f64, if factor > 1 { format!("shown at 1/{factor} scale") } else { "at full size".to_string() })
    };

    let label = format!("{handle}-{}", params["at_draw"].as_i64().map(|draw| format!("draw{draw}")).unwrap_or_else(|| "end".into()));
    let original_path = save(&session, &label, &original)?;
    let view_path = if view == original { original_path.clone() } else { save(&session, &format!("{label}-view"), &view)? };

    let mut summary = format!(
        "{what}: region x {x} y {y} {}×{} pixels (origin top-left), {how}. Image is {}×{}. Replayed on the GPU: gpu-measured.",
        original.width, original.height, view.width, view.height
    );

    if meta["replay_matches"] != true {
        summary.push_str(" Warning: this capture's replay did not match the original frame.");
    }

    summary.push_str(&format!(" Lossless original: {}", original_path.display()));

    let mut value = result(
        summary,
        json!({ "capture": handle, "at_draw": params["at_draw"], "region": { "x": x, "y": y, "w": original.width, "h": original.height }, "scale": scale, "provenance": "gpu-measured" }),
    );

    value["images"] =
        json!([{ "view": view_path, "original": original_path, "width": view.width, "height": view.height, "scale": scale, "space": "canvas_px" }]);

    Ok(value)
}

pub async fn pixels(host: &Arc<Host>, params: &Value) -> Result<Value> {
    let (Some(x), Some(y)) = (params["x"].as_u64(), params["y"].as_u64()) else { bail!("pixels needs x and y, in pixels from the top-left of the target.") };
    let (_, handle, image, what, _) = replayed(host, params).await?;
    let (w, h) = (params["w"].as_u64().unwrap_or(1).max(1), params["h"].as_u64().unwrap_or(1).max(1));

    if w * h > 256 {
        bail!("{w}×{h} is too many pixels to list (the limit is 256). Use screenshot with a region and zoom to look at an area.");
    }

    let part = image.crop(x as u32, y as u32, w as u32, h as u32);

    if part.width == 0 || part.height == 0 {
        bail!("That point is outside the target, which is {}×{} pixels.", image.width, image.height);
    }

    let at = |column: u32, row: u32| {
        let p = part.pixel(column, row);

        format!("({}, {}, {}, {})", p[0], p[1], p[2], p[3])
    };

    let mut lines = Vec::new();

    if part.width * part.height == 1 {
        lines.push(format!("{what}, pixel ({x}, {y}): rgba8 {}. gpu-measured by replay.", at(0, 0)));
    } else {
        lines.push(format!("{what}, x {x}–{} y {y}–{}, rgba8, gpu-measured by replay:", x + part.width as u64 - 1, y + part.height as u64 - 1));

        for row in 0..part.height {
            let mut cells: Vec<(String, u32)> = Vec::new();

            for column in 0..part.width {
                let text = at(column, row);

                match cells.last_mut() {
                    Some((last, count)) if *last == text => *count += 1,
                    _ => cells.push((text, 1)),
                }
            }

            lines.push(format!(
                "  y {}: {}",
                y + row as u64,
                cells.iter().map(|(text, count)| if *count > 1 { format!("{text}×{count}") } else { text.clone() }).collect::<Vec<_>>().join(" ")
            ));
        }
    }

    Ok(result(
        lines.join("\n"),
        json!({ "capture": handle, "at_draw": params["at_draw"], "region": { "x": x, "y": y, "w": part.width, "h": part.height }, "rgba8": part.data, "provenance": "gpu-measured" }),
    ))
}
