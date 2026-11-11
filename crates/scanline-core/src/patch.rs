//! Live patches (04-AGENT-INTERFACE.md, section 3.7): changing how a running page draws
//! without touching its code, to test an idea before making the change in source.
//!
//! Every patch has a handle, says in plain words what it changes, and is undone with
//! `patches(revert)`. Patches live in the page: a reload removes them.

use std::sync::Arc;
use std::time::Duration;

use anyhow::{Result, anyhow, bail};
use serde_json::{Value, json};

use crate::commands::{SHORT, choose_context, number, page_text, step};
use crate::result;
use crate::session::{ContextRef, Session};

/// An object named by handle, as the number the page's probe knows it by.
fn id_of(session: &Session, context: &ContextRef, handle: &str, kind: &str) -> Result<i64> {
    let object = session.object(handle)?;

    if object.kind != kind {
        bail!("{handle} is a {}, and a {kind} is needed here.", object.kind.replace('_', " "));
    }

    if object.instance != context.instance {
        bail!("{handle} belongs to another frame or worker than {}.", context.handle);
    }

    Ok(object.id)
}

/// Which draws a patch applies to: by the program they use, a texture they have bound, or
/// their place among the frame's draw calls.
fn filter_of(session: &Session, context: &ContextRef, given: &Value) -> Result<Value> {
    let mut filter = json!({});

    // A WebGPU draw's shader and state are its pipeline's, so a pipeline is what is named there.
    if context.api == "webgpu" {
        if let Some(pipeline) = given["pipeline"].as_str().or(given["program"].as_str()) {
            filter["pipeline"] = json!(id_of(session, context, pipeline, "pipeline")?);
        }

        for key in given.as_object().into_iter().flatten().map(|entry| entry.0) {
            if !["pipeline", "program"].contains(&key.as_str()) {
                bail!("On WebGPU a filter names a pipeline ({{\"pipeline\": \"pip_2\"}}), or is left out to mean every draw. There is no \"{key}\" here yet.");
            }
        }

        return Ok(filter);
    }

    if let Some(program) = given["program"].as_str() {
        filter["program"] = json!(id_of(session, context, program, "program")?);
    }

    if let Some(texture) = given["texture"].as_str() {
        filter["texture"] = json!(id_of(session, context, texture, "texture")?);
    }

    if !given["draws"].is_null() {
        if !(given["draws"].is_u64() || given["draws"].as_array().is_some_and(|range| range.len() == 2 && range.iter().all(Value::is_u64))) {
            bail!("filter.draws is one event number, or [first, last]: the frame's events as draw_list numbers them.");
        }

        filter["draws"] = given["draws"].clone();
    }

    for key in given.as_object().into_iter().flatten().map(|entry| entry.0) {
        if !["program", "texture", "draws"].contains(&key.as_str()) {
            bail!(
                "A filter may name program (\"prg_1\"), texture (\"tex_2\") and draws (an event number as in draw_list, or [first, last]). There is no \"{key}\"."
            );
        }
    }

    Ok(filter)
}

/// Sends a patch to the page and remembers its handle.
async fn add(session: &Arc<Session>, context: &ContextRef, mut args: Value) -> Result<(String, Value)> {
    args["context"] = json!(context.local);

    let made = session.probe(&context.instance, "patch.add", args, SHORT).await?;
    let id = made["patch"].as_i64().unwrap_or(0);
    let handle = if context.instance.tag == 0 { format!("pat_{id}") } else { format!("pat_{id}_w{}", context.instance.tag) };

    session.state.lock().unwrap().patches.insert(handle.clone(), (context.instance.clone(), id));

    Ok((handle, made))
}

/// What a patch's description says, with the page's numbers turned back into handles.
fn said(session: &Session, context: &ContextRef, text: &str) -> String {
    let mut out = text.to_string();

    for (kind, word) in [("program", "program "), ("texture", "texture "), ("pipeline", "pipeline "), ("shader", "shader ")] {
        let mut from = 0;

        while let Some(at) = out[from..].find(word) {
            let start = from + at + word.len();
            let digits: String = out[start..].chars().take_while(char::is_ascii_digit).collect();

            if let Ok(id) = digits.parse::<i64>() {
                let handle = session.object_handle(&context.instance, kind, id);

                out.replace_range(from + at..start + digits.len(), &handle);
                from = from + at + handle.len();
            } else {
                from = start;
            }
        }
    }

    out
}

fn done(session: &Session, context: &ContextRef, handle: &str, made: &Value, more: Vec<String>) -> Value {
    let description = said(session, context, made["description"].as_str().unwrap_or(""));
    let mut lines = vec![format!("{handle}: {description}.")];

    lines.extend(more);
    lines.push(format!("It holds from the next draw. Look with step and screenshot; patches(revert: \"{handle}\") undoes it. A reload removes every patch."));

    result(lines.join("\n"), json!({ "patch": handle, "description": description, "log": made["log"] }))
}

pub async fn patch_draws(session: &Arc<Session>, params: &Value) -> Result<Value> {
    let context = choose_context(session, params).await?;
    let mode = params["mode"].as_str().unwrap_or("skip");

    if !["skip", "isolate"].contains(&mode) {
        bail!("mode is skip (the matching draws are not drawn) or isolate (only they are), not \"{mode}\".");
    }

    let filter = filter_of(session, &context, &params["filter"])?;

    if mode == "skip" && filter.as_object().is_some_and(|filter| filter.is_empty()) {
        bail!("patch_draws needs a filter: which draws to skip. For example filter: {{\"program\": \"prg_2\"}} or {{\"draws\": [6, 8]}}.");
    }

    let (handle, made) = add(session, &context, json!({ "kind": "draws", "mode": mode, "filter": filter })).await?;

    Ok(done(session, &context, &handle, &made, Vec::new()))
}

pub async fn patch_state(session: &Arc<Session>, params: &Value) -> Result<Value> {
    let context = choose_context(session, params).await?;
    let filter = filter_of(session, &context, &params["filter"])?;

    if !params["state"].is_object() {
        bail!(
            "patch_state needs state: any of blend, depth_test, depth_write, cull (true or false), color_mask ([r, g, b, a]) and scissor ([x, y, w, h] or false)."
        );
    }

    for key in params["state"].as_object().into_iter().flatten().map(|entry| entry.0) {
        if !["blend", "depth_test", "depth_write", "cull", "color_mask", "scissor"].contains(&key.as_str()) {
            bail!("There is no \"{key}\" to patch. state takes blend, depth_test, depth_write, cull, color_mask and scissor.");
        }
    }

    let (handle, made) = add(session, &context, json!({ "kind": "state", "state": params["state"], "filter": filter })).await?;

    Ok(done(session, &context, &handle, &made, Vec::new()))
}

pub async fn patch_uniform(session: &Arc<Session>, params: &Value) -> Result<Value> {
    let context = choose_context(session, params).await?;
    let target = params["target"].as_str().ok_or_else(|| anyhow!("patch_uniform needs target: the program, such as \"prg_1\"."))?;
    let name = params["name"].as_str().ok_or_else(|| anyhow!("patch_uniform needs name: the uniform's name in the shader."))?;
    let value: Vec<Value> = match &params["value"] {
        Value::Array(values) if !values.is_empty() && values.iter().all(Value::is_number) => values.clone(),
        value if value.is_number() => vec![value.clone()],
        Value::Bool(flag) => vec![json!(*flag as i64)],
        _ => bail!("patch_uniform needs value: a number, or a list of numbers as long as the uniform has components (4 for a vec4, 16 for a mat4)."),
    };

    if context.api == "webgpu" {
        bail!(
            "patch_uniform is for WebGL. A WebGPU shader's inputs live in buffers, and overriding one by name needs WGSL reflection, which is not built. patch_shader can replace the value in the shader's source: edit the expression that reads it."
        );
    }

    let program = id_of(session, &context, target, "program")?;
    let (handle, made) = add(session, &context, json!({ "kind": "uniform", "program": program, "name": name, "value": value })).await?;

    Ok(done(session, &context, &handle, &made, vec!["Whatever the page sets this uniform to, it is set straight back.".to_string()]))
}

pub async fn patch_shader(session: &Arc<Session>, params: &Value) -> Result<Value> {
    let context = choose_context(session, params).await?;
    let target = params["handle"]
        .as_str()
        .ok_or_else(|| anyhow!("patch_shader needs handle: the program whose shader to change, such as \"prg_1\" (WebGL), or a pipeline or shader module, \"pip_2\" or \"shd_3\" (WebGPU)."))?;
    let webgpu = context.api == "webgpu";
    let mut args = json!({ "kind": "shader" });

    if webgpu {
        // A pipeline: its fragment module, or its vertex module if stage says so, for that
        // pipeline alone. A module: every pipeline that uses it.
        match session.object(target)?.kind {
            "pipeline" => {
                args["pipeline"] = json!(id_of(session, &context, target, "pipeline")?);
                args["stage"] = json!(params["stage"].as_str().unwrap_or("fragment"));
            }
            "shader" => args["module"] = json!(id_of(session, &context, target, "shader")?),
            other => bail!("{target} is a {}. On WebGPU patch_shader takes a pipeline (pip_2) or a shader module (shd_3).", other.replace('_', " ")),
        }

        if !params["defines"].is_null() {
            bail!("defines are for GLSL. WGSL has no #define: use edits, for example [{{\"find\": \"SAMPLES = 64\", \"replace\": \"SAMPLES = 24\"}}].");
        }
    } else {
        args["program"] = json!(id_of(session, &context, target, "program")?);

        if let Some(shader) = params["shader"].as_str() {
            args["shader"] = json!(id_of(session, &context, shader, "shader")?);
        }
    }

    let mut given = 0;

    for key in ["source", "edits", "defines"] {
        if !params[key].is_null() {
            args[key] = params[key].clone();
            given += 1;
        }
    }

    if given == 0 {
        bail!(
            "patch_shader needs one of: edits ([{{\"find\": \"64\", \"replace\": \"24\"}}]), defines ({{\"SAMPLES\": 24}}), or source (the whole new shader). It changes the fragment shader unless shader names another."
        );
    }

    let (handle, made) = add(session, &context, args).await?;
    let log = made["log"].as_str().unwrap_or("").trim();

    Ok(done(
        session,
        &context,
        &handle,
        &made,
        vec![
            if log.is_empty() {
                if webgpu {
                    "It compiled, and the pipelines rebuilt with it are valid.".to_string()
                } else {
                    "It compiled and linked with no messages.".to_string()
                }
            } else {
                format!("It compiled{}. The compiler said: «{}»", if webgpu { "" } else { " and linked" }, page_text(log, 600))
            },
            if webgpu {
                "The page's own pipeline and module are untouched: a pipeline rebuilt with the edited module is swapped in for each of its draws, with bind groups remade for it where its layout is its own.".to_string()
            } else {
                "The page's own program is untouched: a rebuilt copy is used for its draws, with every uniform the page sets passed on to it.".to_string()
            },
        ],
    ))
}

pub async fn patch_texture(session: &Arc<Session>, params: &Value) -> Result<Value> {
    let context = choose_context(session, params).await?;
    let target = params["handle"].as_str().ok_or_else(|| anyhow!("patch_texture needs handle: the texture to stand in for, such as \"tex_3\"."))?;
    let with = params["with"].as_str().unwrap_or("checker");

    if !["checker", "white", "black", "mips"].contains(&with) {
        bail!("with is checker, white, black or mips (each mip level a different colour), not \"{with}\".");
    }

    let texture = id_of(session, &context, target, "texture")?;
    let filter = filter_of(session, &context, &params["filter"])?;
    let (handle, made) = add(session, &context, json!({ "kind": "texture", "texture": texture, "with": with, "filter": filter })).await?;

    Ok(done(session, &context, &handle, &made, Vec::new()))
}

/// The patches in force, each with what it changes; or, with revert, one or all undone.
pub async fn patches(session: &Arc<Session>, params: &Value) -> Result<Value> {
    if let Some(which) = params["revert"].as_str() {
        if which == "all" {
            let replies = session.probe_all("patch.remove", json!({ "all": true }), SHORT).await;
            let removed: u64 = replies.iter().map(|(_, reply)| reply["removed"].as_u64().unwrap_or(0)).sum();

            session.state.lock().unwrap().patches.clear();

            return Ok(result(
                format!("{removed} patch{} undone. The page draws as its own code says.", if removed == 1 { "" } else { "es" }),
                json!({ "reverted": removed }),
            ));
        }

        let Some((instance, id)) = session.state.lock().unwrap().patches.remove(which) else {
            bail!("There is no patch \"{which}\". patches() lists the ones in force.");
        };

        let reply = session.probe(&instance, "patch.remove", json!({ "patch": id }), SHORT).await?;

        return Ok(result(
            if reply["removed"].as_u64().unwrap_or(0) > 0 {
                format!("{which} undone.")
            } else {
                format!("{which} was already gone: the page has reloaded since it was made.")
            },
            json!({ "reverted": reply["removed"] }),
        ));
    }

    let known: Vec<(String, (crate::session::Instance, i64))> =
        session.state.lock().unwrap().patches.iter().map(|(handle, entry)| (handle.clone(), entry.clone())).collect();
    let replies = session.probe_all("patch.list", json!({}), SHORT).await;
    let mut lines = Vec::new();
    let mut rows = Vec::new();
    let mut failure: Option<String> = None;

    for (instance, reply) in &replies {
        for patch in reply["patches"].as_array().into_iter().flatten() {
            if let Some(why) = patch["failure"].as_str() {
                failure = Some(why.to_string());
            }

            let Some((handle, _)) = known.iter().find(|(_, entry)| entry.0 == *instance && Some(entry.1) == patch["patch"].as_i64()) else { continue };
            let context = ContextRef { handle: String::new(), instance: instance.clone(), local: 0, api: String::new() };
            let description = said(session, &context, patch["description"].as_str().unwrap_or(""));

            lines.push(format!(
                "  {handle}  {description}{}",
                match (patch["kind"].as_str(), patch["draws"].as_u64().unwrap_or(0)) {
                    (Some("uniform"), _) => String::new(),
                    (_, 0) => "  (matched no draws in the last frame)".to_string(),
                    (_, draws) => format!("  ({draws} draw{} a frame)", if draws == 1 { "" } else { "s" }),
                }
            ));
            rows.push(json!({ "patch": handle, "kind": patch["kind"], "description": description, "draws": patch["draws"] }));
        }
    }

    // Handles whose patches went with a reload.
    session.state.lock().unwrap().patches.retain(|handle, _| rows.iter().any(|row| row["patch"] == handle.as_str()));

    let mut summary = if rows.is_empty() {
        "No patches are in force: the page draws as its own code says.".to_string()
    } else {
        format!(
            "{} patch{} in force. Each line is the change to make in the page's source if it is the fix:\n{}\npatches(revert: \"pat_N\") undoes one; revert: \"all\" undoes every one.",
            rows.len(),
            if rows.len() == 1 { "" } else { "es" },
            lines.join("\n")
        )
    };

    // A draw the patches could not be applied to was issued as the page made it.
    if let Some(why) = &failure {
        summary.push_str(&format!("\nNOT APPLIED to at least one draw, which was drawn unpatched: {}.", page_text(why, 300)));
    }

    Ok(result(summary, json!({ "patches": rows, "not_applied": failure })))
}

/// GPU and CPU time a frame, the mean over the frames just stepped.
async fn measure(session: &Arc<Session>, context: &ContextRef, frames: u64) -> Result<(Option<f64>, f64)> {
    // A few frames first, so that what is measured is the steady state.
    step(session, &json!({ "frames": 8 })).await?;
    step(session, &json!({ "frames": frames })).await?;

    // GPU timings come back a few frames late.
    tokio::time::sleep(Duration::from_millis(120)).await;

    let figures = session.probe(&context.instance, "stats", json!({ "frames": frames }), SHORT).await?;

    let gpu = if figures["gpu"]["frames"].as_u64().unwrap_or(0) > 0 { figures["gpu"]["ms"]["mean"].as_f64() } else { None };

    Ok((gpu, figures["cpuMs"]["mean"].as_f64().unwrap_or(0.0)))
}

/// Tries a change for a number of frames, measures the frame with and without it, and
/// takes the change away again.
pub async fn experiment(session: &Arc<Session>, params: &Value) -> Result<Value> {
    let context = choose_context(session, params).await?;
    let kind = params["kind"]
        .as_str()
        .ok_or_else(|| anyhow!("experiment needs kind: scissor_1px (is the cost in filling pixels?) or skip with a filter (what do these draws cost?)."))?;
    let frames = params["frames"].as_u64().unwrap_or(60).clamp(10, 600);

    let (patch, what, meaning) = match kind {
        "scissor_1px" => (
            json!({ "kind": "state", "state": { "scissor": [0, 0, 1, 1] }, "filter": {} }),
            "every draw clipped to a single pixel".to_string(),
            "Clipped to one pixel, the draws are still issued and their vertices still processed, but almost nothing is filled. What time is left is the cost of issuing the draws and of their vertices; what went was the cost of filling pixels (fragment shading, blending, overdraw).",
        ),
        "skip" => {
            let filter = filter_of(session, &context, &params["filter"])?;

            if filter.as_object().is_some_and(|filter| filter.is_empty()) {
                bail!("experiment(kind: \"skip\") needs a filter: which draws to leave out.");
            }

            (
                json!({ "kind": "draws", "mode": "skip", "filter": filter }),
                "the matching draws left out".to_string(),
                "What went is what those draws cost, all of it: issuing them, their vertices and their pixels.",
            )
        }
        other => bail!("There is no \"{other}\" experiment. Kinds are scissor_1px and skip (with a filter)."),
    };

    let before = measure(session, &context, frames).await?;
    let (handle, made) = add(session, &context, patch).await?;
    let during = measure(session, &context, frames).await;

    // Whatever happened, the page goes back to drawing as it did.
    let made_here = session.state.lock().unwrap().patches.remove(&handle);

    if let Some((instance, id)) = made_here {
        let _ = session.probe(&instance, "patch.remove", json!({ "patch": id }), SHORT).await;
    }

    // One more frame, so that the canvas shows the page's own drawing again and not the
    // last frame of the experiment.
    let _ = step(session, &json!({ "frames": 1 })).await;

    let during = during?;
    let description = said(session, &context, made["description"].as_str().unwrap_or(""));
    let mut lines = vec![format!("Tried for {frames} frames: {what} ({description}). The page is back as it was.")];

    match (before.0, during.0) {
        (Some(without), Some(with)) => {
            lines.push(format!(
                "GPU time a frame: {} ms without the change, {} ms with it{}.",
                number(&json!(without), 3),
                number(&json!(with), 3),
                if without > 0.0 {
                    format!(" ({:.0}% {})", ((with - without) / without * 100.0).abs(), if with < without { "less" } else { "more" })
                } else {
                    String::new()
                }
            ));
        }
        _ => lines.push("GPU time could not be measured: the browser gave no timer queries for this context.".into()),
    }

    lines.push(format!("CPU time in the page's frame callbacks: {} ms without, {} ms with.", number(&json!(before.1), 3), number(&json!(during.1), 3)));
    lines.push(meaning.to_string());
    lines.push("Frames this light are near the limit of what the timer can tell apart: trust a large difference, not a small one.".into());

    Ok(result(
        lines.join("\n"),
        json!({
            "kind": kind,
            "frames": frames,
            "gpu_ms": { "without": before.0, "with": during.0 },
            "cpu_ms": { "without": before.1, "with": during.1 },
            "provenance": "gpu-measured",
        }),
    ))
}
