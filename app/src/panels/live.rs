//! Live: frame time, CPU and GPU time, the work each frame does, and GPU memory, from
//! stats() and memory() as the page runs.

use std::collections::VecDeque;

use gpui::{AnyElement, Context, Window, div, prelude::*, px};
use serde_json::Value;

use crate::player::Player;
use crate::theme::*;

const HISTORY: usize = 160;

#[derive(Default)]
pub struct State {
    pub interval: VecDeque<f32>,
    pub cpu: VecDeque<f32>,
    pub gpu: VecDeque<f32>,
    pub memory_history: VecDeque<f32>,
    pub last: Value,
    pub memory: Value,
    pub warnings: Vec<String>,
    last_frame: u64,
}

fn push(series: &mut VecDeque<f32>, value: f32) {
    series.push_back(value);

    while series.len() > HISTORY {
        series.pop_front();
    }
}

impl State {
    pub fn stats(&mut self, data: &Value) {
        let frame = data["lastFrame"].as_u64().unwrap_or(0);

        self.last = data.clone();

        // A paused page reports the same frames again: nothing new to plot.
        if frame == 0 || frame == self.last_frame {
            return;
        }

        self.last_frame = frame;
        push(&mut self.interval, data["intervalMs"]["mean"].as_f64().unwrap_or(0.0) as f32);
        push(&mut self.cpu, data["cpuMs"]["mean"].as_f64().unwrap_or(0.0) as f32);
        push(&mut self.gpu, data["gpu"]["ms"]["mean"].as_f64().unwrap_or(0.0) as f32);
    }

    pub fn memory(&mut self, value: &Value) {
        self.memory = value["data"].clone();
        push(&mut self.memory_history, self.memory["total_bytes"].as_f64().unwrap_or(0.0) as f32);

        // The host's words for a likely leak or churn, as it gives them.
        self.warnings = value["summary"]
            .as_str()
            .unwrap_or("")
            .lines()
            .filter(|line| {
                let lower = line.to_lowercase();

                lower.contains("leak") || lower.contains("churn")
            })
            .map(|line| line.trim().to_string())
            .collect();
    }
}

fn number(value: &Value) -> f64 {
    value.as_f64().unwrap_or(0.0)
}

pub fn render(player: &mut Player, _window: &mut Window, _cx: &mut Context<Player>) -> AnyElement {
    let live = &player.live;
    let stats = &live.last;
    let interval = number(&stats["intervalMs"]["mean"]);
    let rate = if interval > 0.0 && !player.paused() { 1000.0 / interval } else { 0.0 };
    let cpu = number(&stats["cpuMs"]["mean"]);
    let gpu = number(&stats["gpu"]["ms"]["mean"]);
    let total = number(&live.memory["total_bytes"]);
    let process = number(&live.memory["gpu_process_bytes"]);
    let budget = (total * 2.0).max(256.0 * 1048576.0);
    let counters = &stats["counters"];

    let levels = card("Now", GREEN).child(
        div().flex().justify_between().px_2().children(
            [
                ("FPS", format!("{rate:.0}"), (rate / 120.0) as f32, GREEN),
                ("CPU ms", format!("{cpu:.2}"), (cpu / 16.7) as f32, AMBER),
                ("GPU ms", format!("{gpu:.2}"), (gpu / 16.7) as f32, BLUE),
                ("Memory", bytes(total), (total / budget) as f32, PURPLE),
            ]
            .into_iter()
            .map(|(label, value, fraction, colour)| {
                div()
                    .flex()
                    .flex_col()
                    .items_center()
                    .gap_1()
                    .child(div().text_xs().text_color(tint(colour, 0.9)).child(label))
                    .child(column_meter(18, fraction, colour, 120.0))
                    .child(div().text_xs().font_family(MONO).text_color(tint(colour, 1.0)).child(value))
            }),
        ),
    );

    let frame_time = card("Frame time", GREEN)
        .child(
            div()
                .flex()
                .justify_between()
                .items_end()
                .child(figure(if interval > 0.0 { format!("{interval:.2} ms") } else { "–".into() }, GREEN))
                .child(note(if player.paused() { "paused" } else { "mean of the last 30 frames" })),
        )
        .child(graph(live.interval.iter().copied().collect(), 33.4, GREEN, 90.0))
        .child(row(
            "p50 · p95 · worst",
            format!("{:.2} · {:.2} · {:.2} ms", number(&stats["intervalMs"]["p50"]), number(&stats["intervalMs"]["p95"]), number(&stats["intervalMs"]["max"])),
        ));

    let gpu_ceiling = live.gpu.iter().copied().fold(4.0f32, f32::max) * 1.2;
    let cpu_ceiling = live.cpu.iter().copied().fold(4.0f32, f32::max) * 1.2;

    let times = card("CPU and GPU time per frame", BLUE)
        .child(row("CPU, the page's frame callback", format!("{cpu:.2} ms (p95 {:.2})", number(&stats["cpuMs"]["p95"]))))
        .child(graph(live.cpu.iter().copied().collect(), cpu_ceiling, AMBER, 56.0))
        .child(row(
            if stats["gpu"]["timestamps"] == true { "GPU, timed by the GPU" } else { "GPU, from timer queries" },
            format!("{gpu:.3} ms (p95 {:.3})", number(&stats["gpu"]["ms"]["p95"])),
        ))
        .child(graph(live.gpu.iter().copied().collect(), gpu_ceiling, BLUE, 56.0));

    let work = card("Work per frame", AMBER).children(
        [("draws", "draws"), ("calls", "calls"), ("triangles", "triangles"), ("instances", "instances"), ("passes", "passes"), ("dispatches", "dispatches")]
            .into_iter()
            .filter(|(key, _)| counters[*key]["max"].as_f64().unwrap_or(0.0) > 0.0 || *key == "draws" || *key == "calls")
            .map(|(key, label)| {
                let last = number(&counters[key]["last"]);
                let max = number(&counters[key]["max"]).max(1.0);

                div().flex().flex_col().gap(px(3.0)).child(row(label, format!("{last:.0}  (most {max:.0})"))).child(meter(32, (last / max) as f32, AMBER))
            }),
    );

    let memory_ceiling = live.memory_history.iter().copied().fold(1.0f32, f32::max) * 1.25;
    let categories = live.memory["categories"].as_object().cloned().unwrap_or_default();

    let memory = card("GPU memory", PURPLE)
        .child(div().flex().justify_between().items_end().child(figure(bytes(total), PURPLE)).child(note("estimated from sizes and formats")))
        .child(graph(live.memory_history.iter().copied().collect(), memory_ceiling, PURPLE, 70.0))
        .children(categories.iter().filter(|(_, value)| number(value) > 0.0).map(|(name, value)| row(name.clone(), bytes(number(value)))))
        .when(process > 0.0, |card| card.child(row("the GPU process, as the system counts it", bytes(process))))
        .children(live.warnings.iter().map(|warning| div().text_xs().text_color(tint(RED, 1.0)).child(warning.clone())));

    let objects = card("Objects alive", CYAN).children(
        live.memory["kinds"]
            .as_object()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .map(|(kind, entry)| row(kind, format!("{} alive · {} made · {}", entry["alive"], entry["created"], bytes(number(&entry["bytes"]))))),
    );

    let empty = player.session().is_none();

    crate::panels::frame(
        "live",
        "Live",
        GREEN,
        div()
            .flex()
            .flex_col()
            .gap_2()
            .when(empty, |content| content.child(note("This window has no session, so there is nothing to measure.")))
            .child(levels)
            .child(frame_time)
            .child(times)
            .child(work)
            .child(memory)
            .child(objects),
    )
}
