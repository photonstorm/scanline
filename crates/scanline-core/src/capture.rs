//! Frame capture and what can be asked of one (04-AGENT-INTERFACE.md, section 3.5).
//!
//! A capture is one frame: every call, the state at each draw, and the contents of what the
//! frame used. It is written to disk, never changes, and outlives the page it came from.
//!
//! Questions about what the frame says (the draw list, a draw's state, SQL) are answered
//! from the capture's database. Questions about what the frame did (the picture after a
//! draw, which draws changed a pixel) are answered by running it again in a hidden page of
//! a live browser, on the same GPU: those answers are `gpu-measured`.

use std::collections::HashMap;
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

pub(crate) const LONG: Duration = Duration::from_secs(60);

pub(crate) fn unpack(text: &str) -> Result<Vec<u8>> {
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

/// An object's handle, or what to say when there is none.
pub(crate) fn handle_text(kind: &str, id: &Value, tag: u64) -> String {
    handle_for(kind, id, tag).unwrap_or_else(|| "no buffer".to_string())
}

fn text(value: Option<String>) -> Sql {
    value.map(Sql::Text).unwrap_or(Sql::Null)
}

fn int(value: &Value) -> Sql {
    value.as_i64().map(Sql::Integer).unwrap_or(Sql::Null)
}

pub(crate) fn mode_name(mode: &Value) -> Option<String> {
    // A WebGPU topology is already a word.
    if let Some(topology) = mode.as_str() {
        return Some(topology.to_string());
    }

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
    if row["noTarget"] == true {
        return if row["kind"] == "dispatch" { "compute".to_string() } else { "(no colour target)".to_string() };
    }

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

/// What is said of an event that was encoded in a command buffer the browser dropped.
const DROPPED: &str = "dropped with its command buffer";

/// The events of a WebGPU frame that were encoded by an encoder whose command buffer was
/// rejected, each with the call that raised the error.
fn dropped_events(body: &Value, errors: &HashMap<i64, String>) -> Vec<(i64, i64)> {
    let methods: Vec<&str> = body["methods"].as_array().into_iter().flatten().map(|name| name.as_str().unwrap_or("")).collect();
    let commands = body["commands"].as_array().cloned().unwrap_or_default();
    let method_of = |command: &Value| command[0].as_u64().and_then(|id| methods.get(id as usize)).copied().unwrap_or("");
    let local = |reference: &Value| reference["l"].as_i64();

    // The encoder each pass belongs to, and the encoders whose finish raised an error.
    let mut encoder_of_pass = HashMap::new();
    let mut failed = HashMap::new();

    for (index, command) in commands.iter().enumerate() {
        match method_of(command) {
            "GPUCommandEncoder.beginRenderPass" | "GPUCommandEncoder.beginComputePass" => {
                if let (Some(pass), Some(encoder)) = (local(&command[2]), local(&command[3])) {
                    encoder_of_pass.insert(pass, encoder);
                }
            }
            "GPUCommandEncoder.finish" if errors.contains_key(&(index as i64)) => {
                if let Some(encoder) = local(&command[3]) {
                    failed.insert(encoder, index as i64);
                }
            }
            _ => {}
        }
    }

    body["draws"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
        .filter_map(|(event, row)| {
            let command = &commands[row["command"].as_u64()? as usize];
            let receiver = local(&command[3])?;

            // A pass's own calls are made on the pass; beginning one, and copies, on the encoder.
            let encoder = encoder_of_pass.get(&receiver).copied().unwrap_or(receiver);

            failed.get(&encoder).map(|cause| (event as i64, *cause))
        })
        .collect()
}

/// A setting that is on: WebGL's are numbers, WebGPU's are words.
fn set(value: &Value) -> bool {
    value.is_u64() || value.is_string()
}

fn is_webgpu(body: &Value) -> bool {
    body["header"]["api"] == "webgpu"
}

/// One object of a WebGPU capture in a few words, and the bytes of its contents the capture holds.
fn describe_gpu_object(object: &Value, body: &Value) -> (String, i64) {
    let base = body["header"]["blobBase"].as_u64().unwrap_or(0);
    let held = |index: &Value| index.as_u64().and_then(|index| body["blobs"][index.saturating_sub(base) as usize].as_i64()).unwrap_or(0);
    let made = if object["createdInFrame"] == true { ", made during the frame" } else { "" };

    match object["kind"].as_str().unwrap_or("") {
        "texture" => {
            let bytes: i64 = object["data"].as_array().into_iter().flatten().map(|part| held(&part["blob"])).sum();
            let layers = object["depthOrArrayLayers"].as_i64().unwrap_or(1);

            (
                format!(
                    "{}×{}{} {}{}{}{}{made}",
                    object["width"],
                    object["height"],
                    if layers > 1 { format!("×{layers}") } else { String::new() },
                    object["format"].as_str().unwrap_or("?"),
                    if object["levels"].as_i64().unwrap_or(1) > 1 { format!(", {} levels", object["levels"]) } else { String::new() },
                    if object["sampleCount"].as_i64().unwrap_or(1) > 1 { format!(", {}× multisampled", object["sampleCount"]) } else { String::new() },
                    if object["renderTarget"] == true { ", render target" } else { "" }
                ),
                bytes,
            )
        }
        "buffer" => (format!("{} bytes{made}", object["size"]), held(&object["data"])),
        "shader" => (format!("WGSL module, {} characters{made}", object["source"].as_str().map_or(0, str::len)), 0),
        "pipeline" => (format!("{} pipeline{made}", object["type"].as_str().unwrap_or("render")), 0),
        "bind_group" => (format!("{}{made}", plural(object["descriptor"]["entries"].as_array().map_or(0, Vec::len) as i64, "binding")), 0),
        "layout" => (
            match object["pipeline"].as_i64() {
                Some(pipeline) => format!("bind group layout {} of pip_{pipeline}", object["index"]),
                None => format!("{} layout{made}", object["type"].as_str().unwrap_or("")),
            },
            0,
        ),
        "sampler" => (format!("sampler{made}"), 0),
        "query" => (format!("{} {} queries", object["count"], object["type"].as_str().unwrap_or("")), 0),
        _ => (String::new(), 0),
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
fn gl_error_name(code: u64) -> String {
    match code {
        0x0500 => "INVALID_ENUM".into(),
        0x0501 => "INVALID_VALUE".into(),
        0x0502 => "INVALID_OPERATION".into(),
        0x0505 => "OUT_OF_MEMORY".into(),
        0x0506 => "INVALID_FRAMEBUFFER_OPERATION".into(),
        0x9242 => "CONTEXT_LOST".into(),
        other => format!("0x{other:04X}"),
    }
}

/// A call's arguments for reading: object references become handles, uniform locations
/// become `prg_1.name`, and where an argument is one of WebGL's named numbers, its name.
fn readable(method: &str, args: &Value, tag: u64) -> Value {
    fn objects(value: &Value, tag: u64) -> Value {
        match value {
            Value::Object(map) if map.contains_key("o") && map.contains_key("i") => {
                json!(handle_for(map["o"].as_str().unwrap_or(""), &map["i"], tag).unwrap_or_default())
            }
            Value::Object(map) if map.contains_key("u") && map.contains_key("n") => {
                json!(format!("{}.{}", handle_for("program", &map["u"], tag).unwrap_or_default(), map["n"].as_str().unwrap_or("")))
            }
            // WebGPU: objects made during the frame that have no handle, views, the device and its queue, data.
            Value::Object(map) if map.len() == 1 && map.contains_key("l") => json!(format!("#{}", map["l"])),
            Value::Object(map) if map.len() == 1 && map.contains_key("v") => match map["v"]["t"].as_i64() {
                Some(texture) if texture > 0 => json!(format!("view of {}", handle_for("texture", &json!(texture), tag).unwrap_or_default())),
                _ => json!("view of the canvas"),
            },
            Value::Object(map) if map.len() == 1 && map.contains_key("dev") => json!("device"),
            Value::Object(map) if map.len() == 1 && map.contains_key("q") => json!("queue"),
            Value::Object(map) if map.len() == 1 && map.contains_key("ctx") => json!("canvas context"),
            Value::Object(map) if map.len() == 1 && map.contains_key("$u") => Value::Null,
            Value::Object(map) if map.len() == 2 && map.contains_key("b") && map.contains_key("a") => {
                json!(format!("<{} data>", map["a"].as_str().unwrap_or("")))
            }
            Value::Object(map) => Value::Object(map.iter().map(|(key, value)| (key.clone(), objects(value, tag))).collect()),
            Value::Array(items) => Value::Array(items.iter().map(|item| objects(item, tag)).collect()),
            other => other.clone(),
        }
    }

    let mut out = objects(args, tag);

    // Which arguments of which methods are named numbers.
    let named: &[usize] = match method.strip_prefix("gl.").unwrap_or("") {
        "enable" | "disable" | "depthFunc" | "cullFace" | "frontFace" | "activeTexture" | "bindTexture" | "bindBuffer" | "bindFramebuffer"
        | "bindRenderbuffer" | "generateMipmap" | "stencilFunc" | "pixelStorei" | "drawArrays" | "blendEquation" | "bufferData" | "bufferSubData" => &[0],
        "blendFunc" | "blendEquationSeparate" => &[0, 1],
        "blendFuncSeparate" => &[0, 1, 2, 3],
        "stencilOp" | "texParameteri" | "texParameterf" | "framebufferTexture2D" => &[0, 1, 2],
        "drawElements" => &[0, 2],
        _ => &[],
    };

    let blend = method.starts_with("gl.blendFunc");
    let draw = method.starts_with("gl.draw");

    for index in named {
        let Some(code) = out[*index].as_u64() else { continue };
        let value = json!(code);

        let name = match code {
            _ if blend => factor(&value),
            _ if draw && *index == 0 => mode_name(&value).unwrap_or_default(),
            0x84C0..=0x84FF => format!("TEXTURE{}", code - 0x84C0),
            0x0DE1 => "TEXTURE_2D".into(),
            0x8513 => "TEXTURE_CUBE_MAP".into(),
            0x806F => "TEXTURE_3D".into(),
            0x8C1A => "TEXTURE_2D_ARRAY".into(),
            0x8892 => "ARRAY_BUFFER".into(),
            0x8893 => "ELEMENT_ARRAY_BUFFER".into(),
            0x8A11 => "UNIFORM_BUFFER".into(),
            0x8D40 => "FRAMEBUFFER".into(),
            0x8CA8 => "READ_FRAMEBUFFER".into(),
            0x8CA9 => "DRAW_FRAMEBUFFER".into(),
            0x8D41 => "RENDERBUFFER".into(),
            0x8CE0 => "COLOR_ATTACHMENT0".into(),
            0x8D00 => "DEPTH_ATTACHMENT".into(),
            0x821A => "DEPTH_STENCIL_ATTACHMENT".into(),
            _ => gl_name(&value),
        };

        // A number with no name here stays a number.
        if !name.is_empty() && !name.starts_with("0x") {
            out[*index] = json!(name);
        }
    }

    out
}

/// The sizes of the capture's textures, by ID, and of its canvas.
struct Sizes {
    canvas: (i64, i64),
    textures: HashMap<i64, (i64, i64)>,
    /// Framebuffers whose colour is a renderbuffer, and that renderbuffer's size.
    framebuffers: HashMap<i64, (i64, i64)>,
}

impl Sizes {
    fn of(body: &Value) -> Sizes {
        Sizes {
            canvas: (body["header"]["width"].as_i64().unwrap_or(0), body["header"]["height"].as_i64().unwrap_or(0)),
            textures: body["objects"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|object| object["kind"] == "texture")
                .map(|object| (object["id"].as_i64().unwrap_or(0), (object["width"].as_i64().unwrap_or(0), object["height"].as_i64().unwrap_or(0))))
                .collect(),
            framebuffers: body["objects"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|object| object["kind"] == "framebuffer")
                .filter_map(|object| {
                    let renderbuffer = object["attachments"]["36064"]["renderbuffer"].as_i64()?;
                    let found = body["objects"].as_array()?.iter().find(|other| other["kind"] == "renderbuffer" && other["id"] == renderbuffer)?;

                    Some((object["id"].as_i64()?, (found["width"].as_i64()?, found["height"].as_i64()?)))
                })
                .collect(),
        }
    }

    /// The size of the target an event drew to.
    fn target(&self, row: &Value) -> (i64, i64) {
        match row["target"].as_i64().filter(|texture| *texture > 0).and_then(|texture| self.textures.get(&texture)) {
            Some((width, height)) => {
                let level = row["targetLevel"].as_i64().unwrap_or(0);

                ((width >> level).max(1), (height >> level).max(1))
            }
            None => row["framebuffer"].as_i64().and_then(|framebuffer| self.framebuffers.get(&framebuffer)).copied().unwrap_or(self.canvas),
        }
    }
}

/// Whether a box (x, y, width, height) leaves part of a target uncovered.
fn partial(area: &Value, (width, height): (i64, i64)) -> bool {
    let at = |index: usize| area[index].as_i64().unwrap_or(0);

    area.is_array() && width > 0 && (at(0) > 0 || at(1) > 0 || at(0) + at(2) < width || at(1) + at(3) < height)
}

/// Numbers as a short list of runs: 5–8, 12.
pub(crate) fn runs(numbers: &[i64]) -> String {
    let mut parts: Vec<String> = Vec::new();
    let mut index = 0;

    while index < numbers.len() {
        let mut end = index;

        while end + 1 < numbers.len() && numbers[end + 1] == numbers[end] + 1 {
            end += 1;
        }

        parts.push(if end > index { format!("{}–{}", numbers[index], numbers[end]) } else { numbers[index].to_string() });
        index = end + 1;
    }

    if parts.len() > 6 {
        let more = parts.len() - 6;

        parts.truncate(6);
        parts.push(format!("and {more} more runs"));
    }

    parts.join(", ")
}

/// A draw rejected for drawing to a texture it also has bound: the unit and the texture.
fn feedback(row: &Value, tag: u64) -> Option<(i64, String)> {
    let target = row["target"].as_i64().filter(|texture| *texture > 0)?;

    row["textures"].as_array()?.iter().find_map(|unit| {
        ["t2d", "cube", "t3d", "array"]
            .iter()
            .any(|key| unit[*key].as_i64() == Some(target))
            .then(|| (unit["unit"].as_i64().unwrap_or(0), handle_for("texture", &json!(target), tag).unwrap_or_default()))
    })
}

pub(crate) fn plural(count: i64, noun: &str) -> String {
    format!("{count} {noun}{}", if count == 1 { "" } else { "s" })
}

/// Things about the frame that are often the bug, found without being asked. Each is a
/// plain fact about the capture; whether it is a mistake is for the reader to judge.
fn findings(body: &Value, tag: u64, errors: &HashMap<i64, String>, effects: &HashMap<i64, Value>) -> Vec<String> {
    let draws = body["draws"].as_array().cloned().unwrap_or_default();
    let sizes = Sizes::of(body);
    let methods: Vec<&str> = body["methods"].as_array().into_iter().flatten().map(|name| name.as_str().unwrap_or("")).collect();

    // The calls of earlier frames of a recording are blanked: they keep their places, so
    // call numbers still line up, but they are not this frame's doing.
    let first_command = body["header"]["firstCommand"].as_u64().unwrap_or(0) as usize;
    let commands: Vec<Value> = body["commands"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
        .map(|(index, command)| if index < first_command { Value::Null } else { command.clone() })
        .collect();
    let method_of = |command: &Value| command[0].as_u64().and_then(|id| methods.get(id as usize)).copied().unwrap_or("");
    let rejected = |row: &Value| errors.contains_key(&row["command"].as_i64().unwrap_or(-1));
    let mut found = Vec::new();

    // Draws that did nothing.
    let idle: Vec<i64> = draws
        .iter()
        .enumerate()
        .filter(|(index, row)| row["kind"] == "draw" && !rejected(row) && effects.get(&(*index as i64)).is_some_and(|effect| effect["changed"] == 0))
        .map(|(index, _)| index as i64)
        .collect();

    if !idle.is_empty() {
        found.push(format!(
            "{} changed no pixels: event{} {}. draw(draw: {}) says which test rejected it.",
            plural(idle.len() as i64, "draw"),
            if idle.len() == 1 { "" } else { "s" },
            runs(&idle),
            idle[0]
        ));
    }

    // Runs of events on one target that all use one viewport that is not the target's size.
    let mut start = 0;

    while start < draws.len() {
        let name = target_name(&draws[start], tag);
        let mut end = start;

        while end + 1 < draws.len() && target_name(&draws[end + 1], tag) == name {
            end += 1;
        }

        let size = sizes.target(&draws[start]);
        let viewport = &draws[start]["viewport"];
        let drawn = draws[start..=end].iter().filter(|row| row["kind"] == "draw").count();

        if drawn > 0 && partial(viewport, size) && draws[start..=end].iter().all(|row| row["viewport"] == *viewport) {
            let set_in_frame =
                commands[..draws[start]["command"].as_u64().unwrap_or(0) as usize].iter().rposition(|command| method_of(command) == "gl.viewport");

            found.push(format!(
                "Every event on {name} (events {start}–{end}) uses viewport {}, but {name} is {}×{}. {}",
                list(viewport),
                size.0,
                size.1,
                match set_in_frame {
                    Some(call) => format!("The viewport was last set at call {call}."),
                    None => "Nothing in the frame sets the viewport before them: it was left like that by an earlier frame.".to_string(),
                }
            ));
        }

        start = end + 1;
    }

    // Clears clipped by the scissor test.
    let clipped: Vec<i64> = draws
        .iter()
        .enumerate()
        .filter(|(_, row)| row["kind"] == "clear" && partial(&row["scissor"], sizes.target(row)))
        .map(|(index, _)| index as i64)
        .collect();

    if let Some(first) = clipped.first() {
        let row = &draws[*first as usize];
        let switched_on = commands[..row["command"].as_u64().unwrap_or(0) as usize]
            .iter()
            .any(|command| method_of(command) == "gl.enable" && command[1][0].as_u64() == Some(0x0C11));

        found.push(format!(
            "Event{} {} clear{} with the scissor test on (box {}), so only that box is cleared.{}",
            if clipped.len() == 1 { "" } else { "s" },
            runs(&clipped),
            if clipped.len() == 1 { "s" } else { "" },
            list(&row["scissor"]),
            if switched_on {
                String::new()
            } else {
                let is = |command: &Value, method: &str| method_of(command) == method && command[1][0].as_u64() == Some(0x0C11);

                // Where this frame does the same, which is very likely where the last one did.
                let left_on = match commands.iter().rposition(|command| is(command, "gl.enable")) {
                    Some(on) if !commands[on..].iter().any(|command| is(command, "gl.disable")) => {
                        format!(" This frame does the same: call {on} switches it on and nothing after it switches it off.")
                    }
                    _ => String::new(),
                };

                format!(" The frame began with the scissor test already on: an earlier frame left it on.{left_on}")
            }
        ));
    }

    // Translucent draws followed by opaque ones that land on top of them.
    let overlap = |a: &Value, b: &Value| {
        let at = |effect: &Value, key: &str| effect[key].as_i64().unwrap_or(0);

        a["changed"].as_i64().unwrap_or(0) > 0
            && b["changed"].as_i64().unwrap_or(0) > 0
            && at(a, "x") < at(b, "x") + at(b, "w")
            && at(b, "x") < at(a, "x") + at(a, "w")
            && at(a, "y") < at(b, "y") + at(b, "h")
            && at(b, "y") < at(a, "y") + at(a, "h")
    };

    let mut out_of_order = 0;

    for (index, row) in draws.iter().enumerate() {
        if row["kind"] != "draw" || !row["blend"].is_object() || !row["depth"].is_object() || out_of_order == 2 {
            continue;
        }

        let Some(mine) = effects.get(&(index as i64)) else { continue };
        let target = target_name(row, tag);

        let later: Vec<i64> = draws
            .iter()
            .enumerate()
            .skip(index + 1)
            .filter(|(_, other)| other["kind"] == "draw" && !other["blend"].is_object() && other["depth"]["write"] == true && target_name(other, tag) == target)
            .filter(|(other, _)| effects.get(&(*other as i64)).is_some_and(|theirs| overlap(mine, theirs)))
            .map(|(other, _)| other as i64)
            .collect();

        if !later.is_empty() {
            out_of_order += 1;

            found.push(format!(
                "Event {index} blends, but opaque depth-written event{} {} drawn after it on the same pixels. A blended draw only tints what is already there, so what is drawn after it is not seen through it.",
                if later.len() == 1 { "" } else { "s" },
                if later.len() == 1 { format!("{} is", later[0]) } else { format!("{} are", runs(&later)) }
            ));
        }
    }

    // Blending off on a draw given a translucent colour.
    let mut solid: Vec<(i64, String, f64)> = Vec::new();

    for (index, row) in draws.iter().enumerate() {
        if row["kind"] != "draw" || row["blend"].is_object() || effects.get(&(index as i64)).is_some_and(|effect| effect["changed"] == 0) {
            continue;
        }

        for (name, value) in row["uniforms"].as_object().into_iter().flatten() {
            let lower = name.to_lowercase();
            let alpha = match value.as_array().map(Vec::as_slice) {
                Some([_, _, _, alpha]) if ["color", "colour", "tint"].iter().any(|word| lower.contains(word)) => alpha.as_f64(),
                Some([alpha]) if ["alpha", "opacity"].iter().any(|word| lower.contains(word)) => alpha.as_f64(),
                _ => None,
            };

            if let Some(alpha) = alpha.filter(|alpha| *alpha > 0.0 && *alpha < 1.0) {
                solid.push((index as i64, name.clone(), alpha));
                break;
            }
        }
    }

    if let Some((first, name, alpha)) = solid.first() {
        let events: Vec<i64> = solid.iter().map(|entry| entry.0).collect();

        found.push(format!(
            "Event{} {} drawn with blending off, but {} uniform {name} has an alpha of {alpha}. With blending off alpha does nothing: the draw replaces what is behind it.",
            if events.len() == 1 { "" } else { "s" },
            if events.len() == 1 { format!("{first} is") } else { format!("{} are", runs(&events)) },
            if events.len() == 1 { "its" } else { "their" }
        ));
    }

    // Textures a draw has bound that cannot be sampled.
    // WebGL only: a WebGPU texture has no sampling state of its own.
    for object in body["objects"].as_array().into_iter().flatten().filter(|object| object["kind"] == "texture" && !is_webgpu(body)) {
        let filter = object["params"]["10241"].as_u64();
        let needs_mips = filter.is_none_or(|filter| (0x2700..=0x2703).contains(&filter));

        if !needs_mips || object["levels"].as_u64().unwrap_or(1) > 1 || object["width"].as_u64().unwrap_or(0) == 0 || object["renderTarget"] == true {
            continue;
        }

        let id = object["id"].as_i64();
        let users: Vec<i64> = draws
            .iter()
            .enumerate()
            .filter(|(_, row)| {
                row["kind"] == "draw"
                    && row["textures"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .any(|unit| unit["sampler"].is_null() && ["t2d", "cube", "t3d", "array"].iter().any(|key| unit[*key].as_i64() == id))
            })
            .map(|(index, _)| index as i64)
            .collect();

        if !users.is_empty() {
            found.push(format!(
                "{} is bound for event{} {} but is incomplete: it has one mip level and its MIN_FILTER ({}) needs mipmaps. A shader that samples it reads black.",
                handle_for("texture", &object["id"], tag).unwrap_or_default(),
                if users.len() == 1 { "" } else { "s" },
                runs(&users),
                match filter {
                    Some(_) => gl_name(&object["params"]["10241"]),
                    None => "never set, so NEAREST_MIPMAP_LINEAR".to_string(),
                }
            ));
        }
    }

    // What the frame itself created and deleted.
    let mut made: Vec<(&str, i64)> = Vec::new();
    let mut deleted: Vec<(&str, i64)> = Vec::new();
    let count = |name: &str| commands.iter().filter(|command| method_of(command) == name).count() as i64;

    // WebGPU makes views, bind groups and encoders every frame as a matter of course. What
    // is worth a word is what is costly or holds memory.
    for (noun, methods) in [
        (
            "pipeline",
            &[
                "GPUDevice.createRenderPipeline",
                "GPUDevice.createComputePipeline",
                "GPUDevice.createRenderPipelineAsync",
                "GPUDevice.createComputePipelineAsync",
            ][..],
        ),
        ("shader module", &["GPUDevice.createShaderModule"][..]),
        ("texture", &["GPUDevice.createTexture"][..]),
        ("buffer", &["GPUDevice.createBuffer"][..]),
    ] {
        let created: i64 = methods.iter().map(|name| count(name)).sum();

        if created > 0 {
            made.push((noun, created));
        }
    }

    for (noun, method) in [("texture", "GPUTexture.destroy"), ("buffer", "GPUBuffer.destroy")] {
        if count(method) > 0 {
            deleted.push((noun, count(method)));
        }
    }

    for (noun, suffix) in [
        ("program", "Program"),
        ("shader", "Shader"),
        ("texture", "Texture"),
        ("buffer", "Buffer"),
        ("framebuffer", "Framebuffer"),
        ("renderbuffer", "Renderbuffer"),
        ("vertex array", "VertexArray"),
    ] {
        let (created, removed) = (count(&format!("gl.create{suffix}")), count(&format!("gl.delete{suffix}")));

        if created > 0 {
            made.push((noun, created));
        }

        if removed > 0 {
            deleted.push((noun, removed));
        }
    }

    if !made.is_empty() {
        let words = |items: &[(&str, i64)]| items.iter().map(|(noun, count)| plural(*count, noun)).collect::<Vec<_>>().join(", ");
        let webgpu = is_webgpu(body);
        let (compiled, linked) = if webgpu {
            (
                made.iter().filter(|entry| entry.0 == "shader module").map(|entry| entry.1).sum(),
                made.iter().filter(|entry| entry.0 == "pipeline").map(|entry| entry.1).sum(),
            )
        } else {
            (count("gl.compileShader"), count("gl.linkProgram"))
        };

        // The events drawn with a program the frame itself made.
        let users: Vec<String> = commands
            .iter()
            .filter(|command| method_of(command) == "gl.createProgram")
            .filter_map(|command| command[2]["i"].as_i64())
            .filter_map(|program| {
                let events: Vec<i64> =
                    draws.iter().enumerate().filter(|(_, row)| row["program"].as_i64() == Some(program)).map(|(index, _)| index as i64).collect();

                (!events.is_empty()).then(|| {
                    format!(
                        " {} is used by event{} {}.",
                        handle_for("program", &json!(program), tag).unwrap_or_default(),
                        if events.len() == 1 { "" } else { "s" },
                        runs(&events)
                    )
                })
            })
            .take(3)
            .collect();

        found.push(format!(
            "The frame itself created {}{}{}.{}{}{} resources() counts what is alive and what has been created in all; resources(kind: …, sort: \"created\") shows the line that creates each.",
            words(&made),
            if compiled + linked > 0 && !webgpu {
                format!(" (compiled {}, linked {})", plural(compiled, "shader"), plural(linked, "program"))
            } else {
                String::new()
            },
            if deleted.is_empty() { " and deleted nothing".to_string() } else { format!(", and deleted {}", words(&deleted)) },
            users.concat(),
            if compiled + linked > 0 && webgpu {
                " Compiling shader modules and building pipelines are slow: a page that does this every frame stutters."
            } else if compiled + linked > 0 {
                " Compiling and linking are slow: a page that does this every frame stutters."
            } else {
                ""
            },
            if made.iter().map(|entry| entry.1).sum::<i64>() > deleted.iter().map(|entry| entry.1).sum::<i64>() {
                " It created more than it deleted: if every frame does, they pile up (a leak)."
            } else {
                ""
            }
        ));
    }

    found
}

/// `errors` maps a command's index to the GL error it raised when replayed; `effects` maps
/// an event's number to what replaying it did to its target.
/// The named groups around each event, outermost first, and the game object it belongs to
/// (05-PAGE-PROTOCOL.md, section 4). Keyed by the event's command.
///
/// Groups come from the page protocol (`header.groups`, said by the page or by an engine
/// adapter) and, for WebGPU, from the page's own debug groups and pass labels in the stream.
fn groups_of(body: &Value) -> HashMap<i64, (Vec<String>, Option<Value>)> {
    let methods: Vec<&str> = body["methods"].as_array().into_iter().flatten().map(|name| name.as_str().unwrap_or("")).collect();
    let said: Vec<&Value> = body["header"]["groups"].as_array().into_iter().flatten().collect();
    let events: std::collections::HashSet<i64> = body["draws"].as_array().into_iter().flatten().filter_map(|row| row["command"].as_i64()).collect();
    let mut out = HashMap::new();

    // What the protocol has open: each group's name and the game object declared in it.
    let mut open: Vec<(String, Option<Value>)> = Vec::new();
    let mut next = 0;

    // WebGPU: the debug groups open on each encoder and pass, and what was open around a
    // pass when it began.
    let mut on: HashMap<String, Vec<String>> = HashMap::new();
    let mut around: HashMap<String, Vec<String>> = HashMap::new();

    for (index, command) in body["commands"].as_array().into_iter().flatten().enumerate() {
        while next < said.len() && said[next][0].as_u64().unwrap_or(0) as usize <= index {
            match said[next][1].as_str().unwrap_or("") {
                "push" | "open" => open.push((said[next][2].as_str().unwrap_or("").to_string(), None)),
                "pop" => {
                    open.pop();
                }
                "entity" => {
                    if let Some(top) = open.last_mut() {
                        top.1 = Some(said[next][2].clone());
                    }
                }
                _ => {}
            }

            next += 1;
        }

        let method = command[0].as_u64().and_then(|id| methods.get(id as usize)).copied().unwrap_or("");
        let receiver = command.get(3).map(Value::to_string).unwrap_or_default();

        if method.ends_with(".pushDebugGroup") {
            on.entry(receiver.clone()).or_default().push(command[1][0].as_str().unwrap_or("").to_string());
        } else if method.ends_with(".popDebugGroup") {
            on.entry(receiver.clone()).or_default().pop();
        } else if method.ends_with(".beginRenderPass") || method.ends_with(".beginComputePass") {
            let mut outer = on.get(&receiver).cloned().unwrap_or_default();

            if let Some(label) = command[1][0]["label"].as_str().filter(|label| !label.is_empty()) {
                outer.push(label.to_string());
            }

            around.insert(command[2].to_string(), outer);
        }

        if events.contains(&(index as i64)) {
            // A WebGPU pass clears as it begins: that event is the pass's, not the encoder's.
            let receiver = if method.ends_with(".beginRenderPass") { command[2].to_string() } else { receiver };

            let mut path: Vec<String> = open.iter().map(|(name, _)| name.clone()).collect();

            path.extend(around.get(&receiver).cloned().unwrap_or_default());
            path.extend(on.get(&receiver).cloned().unwrap_or_default());

            let entity = open.iter().rev().find_map(|(_, entity)| entity.clone());

            if !path.is_empty() || entity.is_some() {
                out.insert(index as i64, (path, entity));
            }
        }
    }

    out
}

/// A game object in a few words: its type and name, or whatever it has.
pub(crate) fn entity_text(entity: &Value) -> String {
    let word = |key: &str| entity[key].as_str().map(str::to_string).or_else(|| entity[key].as_i64().map(|number| number.to_string()));

    match (word("type"), word("name").filter(|name| !name.is_empty()).or_else(|| word("id")).or_else(|| word("path"))) {
        (Some(kind), Some(name)) => format!("{kind} «{}»", page_text(&name, 60)),
        (Some(kind), None) => kind,
        (None, Some(name)) => format!("«{}»", page_text(&name, 60)),
        (None, None) => page_text(&entity.to_string(), 80),
    }
}

fn tables(body: &Value, tag: u64, errors: &HashMap<i64, String>, effects: &HashMap<i64, Value>) -> (Vec<Table>, Value) {
    let sizes = Sizes::of(body);
    let groups = groups_of(body);
    let webgpu = is_webgpu(body);
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

        let size = sizes.target(row);
        let effect = effects.get(&index).cloned().unwrap_or(Value::Null);
        let group = groups.get(&row["command"].as_i64().unwrap_or(-1));

        let textures: Vec<String> = row["textures"]
            .as_array()
            .into_iter()
            .flatten()
            .flat_map(|unit| ["t2d", "cube", "t3d", "array"].into_iter().filter_map(move |key| handle_for("texture", &unit[key], tag)))
            .fold(Vec::new(), |mut seen: Vec<String>, texture| {
                // A texture bound in several places is named once.
                if !seen.contains(&texture) {
                    seen.push(texture);
                }

                seen
            });

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
            Sql::Integer(!row["indexType"].is_null() as i64),
            if row["pipeline"].is_number() { named("pipeline", &row["pipeline"]) } else { named("program", &row["program"]) },
            named("vertex_array", &row["vertexArray"]),
            named("framebuffer", &row["framebuffer"]),
            Sql::Integer(row["blend"].is_object() as i64),
            text(set(&row["blend"]["srcRgb"]).then(|| factor(&row["blend"]["srcRgb"]))),
            text(set(&row["blend"]["dstRgb"]).then(|| factor(&row["blend"]["dstRgb"]))),
            Sql::Integer(row["depth"].is_object() as i64),
            Sql::Integer((row["depth"]["write"] == true) as i64),
            text(set(&row["depth"]["func"]).then(|| gl_name(&row["depth"]["func"]))),
            Sql::Integer(row["stencil"].is_object() as i64),
            text(set(&row["cull"]).then(|| gl_name(&row["cull"]))),
            text(row["scissor"].as_array().map(|_| list(&row["scissor"]))),
            Sql::Text(list(&row["viewport"])),
            Sql::Text(list(&row["colorMask"])),
            Sql::Text(textures.join(" ")),
            text(errors.get(&row["command"].as_i64().unwrap_or(-1)).cloned()),
            Sql::Integer(size.0),
            Sql::Integer(size.1),
            int(&effect["changed"]),
            text(effect["w"].as_i64().map(|_| format!("{}, {}, {}, {}", effect["x"], effect["y"], effect["w"], effect["h"]))),
            text(group.map(|(path, _)| path.join(" / ")).filter(|path| !path.is_empty())),
            text(group.and_then(|(_, entity)| entity.as_ref()).map(entity_text)),
            text(group.and_then(|(_, entity)| entity.as_ref()).map(Value::to_string)),
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

    // The event each call leads up to: the first one at or after it.
    let mut event_commands: Vec<(i64, i64)> = event_of_command.iter().map(|(command, event)| (*command, *event)).collect();

    event_commands.sort();

    let leads_to = |command: i64| {
        let at = event_commands.partition_point(|(event_command, _)| *event_command < command);

        event_commands.get(at).map(|(_, event)| Sql::Integer(*event)).unwrap_or(Sql::Null)
    };

    // A frame taken from a recording carries the frames before it, which replay needs and
    // which are not this frame's calls.
    let first_command = body["header"]["firstCommand"].as_u64().unwrap_or(0) as usize;

    let command_rows: Vec<Vec<Sql>> = body["commands"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
        .skip(first_command)
        .map(|(index, command)| {
            let method = command[0].as_u64().and_then(|id| methods.get(id as usize)).cloned().unwrap_or_default();
            let mut args = readable(&method, &command[1], tag).to_string();

            if args.len() > 400 {
                args = format!("{}…", args.chars().take(400).collect::<String>());
            }

            vec![
                Sql::Integer(index as i64),
                Sql::Text(method),
                Sql::Text(args),
                event_of_command.get(&(index as i64)).map(|draw| Sql::Integer(*draw)).unwrap_or(Sql::Null),
                leads_to(index as i64),
                text(errors.get(&(index as i64)).cloned()),
                // What a WebGPU call was made on: "#4" is an encoder or a pass made during the frame.
                text(command.get(3).map(|receiver| readable("", &json!([receiver]), tag)[0].as_str().map(str::to_string).unwrap_or_default())),
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
            let (what, bytes) = if webgpu { describe_gpu_object(object, body) } else { describe_object(object) };

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

    let grouped = draws
        .iter()
        .filter(|row| row["kind"] == "draw" && groups.get(&row["command"].as_i64().unwrap_or(-1)).is_some_and(|(path, _)| !path.is_empty()))
        .count();
    let with_entity = draws
        .iter()
        .filter(|row| row["kind"] == "draw" && groups.get(&row["command"].as_i64().unwrap_or(-1)).is_some_and(|(_, entity)| entity.is_some()))
        .count();

    let counts = json!({
        "grouped": grouped,
        "with_entity": with_entity,
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
                "gl_error TEXT",
                "target_width INTEGER",
                "target_height INTEGER",
                "pixels_changed INTEGER",
                "changed_box TEXT",
                "path TEXT",
                "entity TEXT",
                "entity_detail TEXT",
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
        Table {
            name: "commands",
            columns: vec!["command INTEGER PRIMARY KEY", "method TEXT", "args TEXT", "draw INTEGER", "for_draw INTEGER", "gl_error TEXT", "receiver TEXT"],
            rows: command_rows,
        },
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
pub(crate) async fn load_into(host: &Arc<Host>, session: &Arc<Session>, handle: &str) -> Result<Value> {
    let stream = host.store.stream(handle)?;
    let hashes: Vec<String> = stream["blob_hashes"].as_array().into_iter().flatten().filter_map(|hash| hash.as_str().map(str::to_string)).collect();
    let store = &host.store;

    session.replay_load(handle, &stream, &|index| store.get_blob(hashes.get(index).ok_or_else(|| anyhow!("The capture names no blob {index}."))?)).await?;

    Ok(stream)
}

pub(crate) fn replay_image(reply: &Value) -> Result<Image> {
    Image::new(reply["width"].as_u64().unwrap_or(0) as u32, reply["height"].as_u64().unwrap_or(0) as u32, unpack(reply["data"].as_str().unwrap_or(""))?)
}

pub(crate) fn the_capture(host: &Host, params: &Value) -> Result<(String, Value)> {
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

/// What a capture is of, for the first line of every answer about one, and a warning when
/// the session named alongside it has a different page open: handles are shared by every
/// session on the host, so it is easy to pass someone else's.
pub(crate) fn about(host: &Host, params: &Value, handle: &str, meta: &Value) -> String {
    let url = meta["url"].as_str().unwrap_or("");
    let mut text = format!("{handle} (frame {} of {})", meta["frame"], page_text(url, 80));

    if let Some(session) = params["session"].as_str().and_then(|id| host.sessions.lock().ok()?.get(id).cloned()) {
        let open = session.url();

        if !url.is_empty() && !open.is_empty() && open != url {
            text.push_str(&format!(
                " [WARNING: not a capture of the page {} has open, which is {}; captures() lists them all]",
                session.id,
                page_text(&open, 80)
            ));
        }
    }

    text
}

// ---- Taking a capture ----

pub async fn capture(host: &Arc<Host>, session: &Arc<Session>, params: &Value) -> Result<Value> {
    let context = choose_context(session, params).await?;

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

    let body = fetch(host, session, &context.instance, &id, &taken).await?;

    // The frame's own final image, as the page drew it.
    let original = decode_grab(&session.probe(&context.instance, "image.grab", json!({ "context": context.local }), Duration::from_secs(20)).await?)?;

    if was_running {
        session.probe_all("resume", json!({}), SHORT).await;
    }

    build(
        host,
        session,
        body,
        Source { context: context.handle.clone(), tag: context.instance.tag as u64, original: Some(original), recording: None, url: None },
        params,
    )
    .await
}

/// Fetches from the page what it recorded: the description, and the blobs, which are stored
/// by content, so a texture this capture shares with an earlier one costs nothing.
pub(crate) async fn fetch(host: &Arc<Host>, session: &Arc<Session>, instance: &crate::session::Instance, id: &Value, taken: &Value) -> Result<Value> {
    let mut body: Value = serde_json::from_slice(&unpack(taken["body"].as_str().unwrap_or(""))?).context("reading the capture the page sent")?;
    let count = taken["blobs"].as_u64().unwrap_or(0);
    let mut hashes = Vec::with_capacity(count as usize);
    let mut from = 0u64;

    while from < count {
        let part = session.probe(instance, "capture.blobs", json!({ "capture": id, "from": from }), LONG).await?;

        for blob in part["blobs"].as_array().into_iter().flatten() {
            hashes.push(host.store.put_blob(&unpack(blob.as_str().unwrap_or(""))?)?);
        }

        from = part["next"].as_u64().unwrap_or(count);
    }

    let _ = session.probe(instance, "capture.release", json!({ "capture": id }), SHORT).await;

    body["blob_hashes"] = json!(hashes);
    body["blob_bytes"] = taken["blobBytes"].clone();

    Ok(body)
}

/// One frame of a flight recording as a capture's stream. The frames before it stay in the
/// stream, because replay has to run them to arrive at this one, but its events are its own.
pub(crate) fn frame_body(recording: &Value, index: usize) -> Result<Value> {
    let marks = recording["header"]["frames"].as_array().cloned().unwrap_or_default();
    let mark = marks.get(index).ok_or_else(|| anyhow!("The recording has {} frames; there is no frame at position {index}.", marks.len()))?;
    let (first_command, first_draw) = match index.checked_sub(1).and_then(|before| marks.get(before)) {
        Some(before) => (before["command"].as_u64().unwrap_or(0) as usize, before["draw"].as_u64().unwrap_or(0) as usize),
        None => (0, 0),
    };
    let (end_command, end_draw) = (mark["command"].as_u64().unwrap_or(0) as usize, mark["draw"].as_u64().unwrap_or(0) as usize);
    let mut body = recording.clone();

    if let Some(commands) = body["commands"].as_array_mut() {
        commands.truncate(end_command);
    }

    body["draws"] =
        json!(recording["draws"].as_array().map(|draws| draws[first_draw.min(draws.len())..end_draw.min(draws.len())].to_vec()).unwrap_or_default());
    body["header"]["frame"] = mark["frame"].clone();
    body["header"]["firstCommand"] = json!(first_command);

    Ok(body)
}

/// Where a capture's frame came from.
pub(crate) struct Source {
    pub context: String,
    pub tag: u64,
    /// The frame's own final image, as the page drew it. A frame taken from a flight
    /// recording has none, unless it is the frame the page was frozen on.
    pub original: Option<Image>,
    /// The recording the frame was taken from, and whether that recording's last frame
    /// replayed to the image the page showed.
    pub recording: Option<(String, bool)>,
    /// The page the frame is of, where that is not the page the session has open now.
    pub url: Option<String>,
}

/// Makes a capture of a frame's stream: replays it, measures it, builds its tables and writes it.
pub(crate) async fn build(host: &Arc<Host>, session: &Arc<Session>, body: Value, source: Source, params: &Value) -> Result<Value> {
    let handle = host.store.reserve_handle()?;
    let tag = source.tag;
    let hashes: Vec<String> = body["blob_hashes"].as_array().into_iter().flatten().filter_map(|hash| hash.as_str().map(str::to_string)).collect();

    // Run it again and compare. If the replay does not match the frame, every answer that
    // comes from replay is suspect, and says so.
    let store = &host.store;

    session.replay_load(&handle, &body, &|index| store.get_blob(&hashes[index])).await?;

    // A capture that cannot be replayed is still kept: what it says can be read, and the
    // verdict says why nothing can be asked of what it did.
    let mut replayed_image = None;

    let (replayed, difference) = match session.replay("image", &json!({ "key": handle }), LONG).await {
        Ok(replayed) => {
            let image = replay_image(&replayed);

            let difference = match (&image, &source.original) {
                (Ok(image), Some(original)) => original.difference(image, 0).map(Some),
                (Ok(_), None) => Ok(None),
                (Err(error), _) => Err(anyhow!("{error}")),
            };

            replayed_image = image.ok();

            (replayed, difference)
        }
        Err(error) => (Value::Null, Err(anyhow!("the replay failed ({error})"))),
    };

    // If the frame left a GL error behind, find out which calls raised one. The browser
    // rejects such a call outright, so a draw that raised one drew nothing.
    let mut errors = HashMap::new();

    if replayed["error"].as_u64().unwrap_or(0) != 0 {
        if let Ok(found) = session.replay("errors", &json!({ "key": handle }), LONG).await {
            for entry in found["errors"].as_array().into_iter().flatten() {
                // WebGL gives a code; WebGPU gives the browser's own sentence.
                let error = match entry["error"].as_str() {
                    Some(message) => page_text(message, 400),
                    None => gl_error_name(entry["error"].as_u64().unwrap_or(0)),
                };

                errors.insert(entry["command"].as_i64().unwrap_or(-1), error);
            }
        }
    }

    // What every event did to its target, measured in one more replay. A frame too big for
    // that goes without: draw measures a single event when asked.
    let mut effects = HashMap::new();
    let mut effect_note = None;

    match if replayed.is_null() { Err(anyhow!("the capture does not replay")) } else { session.replay("effects", &json!({ "key": handle }), LONG).await } {
        Ok(measured) if measured["skipped"] == true => {
            effect_note =
                Some("The frame is too large to measure what every event changed, so draw_list does not say; draw(draw: n) measures one.".to_string());
        }
        Ok(measured) => {
            for effect in measured["effects"].as_array().into_iter().flatten() {
                effects.insert(effect["draw"].as_i64().unwrap_or(-1), effect.clone());
            }
        }
        Err(error) => effect_note = Some(format!("What each event changed could not be measured: {error}")),
    }

    // WebGPU drops a whole command buffer for one bad call in it. Splitting the frame to
    // measure each event hides that: the events before the bad call were submitted on their
    // own and drew. In the page they did not, so they are marked as dropped.
    let raised = errors.len();

    if is_webgpu(&body) && !errors.is_empty() {
        for (event, cause) in dropped_events(&body, &errors) {
            let command = body["draws"][event as usize]["command"].as_i64().unwrap_or(-1);

            effects.insert(event, json!({ "draw": event, "changed": 0 }));
            errors.entry(command).or_insert(format!("{DROPPED} (call {cause})"));
        }
    }

    let (capture_tables, mut counts) = tables(&body, tag, &errors, &effects);

    counts["gl_errors"] = json!(raised);

    let found = findings(&body, tag, &errors, &effects);

    let mut notes: Vec<String> = replayed["notes"].as_array().into_iter().flatten().filter_map(|note| note.as_str().map(str::to_string)).collect();

    notes.extend(effect_note);

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
        Ok(Some(difference)) if difference.changed == 0 => "identical".to_string(),
        Ok(Some(difference)) => format!("{} of {} pixels differ, by up to {}", difference.changed, difference.pixels, difference.max),
        // A frame from a recording, other than the one the page was frozen on.
        Ok(None) => "not compared".to_string(),
        Err(error) => format!("could not be compared: {error}"),
    };

    // With no image of its own to compare with, the frame is as trustworthy as its recording.
    let matches = match (&difference, &source.recording) {
        (Ok(None), Some((_, recording_matches))) => *recording_matches,
        _ => fidelity == "identical",
    };

    // The picture kept as the frame's final image: the page's own where there is one.
    let Some(original) = source.original.or(replayed_image) else {
        bail!("The frame could not be replayed, and there is no image of it from the page: {fidelity}.");
    };

    let header = &body["header"];

    let meta = json!({
        "capture": handle,
        "session": session.id,
        "url": source.url.clone().unwrap_or_else(|| session.url()),
        "context": source.context,
        "instance_tag": tag,
        "api": header["api"],
        "width": header["width"],
        "height": header["height"],
        "frame": header["frame"],
        "profile": session.profile.name(),
        "browser": session.browser_version,
        "replay": fidelity,
        "replay_matches": matches,
        "recording": source.recording.as_ref().map(|recording| recording.0.clone()),
        "notes": notes,
        "findings": found,
        "counts": counts,
        "blob_bytes": body["blob_bytes"],
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

/// Why the browser rejected a draw, where the capture itself shows it.
fn rejection(host: &Host, handle: &str, draw: i64, tag: u64) -> Option<String> {
    let rows = host.store.query(handle, "SELECT state FROM draws WHERE draw = ?1", &[Sql::Integer(draw)], 1).ok()?;
    let state: Value = serde_json::from_str(rows.rows.first()?[0].as_str()?).ok()?;
    let (unit, texture) = feedback(&state, tag)?;

    Some(format!(" — a feedback loop: {texture} is the target being drawn to and is also bound on texture unit {unit}"))
}

pub(crate) fn describe_capture(host: &Host, handle: &str, meta: &Value) -> Result<Value> {
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

    // Names the page or its engine gave: the draws resolve to them.
    let draws = counts["draws"].as_u64().unwrap_or(0);
    let grouped = counts["grouped"].as_u64().unwrap_or(0);

    if grouped > 0 {
        let entities = counts["with_entity"].as_u64().unwrap_or(0);

        lines.push(format!(
            "{} in a named group{}. pass_tree shows the groups; draw_list shows each draw's.",
            match (grouped == draws, draws) {
                (true, 1) => "The one draw is".to_string(),
                (true, _) => format!("All {draws} draws are"),
                (false, _) => format!("{grouped} of the {draws} draws {}", if grouped == 1 { "is" } else { "are" }),
            },
            match entities {
                0 => String::new(),
                1 if draws == 1 => ", and belongs to an object the page or its engine declared".to_string(),
                all if all == draws => ", and every one belongs to an object the page or its engine declared".to_string(),
                some => format!(", and {some} belong to an object the page or its engine declared"),
            }
        ));
    }

    lines.push(format!(
        "Uses {} textures ({}) and {} buffers ({}).",
        counts["textures"],
        size(counts["texture_bytes"].as_f64().unwrap_or(0.0)),
        counts["buffers"],
        size(counts["buffer_bytes"].as_f64().unwrap_or(0.0))
    ));

    // Calls the browser rejected. A rejected draw draws nothing, which is often the whole bug.
    if counts["gl_errors"].as_u64().unwrap_or(0) > 0 {
        let failed = host.store.query(
            handle,
            "SELECT c.command, c.method, c.gl_error, c.draw FROM commands c WHERE c.gl_error IS NOT NULL AND c.gl_error NOT LIKE 'dropped with%' ORDER BY c.command",
            &[],
            6,
        )?;

        lines.push(format!(
            "{} call{} raised {} when replayed. {}:",
            counts["gl_errors"],
            if counts["gl_errors"] == 1 { "" } else { "s" },
            if meta["api"] == "webgpu" { "a validation error" } else { "a GL error" },
            if meta["api"] == "webgpu" {
                "WebGPU drops the whole command buffer such a call is encoded in, so none of its passes drew"
            } else {
                "The browser rejects such a call, so it did nothing"
            }
        ));

        for row in &failed.rows {
            let event = row[3].as_i64().map(|draw| format!("event {draw}, ")).unwrap_or_default();
            let why = row[3].as_i64().and_then(|draw| rejection(host, handle, draw, meta["instance_tag"].as_u64().unwrap_or(0))).unwrap_or_default();

            lines.push(format!("  {event}call {} {}: {}{why}", row[0], row[1].as_str().unwrap_or(""), page_text(row[2].as_str().unwrap_or(""), 300)));
        }

        if failed.truncated {
            lines.push("  … and more: query \"select command, method, gl_error from commands where gl_error is not null\".".into());
        }

        if meta["api"] != "webgpu" {
            lines.push("  console(level: \"error\") has the browser's own message for each.".into());
        } else {
            let dropped = host.store.query(handle, "SELECT draw FROM draws WHERE gl_error LIKE 'dropped with%' ORDER BY draw", &[], 500)?;
            let events: Vec<i64> = dropped.rows.iter().filter_map(|row| row[0].as_i64()).collect();

            if !events.is_empty() {
                lines.push(format!(
                    "  So event{} {} did not run in the page, whatever {} would have drawn.",
                    if events.len() == 1 { "" } else { "s" },
                    runs(&events),
                    if events.len() == 1 { "it" } else { "they" }
                ));
            }
        }
    }

    let found: Vec<&str> = meta["findings"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();

    if !found.is_empty() {
        lines.push("Worth a look (facts about this frame that are often the bug):".into());
        lines.extend(found.iter().map(|finding| format!("  • {finding}")));
    }

    lines.push(if meta["replay"] == "not compared" {
        format!(
            "Replay check: this frame was taken from recording {}, which kept no image of it to compare with. The recording's last frame, the one the page was frozen on, {}.",
            meta["recording"].as_str().unwrap_or("?"),
            if meta["replay_matches"] == true { "replayed to an identical image, so answers from replay can be trusted" } else { "did NOT replay to the same image, so answers from replay may be wrong" }
        )
    } else if meta["replay_matches"] == true {
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
    let (handle, meta) = the_capture(host, params)?;
    let passes = host.store.query(&handle, "SELECT pass, target, first_draw, last_draw, draws, clears FROM passes ORDER BY pass", &[], 500)?;
    let handle_text = about(host, params, &handle, &meta);
    let mut lines =
        vec![format!("{handle_text}: {} pass{}. A pass is a run of events on one target.", passes.rows.len(), if passes.rows.len() == 1 { "" } else { "es" })];

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

    // The groups the page or its engine named, as a tree. A group's events are those whose
    // path begins with it.
    let named = if has_groups(host, &handle) {
        host.store.query(&handle, "SELECT draw, kind, path, entity FROM draws ORDER BY draw", &[], 20_000)?
    } else {
        scanline_store::Rows::default()
    };
    let mut groups: Vec<Value> = Vec::new();

    if named.rows.iter().any(|row| row[2].is_string()) {
        // A group is a run of events that share a path up to its depth. The same name
        // coming round again after something else is another group.
        struct Open {
            depth: usize,
            name: String,
            first: i64,
            last: i64,
            draws: i64,
            entity: Option<String>,
        }

        let mut done: Vec<Open> = Vec::new();
        let mut open: Vec<usize> = Vec::new(); // indices into `done`, outermost first
        let mut ungrouped = 0;

        for row in &named.rows {
            let event = row[0].as_i64().unwrap_or(0);
            let is_draw = row[1] == "draw";
            let parts: Vec<&str> = row[2].as_str().map(|path| path.split(" / ").collect()).unwrap_or_default();

            if parts.is_empty() && is_draw {
                ungrouped += 1;
            }

            let shared = open.iter().zip(&parts).take_while(|(at, part)| done[**at].name == **part).count();

            open.truncate(shared);

            for (depth, part) in parts.iter().enumerate().skip(shared) {
                done.push(Open { depth, name: part.to_string(), first: event, last: event, draws: 0, entity: None });
                open.push(done.len() - 1);
            }

            for at in &open {
                done[*at].last = event;
                done[*at].draws += is_draw as i64;
            }

            // The event's object is that of its innermost group.
            if let (Some(at), Some(entity)) = (open.last(), row[3].as_str()) {
                done[*at].entity.get_or_insert_with(|| entity.to_string());
            }
        }

        lines.push(format!(
            "Named groups, as the page or its engine declared them ({}{}):",
            plural(done.len() as i64, "group"),
            if ungrouped > 0 { format!("; {} in none", plural(ungrouped, "draw")) } else { String::new() }
        ));

        for (shown, group) in done.iter().enumerate() {
            if shown < 80 {
                lines.push(format!(
                    "  {}«{}»  {}  {}{}",
                    "  ".repeat(group.depth),
                    page_text(&group.name, 60),
                    if group.first == group.last { format!("event {}", group.first) } else { format!("events {}–{}", group.first, group.last) },
                    plural(group.draws, "draw"),
                    group.entity.as_ref().map(|entity| format!("  of {entity}")).unwrap_or_default()
                ));
            }

            groups.push(
                json!({ "name": group.name, "depth": group.depth, "first": group.first, "last": group.last, "draws": group.draws, "entity": group.entity }),
            );
        }

        if done.len() > 80 {
            lines.push(format!(
                "  … and {} more groups. query(capture, sql: \"SELECT path, count(*) FROM draws GROUP BY path\") counts draws by path.",
                done.len() - 80
            ));
        }

        lines.push(format!("draw_list(capture: \"{handle}\", filter: \"path LIKE 'name%'\") lists a group's events. Names in «» are the page's own words."));
    }

    Ok(result(lines.join("\n"), json!({ "capture": handle, "passes": rows_as_objects(&passes), "groups": groups })))
}

/// Whether a capture's draws carry group paths. One written before they existed does not.
fn has_groups(host: &Host, handle: &str) -> bool {
    host.store
        .query(handle, "SELECT count(*) FROM pragma_table_info('draws') WHERE name = 'path'", &[], 1)
        .is_ok_and(|found| found.rows.first().is_some_and(|row| row[0].as_i64().unwrap_or(0) > 0))
}

pub(crate) fn rows_as_objects(rows: &scanline_store::Rows) -> Vec<Value> {
    rows.rows.iter().map(|row| Value::Object(rows.columns.iter().cloned().zip(row.iter().cloned()).collect())).collect()
}

pub(crate) fn describe_event(row: &serde_json::Map<String, Value>) -> String {
    let get = |key: &str| row.get(key).cloned().unwrap_or(Value::Null);
    let word = |key: &str| get(key).as_str().unwrap_or("").to_string();
    let mut text = format!("{:>4}  ", get("draw").as_i64().unwrap_or(0));

    match word("kind").as_str() {
        "clear" => text.push_str(&format!("clear          → {}", word("target"))),
        "blit" => text.push_str(&format!("blit           → {}", word("target"))),
        "dispatch" => text.push_str(&format!("dispatch       {} (compute)", word("program"))),
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

            if !word("textures").is_empty() {
                text.push_str(&format!("  textures {}", word("textures")));
            }
        }
    }

    let size = (get("target_width").as_i64().unwrap_or(0), get("target_height").as_i64().unwrap_or(0));
    let area = |key: &str| json!(word(key).split(", ").filter_map(|part| part.parse::<i64>().ok()).collect::<Vec<_>>());

    if word("kind") != "blit" {
        if !word("scissor").is_empty() {
            text.push_str(&format!("  scissor ON {}", word("scissor")));
        }

        // The viewport is only worth a line's space when it is not the whole target.
        if word("kind") == "draw" && partial(&area("viewport"), size) {
            text.push_str(&format!("  viewport {} (target is {}×{})", word("viewport"), size.0, size.1));
        }
    }

    match get("pixels_changed").as_i64() {
        Some(0) => text.push_str("  ⇒ changed nothing"),
        Some(changed) => text.push_str(&format!("  ⇒ {changed} px at {}", word("changed_box"))),
        None => {}
    }

    if !word("entity").is_empty() {
        text.push_str(&format!("  of {}", word("entity")));
    }

    if !word("path").is_empty() {
        text.push_str(&format!("  in «{}»", page_text(&word("path"), 90)));
    }

    let error = word("gl_error");

    if error.starts_with(DROPPED) {
        text.push_str(&format!("  DID NOT RUN: {error}"));
    } else if error.contains(' ') {
        // WebGPU's errors are sentences.
        text.push_str(&format!("  REJECTED: {}", page_text(&error, 100)));
    } else if !error.is_empty() {
        text.push_str(&format!("  REJECTED: GL_{error}"));
    }

    text
}

pub fn draw_list(host: &Arc<Host>, params: &Value) -> Result<Value> {
    let (handle, meta) = the_capture(host, params)?;
    let limit = params["limit"].as_u64().unwrap_or(25).clamp(1, 200);
    let cursor = params["cursor"].as_u64().unwrap_or(0);
    let filter = params["filter"].as_str().map(str::trim).filter(|filter| !filter.is_empty());

    // The filter is a SQL condition on the draws table. The database is read-only.
    let condition = filter.map(|filter| format!(" WHERE ({filter})")).unwrap_or_default();
    let columns = format!(
        "draw, kind, method, pass, target, mode, count, instances, indexed, program, blend, blend_src, blend_dst, depth_test, depth_write, depth_func, cull, scissor, viewport, textures, gl_error, target_width, target_height, pixels_changed, changed_box{}",
        if has_groups(host, &handle) { ", path, entity" } else { "" }
    );

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
    let mut lines = vec![format!(
        "{}: {total} event{}{matching} (draws, clears and blits, in order). ⇒ is what replaying the event changed on its target: pixels, and the box they fall in (x, y, w, h from the top-left).{}",
        about(host, params, &handle, &meta),
        if total == 1 { "" } else { "s" },
        if meta["api"] == "webgpu" { "" } else { " Scissor and viewport boxes are as WebGL has them: x, y from the bottom-left." }
    )];

    lines.extend(objects.iter().filter_map(Value::as_object).map(describe_event));

    let next = cursor + objects.len() as u64;

    if next < total {
        lines.push(format!("total {total}, returned {}, next_cursor {next}. Narrow with filter (a SQL condition on draws: pass, target, program, blend, depth_test, textures …).", objects.len()));
    }

    if total > 0 {
        lines.push(if meta["api"] == "webgpu" {
            format!("draw(capture: \"{handle}\", draw: n) gives one in full, with its pipeline and what its bind groups hold.")
        } else {
            format!("draw(capture: \"{handle}\", draw: n) gives one in full, with its uniforms and where each was set.")
        });
    }

    Ok(result(
        lines.join("\n"),
        json!({ "capture": handle, "events": objects, "total": total, "returned": objects.len(), "next_cursor": if next < total { json!(next) } else { Value::Null } }),
    ))
}

pub(crate) fn draw_state(host: &Host, handle: &str, draw: &Value) -> Result<Value> {
    let Some(index) = draw.as_i64() else { bail!("A draw is named by its number in the capture, from 0. Call draw_list to see them.") };
    let rows = host.store.query(
        handle,
        &format!(
            "SELECT state, pass, target, program, gl_error, pixels_changed, changed_box, target_width, target_height, {} FROM draws WHERE draw = ?1",
            if has_groups(host, handle) { "path, entity, entity_detail" } else { "NULL, NULL, NULL" }
        ),
        &[Sql::Integer(index)],
        1,
    )?;

    let Some(row) = rows.rows.first() else {
        let total = host.store.query(handle, "SELECT count(*) FROM draws", &[], 1)?.rows[0][0].clone();

        bail!("{handle} has {total} events, numbered from 0; there is no draw {index}.");
    };

    let mut state: Value = serde_json::from_str(row[0].as_str().unwrap_or("{}")).context("reading the draw's state")?;

    state["pass"] = row[1].clone();
    state["targetName"] = row[2].clone();
    state["programName"] = row[3].clone();
    state["glError"] = row[4].clone();
    state["pixelsChanged"] = row[5].clone();
    state["changedBox"] = row[6].clone();
    state["targetSize"] = json!([row[7], row[8]]);
    state["path"] = row[9].clone();
    state["entity"] = row[10].clone();
    state["entityDetail"] = row[11].as_str().and_then(|text| serde_json::from_str(text).ok()).unwrap_or(Value::Null);

    Ok(state)
}

pub async fn draw(host: &Arc<Host>, params: &Value) -> Result<Value> {
    let (handle, meta) = the_capture(host, params)?;
    let index = params["draw"].as_i64().ok_or_else(|| anyhow!("draw needs draw: the event's number in the capture, from 0. Call draw_list to see them."))?;
    let state = draw_state(host, &handle, &params["draw"])?;
    let tag = meta["instance_tag"].as_u64().unwrap_or(0);
    let named = |kind: &str, id: &Value| handle_for(kind, id, tag).unwrap_or_else(|| "none".into());
    let kind = state["kind"].as_str().unwrap_or("draw");

    let size = (state["targetSize"][0].as_i64().unwrap_or(0), state["targetSize"][1].as_i64().unwrap_or(0));
    let webgpu = meta["api"] == "webgpu";

    let mut lines = vec![format!(
        "{} event {index}: {} to {} (pass {}, call {}).",
        about(host, params, &handle, &meta),
        state["method"].as_str().unwrap_or(""),
        state["targetName"].as_str().unwrap_or("?"),
        state["pass"],
        state["command"]
    )];

    // A blit copies from another target, which is where its pixels were made.
    if kind == "blit" {
        let from = match state["readFramebuffer"].as_i64().filter(|id| *id > 0) {
            Some(_) => named("framebuffer", &state["readFramebuffer"]),
            None => "the canvas".to_string(),
        };
        let rects = state["rects"].as_array().map(|rects| rects.iter().map(Value::to_string).collect::<Vec<_>>()).unwrap_or_default();

        lines.push(if rects.len() == 8 {
            format!(
                "  Copies from {from}, the box from ({}, {}) to ({}, {}), to the box from ({}, {}) to ({}, {}) here. Boxes are as WebGL has them: from the bottom-left.",
                rects[0], rects[1], rects[2], rects[3], rects[4], rects[5], rects[6], rects[7]
            )
        } else {
            format!("  Copies from {from}.")
        });
    }

    // What the page or its engine says this event is. Its words, not Scanline's.
    if let Some(path) = state["path"].as_str() {
        lines.push(format!("  In group «{}».", page_text(path, 200)));
    }

    if let Some(entity) = state["entity"].as_str() {
        lines.push(format!("  Object: {entity}. As the page or its engine declared it: «{}».", page_text(&state["entityDetail"].to_string(), 400)));
    }

    if kind == "clear" && webgpu {
        // A WebGPU pass clears what it is told to as it begins.
        let mut cleared = Vec::new();

        if state["mask"].as_u64().unwrap_or(0) & 0x4000 != 0 {
            let colour: Vec<String> = state["clearColor"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|channel| format!("{}", (channel.as_f64().unwrap_or(0.0) * 1e4).round() / 1e4))
                .collect();

            cleared.push(format!("colour to {}", colour.join(", ")));
        }

        if !state["clearDepth"].is_null() {
            cleared.push(format!("depth to {}", state["clearDepth"]));
        }

        if !state["clearStencil"].is_null() {
            cleared.push(format!("stencil to {}", state["clearStencil"]));
        }

        lines.push(format!("  the pass begins by clearing {}", cleared.join(", ")));
    } else if kind == "clear" {
        lines.push(format!(
            "  clears to colour {}, depth {}, stencil {}; mask 0x{:X}",
            list(&state["clearColor"]),
            state["clearDepth"],
            state["clearStencil"],
            state["mask"].as_u64().unwrap_or(0)
        ));
    } else if webgpu && (kind == "draw" || kind == "dispatch") {
        lines.extend(gpu_draw_lines(host, &handle, &state, tag));
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
        "  viewport {}{}; scissor {}; colour mask {}",
        list(&state["viewport"]),
        if partial(&state["viewport"], size) { format!(" (NOT the whole target, which is {}×{})", size.0, size.1) } else { String::new() },
        if state["scissor"].is_array() { format!("test ON, box {}", list(&state["scissor"])) } else { "test off".into() },
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

        if webgpu && state["stencil"].is_object() {
            let front = &state["stencil"]["front"];

            lines.push(format!(
                "  stencil: {} against reference {}; fail {}, depth fail {}, pass {}",
                front["compare"].as_str().unwrap_or("always"),
                state["stencil"]["reference"],
                front["failOp"].as_str().unwrap_or("keep"),
                front["depthFailOp"].as_str().unwrap_or("keep"),
                front["passOp"].as_str().unwrap_or("keep")
            ));
        } else if state["stencil"].is_object() {
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

        lines.push(if set(&state["cull"]) {
            format!("  cull {}, front face {}", gl_name(&state["cull"]), gl_name(&state["frontFace"]))
        } else {
            "  cull: off".to_string()
        });

        // WebGPU has no bindings that carry over from one draw to the next within a frame's
        // state: what a draw reads is its bind groups, listed above.
        let history = if webgpu { None } else { history(host, &handle, &state) };
        let no_units = Vec::new();

        for unit in if webgpu { &no_units } else { state["textures"].as_array().unwrap_or(&no_units) } {
            let bound: Vec<String> = [("t2d", "2D"), ("cube", "cube"), ("t3d", "3D"), ("array", "2D array")]
                .iter()
                .filter(|(key, _)| !unit[*key].is_null())
                .map(|(key, name)| format!("{name} {}", named("texture", &unit[*key])))
                .collect();

            // What each bound texture is, so the wrong one stands out.
            let facts: Vec<String> = ["t2d", "cube", "t3d", "array"]
                .iter()
                .filter_map(|key| handle_for("texture", &unit[*key], tag))
                .filter_map(|texture| {
                    let rows = host.store.query(&handle, "SELECT what, label FROM objects WHERE handle = ?1", &[Sql::Text(texture)], 1).ok()?;
                    let row = rows.rows.first()?;

                    Some(format!("{}{}", row[0].as_str()?, row[1].as_str().map(|label| format!(" «{}»", page_text(label, 40))).unwrap_or_default()))
                })
                .collect();

            let source = match history.as_ref().map(|history| history.1.get(&unit["unit"].as_i64().unwrap_or(-1))) {
                Some(Some((call, event))) if *event == index => format!("   ← bound for this draw, at call {call}"),
                Some(Some((call, event))) => format!("   ← last bound at call {call}, for event {event}; not bound again for this draw"),
                Some(None) => "   ← not bound in this frame: left bound by an earlier frame".to_string(),
                None => String::new(),
            };

            lines.push(format!(
                "  unit {}: {}{}{source}",
                unit["unit"],
                bound.join(", "),
                if facts.is_empty() { String::new() } else { format!("  ({})", facts.join("; ")) }
            ));
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
            lines.push(format!(
                "  {} uniform{} set (those never set hold their default). A program keeps a uniform's value until it is set again, so one not set for this draw still holds what an earlier draw gave it:",
                uniforms.len(),
                if uniforms.len() == 1 { "" } else { "s" }
            ));

            let set_at = history.as_ref().map(|history| &history.0);

            for (name, value) in uniforms.iter().take(40) {
                let values: Vec<String> = value
                    .as_array()
                    .into_iter()
                    .flatten()
                    .take(16)
                    .map(|number| number.as_f64().map(|n| format!("{}", (n * 1e6).round() / 1e6)).unwrap_or_default())
                    .collect();

                let source = match set_at.as_ref().map(|calls| calls.get(name)) {
                    Some(Some((call, event))) if *event == index => format!("   ← set for this draw, at call {call}"),
                    Some(Some((call, event))) => format!("   ← last set at call {call}, for event {event}; not set again for this draw"),
                    Some(None) => "   ← not set in this frame: carried over from an earlier frame".to_string(),
                    None => String::new(),
                };

                lines.push(format!("    {name} = {}{}{source}", values.join(", "), if value.as_array().map_or(0, Vec::len) > 16 { ", …" } else { "" }));
            }
        }
    }

    if let Some(error) = state["glError"].as_str().filter(|_| webgpu) {
        lines.push(if error.starts_with(DROPPED) {
            format!(
                "  THIS EVENT DID NOT RUN in the page: it was {error}. WebGPU rejects a whole command buffer for one invalid call in it. The capture's summary has the browser's message."
            )
        } else {
            format!("  THIS CALL WAS REJECTED when replayed: {}", page_text(error, 400))
        });
    } else if let Some(error) = state["glError"].as_str() {
        lines.push(format!(
            "  THIS CALL RAISED GL_{error} when replayed: the browser rejected it, so it drew nothing.{}",
            match feedback(&state, tag) {
                Some((unit, texture)) => format!(
                    " It is a feedback loop: {texture} is the target being drawn to and is also bound on texture unit {unit}. Bind something else on that unit (or nothing) before drawing to {texture}."
                ),
                None => " console(level: \"error\") has the browser's message saying why.".to_string(),
            }
        ));
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
        // No browser to replay in: what was measured when the capture was taken still stands.
        match (state["pixelsChanged"].as_i64(), state["changedBox"].as_str()) {
            (Some(0), _) => lines.push(
                "  Effect: it changed no pixels of its target (measured when captured). Finding which test rejected it needs an open session to replay in."
                    .into(),
            ),
            (Some(changed), Some(area)) => {
                lines.push(format!("  Effect: it changed {changed} pixels of its target, within x, y, w, h = {area} (measured when captured)."))
            }
            _ => lines.push("  Its effect on the target is measured by replay, which needs an open session.".into()),
        }
    }

    if meta["replay_matches"] != true {
        lines.push("  Warning: this capture's replay did not match the original frame, so the measured effect may be wrong.".into());
    }

    value["summary"] = json!(lines.join("\n"));

    Ok(value)
}

/// The difference an event made to its target: the target before it against the target after it.
async fn effect(host: &Arc<Host>, session: &Arc<Session>, handle: &str, index: i64, params: &Value) -> Result<(String, Value, Value)> {
    let state = draw_state(host, handle, &json!(index))?;

    load_into(host, session, handle).await?;

    // Measured when the capture was taken, unless the frame was too large for that.
    if params["output"] != true {
        match state["pixelsChanged"].as_i64() {
            Some(0) if state["glError"].is_null() => return Ok((unchanged(host, session, handle, index, &state).await, json!({ "changed": 0 }), json!([]))),
            Some(0) => return Ok(("  Effect: it changed no pixels of its target (gpu-measured).".into(), json!({ "changed": 0 }), json!([]))),
            Some(changed) => {
                return Ok((
                    format!(
                        "  Effect: it changed {changed} pixels of its target, within x, y, w, h = {} (gpu-measured). Pass output: true to see the target after it.",
                        state["changedBox"].as_str().unwrap_or("?")
                    ),
                    match state["changedBox"].as_str().map(|text| text.split(", ").filter_map(|part| part.parse::<i64>().ok()).collect::<Vec<_>>()).as_deref() {
                        Some([x, y, w, h]) => json!({ "changed": changed, "bounds": { "x": x, "y": y, "w": w, "h": h } }),
                        _ => json!({ "changed": changed }),
                    },
                    json!([]),
                ));
            }
            None => {}
        }
    }

    let after = replay_image(&session.replay("image", &json!({ "key": handle, "draw": index }), LONG).await?)?;

    // Before: the same target after the previous event. For the first event, the target as the frame found it.
    let before = if index > 0 {
        let state = draw_state(host, handle, &json!(index))?;
        let target = if state["target"].as_i64().unwrap_or(0) > 0 {
            json!({ "texture": state["target"], "level": state["targetLevel"] })
        } else if state["framebuffer"].as_i64().unwrap_or(0) > 0 {
            json!({ "framebuffer": state["framebuffer"] })
        } else {
            Value::Null
        };

        replay_image(&session.replay("image", &json!({ "key": handle, "draw": index - 1, "target": target }), LONG).await?).ok()
    } else {
        None
    };

    let Some(before) = before.filter(|before| before.width == after.width && before.height == after.height) else {
        return Ok(("  It is the first event on its target, so there is nothing before it to compare with.".into(), json!({}), json!([])));
    };

    let difference = before.difference(&after, 0)?;

    if difference.changed == 0 {
        return Ok((unchanged(host, session, handle, index, &state).await, json!({ "changed": 0 }), json!([])));
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

/// What a WebGPU draw runs with: its pipeline, what its bind groups hold, and its buffers.
fn gpu_draw_lines(host: &Host, handle: &str, state: &Value, tag: u64) -> Vec<String> {
    let named = |kind: &str, id: &Value| handle_for(kind, id, tag).unwrap_or_else(|| "none".into());

    // An object's few words and label from the capture, for the end of a line.
    let about = |name: &str| -> String {
        let Ok(rows) = host.store.query(handle, "SELECT what, label FROM objects WHERE handle = ?1", &[Sql::Text(name.to_string())], 1) else {
            return String::new();
        };

        rows.rows
            .first()
            .map(|row| {
                format!("  ({}{})", row[0].as_str().unwrap_or(""), row[1].as_str().map(|label| format!(" «{}»", page_text(label, 40))).unwrap_or_default())
            })
            .unwrap_or_default()
    };

    let mut lines = Vec::new();

    if state["kind"] == "dispatch" {
        lines.push(match state["count"].as_array() {
            Some(_) => format!("  dispatches {} workgroups", list(&state["count"]).replace(", ", " × ")),
            None => "  dispatches workgroups counted in a buffer (indirect)".to_string(),
        });
    } else if state["method"] == "executeBundles" {
        lines.push(format!(
            "  runs {} render bundle{}: what they draw was decided when they were built",
            state["bundles"],
            if state["bundles"] == 1 { "" } else { "s" }
        ));
    } else if state["indirect"].is_object() {
        lines.push(format!(
            "  {}, counts read from {} at byte {} (indirect)",
            state["mode"].as_str().unwrap_or(""),
            named("buffer", &state["indirect"]["buffer"]),
            state["indirect"]["offset"]
        ));
    } else {
        lines.push(format!(
            "  {} × {}{}{}",
            state["mode"].as_str().unwrap_or(""),
            state["count"],
            match state["indexBuffer"].as_object() {
                Some(index) => format!(
                    ", indexed ({} from {} at byte {}), from index {}, base vertex {}",
                    index["format"].as_str().unwrap_or(""),
                    named("buffer", &index["buffer"]),
                    index["offset"],
                    state["first"],
                    state["baseVertex"]
                ),
                None => format!(", from vertex {}", state["first"]),
            },
            if state["instances"].as_i64().unwrap_or(1) != 1 { format!(", {} instances", state["instances"]) } else { String::new() }
        ));
    }

    let pipeline = named("pipeline", &state["pipeline"]);

    lines.push(format!("  pipeline {pipeline}{}", about(&pipeline)));

    for (slot, group) in state["bindGroups"].as_array().into_iter().flatten().enumerate() {
        if group.is_null() {
            continue;
        }

        let name = named("bind_group", group);

        lines.push(format!("  bind group {slot}: {name}{}", about(&name)));

        let detail = host
            .store
            .query(handle, "SELECT detail FROM objects WHERE handle = ?1", &[Sql::Text(name.clone())], 1)
            .ok()
            .and_then(|rows| rows.rows.first().and_then(|row| serde_json::from_str::<Value>(row[0].as_str().unwrap_or("")).ok()))
            .unwrap_or(Value::Null);

        for entry in detail["descriptor"]["entries"].as_array().into_iter().flatten() {
            let resource = &entry["resource"];

            let what = match resource["ref"].as_str() {
                Some("texture") => {
                    let texture = named("texture", &resource["id"]);

                    format!("a view of {texture}{}", about(&texture))
                }
                Some("sampler") => named("sampler", &resource["id"]),
                Some(_) => named(resource["ref"].as_str().unwrap_or(""), &resource["id"]),
                // A buffer binding: { buffer, offset, size }.
                None if resource["buffer"]["ref"] == "buffer" => {
                    let buffer = named("buffer", &resource["buffer"]["id"]);

                    format!(
                        "{buffer}{}{}{}",
                        if resource["offset"].as_u64().unwrap_or(0) > 0 { format!(" from byte {}", resource["offset"]) } else { String::new() },
                        if resource["size"].is_number() { format!(", {} bytes", resource["size"]) } else { String::new() },
                        about(&buffer)
                    )
                }
                None => "something a capture cannot hold".to_string(),
            };

            lines.push(format!("    binding {}: {what}", entry["binding"]));
        }
    }

    for buffer in state["vertexBuffers"].as_array().into_iter().flatten() {
        lines.push(format!("  vertex buffer {}: {} from byte {}", buffer["slot"], named("buffer", &buffer["buffer"]), buffer["offset"]));
    }

    if state["kind"] != "dispatch" && !state["bindGroups"].as_array().is_none_or(Vec::is_empty) {
        lines.push("  Uniform values are bytes in the buffers bound above. resource(handle: \"buf_N\") reads a live buffer; WGSL reflection is not built, so they are not named here.".into());
    }

    lines
}

/// Why an event changed nothing: it is replayed with each test that is on switched off in
/// turn, and whichever then lets it change pixels is what rejected it.
async fn unchanged(host: &Arc<Host>, session: &Arc<Session>, handle: &str, index: i64, state: &Value) -> String {
    let start = "  Effect: it changed no pixels of its target (gpu-measured).";

    if state["kind"] != "draw" {
        return format!("{start} It wrote what was already there, or the scissor box or colour mask kept it out.");
    }

    let Ok(tried) = session.replay("why", &json!({ "key": handle, "draw": index }), LONG).await else {
        return format!("{start} Every fragment was rejected, clipped or wrote what was already there.");
    };

    if tried["unsupported"] == true {
        return format!(
            "{start} Every fragment was rejected, clipped or wrote what was already there. Which test rejected it is not worked out for WebGPU yet: the tests are part of the pipeline (cull mode, depth compare, stencil), listed above."
        );
    }

    let mut causes = Vec::new();

    for attempt in tried["tried"].as_array().into_iter().flatten() {
        let changed = attempt["changed"].as_i64().unwrap_or(0);

        if changed == 0 {
            continue;
        }

        causes.push(match attempt["what"].as_str().unwrap_or("") {
            "cull" => format!(
                "With face culling off it changes {changed} pixels: every triangle is culled (cull {}, front face {}). The triangles face away from the viewer: the winding order, or a negative scale or size flipping them.",
                gl_name(&state["cull"]),
                gl_name(&state["frontFace"])
            ),
            "depth" => format!(
                "With the depth test off it changes {changed} pixels: every fragment fails the depth test ({}).{}",
                gl_name(&state["depth"]["func"]),
                last_depth_clear(host, handle, index, state).unwrap_or_default()
            ),
            "scissor" => format!("With the scissor test off it changes {changed} pixels: it falls outside the scissor box ({}).", list(&state["scissor"])),
            "stencil" => format!("With the stencil test off it changes {changed} pixels: every fragment fails the stencil test."),
            "blend" => format!("With blending off it changes {changed} pixels: it is drawn, but the blend leaves the target as it was (a source alpha of 0, or factors that cancel)."),
            "color_mask" => format!("With every colour channel writable it changes {changed} pixels: the colour mask ({}) keeps it out.", list(&state["colorMask"])),
            "rasterizer_discard" => format!("With RASTERIZER_DISCARD off it changes {changed} pixels: rasterisation is switched off for this draw."),
            "viewport" => format!(
                "With the viewport set to the whole target it changes {changed} pixels: the viewport ({}) puts it somewhere it cannot be seen.",
                list(&state["viewport"])
            ),
            other => format!("With {other} off it changes {changed} pixels."),
        });
    }

    if causes.is_empty() {
        let together = tried["together"].as_i64().unwrap_or(0);

        causes.push(if together > 0 {
            format!("No single test explains it, but with every test that is on switched off together it changes {together} pixels: more than one of them rejects it.")
        } else {
            "It changes nothing even with culling, the depth, scissor and stencil tests and blending all off and the viewport set to the whole target. So the geometry is off the target or has no area (check the vertex data and the uniforms that place it), the shader discards every fragment, or it writes exactly what was already there.".to_string()
        });
    }

    format!("{start}\n  Why: {}", causes.join("\n       "))
}

/// The value the depth buffer of a draw's target was last cleared to, when the frame did so.
fn last_depth_clear(host: &Host, handle: &str, index: i64, state: &Value) -> Option<String> {
    let rows = host
        .store
        .query(
            handle,
            "SELECT draw, state FROM draws WHERE kind = 'clear' AND draw < ?1 AND target = ?2 ORDER BY draw DESC",
            &[Sql::Integer(index), Sql::Text(state["targetName"].as_str()?.to_string())],
            20,
        )
        .ok()?;

    for row in &rows.rows {
        let clear: Value = serde_json::from_str(row[1].as_str()?).ok()?;

        if clear["mask"].as_u64().unwrap_or(0) & 0x100 != 0 {
            let depth = clear["clearDepth"].as_f64().unwrap_or(1.0);
            let hopeless = match state["depth"]["func"].as_u64() {
                Some(0x0201) => depth <= 0.0,
                Some(0x0204) => depth >= 1.0,
                _ => false,
            };

            return Some(format!(
                " The depth buffer was last cleared to {depth} by event {}{}",
                row[0],
                if hopeless { ", and nothing can pass that test against that value: the clear depth is wrong for this depth function." } else { "." }
            ));
        }
    }

    Some(" Nothing in the frame clears this target's depth buffer before it.".to_string())
}

/// Where a draw's inputs came from: for each uniform of its program, and for each texture
/// unit, the call that last set it before the draw and the event that call was leading up to.
fn history(host: &Host, handle: &str, state: &Value) -> Option<(HashMap<String, (i64, i64)>, HashMap<i64, (i64, i64)>)> {
    let stream = host.store.stream(handle).ok()?;
    let methods: Vec<&str> = stream["methods"].as_array()?.iter().map(|name| name.as_str().unwrap_or("")).collect();
    let program = state["program"].as_i64();
    let end = state["command"].as_u64()? as usize;
    let events: Vec<i64> = stream["draws"].as_array()?.iter().map(|row| row["command"].as_i64().unwrap_or(-1)).collect();
    let leads_to = |index: usize| events.partition_point(|event_command| *event_command < index as i64) as i64;
    let mut uniforms = HashMap::new();
    let mut units = HashMap::new();
    let mut active = stream["initial"]["unit"].as_i64().unwrap_or(0);

    // In a frame taken from a recording, what earlier frames set counts as carried over.
    let own = stream["header"]["firstCommand"].as_u64().unwrap_or(0) as usize;

    for (index, command) in stream["commands"].as_array()?.iter().enumerate().take(end) {
        let method = command[0].as_u64().and_then(|id| methods.get(id as usize)).copied().unwrap_or("");
        let first = &command[1][0];

        match method {
            "gl.activeTexture" => active = first.as_i64().unwrap_or(0x84C0) - 0x84C0,
            _ if index < own => {}
            "gl.bindTexture" => {
                units.insert(active, (index as i64, leads_to(index)));
            }
            _ if method.starts_with("gl.uniform") && program.is_some() && first["u"].as_i64() == program => {
                if let Some(name) = first["n"].as_str() {
                    uniforms.insert(name.to_string(), (index as i64, leads_to(index)));
                }
            }
            _ => {}
        }
    }

    Some((uniforms, units))
}

pub(crate) fn flatten(prefix: &str, value: &Value, out: &mut std::collections::BTreeMap<String, String>) {
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
    let (handle, meta) = the_capture(host, params)?;
    let handle_text = about(host, params, &handle, &meta);

    if !params["a"].is_i64() || !params["b"].is_i64() {
        bail!("draw_diff needs a and b: the numbers of two events in the capture.");
    }

    let (mut a, mut b) = (std::collections::BTreeMap::new(), std::collections::BTreeMap::new());

    flatten("", &draw_state(host, &handle, &params["a"])?, &mut a);
    flatten("", &draw_state(host, &handle, &params["b"])?, &mut b);

    let ignored = ["command", "pass", "pixelsChanged", "changedBox"];
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
        format!("{handle_text}: events {} and {} have the same state, bindings and uniforms.", params["a"], params["b"])
    } else {
        format!("{handle_text}: events {} and {} differ in {} value{}.", params["a"], params["b"], rows.len(), if rows.len() == 1 { "" } else { "s" })
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
    let (handle, meta) = the_capture(host, params)?;
    let sql = params["sql"].as_str().ok_or_else(|| anyhow!("query needs sql: one SELECT statement. help(topic: \"sql\") lists the tables."))?;
    let limit = params["limit"].as_u64().unwrap_or(50).clamp(1, 500) as usize;
    let rows = host.store.query(&handle, sql, &[], limit).map_err(|error| anyhow!("{error}.\n{}", schema(host, &handle)))?;

    let hint = (rows.rows.is_empty() && sql.to_lowercase().contains("method") && !sql.contains("gl.") && !sql.contains('%')).then_some(
        "\nNo rows. Method names carry their owner, as in 'gl.bindTexture' or 'ext.drawBuffersWEBGL'; or match loosely: method like '%bindTexture%'.",
    );

    let mut lines = vec![format!(
        "{}: {} row{}{}. Columns: {}{}",
        about(host, params, &handle, &meta),
        rows.rows.len(),
        if rows.rows.len() == 1 { "" } else { "s" },
        if rows.truncated { format!(" (the first {limit}; add LIMIT and OFFSET, or pass limit up to 500)") } else { String::new() },
        rows.columns.join(" | "),
        hint.unwrap_or("")
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

/// The capture's tables and their columns, for a query that named one wrongly.
fn schema(host: &Host, handle: &str) -> String {
    let found = host.store.query(
        handle,
        "SELECT m.name, group_concat(p.name, ', ') FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = 'table' GROUP BY m.name ORDER BY m.name",
        &[],
        40,
    );

    match found {
        Ok(tables) if !tables.rows.is_empty() => format!(
            "The tables and their columns:\n{}",
            tables.rows.iter().map(|row| format!("  {}: {}", row[0].as_str().unwrap_or(""), row[1].as_str().unwrap_or(""))).collect::<Vec<_>>().join("\n")
        ),
        _ => "Tables: draws, passes, objects, commands, uniforms, bindings, attributes, capture. help(topic: \"sql\") lists their columns.".to_string(),
    }
}

// ---- What the frame did: answered by replay ----

/// The target a looking command means: the canvas, or a texture the frame drew to.
pub(crate) fn target_of(host: &Host, handle: &str, params: &Value) -> Result<(Value, String)> {
    match params["target"].as_str() {
        None | Some("canvas") => Ok((Value::Null, "the canvas".into())),
        Some(name) => {
            let rows = host.store.query(handle, "SELECT id FROM objects WHERE handle = ?1 AND kind = 'texture'", &[Sql::Text(name.to_string())], 1)?;

            // A framebuffer whose colour is a renderbuffer has no texture to name: it is named itself.
            let framebuffer =
                host.store.query(handle, "SELECT id FROM objects WHERE handle = ?1 AND kind = 'framebuffer'", &[Sql::Text(name.to_string())], 1)?;

            if let Some(row) = framebuffer.rows.first() {
                return Ok((json!({ "framebuffer": row[0] }), name.to_string()));
            }

            match rows.rows.first() {
                Some(row) => Ok((json!({ "texture": row[0], "level": params["level"].as_u64().unwrap_or(0) }), name.to_string())),
                None => {
                    let targets = host.store.query(handle, "SELECT DISTINCT target FROM draws", &[], 20)?;
                    let known: Vec<&str> = targets.rows.iter().filter_map(|row| row[0].as_str()).collect();

                    bail!("\"{name}\" is not a texture or a framebuffer in {handle}. Targets the frame drew to: {}.", known.join(", "))
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
            "{} pixel ({x}, {y}) of {target_name}: its final value {} was produced by event {}. gpu-measured.",
            about(host, params, &handle, &meta),
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

        lines.push("Events that covered the pixel without changing its value (rejected by a test, or writing the same colour) are not listed. draw_list shows the box each event changed; draw(draw: n) says why one changed nothing.".into());
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
