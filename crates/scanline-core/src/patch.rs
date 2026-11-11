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
    } else if let Some(program) = given["program"].as_str() {
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
        if context.api == "webgpu" && !["pipeline", "program", "texture", "draws"].contains(&key.as_str()) {
            bail!(
                "On WebGPU a filter may name pipeline (\"pip_2\"), texture (\"tex_2\": draws with it in a bind group) and draws (an event number as in draw_list, or [first, last]). There is no \"{key}\"."
            );
        }

        if context.api != "webgpu" && !["program", "texture", "draws"].contains(&key.as_str()) {
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

/// Makes a patch, and remembers how if it was asked to outlast a reload.
pub async fn apply(session: &Arc<Session>, method: &str, params: &Value) -> Result<Value> {
    let mut value = make(session, method, params).await?;

    if params["keep"] == true {
        let handle = value["data"]["patch"].as_str().unwrap_or("").to_string();
        let mut kept = params.clone();

        // The session is this one; it is not part of what to do again.
        if let Some(object) = kept.as_object_mut() {
            object.remove("session");
        }

        session.state.lock().unwrap().kept_patches.push((method.to_string(), kept, handle));

        let summary = value["summary"].as_str().unwrap_or("").replace(
            "A reload removes every patch.",
            "It is kept: after navigate(reload: true) or replay_run it is made again, as long as the page creates its objects in the same order, so that the handles mean the same things.",
        );

        value["summary"] = json!(summary);
        value["data"]["kept"] = json!(true);
    }

    Ok(value)
}

async fn make(session: &Arc<Session>, method: &str, params: &Value) -> Result<Value> {
    match method {
        "patch_draws" => patch_draws(session, params).await,
        "patch_state" => patch_state(session, params).await,
        "patch_uniform" => patch_uniform(session, params).await,
        "patch_shader" => patch_shader(session, params).await,
        "patch_texture" => patch_texture(session, params).await,
        other => bail!("{other} does not make a patch."),
    }
}

/// After a reload: makes the kept patches again in the new page. The page may still be
/// building what they name (a program linked a moment after load), so each is tried for a
/// short while. Returns what to tell whoever asked for the reload, if anything was kept.
pub async fn reapply(session: &Arc<Session>) -> Option<String> {
    let kept: Vec<(String, Value, String)> = session.state.lock().unwrap().kept_patches.clone();

    if kept.is_empty() {
        return None;
    }

    {
        let mut state = session.state.lock().unwrap();
        let live = state.instances.clone();

        // Handles of the page that has gone would be refused as stale. The same handles
        // name the new page's objects, if it makes them in the same order.
        state.objects.retain(|_, instance| live.contains(instance));
        state.patches.clear();
    }

    let mut again = Vec::new();
    let mut made = Vec::new();
    let mut failed = Vec::new();

    for (method, params, was) in kept {
        let give_up = tokio::time::Instant::now() + Duration::from_millis(2000);
        let outcome = loop {
            match make(session, &method, &params).await {
                Ok(value) => break Ok(value),
                Err(error) if tokio::time::Instant::now() >= give_up => break Err(error),
                Err(_) => tokio::time::sleep(Duration::from_millis(100)).await,
            }
        };

        match outcome {
            Ok(value) => {
                let handle = value["data"]["patch"].as_str().unwrap_or("").to_string();

                made.push(format!("{handle} ({})", value["data"]["description"].as_str().unwrap_or("")));
                again.push((method, params, handle));
            }
            Err(error) => {
                failed.push(format!("{} that was {was}: {}", method, page_text(&format!("{error:#}"), 240)));
                again.push((method, params, String::new()));
            }
        }
    }

    session.state.lock().unwrap().kept_patches = again;

    let mut lines = Vec::new();

    if !made.is_empty() {
        lines.push(format!("Kept patch{} made again in the new page: {}.", if made.len() == 1 { "" } else { "es" }, made.join("; ")));
    }

    if !failed.is_empty() {
        lines.push(format!(
            "NOT made again ({}): {}. The page may not have created what it names yet: patches(again: true) tries once more; patches(revert: \"all\") forgets them.",
            failed.len(),
            failed.join("; ")
        ));
    }

    Some(lines.join("\n"))
}

pub async fn patch_draws(session: &Arc<Session>, params: &Value) -> Result<Value> {
    let context = choose_context(session, params).await?;
    let mode = params["mode"].as_str().unwrap_or("skip");

    if !["skip", "isolate", "solid"].contains(&mode) {
        bail!("mode is skip (the matching draws are not drawn), isolate (only they are) or solid (they are drawn in one flat colour), not \"{mode}\".");
    }

    let filter = filter_of(session, &context, &params["filter"])?;

    if mode == "solid" {
        let colour = match &params["colour"] {
            Value::Null => Value::Null,
            Value::Array(parts) if (3..=4).contains(&parts.len()) && parts.iter().all(Value::is_number) => params["colour"].clone(),
            _ => bail!("colour is [r, g, b] or [r, g, b, a], each from 0 to 1. Left out: magenta."),
        };
        let (handle, made) = add(session, &context, json!({ "kind": "draws", "mode": "solid", "colour": colour, "filter": filter })).await?;

        return Ok(done(
            session,
            &context,
            &handle,
            &made,
            vec!["The shape, the tests and what the shader discards are the page's own; only the colour written is replaced. A draw that still does not show is not reaching the target: geometry and pixel_history on a capture say why.".to_string()],
        ));
    }

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
        // A WebGPU uniform is bytes in a buffer. The name says which bytes of which binding;
        // each draw of the pipeline says which buffer.
        let pipeline = id_of(session, &context, target, "pipeline")
            .map_err(|error| anyhow!("{error} On WebGPU patch_uniform takes the pipeline whose shaders declare the uniform, such as \"pip_2\"."))?;
        let (handle, made) = add(session, &context, json!({ "kind": "uniform", "pipeline": pipeline, "name": name, "value": value })).await?;

        return Ok(done(
            session,
            &context,
            &handle,
            &made,
            vec![
                "It is written into the buffer each of that pipeline's draws reads it from, and written again whenever the page writes that buffer. Every draw that reads the same bytes sees the value, whatever its pipeline: a buffer shared by the whole frame (a camera) changes for the whole frame.".to_string(),
                "Not held if the page fills the buffer by copying another buffer into it.".to_string(),
            ],
        ));
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

    let texture = id_of(session, &context, target, "texture")?;
    let filter = filter_of(session, &context, &params["filter"])?;
    let mut args = json!({ "kind": "texture", "texture": texture, "with": with, "filter": filter });

    // A file was read by the host (with_image) and comes as its pixels.
    if params[IMAGE].is_object() {
        args["with"] = json!("file");
        args["width"] = params[IMAGE]["width"].clone();
        args["height"] = params[IMAGE]["height"].clone();
        args["pixels"] = params[IMAGE]["pixels"].clone();
    } else if !["checker", "white", "black", "mips"].contains(&with) {
        bail!("with is checker, white, black, mips (each mip level a different colour) or the path of a PNG file, not \"{with}\".");
    }

    let (handle, made) = add(session, &context, args).await?;

    Ok(done(
        session,
        &context,
        &handle,
        &made,
        if params[IMAGE].is_object() {
            vec![format!(
                "The image is {}, sampled with linear filtering and no mipmaps; its first row is where the texture coordinate t is 0.",
                page_text(with, 200)
            )]
        } else {
            Vec::new()
        },
    ))
}

/// Where the pixels of a file given to patch_texture travel in its parameters.
const IMAGE: &str = "_image";

/// patch_texture's parameters with the file it names, if it names one, read and put
/// beside them as pixels. The host reads the file: the page never sees a path.
pub fn with_image(host: &crate::Host, params: &Value) -> Result<Value> {
    let with = params["with"].as_str().unwrap_or("checker");

    if ["checker", "white", "black", "mips"].contains(&with) {
        return Ok(params.clone());
    }

    let path = crate::tiers::file(host, with, "The image")?;
    let bytes = std::fs::read(&path)
        .map_err(|error| anyhow!("with is checker, white, black, mips or the path of a PNG file. {} could not be read: {error}.", path.display()))?;
    let image = scanline_image::Image::from_png(&bytes).map_err(|error| anyhow!("{} is not a PNG this can read: {error}.", path.display()))?;

    // A stand-in has no need to be large, and it travels to the page as text.
    let (image, _) = image.fit(2048);
    let mut out = params.clone();

    out[IMAGE] = json!({
        "width": image.width,
        "height": image.height,
        "pixels": base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &image.data),
    });

    Ok(out)
}

/// A view of the whole frame on the running page: overdraw, outlines, a colour for each
/// draw, or depth. It is a patch like any other, and patches(revert) undoes it.
pub async fn view(session: &Arc<Session>, params: &Value, which: &str) -> Result<Value> {
    let context = choose_context(session, params).await?;
    let (handle, made) = add(session, &context, json!({ "kind": "view", "view": which })).await?;

    Ok(done(
        session,
        &context,
        &handle,
        &made,
        vec![format!(
            "It is the page's own frame, drawn as it runs: offscreen passes are drawn this way too, so what a later pass makes of them shows as well. view(capture, view: \"{which}\") measures one frame exactly. live_view(view: \"off\") switches it off."
        )],
    ))
}

/// Switches every live view off. Returns how many there were.
pub async fn views_off(session: &Arc<Session>) -> usize {
    let replies = session.probe_all("patch.remove", json!({ "views": true }), SHORT).await;
    let mut gone = 0;

    for (instance, reply) in &replies {
        for id in reply["ids"].as_array().into_iter().flatten().filter_map(Value::as_i64) {
            let mut state = session.state.lock().unwrap();
            let handle = state.patches.iter().find(|(_, entry)| entry.0 == *instance && entry.1 == id).map(|(handle, _)| handle.clone());

            if let Some(handle) = handle {
                state.patches.remove(&handle);
            }

            gone += 1;
        }
    }

    gone
}

/// The patches in force, each with what it changes; or, with revert, one or all undone.
pub async fn patches(session: &Arc<Session>, params: &Value) -> Result<Value> {
    // Kept patches that could not be made straight after a reload, tried again.
    if params["again"] == true {
        let pending = session.state.lock().unwrap().kept_patches.iter().any(|entry| entry.2.is_empty());

        if !pending {
            return Ok(result("No kept patch is waiting to be made again.", json!({ "again": 0 })));
        }

        // Only the ones that are missing: the others are in force.
        let all = std::mem::take(&mut session.state.lock().unwrap().kept_patches);
        let (waiting, in_force): (Vec<_>, Vec<_>) = all.into_iter().partition(|entry| entry.2.is_empty());
        let before = session.state.lock().unwrap().patches.clone();

        session.state.lock().unwrap().kept_patches = waiting;

        let said = reapply(session).await.unwrap_or_default();
        let mut state = session.state.lock().unwrap();

        state.patches.extend(before);
        state.kept_patches.extend(in_force);

        return Ok(result(said, json!({ "again": true })));
    }

    if let Some(which) = params["revert"].as_str() {
        if which == "all" {
            let replies = session.probe_all("patch.remove", json!({ "all": true }), SHORT).await;
            let removed: u64 = replies.iter().map(|(_, reply)| reply["removed"].as_u64().unwrap_or(0)).sum();

            session.state.lock().unwrap().patches.clear();
            session.state.lock().unwrap().kept_patches.clear();

            return Ok(result(
                format!("{removed} patch{} undone. The page draws as its own code says.", if removed == 1 { "" } else { "es" }),
                json!({ "reverted": removed }),
            ));
        }

        let Some((instance, id)) = session.state.lock().unwrap().patches.remove(which) else {
            bail!("There is no patch \"{which}\". patches() lists the ones in force.");
        };

        // Undone is undone: it is not made again after the next reload either.
        session.state.lock().unwrap().kept_patches.retain(|entry| entry.2 != which);

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

            let kept = session.state.lock().unwrap().kept_patches.iter().any(|entry| entry.2 == *handle);

            lines.push(format!(
                "  {handle}  {description}{}{}",
                match (patch["kind"].as_str(), patch["draws"].as_u64().unwrap_or(0)) {
                    (Some("uniform"), _) => String::new(),
                    (_, 0) => "  (matched no draws in the last frame)".to_string(),
                    (_, draws) => format!("  ({draws} draw{} a frame)", if draws == 1 { "" } else { "s" }),
                },
                if kept { "  [kept across reloads]" } else { "" }
            ));
            rows.push(json!({ "patch": handle, "kind": patch["kind"], "description": description, "draws": patch["draws"], "kept": kept }));
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

    let waiting = session.state.lock().unwrap().kept_patches.iter().filter(|entry| entry.2.is_empty()).count();

    if waiting > 0 {
        summary.push_str(&format!(
            "\n{waiting} kept patch{} could not be made again after the last reload. patches(again: true) tries once more.",
            if waiting == 1 { "" } else { "es" }
        ));
    }

    Ok(result(summary, json!({ "patches": rows, "not_applied": failure, "waiting": waiting })))
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
        .ok_or_else(|| {
            anyhow!("experiment needs kind: scissor_1px (is the cost in filling pixels?), flat_fragment (is it in computing their colour?), textures_2x2 (is it in fetching texels?) or skip with a filter (what do these draws cost?).")
        })?;
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
        "flat_fragment" => (
            json!({ "kind": "draws", "mode": "solid", "filter": filter_of(session, &context, &params["filter"])? }),
            "every matching draw writing one flat colour".to_string(),
            "The draws are issued, their vertices processed and the same pixels filled, but each fragment writes one constant colour. Its shader still runs what it needs to decide a discard; the work that only made the colour (texture samples, lighting, loops) is gone. What went is the cost of computing the colour. If little went and scissor_1px takes a lot away, the cost is in how many pixels are filled, not in what each one computes: overdraw, or resolution.",
        ),
        // Not one patch but one for every texture: handled below.
        "textures_2x2" => (
            Value::Null,
            "every plain 2D colour texture stood in for by a 2×2 one".to_string(),
            "The draws, their vertices, their shaders and the pixels they fill are all as they were; only the textures are tiny, so every sample is a hit in the cache. What went is the cost of fetching texels from large textures: memory traffic. If little went, the textures are not what makes the frame slow.",
        ),
        other => {
            bail!("There is no \"{other}\" experiment. Kinds are scissor_1px, flat_fragment (optionally with a filter), textures_2x2 and skip (with a filter).")
        }
    };

    let before = measure(session, &context, frames).await?;
    let mut handles = Vec::new();
    let said_made;
    let mut left = 0;

    if kind == "textures_2x2" {
        // A stand-in for each texture a small colour texture can stand in for. The rest
        // (render targets, depth, cube maps, arrays, integer formats) are left as they are.
        let listed =
            session.probe(&context.instance, "registry.list", json!({ "kind": "texture", "sort": "bytes", "offset": 0, "limit": 2000 }), SHORT).await?;

        for row in listed["rows"].as_array().into_iter().flatten() {
            if row["api"] == "webgl" && row["context"] != json!(context.local) {
                continue;
            }

            match add(session, &context, json!({ "kind": "texture", "texture": row["id"], "with": "white", "plain": true, "filter": {} })).await {
                Ok((handle, _)) => handles.push(handle),
                Err(_) => left += 1,
            }
        }

        if handles.is_empty() {
            bail!(
                "This page has no plain 2D colour texture to stand in for ({left} left as they are: render targets, depth, cube maps, arrays and integer formats)."
            );
        }

        said_made = format!(
            "{} stood in for{}",
            crate::capture::plural(handles.len() as i64, "texture"),
            if left > 0 { format!("; {left} left as they are: render targets, depth, cube maps, arrays and integer formats") } else { String::new() }
        );
    } else {
        let (handle, made) = add(session, &context, patch).await?;

        said_made = said(session, &context, made["description"].as_str().unwrap_or(""));
        handles.push(handle);
    }

    let during = measure(session, &context, frames).await;

    // Whatever happened, the page goes back to drawing as it did.
    for handle in &handles {
        let made_here = session.state.lock().unwrap().patches.remove(handle);

        if let Some((instance, id)) = made_here {
            let _ = session.probe(&instance, "patch.remove", json!({ "patch": id }), SHORT).await;
        }
    }

    // One more frame, so that the canvas shows the page's own drawing again and not the
    // last frame of the experiment.
    let _ = step(session, &json!({ "frames": 1 })).await;

    let during = during?;
    let description = said_made;
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
