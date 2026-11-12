//! Agent: every command the agent runs, and what the person does, from activity(); and what
//! the agent has asked the person, with Debug to answer it.

use std::collections::HashSet;

use gpui::{AnyElement, Context, Window, div, prelude::*, px, rgb};
use serde_json::Value;

use crate::player::Player;
use crate::theme::*;

#[derive(Default)]
pub struct State {
    pub rows: Vec<Value>,
    pub next: u64,
    pub open: HashSet<u64>,
}

impl State {
    /// The host's log covers every session: what names another session is left out.
    pub fn receive(&mut self, data: &Value, session: Option<&str>) {
        let mine = |row: &Value| {
            let named = row["arguments"]
                .as_str()
                .and_then(|text| serde_json::from_str::<Value>(text).ok())
                .and_then(|arguments| arguments["session"].as_str().map(str::to_string));

            match (named, session) {
                (Some(named), Some(session)) => named == session,
                _ => true,
            }
        };
        let session_rows: Vec<Value> = data["activity"].as_array().cloned().unwrap_or_default().into_iter().filter(mine).collect();

        self.rows.extend(session_rows);

        if self.rows.len() > 2000 {
            let extra = self.rows.len() - 2000;

            self.rows.drain(..extra);
        }

        if let Some(next) = data["next"].as_u64() {
            self.next = self.next.max(next);
        }
    }
}

pub fn render(player: &mut Player, _window: &mut Window, cx: &mut Context<Player>) -> AnyElement {
    let request = player.status["request"].clone();
    let human = player.status["owner"] == "human";

    let asked = request["instruction"].as_str().map(|instruction| {
        card("The agent asks you", AMBER)
            .child(div().text_sm().text_color(rgb(TEXT)).child(format!("«{instruction}»")))
            .child(note("Play until it happens, then press Debug: the frames before the press are kept for the agent."))
            .child(div().flex().gap_2().child(button("agent-debug", "⚑  Debug", RED).on_click(cx.listener(|this, _, _, cx| {
                this.debug();
                cx.notify();
            }))))
    });

    let rows: Vec<Value> = player.agent.rows.iter().rev().cloned().collect();

    let list = div().flex().flex_col().gap_1().children(rows.into_iter().take(300).map(|entry| {
        let seq = entry["seq"].as_u64().unwrap_or(0);
        let open = player.agent.open.contains(&seq);
        let person = entry["by"] == "person";
        let ok = entry["ok"] == true;
        let colour = if !ok {
            RED
        } else if person {
            AMBER
        } else {
            BLUE
        };
        let result = entry["result"].as_str().unwrap_or("").to_string();
        let first = result.lines().next().unwrap_or("").to_string();
        let arguments = entry["arguments"].as_str().unwrap_or("").to_string();
        let arguments = if arguments == "{}" { String::new() } else { arguments };

        div()
            .id(("activity", seq as usize))
            .flex()
            .flex_col()
            .gap(px(2.0))
            .p_2()
            .rounded_md()
            .bg(tint(colour, 0.06))
            .border_l_2()
            .border_color(tint(colour, 0.8))
            .cursor_pointer()
            .on_click(cx.listener(move |this, _, _, cx| {
                if !this.agent.open.remove(&seq) {
                    this.agent.open.insert(seq);
                }

                cx.notify();
            }))
            .child(
                div()
                    .flex()
                    .gap_2()
                    .text_xs()
                    .child(div().text_color(tint(colour, 1.0)).child(if person { "you" } else { "agent" }))
                    .child(div().font_family(MONO).text_color(rgb(TEXT)).child(entry["command"].as_str().unwrap_or("").to_string()))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .overflow_hidden()
                            .whitespace_nowrap()
                            .text_color(rgb(DIM))
                            .child(arguments.chars().take(120).collect::<String>()),
                    )
                    .child(div().flex_none().font_family(MONO).text_color(rgb(DIM)).child(format!("{} ms", entry["ms"].as_f64().unwrap_or(0.0).round()))),
            )
            .child(if open {
                div().text_xs().font_family(MONO).text_color(rgb(TEXT)).whitespace_normal().child(result)
            } else {
                div().text_xs().text_color(rgb(if ok { DIM } else { RED })).overflow_hidden().whitespace_nowrap().child(first)
            })
    }));

    crate::panels::frame(
        "agent",
        "Agent",
        BLUE,
        div()
            .flex()
            .flex_col()
            .gap_2()
            .when_some(asked, |content, asked| content.child(asked))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap_1p5()
                    .child(note(if human {
                        "You have the input. The agent can look, but not move time or send input."
                    } else {
                        "Newest first. Click a line to read all of it."
                    }))
                    .when(human, |bar| {
                        bar.child(button("give-back", "Give the agent the input", BLUE).on_click(cx.listener(|this, _, _, cx| {
                            this.take_input(false);
                            cx.notify();
                        })))
                    }),
            )
            .when(player.agent.rows.is_empty(), |content| content.child(note("No commands yet. An agent's work on this session appears here as it happens.")))
            .child(list),
    )
}
