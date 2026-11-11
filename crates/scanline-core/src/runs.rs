//! Runs: a play session kept so that it can be played again (02-ARCHITECTURE.md, section 7).
//!
//! A browser cannot be rewound. What can be done is to load the page again and give it the
//! same input on the same frames. In a deterministic session (seeded random numbers, a fixed
//! time step) that brings it to the same state, so "go back to frame 900" is "reload, replay
//! to frame 900, pause", and a bug that took two minutes of play to reach can be reached
//! again after every change to the code.
//!
//! A run is the input the page received since it loaded, by frame, and a fingerprint of the
//! frame every so often. Replaying compares fingerprints as it goes and stops where they
//! first differ, so a replay that has parted from the original says so, and where.

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result, anyhow, bail};
use serde_json::{Value, json};

use crate::commands::{SHORT, page_text, primary, step};
use crate::session::Session;
use crate::{Host, result};

fn dir(host: &Host) -> PathBuf {
    host.store.root().join("runs")
}

fn known(host: &Host) -> Vec<String> {
    let mut numbers: Vec<u32> = std::fs::read_dir(dir(host))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| entry.file_name().to_str()?.strip_prefix("run_")?.strip_suffix(".json")?.parse().ok())
        .collect();

    numbers.sort_unstable();
    numbers.into_iter().map(|number| format!("run_{number}")).collect()
}

fn load(host: &Host, handle: &str) -> Result<Value> {
    let valid = handle.strip_prefix("run_").is_some_and(|number| !number.is_empty() && number.bytes().all(|byte| byte.is_ascii_digit()));
    let path = dir(host).join(format!("{handle}.json"));

    if !valid || !path.exists() {
        let all = known(host);

        bail!(
            "No run \"{handle}\". {}",
            match all.last() {
                Some(latest) => format!("The most recent of {} is {latest}.", all.len()),
                None => "None have been saved: call save_run in a session to keep its input.".to_string(),
            }
        );
    }

    serde_json::from_slice(&std::fs::read(&path).with_context(|| format!("reading {}", path.display()))?).context("reading the run")
}

/// The fingerprints the page has taken, from whichever probe holds the canvas.
async fn prints(session: &Arc<Session>, after: u64) -> (u64, Vec<Value>) {
    let replies = session.probe_all("frames.prints", json!({ "after": after }), SHORT).await;
    let best = replies.iter().map(|(_, reply)| reply).max_by_key(|reply| reply["prints"].as_array().map_or(0, Vec::len));

    match best {
        Some(reply) => (reply["every"].as_u64().unwrap_or(0), reply["prints"].as_array().cloned().unwrap_or_default()),
        None => (0, Vec::new()),
    }
}

/// An input row as the page recorded it, as an event `step` can send. None for rows that
/// are not replayed: focus changes, and key repeats, which the held key produces again.
fn event_of(row: &Value) -> Option<Value> {
    let kind = row[2].as_str()?;
    let number = |index: usize| row[index].as_f64().unwrap_or(0.0);

    match kind {
        "keydown" | "keyup" => {
            if row[6].as_u64() == Some(1) {
                return None;
            }

            Some(json!({ "key": row[3].as_str().filter(|code| !code.is_empty()).or(row[4].as_str())?, "down": kind == "keydown" }))
        }
        "mousemove" => Some(json!({ "pointer": "move", "x": number(3), "y": number(4), "space": "css_px" })),
        "mousedown" | "mouseup" => Some(json!({
            "pointer": if kind == "mousedown" { "down" } else { "up" },
            "x": number(3),
            "y": number(4),
            "button": match row[5].as_u64() { Some(1) => "middle", Some(2) => "right", _ => "left" },
            "space": "css_px",
        })),
        "wheel" => Some(json!({ "wheel": { "dx": number(5), "dy": number(6) }, "x": number(3), "y": number(4), "space": "css_px" })),
        "touchstart" | "touchmove" | "touchend" | "touchcancel" => {
            let points: Vec<Value> = row.as_array()?[4..].chunks_exact(3).map(|point| json!({ "id": point[0], "x": point[1], "y": point[2] })).collect();

            Some(json!({ "touch": kind.trim_start_matches("touch"), "points": points, "space": "css_px" }))
        }
        _ => None,
    }
}

/// Keeps the session's input since the page loaded, and its frame fingerprints, as a run.
pub async fn save_run(host: &Arc<Host>, session: &Arc<Session>) -> Result<Value> {
    let top = session.top()?;
    let status = session.probe(&top, "status", json!({}), SHORT).await?;
    let mut rows: Vec<Value> = Vec::new();
    let mut since = 0u64;
    let mut dropped: u64;

    loop {
        let part = session.probe(&top, "input.log", json!({ "since": since, "limit": 5000 }), SHORT).await?;
        let got = part["rows"].as_array().cloned().unwrap_or_default();

        dropped = part["dropped"].as_u64().unwrap_or(0);
        since = part["next"].as_u64().unwrap_or(since);

        if got.is_empty() {
            break;
        }

        rows.extend(got);
    }

    let events: Vec<Value> = rows.iter().filter(|row| event_of(row).is_some()).cloned().collect();
    let (every, taken) = prints(session, 0).await;
    let frame = status["frame"].as_u64().unwrap_or(0);

    std::fs::create_dir_all(dir(host)).with_context(|| format!("creating {}", dir(host).display()))?;

    let handle = format!("run_{}", known(host).last().and_then(|last| last[4..].parse::<u32>().ok()).unwrap_or(0) + 1);

    let run = json!({
        "run": handle,
        "url": session.url(),
        "frames": frame,
        "deterministic": status["deterministic"],
        "print_every": every,
        "events": events,
        "prints": taken,
        "dropped": dropped,
        "profile": session.profile.name(),
    });

    let path = dir(host).join(format!("{handle}.json"));

    std::fs::write(&path, serde_json::to_vec(&run)?).with_context(|| format!("writing {}", path.display()))?;

    // What was done, in a line: how many of each kind of input.
    let mut kinds: Vec<((&str, &str), usize)> = Vec::new();

    for row in &events {
        let kind = match row[2].as_str().unwrap_or("") {
            "keydown" => ("key press", "key presses"),
            "mousemove" => ("mouse move", "mouse moves"),
            "mousedown" => ("click", "clicks"),
            "wheel" => ("wheel turn", "wheel turns"),
            "touchstart" => ("touch", "touches"),
            _ => continue,
        };

        match kinds.iter_mut().find(|entry| entry.0 == kind) {
            Some(entry) => entry.1 += 1,
            None => kinds.push((kind, 1)),
        }
    }

    let mut lines = vec![format!(
        "{handle}: the {frame} frames since {} loaded, with {}.",
        page_text(&session.url(), 80),
        if kinds.is_empty() {
            "no input".to_string()
        } else {
            kinds.iter().map(|((one, many), count)| format!("{count} {}", if *count == 1 { one } else { many })).collect::<Vec<_>>().join(", ")
        }
    )];

    if status["deterministic"].is_null() {
        lines.push(
            "This session is not deterministic, so the replay will be given the same input but its clock and random numbers will differ, and it will probably part from the original. Launch with deterministic: true to record a run that replays exactly."
                .into(),
        );
    } else {
        lines.push(format!(
            "Deterministic (seed {}, {} ms a frame), with a fingerprint of the frame every {every} frames: {} of them.",
            status["deterministic"]["seed"],
            status["deterministic"]["fixedDt"],
            taken.len()
        ));
    }

    if dropped > 0 {
        lines.push(format!(
            "Warning: the page had received more input than is kept, and the oldest {dropped} events are missing. The replay will part from the original early."
        ));
    }

    lines.push(format!("replay_run(run: \"{handle}\") reloads the page and plays it again; to_frame stops it early, paused, to look."));

    Ok(result(
        lines.join("\n"),
        json!({ "run": handle, "frames": frame, "events": events.len(), "prints": taken.len(), "deterministic": status["deterministic"], "path": path }),
    ))
}

/// Reloads the page and gives it a run's input again, frame for frame, checking as it goes.
pub async fn replay_run(host: &Arc<Host>, session: &Arc<Session>, params: &Value) -> Result<Value> {
    let handle = params["run"].as_str().ok_or_else(|| {
        let all = known(host);

        anyhow!(
            "replay_run needs run: a handle such as run_1. {}",
            match all.last() {
                Some(latest) => format!("The most recent of {} is {latest}.", all.len()),
                None => "None have been saved: call save_run first.".to_string(),
            }
        )
    })?;
    let run = load(host, handle)?;
    let total = run["frames"].as_u64().unwrap_or(0);
    let target = params["to_frame"].as_u64().unwrap_or(total).min(total);
    let mut notes = Vec::new();

    if run["url"].as_str() != Some(session.url().as_str()) {
        notes.push(format!(
            "The run was recorded on {}, not the page this session has open. It is replayed here all the same.",
            page_text(run["url"].as_str().unwrap_or("?"), 80)
        ));
    }

    session.reload_paused().await?;

    let top = session.top()?;
    let status = session.probe(&top, "status", json!({}), SHORT).await?;

    if status["deterministic"] != run["deterministic"] {
        notes.push(if run["deterministic"].is_null() {
            "The run was not recorded in a deterministic session, so it may part from the original.".to_string()
        } else {
            format!(
                "The run was recorded with deterministic {}, and this session has {}: launch with the same settings to replay it exactly.",
                run["deterministic"], status["deterministic"]
            )
        });
    }

    // Input by frame, and the fingerprints to check against.
    let events: Vec<(u64, Value)> = run["events"].as_array().into_iter().flatten().filter_map(|row| Some((row[0].as_u64()?, event_of(row)?))).collect();
    let expected: Vec<&Value> = run["prints"].as_array().into_iter().flatten().collect();
    let every = run["print_every"].as_u64().unwrap_or(0);

    let mut frame = status["frame"].as_u64().unwrap_or(0);
    let mut next_event = events.iter().position(|(at, _)| *at >= frame).unwrap_or(events.len());
    let mut matched = 0usize;
    let mut diverged: Option<String> = None;
    let mut skipped_keys = 0usize;

    while frame < target && diverged.is_none() {
        // Up to the next fingerprint, so that a difference is found within one chunk of where it began.
        let stop = if every > 0 { ((frame / every + 1) * every).min(target) } else { (frame + 120).min(target) };
        let mut chunk = Vec::new();

        while next_event < events.len() && events[next_event].0 < stop {
            let (at, event) = &events[next_event];
            let mut event = event.clone();

            event["at"] = json!(at.saturating_sub(frame));
            chunk.push(event);
            next_event += 1;
        }

        // Fast: nobody is watching a replay, and the frames are the same either way.
        let stepped = step(session, &json!({ "frames": stop - frame, "events": chunk, "fast": params["fast"] != false })).await;

        if let Err(error) = stepped {
            // A key the host has no name for: send the rest without it.
            if error.to_string().contains("key") && skipped_keys < 20 {
                skipped_keys += 1;
                notes.push(format!("Some input could not be sent again ({error})."));
            } else {
                return Err(error.context(format!("replaying {handle} at frame {frame}")));
            }
        }

        let now = primary(&session.probe_all("status", json!({}), SHORT).await)?["frame"].as_u64().unwrap_or(stop);

        if now <= frame {
            diverged = Some(format!("the page stopped producing frames at frame {now}"));
            break;
        }

        // Compare the fingerprints taken since the last look.
        let (_, taken) = prints(session, frame).await;

        for print in &taken {
            let Some(original) = expected.iter().find(|original| original["frame"] == print["frame"]) else { continue };

            let difference = if original["draws"] != print["draws"] {
                Some(format!("it issued {} draws where the original issued {}", print["draws"], original["draws"]))
            } else if original["calls"] != print["calls"] {
                Some(format!("it made {} graphics calls where the original made {}", print["calls"], original["calls"]))
            } else if !original["hash"].is_null() && !print["hash"].is_null() && original["hash"] != print["hash"] {
                Some("its picture differs from the original's".to_string())
            } else {
                None
            };

            match difference {
                Some(what) => {
                    diverged = Some(format!("at frame {}, {what}", print["frame"]));
                    break;
                }
                None => matched += 1,
            }
        }

        frame = now;
    }

    let mut lines = Vec::new();

    match &diverged {
        Some(what) => {
            lines.push(format!("DIVERGED: the replay of {handle} parted from the original: {what}. Paused at frame {frame}."));
            lines.push(format!(
                "{matched} fingerprint{} before that matched. What the page does now is not what it did when the run was recorded: something outside the input differs (the code, a network response, real time read some other way, or the GPU).",
                if matched == 1 { "" } else { "s" }
            ));
        }
        None => {
            lines.push(format!("Replayed {handle} to frame {frame}{}. Paused.", if target < total { format!(" of {total}") } else { String::new() }));
            lines.push(if matched > 0 {
                format!("All {matched} fingerprints along the way match the original: the same picture and the same draws at each. The page is where it was.")
            } else if expected.is_empty() {
                "The run has no fingerprints to check against, so whether the page is where it was is not known.".to_string()
            } else {
                "No fingerprint fell within the frames replayed, so nothing was checked.".to_string()
            });
        }
    }

    lines.extend(notes.iter().map(|note| format!("Note: {note}")));

    Ok(result(
        lines.join("\n"),
        json!({
            "run": handle,
            "frame": frame,
            "frames": total,
            "matched": matched,
            "diverged": diverged,
            "events": next_event,
            "notes": notes,
        }),
    ))
}
