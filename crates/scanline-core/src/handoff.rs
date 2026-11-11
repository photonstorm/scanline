//! Working with the person (04-AGENT-INTERFACE.md, sections 3.8 and 4).
//!
//! The agent asks the person to do something it cannot: play until the glitch shows. The
//! request returns at once. The person plays, with the flight recorder keeping the last
//! frames, and presses Debug. At that moment, and without waiting for the agent, the host
//! freezes the page, takes the recording, makes a capture of the frozen frame, and queues an
//! event that says where they are. The agent collects it with `wait` whenever it next looks.

use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use base64::Engine;
use scanline_image::Image;
use serde_json::{Value, json};

use crate::capture::{self, LONG, Source};
use crate::commands::{SHORT, choose_context, decode_grab, hold, page_text, primary};
use crate::session::{Request, Session};
use crate::{Host, result};

/// Asks the person to do something, hands them the input, and starts the flight recorder.
pub async fn request_human(session: &Arc<Session>, params: &Value) -> Result<Value> {
    let instruction = params["instruction"].as_str().map(str::trim).filter(|text| !text.is_empty()).ok_or_else(|| {
        anyhow!("request_human needs instruction: what the person should do, for example \"Play until the water flickers, then press Debug\".")
    })?;
    let frames = params["flight_frames"].as_u64().unwrap_or(120).clamp(1, 600);
    let context = choose_context(session, params).await?;

    // Nothing the agent was holding may stay held when the person takes over.
    hold(session, &json!({ "keys_down": [] })).await?;

    let recorder = session.probe(&context.instance, "record.start", json!({ "context": context.local, "frames": frames }), SHORT).await;

    let (id, cursor) = {
        let mut state = session.state.lock().unwrap();

        state.next_request += 1;
        state.owner = "human".into();
        state.strip_note = None;
        state.recorder = recorder.is_ok().then(|| context.clone());

        let id = format!("req_{}", state.next_request);

        state.request = Some(Request { id: id.clone(), instruction: instruction.to_string(), cursor: state.event_seq });

        (id, state.event_seq)
    };

    session.queue("owner_changed", json!({ "owner": "human", "request": id, "instruction": instruction }));

    // The person's input reaches the page again, if the agent had been keeping it out.
    session.probe_all("input.block", json!({ "on": false }), SHORT).await;

    // The person has to be able to see what was asked of them.
    let strip = session.open_strip().await;

    session.probe_all("resume", json!({}), SHORT).await;
    refresh(session).await;

    let mut lines = vec![format!("{id}: the person has been asked: «{}». They have the input and the page is running.", page_text(instruction, 300))];

    match &recorder {
        Ok(_) => lines.push(format!("The flight recorder is keeping the last {frames} frames of {}.", context.handle)),
        Err(error) => lines.push(format!(
            "The flight recorder could not be started ({error}), so Debug will capture the frame after the press instead of the frames before it."
        )),
    }

    lines.push(match &strip {
        Ok(()) => "A control strip under the game's window shows them the instruction, with Debug, Pause and Step buttons.".to_string(),
        Err(error) => format!(
            "The control strip could not be opened ({error}), so the person sees nothing from Scanline: tell them what you asked, and that Debug is F9."
        ),
    });

    lines.push(format!(
        "Debug is F9 with the page focused, the strip's button, or the debug command. Call wait(session: \"{}\", request: \"{id}\") for the press: it is acted on when it happens, and nothing is lost if you are busy.",
        session.id
    ));

    Ok(result(lines.join("\n"), json!({ "request": id, "cursor": cursor, "owner": "human", "recording": recorder.is_ok(), "flight_frames": frames })))
}

/// Makes the agent the owner of the input, and keeps the person's out of the page until it
/// is given up again. The page is paused first, so nothing happens in between.
pub async fn take_control(session: &Arc<Session>, params: &Value) -> Result<Value> {
    if params["release"] == true {
        // Nobody in particular: the person's input reaches the page, and so does the agent's.
        let changed = {
            let mut state = session.state.lock().unwrap();
            let changed = state.owner == "agent";

            if changed {
                state.owner = String::new();
            }

            changed
        };

        session.probe_all("input.block", json!({ "on": false }), SHORT).await;

        if changed {
            session.queue("owner_changed", json!({ "owner": "none" }));
        }

        refresh(session).await;

        return Ok(result("The agent has given up the input. The person's input reaches the page again.", json!({ "owner": "none" })));
    }

    let results = session.probe_all("pause", json!({}), SHORT).await;
    let frame = primary(&results)?["frame"].clone();

    // Nothing either of them was holding may stay held across the change.
    hold(session, &json!({ "keys_down": [] })).await?;

    let changed = {
        let mut state = session.state.lock().unwrap();
        let changed = state.owner != "agent";

        state.owner = "agent".into();
        state.request = None;
        state.strip_note = None;

        changed
    };

    session.probe_all("input.block", json!({ "on": true }), SHORT).await;

    if changed {
        session.queue("owner_changed", json!({ "owner": "agent" }));
    }

    refresh(session).await;

    Ok(result(
        format!(
            "The agent has the input: the person's keys and mouse are kept out of the page until take_control(release: true) or request_human. The Debug key still works. Paused at frame {frame}."
        ),
        json!({ "owner": "agent", "paused": true, "frame": frame }),
    ))
}

/// Tells the control strip what to show: who is driving, what was asked, where the page is.
pub async fn refresh(session: &Arc<Session>) {
    let (owner, mut instruction, recording, open, mut annotating, frozen_at) = {
        let state = session.state.lock().unwrap();

        (
            state.owner.clone(),
            state.request.as_ref().map(|request| request.instruction.clone()).or(state.strip_note.clone()),
            state.recorder.is_some(),
            state.strip.is_some(),
            state.annotating,
            state.annotating_frame,
        )
    };

    if !open {
        return;
    }

    let Ok(top) = session.top() else { return };
    let Ok(status) = session.probe(&top, "status", json!({}), SHORT).await else { return };

    // Marks are about the frozen frame: once the page has moved on they are over, and so
    // is the invitation to make them.
    if annotating && (status["paused"] != true || status["frame"].as_u64() != Some(frozen_at)) {
        let mut state = session.state.lock().unwrap();

        state.annotating = false;
        state.strip_note = None;
        annotating = false;

        if state.request.is_none() {
            instruction = None;
        }
    }

    let shown = json!({
        "owner": owner,
        "instruction": instruction,
        "recording": recording,
        "frame": status["frame"],
        "paused": status["paused"],
        "debug_key": status["debugKey"],
        "annotate": annotating,
    });

    let _ = session.strip_eval(&format!("update({shown})")).await;
}

/// Acts on what the person presses, the Debug key in the page or a button on the control
/// strip, and keeps the strip up to date, for as long as the session lives.
pub async fn watch(host: Arc<Host>, session: Arc<Session>) {
    loop {
        let open = session.state.lock().unwrap().strip.is_some();

        // With the strip open, look often enough that its frame counter moves.
        let _ = tokio::time::timeout(Duration::from_millis(if open { 250 } else { 5000 }), session.debug.notified()).await;

        if session.check_alive().is_err() {
            return;
        }

        loop {
            let Some(action) = session.state.lock().unwrap().actions.pop_front() else { break };

            let outcome = match action.as_str() {
                "debug:key" => debug(&host, &session, &json!({ "by": "key" })).await.map(|_| ()),
                "debug" => debug(&host, &session, &json!({ "by": "strip" })).await.map(|_| ()),
                "pause" => crate::commands::pause(&session).await.map(|_| ()),
                "resume" => crate::commands::resume(&session, &json!({})).await.map(|_| ()),
                "step" => crate::commands::step(&session, &json!({ "frames": 1 })).await.map(|_| ()),
                // A note the person typed about the frozen frame.
                note if note.starts_with("note:") => {
                    session.queue("annotation", json!({ "note": note[5..].chars().take(400).collect::<String>() }));
                    session.state.lock().unwrap().strip_note = Some("Your note was sent to the agent. You can send more, or mark the picture.".into());

                    Ok(())
                }
                _ => Ok(()),
            };

            if let Err(error) = outcome {
                session
                    .queue("warning", json!({ "text": format!("The person pressed {}, but it could not be done: {error}", action.trim_end_matches(":key")) }));
            }
        }

        refresh(&session).await;
    }
}

/// The control strip: opens it, says what it shows, or presses one of its buttons as the
/// person would.
pub async fn strip(session: &Arc<Session>, params: &Value) -> Result<Value> {
    if params["open"] == true || (params["press"].is_string() && session.state.lock().unwrap().strip.is_none()) {
        session.open_strip().await?;
        refresh(session).await;
    }

    if session.state.lock().unwrap().strip.is_none() {
        return Ok(result("The control strip is not open. It opens when request_human is called; strip(open: true) opens it now.", json!({ "open": false })));
    }

    let mut lines: Vec<String> = Vec::new();

    // Type a note and send it, as the person would.
    if let Some(note) = params["note"].as_str() {
        let sent = session
            .strip_eval(&format!(
                "(() => {{ const form = document.getElementById('mark'); if (form.hidden) {{ return false; }} document.getElementById('note').value = {}; form.requestSubmit(); return true; }})()",
                Value::String(note.to_string())
            ))
            .await;

        if sent != Some(json!(true)) {
            bail!("The strip shows no note field just now. It is there once the person has pressed Debug, while the page stays frozen.");
        }

        lines.push("Typed a note into the strip and sent it, as the person would. It arrives as an annotation event.".to_string());
        tokio::time::sleep(Duration::from_millis(150)).await;
        refresh(session).await;
    }

    if let Some(button) = params["press"].as_str() {
        if !["debug", "pause", "step"].contains(&button) {
            bail!("The strip has three buttons: debug, pause (which is Resume while paused) and step. There is no \"{button}\".");
        }

        let pressed = session
            .strip_eval(&format!(
                "(() => {{ const button = document.getElementById('{button}'); if (button.disabled) {{ return false; }} button.click(); return true; }})()"
            ))
            .await;

        if pressed != Some(json!(true)) {
            bail!("The strip's {button} button is disabled just now{}.", if button == "step" { ": Step works while the page is paused" } else { "" });
        }

        lines.push(format!("Pressed {button} on the strip, as the person would. It is acted on at once; wait or status shows the result."));

        // Give the host's own loop a moment to act, so what is reported is the state after the press.
        tokio::time::sleep(Duration::from_millis(150)).await;
        refresh(session).await;
    }

    let shown = session.strip_eval("shown()").await.unwrap_or(Value::Null);

    lines.push(format!(
        "The strip shows: {}{}{}. {}. Buttons: {}, Step{}, Debug.",
        shown["who"].as_str().unwrap_or("?"),
        match shown["instruction"].as_str().filter(|text| !text.is_empty()) {
            Some(text) => format!(" — «{}»", page_text(text, 200)),
            None => String::new(),
        },
        if shown["recording"] == true { ", REC" } else { "" },
        shown["frame"].as_str().unwrap_or("frame ?"),
        shown["pause"].as_str().unwrap_or("Pause"),
        if shown["step_enabled"] == true { "" } else { " (disabled)" }
    ));

    let mut value = result(lines.join("\n"), json!({ "open": true, "shown": shown }));

    if params["output"] == true {
        let path = session.dir.join("images").join("strip.png");

        std::fs::write(&path, session.strip_picture().await?).with_context(|| format!("writing {}", path.display()))?;
        value["images"] = json!([{ "view": path, "original": path, "space": "strip_px" }]);
    }

    Ok(value)
}

/// Debug: freeze, keep the recording, capture the frozen frame, and tell whoever is listening.
pub async fn debug(host: &Arc<Host>, session: &Arc<Session>, params: &Value) -> Result<Value> {
    let stopped = session.probe_all("pause", json!({}), SHORT).await;
    let frame = primary(&stopped)?["frame"].clone();

    let (request, recorder) = {
        let mut state = session.state.lock().unwrap();

        (state.request.take(), state.recorder.take())
    };

    let context = match recorder {
        Some(context) => context,
        None => choose_context(session, params).await?,
    };

    // A press by the person, or a trigger the agent set (capture(when)).
    let triggered = params["by"] == "trigger";
    let word = if triggered { "Triggered" } else { "Debug" };
    let recording = session.probe(&context.instance, "record.status", json!({}), SHORT).await.is_ok_and(|status| status["recording"] == true);
    let mut data = json!({ "frame": frame, "request": request.as_ref().map(|request| request.id.clone()), "by": params["by"].as_str().unwrap_or("command") });
    let mut lines = Vec::new();
    let value;

    if recording {
        let frozen = session.probe(&context.instance, "record.freeze", json!({}), SHORT).await?;
        let taken = session.probe(&context.instance, "capture.take", json!({ "capture": frozen["capture"] }), LONG).await?;
        let body = capture::fetch(host, session, &context.instance, &frozen["capture"], &taken).await?;
        let original = decode_grab(&session.probe(&context.instance, "image.grab", json!({ "context": context.local }), Duration::from_secs(20)).await?)?;
        let marks = body["header"]["frames"].as_array().cloned().unwrap_or_default();

        if marks.is_empty() {
            bail!("The flight recorder held no whole frame.");
        }

        let handle = host.store.reserve_recording()?;
        let tag = context.instance.tag as u64;

        // The frozen frame is a capture like any other, and the one frame of the recording
        // there is a picture from the page to check the replay against.
        let last = capture::frame_body(&body, marks.len() - 1)?;
        let source = Source { context: context.handle.clone(), tag, original: Some(original), recording: Some((handle.clone(), true)), url: None };

        value = capture::build(host, session, last, source, params).await?;

        let meta = json!({
            "recording": handle,
            "session": session.id,
            "url": session.url(),
            "context": context.handle,
            "instance_tag": tag,
            "api": body["header"]["api"],
            "width": body["header"]["width"],
            "height": body["header"]["height"],
            "frames": marks.len(),
            "first_frame": marks[0]["frame"],
            "last_frame": marks[marks.len() - 1]["frame"],
            "request": request.as_ref().map(|request| request.id.clone()),
            "instruction": request.as_ref().map(|request| request.instruction.clone()),
            "capture": value["data"]["capture"],
            "replay": value["data"]["replay"],
            "replay_matches": value["data"]["replay_matches"],
            "profile": session.profile.name(),
            "notes": body["header"]["notes"],
        });

        host.store.write_recording(&handle, &body, &meta)?;

        data["recording"] = json!(handle);
        data["frames"] = json!(marks.len());
        data["first_frame"] = marks[0]["frame"].clone();

        lines.push(format!(
            "{word} at frame {frame}. The page is frozen. {} is that frame; {handle} holds the {} frames up to it ({}–{}).",
            value["data"]["capture"].as_str().unwrap_or("?"),
            marks.len(),
            marks[0]["frame"],
            marks[marks.len() - 1]["frame"]
        ));
        lines.push(format!(
            "recording(recording: \"{handle}\") says how the frames differ; capture(recording: \"{handle}\", frame: n) makes any of them a capture."
        ));
    } else {
        // Nothing was recording, so the frames before the press are gone. The next one is taken.
        value = capture::capture(host, session, params).await?;

        lines.push(if triggered {
            format!(
                "Triggered at frame {frame}. The page is frozen. The flight recorder could not run, so {} is the frame after the one that met the condition.",
                value["data"]["capture"].as_str().unwrap_or("?")
            )
        } else {
            format!(
                "Debug at frame {frame}. The page is frozen. The flight recorder was not running, so {} is the frame after the press, not the one the person saw. Call request_human first to keep the frames before it.",
                value["data"]["capture"].as_str().unwrap_or("?")
            )
        });
    }

    data["capture"] = value["data"]["capture"].clone();

    // What the person pointed at, if they did.
    let annotation: serde_json::Map<String, Value> =
        ["x", "y", "w", "h", "note"].iter().filter(|key| !params[**key].is_null()).map(|key| (key.to_string(), params[*key].clone())).collect();

    if !annotation.is_empty() {
        lines.push(format!("The person marked: {}", Value::Object(annotation.clone())));
        data["annotation"] = Value::Object(annotation);
    }

    if triggered {
        // Nobody pressed anything: the input stays with whoever had it.
        session.queue("capture_ready", data.clone());
    } else {
        let mut state = session.state.lock().unwrap();

        state.owner = String::new();
        state.annotating = true;
        state.annotating_frame = frame.as_u64().unwrap_or(0);
        state.strip_note = Some(match data["recording"].as_str() {
            Some(_) => {
                format!(
                    "Frozen at frame {frame}. The agent has this frame and the {} before it. Click the picture to point at something, drag to mark a box, or type a note.",
                    data["frames"].as_u64().unwrap_or(1).saturating_sub(1)
                )
            }
            None => format!(
                "Frozen at frame {frame}. The agent has the frame after it. Click the picture to point at something, drag to mark a box, or type a note."
            ),
        });
    }

    // The person can now show what they mean on the frozen picture.
    if !triggered && session.probe(&context.instance, "annotate.start", json!({}), SHORT).await.is_ok() {
        lines.push(
            "The person can now mark the frozen frame: a click on the picture is a point, a drag a box, and the strip takes a typed note. Each arrives as an annotation event, in canvas pixels: wait(kinds: [\"annotation\"]) or events."
                .to_string(),
        );
    }

    if !triggered {
        session.queue("debug_pressed", data.clone());
    }

    refresh(session).await;

    lines.push(value["summary"].as_str().unwrap_or("").to_string());

    let mut out = result(lines.join("\n"), data);

    out["images"] = value["images"].clone();

    Ok(out)
}

/// Capture when something happens (CAP-3): the page runs until the condition is met, with
/// the flight recorder on, and the frame that met it is captured with the frames before it.
pub async fn capture_when(host: &Arc<Host>, session: &Arc<Session>, params: &Value) -> Result<Value> {
    let when = &params["when"];
    let known = ["error", "frame_ms_over", "event", "mark", "expr", "frame", "frames", "ms"];

    if !when.is_object() || !when.as_object().is_some_and(|object| object.keys().any(|key| known.contains(&key.as_str()))) {
        bail!(
            "capture(when) takes one of {{error: true}} (the page raises an error), {{frame_ms_over: n}} (a frame takes longer than n ms), {{mark: \"name\"}} (the page marks an event), {{expr: \"…\"}} (an expression becomes true), {{frames: n}}."
        );
    }

    let keep = params["flight_frames"].as_u64().unwrap_or(30).clamp(1, 600);
    let context = choose_context(session, params).await?;

    // The frames up to the one that meets the condition are kept, as for a Debug press.
    let recorder = session.probe(&context.instance, "record.start", json!({ "context": context.local, "frames": keep }), SHORT).await;

    if recorder.is_ok() {
        session.state.lock().unwrap().recorder = Some(context.clone());
    }

    let ran = crate::commands::run_until(session, &json!({ "until": when, "timeout_s": params["timeout_s"], "observe": { "state": false } })).await;

    let met = match &ran {
        Ok(value) => value["data"]["met"] == true,
        Err(_) => false,
    };

    if !met {
        // Nothing to capture: the recorder is put away and the page left paused.
        let _ = session.probe(&context.instance, "record.stop", json!({}), SHORT).await;

        session.state.lock().unwrap().recorder = None;

        let ran = ran?;

        return Ok(result(
            format!(
                "Nothing was captured: the condition was not met. {}\nCall capture(when) again to keep waiting, or capture() for the frame as it is.",
                ran["summary"].as_str().unwrap_or("")
            ),
            json!({ "met": false, "frame": ran["data"]["frame"] }),
        ));
    }

    let mut args = params.clone();

    args["by"] = json!("trigger");

    let mut value = debug(host, session, &args).await?;
    let stopped = ran.map(|value| value["summary"].as_str().unwrap_or("").lines().next().unwrap_or("").to_string()).unwrap_or_default();

    value["summary"] = json!(format!("{stopped}\n{}", value["summary"].as_str().unwrap_or("")));
    value["data"]["met"] = json!(true);

    Ok(value)
}

fn the_recording(host: &Host, params: &Value) -> Result<(String, Value)> {
    let Some(handle) = params["recording"].as_str() else {
        let known = host.store.recordings();

        bail!(
            "No recording named. {}",
            match known.last() {
                Some(latest) => format!("Pass recording: \"{latest}\" (the most recent of {}).", known.len()),
                None => "None have been kept: one is made when Debug is pressed after request_human.".to_string(),
            }
        );
    };

    Ok((handle.to_string(), host.store.recording_meta(handle)?))
}

/// Numbers as runs: 5–8, 12.
fn runs(numbers: &[u64]) -> String {
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

    if parts.len() > 8 {
        let more = parts.len() - 8;

        parts.truncate(8);
        parts.push(format!("and {more} more runs"));
    }

    parts.join(", ")
}

/// A recording: its frames, how they differ from one another, and a sheet of small pictures.
pub async fn recording(host: &Arc<Host>, params: &Value) -> Result<Value> {
    if params["recording"].is_null() {
        let known = host.store.recordings();

        if known.is_empty() {
            return Ok(result("No recordings on disk. One is made when Debug is pressed after request_human.", json!({ "recordings": [] })));
        }

        let mut lines = vec![format!("{} recording{} on disk, newest first:", known.len(), if known.len() == 1 { "" } else { "s" })];
        let mut rows = Vec::new();

        for handle in known.iter().rev().take(25) {
            let meta = host.store.recording_meta(handle)?;

            lines.push(format!(
                "  {handle}  {} frames, {}–{}, {} {}×{}  «{}»",
                meta["frames"],
                meta["first_frame"],
                meta["last_frame"],
                meta["api"].as_str().unwrap_or("?"),
                meta["width"],
                meta["height"],
                page_text(meta["url"].as_str().unwrap_or(""), 80)
            ));
            rows.push(meta);
        }

        return Ok(result(lines.join("\n"), json!({ "recordings": rows })));
    }

    let (handle, meta) = the_recording(host, params)?;
    let stream = host.store.recording_stream(&handle)?;
    let marks = stream["header"]["frames"].as_array().cloned().unwrap_or_default();

    let mut lines = vec![format!(
        "{handle}: {} frames, {}–{}, of {} ({} {}×{}) at {}.",
        marks.len(),
        meta["first_frame"],
        meta["last_frame"],
        meta["context"].as_str().unwrap_or("?"),
        meta["api"].as_str().unwrap_or("?"),
        meta["width"],
        meta["height"],
        page_text(meta["url"].as_str().unwrap_or(""), 80)
    )];

    if let Some(instruction) = meta["instruction"].as_str() {
        lines.push(format!("Recorded while the person did: «{}».", page_text(instruction, 200)));
    }

    lines.push(format!("Its last frame, the one the page was frozen on, is {}.", meta["capture"].as_str().unwrap_or("a capture that was not kept")));

    // What each frame issued, from the stream itself.
    let mut frames: Vec<Value> = Vec::new();
    let (mut command, mut draw) = (0u64, 0u64);

    for mark in &marks {
        let (end_command, end_draw) = (mark["command"].as_u64().unwrap_or(0), mark["draw"].as_u64().unwrap_or(0));

        frames.push(json!({ "frame": mark["frame"], "calls": end_command - command, "events": end_draw - draw }));
        command = end_command;
        draw = end_draw;
    }

    let events: Vec<u64> = frames.iter().map(|frame| frame["events"].as_u64().unwrap_or(0)).collect();

    if events.iter().all(|count| *count == events[0]) {
        lines.push(format!("Every frame issued {} events (draws, clears and blits).", events[0]));
    } else {
        let changed: Vec<u64> =
            frames.windows(2).filter(|pair| pair[0]["events"] != pair[1]["events"]).map(|pair| pair[1]["frame"].as_u64().unwrap_or(0)).collect();

        lines.push(format!(
            "The number of events a frame issued varies from {} to {}. It changed at frame{} {}.",
            events.iter().min().unwrap(),
            events.iter().max().unwrap(),
            if changed.len() == 1 { "" } else { "s" },
            runs(&changed)
        ));
    }

    // Frames that do not draw what the others draw. A frame's shape is its events in order,
    // each by its kind and the state that makes it what it is, but not by where it draws
    // or the values it is given, which change every frame in anything that moves.
    let all_draws = stream["draws"].as_array().cloned().unwrap_or_default();
    let shape = |row: &Value| -> String {
        format!(
            "{}|{}|{}|{}|{}|{}|{}|{}|{}",
            row["kind"].as_str().unwrap_or(""),
            row["method"].as_str().unwrap_or(""),
            if row["target"].as_i64().unwrap_or(0) > 0 { format!("tex{}", row["target"]) } else { "canvas".to_string() },
            if row["pipeline"].is_number() { &row["pipeline"] } else { &row["program"] },
            row["mode"],
            row["count"],
            if row["blend"].is_object() { format!("blend {} {}", row["blend"]["srcRgb"], row["blend"]["dstRgb"]) } else { "opaque".to_string() },
            if row["depth"].is_object() { format!("depth {} {}", row["depth"]["func"], row["depth"]["write"]) } else { "no depth".to_string() },
            row["cull"]
        )
    };

    let mut shapes: Vec<Vec<String>> = Vec::new();
    let mut from = 0usize;

    for mark in &marks {
        let to = (mark["draw"].as_u64().unwrap_or(0) as usize).min(all_draws.len());

        shapes.push(all_draws[from.min(to)..to].iter().map(shape).collect());
        from = to;
    }

    // The usual shape is the one most frames have.
    let mut tally: Vec<(&Vec<String>, usize)> = Vec::new();

    for shape in &shapes {
        match tally.iter_mut().find(|entry| entry.0 == shape) {
            Some(entry) => entry.1 += 1,
            None => tally.push((shape, 1)),
        }
    }

    tally.sort_by_key(|entry| std::cmp::Reverse(entry.1));

    let usual = tally.first().map(|entry| entry.0.clone()).unwrap_or_default();
    let odd: Vec<usize> = (0..shapes.len()).filter(|index| shapes[*index] != usual).collect();

    for (frame, shape) in frames.iter_mut().zip(&shapes) {
        frame["unusual"] = json!(*shape != usual);
    }

    if odd.is_empty() {
        lines.push(
            "Every frame draws the same things in the same order with the same state. Only values (positions, colours, uniforms) differ between frames.".into(),
        );
    } else {
        let numbers: Vec<u64> = odd.iter().map(|index| frames[*index]["frame"].as_u64().unwrap_or(0)).collect();
        let example = odd[0];
        let at = (0..usual.len().max(shapes[example].len())).find(|index| usual.get(*index) != shapes[example].get(*index)).unwrap_or(0);
        let neighbour = (0..shapes.len()).filter(|index| shapes[*index] == usual).min_by_key(|index| index.abs_diff(example)).unwrap_or(example);

        lines.push(format!(
            "{} of the {} frames {} from the rest in what {} or the state {} with: frame{} {}.",
            odd.len(),
            shapes.len(),
            if odd.len() == 1 { "differs" } else { "differ" },
            if odd.len() == 1 { "it draws" } else { "they draw" },
            if odd.len() == 1 { "it draws" } else { "they draw" },
            if odd.len() == 1 { "" } else { "s" },
            runs(&numbers)
        ));
        lines.push(format!(
            "  Frame {} first differs from frame {} at its event {at}. Make both captures and compare their draw lists: capture(recording: \"{handle}\", frame: {}) and capture(recording: \"{handle}\", frame: {}).",
            frames[example]["frame"], frames[neighbour]["frame"], frames[example]["frame"], frames[neighbour]["frame"]
        ));
    }

    // What each frame looked like, by replaying the recording once. Needs a browser.
    let mut images = json!([]);

    match host.replayer(params) {
        Ok(session) => match pictures(host, &session, &handle, &stream).await {
            Ok((hashes, sheet, columns)) => {
                for (frame, hash) in frames.iter_mut().zip(&hashes) {
                    frame["picture"] = json!(hash);
                }

                let mut distinct: Vec<&String> = hashes.iter().collect();

                distinct.sort();
                distinct.dedup();

                let same: Vec<u64> =
                    (1..hashes.len()).filter(|index| hashes[*index] == hashes[*index - 1]).map(|index| frames[index]["frame"].as_u64().unwrap_or(0)).collect();
                let alternates =
                    distinct.len() == 2 && hashes.len() >= 4 && (2..hashes.len()).all(|index| hashes[index] == hashes[index - 2]) && hashes[0] != hashes[1];

                lines.push(if distinct.len() == 1 {
                    "Every frame is the same picture.".to_string()
                } else if alternates {
                    "The picture alternates between two: every frame is the same as the one two before it and different from the one before. Take two neighbouring frames apart and compare them.".to_string()
                } else if same.is_empty() {
                    format!("Every frame's picture differs from the one before ({} distinct pictures).", distinct.len())
                } else {
                    format!(
                        "{} distinct pictures. The picture did not change at frame{} {}; it changed at every other frame.",
                        distinct.len(),
                        if same.len() == 1 { "" } else { "s" },
                        runs(&same)
                    )
                });

                let path = host.store.recording_dir(&handle).join("contact.png");

                std::fs::write(&path, sheet.to_png()?).with_context(|| format!("writing {}", path.display()))?;
                lines.push(format!("Contact sheet: {} across, frame {} at the top-left, in reading order: {}", columns, meta["first_frame"], path.display()));
                images = json!([{ "view": path, "original": path, "width": sheet.width, "height": sheet.height, "scale": 1.0, "space": "contact_sheet" }]);
            }
            Err(error) => lines.push(format!("The frames' pictures could not be made: {error}")),
        },
        Err(_) => lines.push("The frames' pictures are made by replaying the recording, which needs an open session.".into()),
    }

    if meta["replay_matches"] != true {
        lines.push("Warning: the recording's last frame did not replay to the image the page showed, so what replay says of its frames may be wrong.".into());
    }

    for note in meta["notes"].as_array().into_iter().flatten().filter_map(Value::as_str).filter(|note| note.contains(' ')) {
        lines.push(format!("Note: {}", page_text(note, 300)));
    }

    lines.push(format!("capture(recording: \"{handle}\", frame: n) makes a frame a capture, to take apart like any other."));

    let mut value = result(lines.join("\n"), json!({ "recording": handle, "meta": meta, "frames": frames }));

    value["images"] = images;

    Ok(value)
}

/// Replays a recording once and returns each frame's picture as a hash, with a sheet of
/// small pictures and how many it has across.
async fn pictures(host: &Arc<Host>, session: &Arc<Session>, handle: &str, stream: &Value) -> Result<(Vec<String>, Image, u32)> {
    let hashes: Vec<String> = stream["blob_hashes"].as_array().into_iter().flatten().filter_map(|hash| hash.as_str().map(str::to_string)).collect();
    let store = &host.store;

    session.replay_load(handle, stream, &|index| store.get_blob(hashes.get(index).ok_or_else(|| anyhow!("The recording names no blob {index}."))?)).await?;

    let reply = session.replay("frames", &json!({ "key": handle }), Duration::from_secs(120)).await?;
    let frames = reply["frames"].as_array().cloned().unwrap_or_default();

    if frames.is_empty() {
        bail!("the replay produced no frames");
    }

    let (width, height) = (reply["thumb"]["width"].as_u64().unwrap_or(0) as u32, reply["thumb"]["height"].as_u64().unwrap_or(0) as u32);
    let packed = base64::engine::general_purpose::STANDARD.decode(reply["thumbs"].as_str().unwrap_or("")).context("decoding the frames' pictures")?;
    let mut bytes = Vec::new();

    std::io::Read::read_to_end(&mut flate2::read::GzDecoder::new(packed.as_slice()), &mut bytes).context("unpacking the frames' pictures")?;

    let each = (width * height * 4) as usize;

    if each == 0 || bytes.len() < each * frames.len() {
        bail!("the replay returned pictures of the wrong size");
    }

    // A grid, with a gap between pictures so neighbours can be told apart.
    let count = frames.len() as u32;
    let columns = count.min(12);
    let rows = count.div_ceil(columns);
    let gap = 2;
    let (sheet_width, sheet_height) = (columns * (width + gap) + gap, rows * (height + gap) + gap);
    let mut data = vec![32u8; (sheet_width * sheet_height * 4) as usize];

    for pixel in data.chunks_exact_mut(4) {
        pixel[3] = 255;
    }

    for index in 0..count {
        let (left, top) = (gap + (index % columns) * (width + gap), gap + (index / columns) * (height + gap));
        let picture = &bytes[index as usize * each..(index as usize + 1) * each];

        for y in 0..height {
            let from = (y * width * 4) as usize;
            let to = (((top + y) * sheet_width + left) * 4) as usize;

            data[to..to + (width * 4) as usize].copy_from_slice(&picture[from..from + (width * 4) as usize]);
        }
    }

    // Opaque, so a canvas with transparent pixels still shows.
    for pixel in data.chunks_exact_mut(4) {
        pixel[3] = 255;
    }

    Ok((frames.iter().map(|frame| frame["hash"].as_str().unwrap_or("").to_string()).collect(), Image::new(sheet_width, sheet_height, data)?, columns))
}

/// Makes one frame of a recording into a capture.
pub async fn frame_capture(host: &Arc<Host>, params: &Value) -> Result<Value> {
    let (handle, meta) = the_recording(host, params)?;
    let frame = params["frame"].as_u64().ok_or_else(|| {
        anyhow!(
            "capture of a recording needs frame: a frame number from {} to {}. recording(recording: \"{handle}\") lists them.",
            meta["first_frame"],
            meta["last_frame"]
        )
    })?;

    // The frozen frame was made a capture when Debug was pressed.
    if meta["last_frame"].as_u64() == Some(frame) {
        if let Some(existing) = meta["capture"].as_str() {
            if let Ok(capture_meta) = host.store.meta(existing) {
                return capture::describe_capture(host, existing, &capture_meta);
            }
        }
    }

    let stream = host.store.recording_stream(&handle)?;
    let marks = stream["header"]["frames"].as_array().cloned().unwrap_or_default();
    let index = marks
        .iter()
        .position(|mark| mark["frame"].as_u64() == Some(frame))
        .ok_or_else(|| anyhow!("{handle} holds frames {} to {}; frame {frame} is not one of them.", meta["first_frame"], meta["last_frame"]))?;
    let session = host.replayer(params)?;
    let body = capture::frame_body(&stream, index)?;

    let source = Source {
        context: meta["context"].as_str().unwrap_or("?").to_string(),
        tag: meta["instance_tag"].as_u64().unwrap_or(0),
        original: None,
        recording: Some((handle.clone(), meta["replay_matches"] == true)),
        url: meta["url"].as_str().map(str::to_string),
    };

    capture::build(host, &session, body, source, params).await
}
