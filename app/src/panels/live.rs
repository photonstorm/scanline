//! Live: frame time, CPU and GPU time, the work each frame does, and GPU memory, from
//! stats() and memory() as the page runs; and the game's own objects, from watches().

use std::collections::VecDeque;

use gpui::{AnyElement, Context, MouseButton, SharedString, Window, div, prelude::*, px, rgb};
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
    /// What watches() last said: each watch, its values and their history.
    pub watches: Value,
    /// What the person is typing into, and what they have typed.
    pub entry: Option<Entry>,
    pub typed: String,
    /// New watches stop the game when a rule breaks.
    pub break_new: bool,
}

/// A field in the Objects tab that takes typing.
#[derive(Clone, PartialEq)]
pub enum Entry {
    /// An expression to watch.
    New,
    /// A new value for a watched property.
    Value { name: String, prop: String },
    /// A value to hold an audio node's parameter at (the Game panel).
    Param { node: String, param: String },
    /// A take's new name (the Game panel).
    Rename { name: String },
    /// A note's words, and the words for one of its pins (the Note panel).
    NoteText,
    Pin { index: usize },
}

/// A watched value as words. NaN, infinities and undefined come as { $: name }.
pub fn shown(value: &Value) -> String {
    match value {
        Value::Object(object) => object.get("$").and_then(Value::as_str).unwrap_or("?").to_string(),
        Value::String(text) => format!("\"{text}\""),
        Value::Number(number) => {
            let number = number.as_f64().unwrap_or(0.0);

            if number.fract() == 0.0 && number.abs() < 1e15 { format!("{number:.0}") } else { format!("{number:.4}").trim_end_matches('0').trim_end_matches('.').to_string() }
        }
        other => other.to_string(),
    }
}

/// What the person typed, as the value it means: a number, true or false, null, or else words.
pub fn typed_value(text: &str) -> Value {
    let text = text.trim();

    match text {
        "true" => Value::Bool(true),
        "false" => Value::Bool(false),
        "null" => Value::Null,
        _ => text
            .parse::<f64>()
            .ok()
            .filter(|number| number.is_finite())
            .map(|number| serde_json::json!(number))
            .unwrap_or_else(|| Value::String(text.trim_matches('"').to_string())),
    }
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

pub fn render(player: &mut Player, _window: &mut Window, cx: &mut Context<Player>) -> AnyElement {
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
                .child(note(if player.paused() { "paused" } else { "mean, 30 frames" })),
        )
        .child(graph(live.interval.iter().copied().collect(), 33.4, GREEN, 90.0))
        .child(row(
            "p50 · p95 · max",
            format!("{:.2} · {:.2} · {:.2} ms", number(&stats["intervalMs"]["p50"]), number(&stats["intervalMs"]["p95"]), number(&stats["intervalMs"]["max"])),
        ));

    let gpu_ceiling = live.gpu.iter().copied().fold(4.0f32, f32::max) * 1.2;
    let cpu_ceiling = live.cpu.iter().copied().fold(4.0f32, f32::max) * 1.2;

    let times = card("CPU and GPU", BLUE)
        .child(row("CPU", format!("{cpu:.2} ms (p95 {:.2})", number(&stats["cpuMs"]["p95"]))))
        .child(graph(live.cpu.iter().copied().collect(), cpu_ceiling, AMBER, 56.0))
        .child(row(
            "GPU",
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

                div().flex().flex_col().gap(px(3.0)).child(row(label, format!("{last:.0}  max {max:.0}"))).child(meter(32, (last / max) as f32, AMBER))
            }),
    );

    let memory_ceiling = live.memory_history.iter().copied().fold(1.0f32, f32::max) * 1.25;
    let categories = live.memory["categories"].as_object().cloned().unwrap_or_default();

    let memory = card("GPU memory", PURPLE)
        .child(div().flex().justify_between().items_end().child(figure(bytes(total), PURPLE)).child(note("estimate")))
        .child(graph(live.memory_history.iter().copied().collect(), memory_ceiling, PURPLE, 70.0))
        .children(categories.iter().filter(|(_, value)| number(value) > 0.0).map(|(name, value)| row(name.clone(), bytes(number(value)))))
        .when(process > 0.0, |card| card.child(row("GPU process", bytes(process))))
        .children(live.warnings.iter().map(|warning| div().text_xs().text_color(tint(RED, 1.0)).child(warning.clone())));

    let objects = card("Objects", CYAN).children(
        live.memory["kinds"]
            .as_object()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .map(|(kind, entry)| row(kind, format!("{} live · {} made · {}", entry["alive"], entry["created"], bytes(number(&entry["bytes"]))))),
    );

    let empty = player.session().is_none();
    let wide = player.panel_px >= 780.0;

    let content = move |tab: usize| -> gpui::Div {
        let empty_note = empty.then(|| note("No session."));

        match (tab, wide) {
            // Performance: the meters and the frame's time, then work.
            (0, true) => div()
                .flex()
                .gap_2()
                .children(empty_note)
                .child(div().flex_1().min_w_0().flex().flex_col().gap_2().child(levels).child(frame_time))
                .child(div().flex_1().min_w_0().flex().flex_col().gap_2().child(times).child(work)),
            (0, false) => div().flex().flex_col().gap_2().children(empty_note).child(levels).child(frame_time).child(times).child(work),
            // Memory: GPU memory and the objects that hold it.
            (_, true) => div().flex().gap_2().children(empty_note).child(div().flex_1().min_w_0().child(memory)).child(div().flex_1().min_w_0().child(objects)),
            (_, false) => div().flex().flex_col().gap_2().children(empty_note).child(memory).child(objects),
        }
    };

    let tab = player.tab("live").min(2);
    let chosen = if tab == 2 { watched(player, cx) } else { content(tab) };

    crate::panels::tabbed(player, "live", "Live", GREEN, &["Performance", "Memory", "Objects"], cx, chosen)
}

/// A series of values scaled to fit 0 to 1, for a small graph. Values that are not numbers
/// (NaN, undefined) sit at the bottom.
fn scaled(values: &[Value]) -> Option<Vec<f32>> {
    let numbers: Vec<Option<f64>> = values.iter().map(Value::as_f64).collect();

    if numbers.iter().all(Option::is_none) || values.iter().any(|value| value.is_string() || value.is_boolean()) {
        return None;
    }

    let known: Vec<f64> = numbers.iter().flatten().copied().collect();
    let low = known.iter().copied().fold(f64::INFINITY, f64::min);
    let high = known.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let span = if high > low { high - low } else { 1.0 };

    Some(numbers.iter().map(|number| number.map_or(0.0, |number| (0.1 + 0.8 * (number - low) / span) as f32)).collect())
}

/// The Objects tab: what the game's watches read, frame by frame, with a field to add one and
/// each value editable in place.
fn watched(player: &Player, cx: &mut Context<Player>) -> gpui::Div {
    let live = &player.live;
    let typing_new = live.entry == Some(Entry::New);
    let shown_text = if typing_new { format!("{}▏", live.typed) } else { "game.player".to_string() };

    let field = div()
        .id("watch-field")
        .track_focus(&player.watch_focus)
        .flex_1()
        .min_w_0()
        .flex()
        .items_center()
        .gap_2()
        .px_2()
        .h(px(28.0))
        .rounded(px(6.0))
        .text_xs()
        .font_family(MONO)
        .bg(rgb(FIELD))
        .border_1()
        .border_color(if typing_new { tint(CYAN, 0.8) } else { rgb(LINE) })
        .text_color(if typing_new { rgb(TEXT) } else { rgb(DIM) })
        .overflow_hidden()
        .whitespace_nowrap()
        .cursor_text()
        .on_mouse_down(
            MouseButton::Left,
            cx.listener(|this, _, window, cx| {
                cx.stop_propagation();
                this.start_watch_entry(Entry::New, String::new(), window, cx);
            }),
        )
        .on_key_down(cx.listener(|this, event: &gpui::KeyDownEvent, _, cx| this.type_watch(event, cx)))
        .child(crate::icons::icon("eye", 12.0, tint(DIM, 1.0)))
        .child(shown_text);

    let adding = div()
        .flex()
        .gap_2()
        .items_center()
        .child(field)
        .child(button("watch-add", "Watch", CYAN).on_click(cx.listener(|this, _, _, cx| {
            this.commit_watch_entry();
            cx.notify();
        })))
        .child(
            group().child(
                tab_button("watch-break", "Stop on break", RED, live.break_new).on_click(cx.listener(|this, _, _, cx| {
                    this.live.break_new = !this.live.break_new;
                    cx.notify();
                })),
            ),
        );

    let list = live.watches["watches"].as_array().cloned().unwrap_or_default();

    if player.session().is_none() {
        return div().flex().flex_col().gap_2().child(note("No session."));
    }

    if list.is_empty() {
        return div().flex().flex_col().gap_2().child(adding).child(note(
            "Nothing watched. Type an expression that reaches an object or a value, such as game.player. A game can add its own with __scanline.watch(name, object).",
        ));
    }

    let editing = live.entry.clone();
    let typed = live.typed.clone();

    let cards = list.iter().enumerate().map(|(index, watch)| {
        let name = watch["name"].as_str().unwrap_or("").to_string();
        let history = &watch["history"]["values"];
        let broken_any = watch["props"].as_array().into_iter().flatten().any(|prop| prop["broken"] == true);
        let source = match (watch["source"].as_str(), watch["kind"].as_str()) {
            (Some("page"), Some(kind)) => format!("game's {kind}"),
            (Some("page"), None) => "game's".to_string(),
            _ => "expression".to_string(),
        };
        let removing = name.clone();

        let title = div()
            .flex()
            .items_center()
            .gap_2()
            .child(div().flex_none().w(px(3.0)).h(px(12.0)).rounded(px(1.5)).bg(rgb(if broken_any { RED } else { CYAN })))
            .child(div().flex_1().min_w_0().overflow_hidden().whitespace_nowrap().text_sm().font_weight(gpui::FontWeight::SEMIBOLD).text_color(rgb(TEXT)).child(name.clone()))
            .child(note(source))
            .child(icon_button(SharedString::from(format!("unwatch-{index}")), "close", DIM, false).on_click(cx.listener(move |this, _, _, cx| {
                this.remove_watch(&removing);
                cx.notify();
            })));

        let rows = watch["props"].as_array().cloned().unwrap_or_default().into_iter().enumerate().map(|(row, prop)| {
            let key = prop["prop"].as_str().unwrap_or("").to_string();
            let broken = prop["broken"] == true;
            let here = Entry::Value { name: name.clone(), prop: key.clone() };
            let is_editing = editing.as_ref() == Some(&here);
            let value_text = if is_editing { format!("{typed}▏") } else { shown(&prop["value"]) };
            let current = shown(&prop["value"]).trim_matches('"').to_string();
            let series = history[key.as_str()].as_array().and_then(|values| scaled(values));
            let colour = if broken { RED } else { CYAN };

            div()
                .flex()
                .items_center()
                .gap_2()
                .h(px(24.0))
                .text_xs()
                .child(div().w(px(130.0)).flex_none().overflow_hidden().whitespace_nowrap().text_color(rgb(DIM)).child(if key.is_empty() { "value".to_string() } else { key.clone() }))
                .child(
                    div()
                        .id(SharedString::from(format!("watch-{index}-{row}")))
                        .w(px(110.0))
                        .flex_none()
                        .px_1p5()
                        .h(px(20.0))
                        .flex()
                        .items_center()
                        .rounded(px(4.0))
                        .font_family(MONO)
                        .overflow_hidden()
                        .whitespace_nowrap()
                        .cursor_text()
                        .text_color(if broken { tint(RED, 1.0) } else { rgb(TEXT) })
                        .when(is_editing, |cell| cell.bg(rgb(FIELD)).border_1().border_color(tint(CYAN, 0.8)))
                        .hover(|cell| cell.bg(rgb(RAISED)))
                        .on_mouse_down(
                            MouseButton::Left,
                            cx.listener(move |this, _, window, cx| {
                                cx.stop_propagation();
                                this.start_watch_entry(here.clone(), current.clone(), window, cx);
                            }),
                        )
                        .child(value_text),
                )
                .child(div().flex_1().min_w_0().children(series.map(|values| graph(values, 1.0, colour, 20.0))))
        });

        let broken = watch["broken"].as_array().cloned().unwrap_or_default().into_iter().rev().take(3).map(|broken| {
            let prop = broken["prop"].as_str().unwrap_or("");

            div().text_xs().text_color(tint(RED, 1.0)).child(format!(
                "Frame {}: {} broke {} ({} → {})",
                broken["frame"],
                if prop.is_empty() { "the value" } else { prop },
                broken["rule"].as_str().unwrap_or("?"),
                shown(&broken["before"]),
                shown(&broken["after"])
            ))
        });

        let error = watch["error"].as_str().map(|error| div().text_xs().text_color(tint(AMBER, 1.0)).child(format!("Reading it threw: {error}")));

        div()
            .flex()
            .flex_col()
            .gap_1()
            .p_3()
            .rounded(px(7.0))
            .bg(rgb(CARD))
            .border_1()
            .border_color(if broken_any { tint(RED, 0.5) } else { rgb(LINE) })
            .child(title)
            .children(error)
            .children(rows)
            .children(broken)
    });

    let cost = &live.watches["cost"];
    let footer = note(format!(
        "{} properties · {:.3} ms a frame{}",
        cost["props"],
        cost["ms"].as_f64().unwrap_or(0.0),
        if cost["thinned"] == true { " · read every other frame" } else { "" }
    ));

    div().flex().flex_col().gap_2().child(adding).children(cards).child(footer)
}
