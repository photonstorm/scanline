//! Captures: the session's captured frames; one opened to its draws, the target as it stood
//! after the chosen one, and that draw's state; "Worth a look" first; Send to agent.

use std::path::PathBuf;

use gpui::{AnyElement, Context, ObjectFit, Window, div, img, prelude::*, px, rgb, uniform_list};
use serde_json::Value;

use crate::player::Player;
use crate::theme::*;

#[derive(Default)]
pub struct State {
    pub rows: Vec<Value>,
    pub opened: Option<String>,
    pub made: Option<Value>,
    pub events: Vec<Value>,
    pub selected: Option<i64>,
    pub draw: Option<Value>,
    pub target: Option<PathBuf>,
    pub error: Option<String>,
    pub want_draw: Option<i64>,
    pub loading: bool,
}

impl State {
    pub fn list(&mut self, data: &Value) {
        self.rows = data["captures"].as_array().cloned().unwrap_or_default();

        // A capture opened before the list came (an agent showed it) gets its facts now.
        if let Some(opened) = &self.opened {
            if self.made.as_ref().and_then(|made| made["capture"].as_str()) != Some(opened.as_str()) {
                self.made = self.rows.iter().find(|row| row["capture"].as_str() == Some(opened.as_str())).cloned();
            }
        }
    }

    /// What capture() said of a capture just made: its findings and counts.
    pub fn made(&mut self, data: &Value) {
        self.made = Some(data.clone());
    }

    pub fn open(&mut self, capture: &str) {
        if self.opened.as_deref() != Some(capture) {
            self.events.clear();
            self.selected = None;
            self.draw = None;
            self.target = None;

            if self.made.as_ref().and_then(|made| made["capture"].as_str()) != Some(capture) {
                self.made = self.rows.iter().find(|row| row["capture"].as_str() == Some(capture)).cloned();
            }
        }

        self.opened = Some(capture.to_string());
        self.error = None;
        self.loading = true;
    }

    /// The capture's events. Returns the one to show first: the one asked for, else the last
    /// draw, which made the frame's final picture.
    pub fn events(&mut self, capture: &str, data: &Value) -> Option<i64> {
        if self.opened.as_deref() != Some(capture) {
            return None;
        }

        self.loading = false;
        self.events = data["events"].as_array().cloned().unwrap_or_default();

        self.want_draw
            .take()
            .or_else(|| self.events.iter().rev().find(|event| event["kind"] == "draw").or(self.events.last()).and_then(|event| event["draw"].as_i64()))
    }

    pub fn select(&mut self, draw: i64) {
        self.selected = Some(draw);
        self.draw = None;
        self.error = None;
    }

    pub fn draw(&mut self, capture: &str, draw: i64, data: &Value) {
        if self.opened.as_deref() == Some(capture) && self.selected == Some(draw) {
            self.draw = Some(data.clone());
        }
    }

    pub fn target(&mut self, capture: &str, draw: i64, value: &Value) {
        if self.opened.as_deref() == Some(capture) && self.selected == Some(draw) {
            self.target = value["images"]
                .as_array()
                .and_then(|images| images.first())
                .and_then(|image| image["view"].as_str().or(image["original"].as_str()))
                .map(PathBuf::from);
        }
    }

    pub fn failed(&mut self, capture: &str, draw: i64, error: String) {
        if self.opened.as_deref() == Some(capture) && self.selected == Some(draw) {
            self.error = Some(error);
        }
    }
}

fn event_line(event: &Value) -> String {
    let what = event["entity"].as_str().or(event["path"].as_str()).unwrap_or("");
    let method = event["method"].as_str().unwrap_or(event["kind"].as_str().unwrap_or(""));
    let count = event["count"].as_i64().map(|count| format!(" {count}")).unwrap_or_default();

    if what.is_empty() { format!("{method}{count}") } else { format!("{method}{count}  {what}") }
}

fn list_of_captures(player: &mut Player, cx: &mut Context<Player>) -> gpui::Div {
    let rows = player.captures.rows.clone();

    div()
        .flex()
        .flex_col()
        .gap_2()
        .child(
            div()
                .flex()
                .items_center()
                .gap_2()
                .child(button("capture-now", "●  Capture the next frame", PURPLE).on_click(cx.listener(|this, _, _, cx| {
                    this.capture();
                    cx.notify();
                })))
                .child(note("⇧⌘C from anywhere")),
        )
        .when(rows.is_empty(), |list| list.child(note("No captures yet. A capture keeps one whole frame: every draw, its state and its target.")))
        .children(rows.into_iter().map(|row| {
            let capture = row["capture"].as_str().unwrap_or("").to_string();
            let chosen = capture.clone();
            let draws = row["counts"]["draws"].as_u64().or(row["draws"].as_u64()).map(|draws| format!("{draws} draws")).unwrap_or_default();
            let frame = row["frame"].as_u64().map(|frame| format!("frame {frame}")).unwrap_or_default();
            let url = row["url"].as_str().unwrap_or("").rsplit('/').next().unwrap_or("").to_string();
            let api = row["api"].as_str().unwrap_or("").to_string();

            div()
                .id(gpui::SharedString::from(format!("capture-{capture}")))
                .flex()
                .items_center()
                .gap_3()
                .p_2()
                .rounded_md()
                .cursor_pointer()
                .bg(rgb(CARD))
                .border_1()
                .border_color(tint(PURPLE, 0.3))
                .hover(|row| row.bg(tint(PURPLE, 0.1)))
                .child(div().font_family(MONO).text_sm().text_color(rgb(PURPLE)).child(capture))
                .child(div().text_xs().text_color(rgb(TEXT)).child(format!("{frame} · {api} · {draws}")))
                .child(div().flex_1().min_w_0().overflow_hidden().whitespace_nowrap().text_xs().text_color(rgb(DIM)).child(url))
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.open_capture(chosen.clone(), cx);
                    cx.notify();
                }))
        }))
}

fn state_of(draw: &Value) -> gpui::Div {
    let state = &draw["state"];
    let mut rows: Vec<(String, String)> = Vec::new();
    let mut add = |label: &str, value: &Value| {
        if !value.is_null() {
            let text = match value {
                Value::String(text) => text.clone(),
                other => other.to_string(),
            };

            rows.push((label.to_string(), if text.len() > 200 { format!("{}…", &text[..200]) } else { text }));
        }
    };

    add("method", &state["method"]);
    add("entity", &state["entity"]);
    add("count", &state["count"]);
    add("instances", &state["instances"]);
    add("program", &state["programName"]);
    add("pipeline", &state["pipeline"]);
    add("target", &state["targetName"]);
    add("pixels changed", &state["pixelsChanged"]);
    add("blend", &state["blend"]);
    add("depth", &state["depth"]);
    add("stencil", &state["stencil"]);
    add("cull", &state["cull"]);
    add("scissor", &state["scissor"]);
    add("viewport", &state["viewport"]);
    add("colour mask", &state["colorMask"]);
    add("error", &state["glError"]);

    let uniforms = state["uniforms"].as_object().cloned().unwrap_or_default();
    let textures = state["textures"].as_array().cloned().unwrap_or_default();
    let groups = state["bindGroups"].as_array().or(state["groups"].as_array()).cloned().unwrap_or_default();

    div()
        .flex()
        .flex_col()
        .gap(px(3.0))
        .children(rows.into_iter().map(|(label, value)| row(label, value)))
        .when(!textures.is_empty(), |list| {
            list.child(note("Textures bound")).children(textures.into_iter().map(|unit| {
                let bound: Vec<String> =
                    ["t2d", "cube", "t3d", "array"].iter().filter_map(|key| unit[*key].as_i64().map(|id| format!("{key} tex_{id}"))).collect();

                row(format!("unit {}", unit["unit"]), bound.join(", "))
            }))
        })
        .when(!uniforms.is_empty(), |list| {
            list.child(note("Uniforms")).children(uniforms.into_iter().take(40).map(|(name, value)| {
                let text = value.to_string();

                row(name, if text.len() > 120 { format!("{}…", &text[..120]) } else { text })
            }))
        })
        .when(!groups.is_empty(), |list| {
            list.child(note("Bind groups")).children(groups.into_iter().take(12).map(|group| {
                let text = group.to_string();

                div().text_xs().font_family(MONO).text_color(rgb(TEXT)).child(if text.len() > 300 { format!("{}…", &text[..300]) } else { text })
            }))
        })
}

fn workspace(player: &mut Player, cx: &mut Context<Player>) -> gpui::Div {
    let state = &player.captures;
    let capture = state.opened.clone().unwrap_or_default();
    let count = state.events.len();
    let selected = state.selected;
    let made = state.made.clone().unwrap_or(Value::Null);
    let findings = made["findings"].as_array().cloned().unwrap_or_default();

    let header = div()
        .flex()
        .items_center()
        .gap_2()
        .child(button("back", "◀  All", DIM).on_click(cx.listener(|this, _, _, cx| {
            this.captures.opened = None;
            cx.notify();
        })))
        .child(div().font_family(MONO).text_color(rgb(PURPLE)).child(capture.clone()))
        .child(note(format!(
            "frame {} · {} · {} events{}",
            made["frame"].as_u64().map(|frame| frame.to_string()).unwrap_or_else(|| "?".into()),
            made["api"].as_str().unwrap_or(""),
            count,
            if made["replay_matches"] == true { " · replay identical" } else { "" }
        )))
        .child(div().flex_1())
        .child(button("wide", if player.wide { "Narrow" } else { "Wide" }, DIM).on_click(cx.listener(|this, _, _, cx| {
            this.wide = !this.wide;
            cx.notify();
        })))
        .child(button("send", "Send to agent", BLUE).on_click(cx.listener(|this, _, _, cx| {
            this.send_to_agent();
            cx.notify();
        })));

    let worth = (!findings.is_empty()).then(|| {
        card("Worth a look", RED).children(findings.into_iter().take(8).map(|finding| {
            let text = finding["text"].as_str().or(finding["summary"].as_str()).map(str::to_string).unwrap_or_else(|| finding.to_string());

            div().text_xs().text_color(rgb(TEXT)).child(text)
        }))
    });

    let picture = div()
        .w_full()
        .h(px(if player.wide { 360.0 } else { 240.0 }))
        .rounded_md()
        .bg(rgb(0x000000))
        .border_1()
        .border_color(tint(FAINT, 0.8))
        .flex()
        .items_center()
        .justify_center()
        .overflow_hidden()
        .child(match (&state.target, &state.error) {
            (_, Some(error)) => div().p_3().text_xs().text_color(rgb(RED)).child(error.clone()).into_any_element(),
            (Some(path), None) => img(path.clone()).size_full().object_fit(ObjectFit::Contain).into_any_element(),
            (None, None) => note(if selected.is_some() { "Replaying to this draw…" } else { "" }).into_any_element(),
        });

    let list = uniform_list(
        "draws",
        count,
        cx.processor(|this, range: std::ops::Range<usize>, _, _| {
            range
                .filter_map(|index| this.captures.events.get(index).cloned().map(|event| (index, event)))
                .map(|(index, event)| {
                    let draw = event["draw"].as_i64().unwrap_or(index as i64);
                    let on = this.captures.selected == Some(draw);
                    let nothing = event["pixels_changed"] == 0 && event["kind"] == "draw";
                    let kind = event["kind"].as_str().unwrap_or("");
                    let colour = match kind {
                        "clear" => CYAN,
                        "blit" | "copy" => ORANGE,
                        "dispatch" => AMBER,
                        _ => TEXT,
                    };
                    let changed = event["changed_box"].as_str().map(|area| format!("[{area}]")).unwrap_or_default();

                    div()
                        .id(index)
                        .w_full()
                        .flex()
                        .gap_2()
                        .px_1()
                        .py(px(2.0))
                        .text_xs()
                        .cursor_pointer()
                        .bg(if on {
                            tint(PURPLE, 0.22)
                        } else if index % 2 == 0 {
                            tint(TEXT, 0.03)
                        } else {
                            tint(TEXT, 0.0)
                        })
                        .child(div().w(px(36.0)).flex_none().font_family(MONO).text_color(rgb(DIM)).child(draw.to_string()))
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .overflow_hidden()
                                .whitespace_nowrap()
                                .text_color(rgb(if nothing { DIM } else { colour }))
                                .child(event_line(&event)),
                        )
                        .child(div().flex_none().font_family(MONO).text_color(rgb(if nothing { RED } else { DIM })).child(if nothing {
                            "changed nothing".to_string()
                        } else {
                            changed
                        }))
                        .on_click(move |_, _, cx| crate::player::with_current(cx, move |this, cx| this.select_draw(draw, cx)))
                })
                .collect()
        }),
    )
    .h(px(if player.wide { 300.0 } else { 220.0 }));

    let detail = match (&state.draw, selected) {
        (_, None) => note("Pick a draw.").into_any_element(),
        (None, Some(draw)) => note(format!("Reading draw {draw}…")).into_any_element(),
        (Some(draw), Some(number)) => {
            let effect = &draw["effect"];
            let said = match (effect["changed"].as_u64(), draw["why"].as_str().or(draw["rejected"].as_str())) {
                (_, Some(why)) => why.to_string(),
                (Some(0), None) => "Changed nothing.".to_string(),
                (Some(changed), None) => format!("Changed {changed} pixels."),
                _ => String::new(),
            };

            card(format!("Draw {number}"), PURPLE).child(div().text_xs().text_color(rgb(TEXT)).child(said)).child(state_of(draw)).into_any_element()
        }
    };

    let body = if player.wide {
        div()
            .flex()
            .gap_3()
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .gap_2()
                    .child(picture)
                    .child(div().rounded_md().border_1().border_color(tint(FAINT, 0.8)).p_1().child(list)),
            )
            .child(div().w(px(380.0)).flex_none().flex().flex_col().gap_2().children(worth).child(detail))
    } else {
        div()
            .flex()
            .flex_col()
            .gap_2()
            .children(worth)
            .child(picture)
            .child(div().rounded_md().border_1().border_color(tint(FAINT, 0.8)).p_1().child(list))
            .child(detail)
    };

    div().flex().flex_col().gap_2().child(header).when(state.loading, |content| content.child(note("Reading the capture…"))).child(body)
}

pub fn render(player: &mut Player, _window: &mut Window, cx: &mut Context<Player>) -> AnyElement {
    let content = if player.captures.opened.is_some() { workspace(player, cx) } else { list_of_captures(player, cx) };

    crate::panels::frame("captures", "Captures", PURPLE, content)
}
