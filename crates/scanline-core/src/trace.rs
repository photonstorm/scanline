//! A browser trace for a window of frames (04-AGENT-INTERFACE.md, `gfx_trace`): what the
//! browser's own processes did while the page drew, which no hook in the page can see.
//!
//! The page's calls are only the first half of a frame. The GPU process then validates and
//! translates them and hands them to the driver, and the compositor presents the result.
//! A trace shows how long each of those was busy, and whether frames reached the screen.

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use anyhow::{Context, Result};
use serde_json::{Value, json};

use crate::commands::{page_text, step};
use crate::result;
use crate::session::Session;

const CATEGORIES: &[&str] = &["gpu", "viz", "cc", "benchmark", "toplevel", "disabled-by-default-gpu.service", "disabled-by-default-gpu.dawn"];

/// How long a thread was doing something: the union of its slices, so nested ones count once.
fn busy(mut slices: Vec<(f64, f64)>) -> f64 {
    slices.sort_by(|a, b| a.0.total_cmp(&b.0));

    let mut total = 0.0;
    let mut end = f64::NEG_INFINITY;

    for (start, stop) in slices {
        if start > end {
            total += stop - start;
            end = stop;
        } else if stop > end {
            total += stop - end;
            end = stop;
        }
    }

    total
}

pub async fn trace(session: &Arc<Session>, params: &Value) -> Result<Value> {
    let frames = params["frames"].as_u64().unwrap_or(60).clamp(1, 3000);
    let categories: Vec<String> = match params["categories"].as_array() {
        Some(list) => list.iter().filter_map(Value::as_str).map(str::to_string).collect(),
        None => match params["categories"].as_str() {
            Some(text) => text.split(',').map(|part| part.trim().to_string()).filter(|part| !part.is_empty()).collect(),
            None => CATEGORIES.iter().map(|name| name.to_string()).collect(),
        },
    };

    let (stepped, events) = session.traced(&categories, step(session, &json!({ "frames": frames, "observe": { "state": false } }))).await?;
    let stepped = stepped?;

    // Who is who.
    let mut processes: HashMap<i64, String> = HashMap::new();
    let mut threads: HashMap<(i64, i64), String> = HashMap::new();

    for event in &events {
        if event["ph"] == "M" {
            let (pid, tid) = (event["pid"].as_i64().unwrap_or(0), event["tid"].as_i64().unwrap_or(0));
            let name = event["args"]["name"].as_str().unwrap_or("").to_string();

            match event["name"].as_str() {
                Some("process_name") => {
                    processes.insert(pid, name);
                }
                Some("thread_name") => {
                    threads.insert((pid, tid), name);
                }
                _ => {}
            }
        }
    }

    // Slices by thread, and by name within the GPU process.
    let mut slices: BTreeMap<(i64, i64), Vec<(f64, f64)>> = BTreeMap::new();
    let mut names: BTreeMap<String, (f64, u64)> = BTreeMap::new();
    let mut outcomes: BTreeMap<String, u64> = BTreeMap::new();
    let mut swaps = 0u64;
    let gpu_process = |pid: i64| processes.get(&pid).is_some_and(|name| name.contains("GPU"));

    for event in &events {
        let (pid, tid) = (event["pid"].as_i64().unwrap_or(0), event["tid"].as_i64().unwrap_or(0));
        let name = event["name"].as_str().unwrap_or("");

        if event["ph"] == "X" {
            let (start, length) = (event["ts"].as_f64().unwrap_or(0.0), event["dur"].as_f64().unwrap_or(0.0));

            slices.entry((pid, tid)).or_default().push((start, start + length));

            if gpu_process(pid) {
                let entry = names.entry(name.to_string()).or_default();

                entry.0 += length;
                entry.1 += 1;
            }
        }

        // What became of each frame the compositor set out to make.
        if name == "PipelineReporter" {
            if let Some(status) = event["args"]["termination_status"].as_str().or(event["args"]["chrome_frame_reporter"]["state"].as_str()) {
                *outcomes.entry(status.to_lowercase()).or_default() += 1;
            }
        }

        // One buffer swap in the GPU process is one frame handed on for display.
        if name == "SkiaOutputSurfaceImplOnGpu::SwapBuffers" && event["ph"] == "X" {
            swaps += 1;
        }
    }

    let milli = |micro: f64| micro / 1000.0;
    let mut lines = vec![format!(
        "Browser trace over {frames} frames (frames {}–{}): {} events from {} processes. gpu-measured, by the browser's own instrumentation.",
        stepped["data"]["frame"].as_u64().unwrap_or(frames).saturating_sub(frames - 1),
        stepped["data"]["frame"],
        events.len(),
        processes.len()
    )];

    // The threads that matter for rendering, busiest first.
    let mut rows: Vec<(String, String, f64)> = slices
        .into_iter()
        .map(|((pid, tid), list)| {
            (
                processes.get(&pid).cloned().unwrap_or_else(|| format!("process {pid}")),
                threads.get(&(pid, tid)).cloned().unwrap_or_else(|| format!("thread {tid}")),
                busy(list),
            )
        })
        .filter(|row| row.2 > 0.0)
        .collect();

    rows.sort_by(|a, b| b.2.total_cmp(&a.2));

    let gpu_main = rows.iter().find(|row| row.0.contains("GPU") && row.1.contains("GpuMain")).map(|row| row.2);

    match gpu_main {
        Some(time) => lines.push(format!(
            "The GPU process's main thread was busy for {:.2} ms, {:.3} ms a frame: decoding the page's commands, validating them and calling the driver. This is CPU time in the GPU process, not time on the GPU.",
            milli(time),
            milli(time) / frames as f64
        )),
        None => lines.push("No slices were recorded on the GPU process's main thread. The gpu categories may be off in this browser.".into()),
    }

    lines.push("Busiest threads (time with any slice open):".into());

    for (process, thread, time) in rows.iter().take(8) {
        lines.push(format!("  {:>9.2} ms  {:.3} a frame  {} / {}", milli(*time), milli(*time) / frames as f64, page_text(process, 30), page_text(thread, 40)));
    }

    let mut ranked: Vec<(&String, &(f64, u64))> = names.iter().collect();

    ranked.sort_by(|a, b| b.1.0.total_cmp(&a.1.0));

    if !ranked.is_empty() {
        lines.push("In the GPU process, by what it was doing (slices of one name summed; a slice inside another is counted in both):".into());

        for (name, (time, count)) in ranked.iter().take(10) {
            lines.push(format!("  {:>9.2} ms  ×{count:<6} {}", milli(*time), page_text(name, 70)));
        }
    }

    // Frames as the compositor saw them.
    if outcomes.is_empty() && swaps == 0 {
        lines.push(
            "The compositor reported no frames presented or dropped in this window. A headless session has no display to present to, and a stepped frame is drawn without waiting for one: trace a session with a window, running at its own pace, for presentation."
                .into(),
        );
    } else {
        let listed: Vec<String> = outcomes.iter().map(|(status, count)| format!("{count} {}", status.replace('_', " "))).collect();

        lines.push(format!(
            "Frames as the browser's compositor saw them: {}{}.",
            if swaps > 0 {
                format!("{swaps} buffer swaps in the GPU process (a frame handed on for display) over the {frames} frames stepped")
            } else {
                "no buffer swaps".to_string()
            },
            if listed.is_empty() { String::new() } else { format!("; outcomes it reported: {}", listed.join(", ")) }
        ));
    }

    // The whole trace, in the format chrome://tracing and Perfetto open.
    let dir = session.dir.join("traces");

    std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;

    let number = std::fs::read_dir(&dir).map(|entries| entries.count()).unwrap_or(0) + 1;
    let path = dir.join(format!("trace-{number:03}.json"));

    std::fs::write(&path, serde_json::to_vec(&json!({ "traceEvents": events }))?).with_context(|| format!("writing {}", path.display()))?;
    lines.push(format!("The whole trace: {} (opens in ui.perfetto.dev or chrome://tracing).", path.display()));

    Ok(result(
        lines.join("\n"),
        json!({
            "frames": frames,
            "events": events.len(),
            "path": path,
            "categories": categories,
            "gpu_main_thread_ms": gpu_main.map(milli),
            "threads": rows.iter().take(20).map(|(process, thread, time)| json!({ "process": process, "thread": thread, "busy_ms": milli(*time) })).collect::<Vec<_>>(),
            "gpu_process_slices": ranked.iter().take(30).map(|(name, (time, count))| json!({ "name": name, "ms": milli(*time), "count": count })).collect::<Vec<_>>(),
            "frame_outcomes": outcomes,
            "swaps": swaps,
            "provenance": "gpu-measured",
        }),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn busy_time_counts_nested_slices_once() {
        // Two slices, the second inside the first; then one that overlaps; then one apart.
        assert_eq!(busy(vec![(0.0, 10.0), (2.0, 5.0), (8.0, 14.0), (20.0, 21.0)]), 15.0);
        assert_eq!(busy(Vec::new()), 0.0);
    }
}
