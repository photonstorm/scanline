//! Console: what the page and the browser said, by frame, from console().

use gpui::{AnyElement, Context, Window, div, prelude::*, px, rgb, uniform_list};
use serde_json::Value;

use crate::player::Player;
use crate::theme::*;

#[derive(Default)]
pub struct State {
    pub lines: Vec<Value>,
    pub next: u64,
    pub only: Option<&'static str>,
    pub errors_unseen: usize,
}

impl State {
    pub fn receive(&mut self, data: &Value) {
        let mut fresh: Vec<Value> = data["lines"].as_array().cloned().unwrap_or_default();

        // Oldest first, whichever way they come.
        fresh.sort_by_key(|line| line["seq"].as_u64().or(line["cursor"].as_u64()).unwrap_or(0));
        self.errors_unseen += fresh.iter().filter(|line| line["level"] == "error").count();
        self.lines.extend(fresh);

        if self.lines.len() > 5000 {
            let extra = self.lines.len() - 5000;

            self.lines.drain(..extra);
        }

        if let Some(next) = data["next"].as_u64() {
            self.next = self.next.max(next);
        }
    }

    fn shown(&self) -> Vec<Value> {
        self.lines
            .iter()
            .filter(|line| match self.only {
                Some("error") => line["level"] == "error",
                Some("warning") => line["level"] == "error" || line["level"] == "warning",
                _ => true,
            })
            .cloned()
            .collect()
    }
}

fn colour(level: &str) -> u32 {
    match level {
        "error" => RED,
        "warning" => AMBER,
        "debug" | "verbose" => DIM,
        _ => TEXT,
    }
}

pub fn render(player: &mut Player, _window: &mut Window, cx: &mut Context<Player>) -> AnyElement {
    player.console.errors_unseen = 0;

    let shown = player.console.shown();
    let count = shown.len();
    let only = player.console.only;

    let filters = div().flex().gap_1().children([(None, "All"), (Some("warning"), "Warnings"), (Some("error"), "Errors")].into_iter().map(|(level, label)| {
        let on = only == level;

        button(format!("console-{label}"), label, if on { CYAN } else { DIM }).on_click(cx.listener(move |this, _, _, cx| {
            this.console.only = level;
            cx.notify();
        }))
    }));

    let list = uniform_list(
        "console-lines",
        count,
        cx.processor(move |this, range: std::ops::Range<usize>, _, _| {
            let shown = this.console.shown();

            range
                .filter_map(|index| shown.get(index).cloned().map(|line| (index, line)))
                .map(|(index, line)| {
                    let level = line["level"].as_str().unwrap_or("log").to_string();
                    let frame = line["frame"].as_u64().map(|frame| format!("{frame}")).unwrap_or_default();
                    let repeats = line["count"].as_u64().filter(|count| *count > 1).map(|count| format!(" ×{count}")).unwrap_or_default();
                    let text = line["text"].as_str().unwrap_or("").lines().next().unwrap_or("").chars().take(400).collect::<String>();

                    div()
                        .id(index)
                        .w_full()
                        .flex()
                        .gap_2()
                        .px_1()
                        .py(px(2.0))
                        .text_xs()
                        .bg(if index % 2 == 0 { tint(TEXT, 0.025) } else { tint(TEXT, 0.0) })
                        .child(div().w(px(44.0)).flex_none().font_family(MONO).text_color(rgb(DIM)).child(frame))
                        .child(div().flex_1().min_w_0().overflow_hidden().whitespace_nowrap().text_color(rgb(colour(&level))).child(format!("{text}{repeats}")))
                })
                .collect()
        }),
    )
    .flex_1()
    .min_h(px(200.0));

    div()
        .size_full()
        .flex()
        .flex_col()
        .gap_2()
        .p_3()
        .child(div().flex().justify_between().items_center().child(heading("Console", CYAN).text_xl()).child(filters))
        .child(note(if count == 0 { "Nothing logged yet." } else { "Frame, then the line. Repeats are folded." }))
        .child(list)
        .into_any_element()
}
