//! Takes (docs/GAME.md, section 5): named recordings of input, played back to the same frame.
//!
//! A take is a run with a name, a start and an end (T6). Recorded from the page's load, it is
//! played by loading the page again and giving it the same input on the same frames, as
//! replay_run does. Where the page offers checkpoints, a take started part way through saves
//! one, and is played by restoring it and giving the input from there. Takes are files in
//! `<home>/takes`, so a person can record one and hand its name to an agent.

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result, anyhow, bail};
use serde_json::{Value, json};

use crate::commands::{SHORT, page_text, step};
use crate::runs;
use crate::session::Session;
use crate::{Host, result};

fn dir(host: &Host) -> PathBuf {
    host.store.root().join("takes")
}

/// Whether a name can be a take's: a file name on every system, short, and nothing else.
fn valid(name: &str) -> bool {
    let mut chars = name.chars();

    chars.next().is_some_and(|first| first.is_ascii_alphanumeric())
        && name.len() <= 60
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        && !name.contains("..")
}

fn path_of(host: &Host, name: &str) -> Result<PathBuf> {
    if !valid(name) {
        bail!("\"{}\" cannot be a take's name: letters, digits, - _ and . only, starting with a letter or digit, at most 60.", page_text(name, 60));
    }

    Ok(dir(host).join(format!("{name}.json")))
}

fn names(host: &Host) -> Vec<String> {
    let mut found: Vec<(std::time::SystemTime, String)> = std::fs::read_dir(dir(host))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_str()?.strip_suffix(".json")?.to_string();
            let when = entry.metadata().and_then(|meta| meta.modified()).ok()?;

            Some((when, name))
        })
        .collect();

    found.sort();
    found.into_iter().rev().map(|(_, name)| name).collect()
}

fn load(host: &Host, name: &str) -> Result<Value> {
    let path = path_of(host, name)?;

    if !path.exists() {
        let all = names(host);

        bail!(
            "There is no take \"{name}\". {}",
            if all.is_empty() { "None have been recorded: take(action: \"start\") begins one.".to_string() } else { format!("Takes: {}.", all.join(", ")) }
        );
    }

    serde_json::from_slice(&std::fs::read(&path).with_context(|| format!("reading {}", path.display()))?).context("reading the take")
}

fn next_name(host: &Host) -> String {
    let taken = names(host);

    (1..).map(|number| format!("take_{number}")).find(|name| !taken.contains(name)).unwrap_or_else(|| "take".into())
}

pub async fn take(host: &Arc<Host>, session: &Arc<Session>, params: &Value) -> Result<Value> {
    match params["action"].as_str().unwrap_or("") {
        "start" => start(host, session, params).await,
        "stop" => stop(host, session).await,
        "play" => play(host, session, params).await,
        "remove" => remove(host, params),
        "rename" => rename(host, params),
        other => bail!("take needs action: start, stop, play, remove or rename{}.", if other.is_empty() { String::new() } else { format!(" (not \"{}\")", page_text(other, 20)) }),
    }
}

async fn start(host: &Arc<Host>, session: &Arc<Session>, params: &Value) -> Result<Value> {
    if let Some(open) = session.state.lock().unwrap().take.clone() {
        bail!("Take «{}» is being recorded already, since frame {}. take(action: \"stop\") keeps it.", open["name"].as_str().unwrap_or("?"), open["start"]);
    }

    let name = match params["name"].as_str() {
        Some(name) => {
            path_of(host, name)?;
            name.to_string()
        }
        None => next_name(host),
    };
    let top = session.top()?;
    let status = session.probe(&top, "status", json!({}), SHORT).await?;
    let frame = status["frame"].as_u64().unwrap_or(0);
    let from = params["from"].as_str().unwrap_or("auto");

    if !matches!(from, "auto" | "load" | "checkpoint") {
        bail!("from is load, checkpoint or left out (a checkpoint when the page offers one and the take starts after frame 0).");
    }

    // A checkpoint, when the page can save and restore its state and the take begins part way.
    let mut checkpoint = Value::Null;

    if from == "checkpoint" || (from == "auto" && frame > 0) {
        let said = session.probe(&top, "protocol.describe", json!({ "groups": 0 }), SHORT).await.unwrap_or(Value::Null);

        if said["checkpoint"]["save"] == true && said["checkpoint"]["restore"] == true {
            let saved = session.probe(&top, "protocol.save", json!({}), SHORT).await?;

            checkpoint = saved["state"].clone();
        }

        if from == "checkpoint" && checkpoint.is_null() {
            bail!("The page offers no checkpoint it can restore (checkpoint.provide with save and restore), so a take can only play from its load. Leave from out, or use from: \"load\".");
        }
    }

    let plays_from = if checkpoint.is_null() { "load" } else { "checkpoint" };

    session.state.lock().unwrap().take = Some(json!({ "name": name, "start": frame, "from": plays_from, "checkpoint": checkpoint }));

    Ok(result(
        format!(
            "Recording take «{name}» from frame {frame}. {} Play, or send input; take(action: \"stop\") keeps it.",
            if plays_from == "load" {
                if frame == 0 { "It plays from the page's load.".to_string() } else { format!("It plays from the page's load, with the input before frame {frame} too, so it reaches the same place.") }
            } else {
                format!("The page saved a checkpoint at frame {frame}; the take plays from there.")
            }
        ),
        json!({ "take": name, "start": frame, "from": plays_from }),
    ))
}

async fn stop(host: &Arc<Host>, session: &Arc<Session>) -> Result<Value> {
    let open = session.state.lock().unwrap().take.take().ok_or_else(|| anyhow!("No take is being recorded. take(action: \"start\") begins one."))?;
    let name = open["name"].as_str().unwrap_or("take").to_string();
    let start = open["start"].as_u64().unwrap_or(0);
    let mut run = runs::collect(session).await?;
    let end = run["frames"].as_u64().unwrap_or(0);

    // From a checkpoint, only the input after it is needed.
    if open["from"] == "checkpoint" {
        let after: Vec<Value> = run["events"].as_array().into_iter().flatten().filter(|row| row[0].as_u64().unwrap_or(0) >= start).cloned().collect();

        run["events"] = json!(after);
        run["prints"] = json!([]);
        run["network"] = json!([]);
    }

    let events: Vec<Value> = run["events"].as_array().cloned().unwrap_or_default();
    let words = runs::input_words(&events.iter().filter(|row| row[0].as_u64().unwrap_or(0) >= start).cloned().collect::<Vec<_>>());
    let made = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |since| since.as_secs());

    run["take"] = json!(name);
    run["from"] = open["from"].clone();
    run["start"] = json!(start);
    run["checkpoint"] = open["checkpoint"].clone();
    run["made"] = json!(made);

    let path = path_of(host, &name)?;
    let replaced = path.exists();

    std::fs::create_dir_all(dir(host)).with_context(|| format!("creating {}", dir(host).display()))?;
    std::fs::write(&path, serde_json::to_vec(&run)?).with_context(|| format!("writing {}", path.display()))?;

    let mut lines = vec![format!(
        "Take «{name}»{}: frames {start}–{end} ({} frames) with {words}, playing from {}.",
        if replaced { " (replacing the take of that name)" } else { "" },
        end.saturating_sub(start),
        if open["from"] == "checkpoint" { format!("the checkpoint saved at frame {start}") } else { "the page's load".to_string() }
    )];

    if run["deterministic"].is_null() && open["from"] != "checkpoint" {
        lines.push("This session is not deterministic, so a replay gets the same input but may part from the original. Launch with deterministic: true for takes that reach the same frame every time.".into());
    }

    lines.push(format!("take(action: \"play\", name: \"{name}\") plays it; then: \"capture\" or \"screenshot\" does that where it ends. Its file: {}", path.display()));

    Ok(result(lines.join("\n"), json!({ "take": name, "start": start, "end": end, "events": events.len(), "from": run["from"], "path": path })))
}

async fn play(host: &Arc<Host>, session: &Arc<Session>, params: &Value) -> Result<Value> {
    let name = params["name"].as_str().ok_or_else(|| anyhow!("take(action: \"play\") needs name: a take from takes()."))?;
    let take = load(host, name)?;
    let fast = params["speed"].as_str() != Some("real");
    let then = params["then"].as_str().unwrap_or("pause");

    if !matches!(then, "pause" | "capture" | "screenshot") {
        bail!("then is pause (the default), capture or screenshot.");
    }

    let mut played = if take["from"] == "checkpoint" {
        from_checkpoint(session, &take, name, params, fast).await?
    } else {
        runs::replay(session, &take, name, &json!({ "to_frame": params["to_frame"], "until_mark": params["until_mark"], "fast": fast })).await?
    };

    let summary = played["summary"].as_str().unwrap_or("").replace(&format!(" of {name} "), &format!(" of take «{name}» ")).replace(&format!("Replayed {name} "), &format!("Played take «{name}» "));

    played["summary"] = json!(summary);

    let after = match then {
        "capture" => Some(crate::capture::capture(host, session, &json!({})).await?),
        "screenshot" => Some(crate::commands::screenshot(session, &json!({})).await?),
        _ => None,
    };

    match after {
        // What came after, with the take's own account beside it.
        Some(after) => {
            let mut data = after["data"].clone();

            data["take"] = played["data"].clone();

            Ok(json!({
                "summary": format!("{}\n\n{}", played["summary"].as_str().unwrap_or(""), after["summary"].as_str().unwrap_or("")),
                "data": data,
                "images": after["images"],
            }))
        }
        None => Ok(played),
    }
}

/// Restores the take's checkpoint and gives the input from there, a chunk at a time.
async fn from_checkpoint(session: &Arc<Session>, take: &Value, name: &str, params: &Value, fast: bool) -> Result<Value> {
    let top = session.top()?;
    let restored = session.probe(&top, "protocol.restore", json!({ "state": take["checkpoint"].as_str().unwrap_or("") }), SHORT).await?;

    if restored["unknown"] == true {
        bail!("The page no longer offers a restore, so take «{name}» cannot be played from its checkpoint.");
    }

    let start = take["start"].as_u64().unwrap_or(0);
    let end = take["frames"].as_u64().unwrap_or(start);
    let target = params["to_frame"].as_u64().unwrap_or(end).clamp(start, end);
    let events: Vec<(u64, Value)> = take["events"].as_array().into_iter().flatten().filter_map(|row| Some((row[0].as_u64()?, runs::event_of(row)?))).collect();
    let watched_from = session.state.lock().unwrap().event_seq;
    let mut at = start;
    let mut next = 0;
    let mut stopped_by = None;

    while at < target {
        let stop = (at + 120).min(target);
        let mut chunk = Vec::new();

        while next < events.len() && events[next].0 < stop {
            let mut event = events[next].1.clone();

            event["at"] = json!(events[next].0.saturating_sub(at));
            chunk.push(event);
            next += 1;
        }

        let before = session.probe(&top, "status", json!({}), SHORT).await?["frame"].as_u64().unwrap_or(0);

        step(session, &json!({ "frames": stop - at, "events": chunk, "fast": fast })).await?;

        let after = session.probe(&top, "status", json!({}), SHORT).await?["frame"].as_u64().unwrap_or(before);

        // A watch that broke ends the step early.
        at += after.saturating_sub(before).clamp(1, stop - at);

        if let Some(why) = runs::stop_reason(session, watched_from, params["until_mark"].as_str()) {
            stopped_by = Some(why);
            break;
        }
    }

    let frame = session.probe(&top, "status", json!({}), SHORT).await?["frame"].clone();

    Ok(result(
        match &stopped_by {
            Some(why) => format!("Stopped take «{name}» {} frames after its checkpoint: {why}. Paused at frame {frame}.", at - start),
            None => format!("Played take «{name}» from its checkpoint (saved at frame {start}) for {} frames. Paused at frame {frame}. The page's frame count did not go back with its state.", at - start),
        },
        json!({ "take": name, "from": "checkpoint", "played": at - start, "frame": frame, "stopped_by": stopped_by }),
    ))
}

fn remove(host: &Arc<Host>, params: &Value) -> Result<Value> {
    let name = params["name"].as_str().ok_or_else(|| anyhow!("take(action: \"remove\") needs name."))?;

    load(host, name)?;
    std::fs::remove_file(path_of(host, name)?).context("removing the take")?;

    Ok(result(format!("Removed take «{name}»."), json!({ "removed": name })))
}

fn rename(host: &Arc<Host>, params: &Value) -> Result<Value> {
    let name = params["name"].as_str().ok_or_else(|| anyhow!("take(action: \"rename\") needs name and to."))?;
    let to = params["to"].as_str().ok_or_else(|| anyhow!("take(action: \"rename\") needs to: the new name."))?;
    let mut take = load(host, name)?;
    let target = path_of(host, to)?;

    if target.exists() {
        bail!("There is a take called «{to}» already.");
    }

    take["take"] = json!(to);
    std::fs::write(&target, serde_json::to_vec(&take)?).context("writing the take")?;
    std::fs::remove_file(path_of(host, name)?).context("removing the old name")?;

    Ok(result(format!("Take «{name}» is now «{to}»."), json!({ "take": to })))
}

/// Keeps a run from the page's load as a take of this name (a note's way back to its frame).
pub(crate) fn keep(host: &Host, name: &str, mut run: Value) -> Result<String> {
    let made = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |since| since.as_secs());

    run["take"] = json!(name);
    run["from"] = json!("load");
    run["start"] = json!(0);
    run["checkpoint"] = Value::Null;
    run["made"] = json!(made);

    std::fs::create_dir_all(dir(host)).with_context(|| format!("creating {}", dir(host).display()))?;
    std::fs::write(path_of(host, name)?, serde_json::to_vec(&run)?).context("writing the take")?;

    Ok(name.to_string())
}

pub fn takes(host: &Arc<Host>) -> Result<Value> {
    let all = names(host);

    if all.is_empty() {
        return Ok(result("No takes. take(action: \"start\") records one; the app's Game panel has a Record button.", json!({ "takes": [] })));
    }

    let mut rows = Vec::new();
    let mut lines = vec![format!("{} take{}, newest first:", all.len(), if all.len() == 1 { "" } else { "s" })];

    for name in &all {
        let Ok(take) = load(host, name) else { continue };
        let start = take["start"].as_u64().unwrap_or(0);
        let end = take["frames"].as_u64().unwrap_or(0);
        let events: Vec<Value> = take["events"].as_array().into_iter().flatten().filter(|row| row[0].as_u64().unwrap_or(0) >= start).cloned().collect();
        let row = json!({
            "take": name,
            "url": take["url"],
            "start": start,
            "end": end,
            "from": take["from"],
            "events": events.len(),
            "input": runs::input_words(&events),
            "deterministic": !take["deterministic"].is_null(),
            "made": take["made"],
        });

        lines.push(format!(
            "  {name}  frames {start}–{end}, {}, from {}{}  «{}»",
            row["input"].as_str().unwrap_or(""),
            take["from"].as_str().unwrap_or("load"),
            if take["deterministic"].is_null() { "" } else { ", deterministic" },
            page_text(take["url"].as_str().unwrap_or(""), 80)
        ));
        rows.push(row);
    }

    Ok(result(lines.join("\n"), json!({ "takes": rows })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_take_name_is_a_plain_file_name() {
        assert!(valid("door-glitch"));
        assert!(valid("level_2.boss"));
        assert!(!valid("../escape"));
        assert!(!valid(".hidden"));
        assert!(!valid("a/b"));
        assert!(!valid(""));
        assert!(!valid(&"x".repeat(61)));
    }
}
