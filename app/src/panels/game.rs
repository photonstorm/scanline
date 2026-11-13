//! Game: the game's sound (audio), and later its takes and notes (docs/GAME.md, section 7).
//!
//! Audio: each context with its level, the graph as the game built it with a button to mute,
//! solo or bypass each node, the chosen node's parameters (each editable in place), the
//! buffers and their files, and what is worth a look.

use gpui::{AnyElement, Context, MouseButton, SharedString, Window, div, prelude::*, px, rgb};
use serde_json::Value;

use crate::panels::live::Entry;
use crate::player::Player;
use crate::theme::*;

#[derive(Default)]
pub struct State {
    /// What audio() last said.
    pub audio: Value,
    /// The node chosen, and what audio_node() said of it.
    pub selected: Option<String>,
    pub node: Value,
    /// What takes() last said.
    pub takes: Value,
}

fn number(value: f64) -> String {
    if value.fract() == 0.0 && value.abs() < 1e12 { format!("{value:.0}") } else { format!("{value:.3}").trim_end_matches('0').trim_end_matches('.').to_string() }
}

/// A level, -60 dB to 0, as a fraction of a meter.
fn fraction(db: &Value) -> f32 {
    db.as_f64().map_or(0.0, |db| ((db + 60.0) / 60.0).clamp(0.0, 1.0) as f32)
}

fn db_text(db: &Value) -> String {
    db.as_f64().map_or("–".to_string(), |db| format!("{db:.1} dB"))
}

fn level(level: &Value) -> gpui::Div {
    let clipping = level["clipping"] == true;

    div()
        .flex()
        .flex_col()
        .gap_1()
        .child(
            div()
                .flex()
                .items_center()
                .gap_2()
                .child(div().w(px(34.0)).text_xs().text_color(rgb(DIM)).child("Peak"))
                .child(div().flex_1().child(meter(40, fraction(&level["peak"]), if clipping { RED } else { GREEN })))
                .child(div().w(px(64.0)).text_xs().font_family(MONO).text_color(if clipping { tint(RED, 1.0) } else { rgb(TEXT) }).child(db_text(&level["peak"]))),
        )
        .child(
            div()
                .flex()
                .items_center()
                .gap_2()
                .child(div().w(px(34.0)).text_xs().text_color(rgb(DIM)).child("RMS"))
                .child(div().flex_1().child(meter(40, fraction(&level["rms"]), BLUE)))
                .child(div().w(px(64.0)).text_xs().font_family(MONO).text_color(rgb(TEXT)).child(db_text(&level["rms"]))),
        )
}

fn megabytes(value: f64) -> String {
    bytes(value)
}

/// A node's row in the graph: what it is, its main values, where it goes, and its switches.
fn node_row(player: &Player, node: &Value, index: usize, cx: &mut Context<Player>) -> gpui::Stateful<gpui::Div> {
    let id = node["id"].as_str().unwrap_or("").to_string();
    let chosen = player.sound.selected.as_deref() == Some(id.as_str());
    let patched: Vec<&str> = node["patched"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
    let kind = node["type"].as_str().unwrap_or("?").trim_end_matches("Node").to_string();
    let label = node["label"].as_str().map(|label| format!(" «{label}»")).unwrap_or_default();
    let values: Vec<String> = node["params"]
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(name, _)| !matches!(name.as_str(), "detune"))
        .take(2)
        .map(|(name, param)| format!("{name} {}", param["value"].as_f64().map(number).unwrap_or_default()))
        .collect();
    let outputs: Vec<String> = node["outputs"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|edge| match edge["param"].as_str() {
            Some(param) => format!("{}.{param}", edge["to"].as_str().unwrap_or("?")),
            None => edge["to"].as_str().unwrap_or("?").to_string(),
        })
        .collect();
    let playing = node["playing"] == true;
    let sink = kind == "AudioDestination";
    let selecting = id.clone();

    let switch = |mode: &'static str, word: &'static str, colour: u32| {
        let on = patched.contains(&mode);
        let target = id.clone();

        tab_button(SharedString::from(format!("audio-{mode}-{index}")), word, colour, on).on_click(cx.listener(move |this, _, _, cx| {
            this.toggle_audio_patch(&target, mode);
            cx.notify();
        }))
    };

    div()
        .id(SharedString::from(format!("audio-node-{index}")))
        .flex()
        .items_center()
        .gap_2()
        .px_2()
        .h(px(38.0))
        .rounded(px(5.0))
        .cursor_pointer()
        .when(chosen, |row| row.bg(tint(CYAN, 0.12)))
        .hover(|row| row.bg(rgb(RAISED)))
        .on_click(cx.listener(move |this, _, _, cx| {
            this.select_audio_node(selecting.clone());
            cx.notify();
        }))
        .child(div().flex_none().size(px(7.0)).rounded_full().bg(if playing { tint(GREEN, 1.0) } else { tint(FAINT, 1.0) }))
        .child(div().w(px(64.0)).flex_none().text_xs().font_family(MONO).text_color(rgb(DIM)).child(id.clone()))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .child(div().overflow_hidden().whitespace_nowrap().text_xs().text_color(rgb(TEXT)).child(format!("{kind}{label}")))
                .child(
                    div().overflow_hidden().whitespace_nowrap().text_size(px(10.5)).text_color(rgb(DIM)).child(
                        [values.join(" · "), if outputs.is_empty() { String::new() } else { format!("→ {}", outputs.join(", ")) }]
                            .into_iter()
                            .filter(|part| !part.is_empty())
                            .collect::<Vec<_>>()
                            .join("   "),
                    ),
                ),
        )
        .when(!sink, |row| row.child(group().child(switch("mute", "M", RED)).child(switch("solo", "S", AMBER)).child(switch("bypass", "B", BLUE))))
}

/// The chosen node: every parameter, editable in place, its settings and connections.
fn node_card(player: &Player, cx: &mut Context<Player>) -> Option<gpui::Div> {
    let node = &player.sound.node;
    let id = node["id"].as_str()?.to_string();
    let editing = player.live.entry.clone();
    let typed = player.live.typed.clone();

    let params = node["params"].as_object().cloned().unwrap_or_default().into_iter().enumerate().map(|(index, (name, param))| {
        let here = Entry::Param { node: id.clone(), param: name.clone() };
        let is_editing = editing.as_ref() == Some(&here);
        let value = param["value"].as_f64().map(number).unwrap_or_default();
        let shown = if is_editing { format!("{typed}▏") } else { value.clone() };
        let automated = param["automation"].as_array().is_some_and(|calls| !calls.is_empty());

        div()
            .flex()
            .items_center()
            .gap_2()
            .h(px(24.0))
            .text_xs()
            .child(div().w(px(100.0)).flex_none().text_color(rgb(DIM)).child(name.clone()))
            .child(
                div()
                    .id(SharedString::from(format!("audio-param-{index}")))
                    .w(px(90.0))
                    .px_1p5()
                    .h(px(20.0))
                    .flex()
                    .items_center()
                    .rounded(px(4.0))
                    .font_family(MONO)
                    .cursor_text()
                    .text_color(rgb(TEXT))
                    .when(is_editing, |cell| cell.bg(rgb(FIELD)).border_1().border_color(tint(CYAN, 0.8)))
                    .hover(|cell| cell.bg(rgb(RAISED)))
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(move |this, _, window, cx| {
                            cx.stop_propagation();
                            this.start_watch_entry(here.clone(), value.clone(), window, cx);
                        }),
                    )
                    .child(shown),
            )
            .child(note(format!(
                "{} to {}{}",
                param["min"].as_f64().map(|min| if min < -1e30 { "-∞".into() } else { number(min) }).unwrap_or_default(),
                param["max"].as_f64().map(|max| if max > 1e30 { "∞".into() } else { number(max) }).unwrap_or_default(),
                if automated { " · automated" } else { "" }
            )))
    });

    let settings: Vec<String> = node["props"].as_object().into_iter().flatten().map(|(name, value)| format!("{name} {}", value.as_str().map(str::to_string).unwrap_or_else(|| value.to_string()))).collect();
    let inputs: Vec<String> = node["inputs"].as_array().into_iter().flatten().filter_map(|edge| edge["from"].as_str().map(str::to_string)).collect();
    let outputs: Vec<String> = node["outputs"].as_array().into_iter().flatten().filter_map(|edge| edge["to"].as_str().map(str::to_string)).collect();
    let title = format!("{} {}{}", id, node["type"].as_str().unwrap_or(""), node["label"].as_str().map(|label| format!(" «{label}»")).unwrap_or_default());

    Some(
        card(title, CYAN)
            .child(if node["level"].is_null() { note(format!("No level{}", node["why"].as_str().map(|why| format!(": {why}")).unwrap_or_default())) } else { level(&node["level"]) })
            .children(params)
            .when(!settings.is_empty(), |card| card.child(row("Settings", settings.join(", "))))
            .child(row("From", if inputs.is_empty() { "nothing".into() } else { inputs.join(", ") }))
            .child(row("To", if outputs.is_empty() { "nothing".into() } else { outputs.join(", ") })),
    )
}

fn audio_tab(player: &Player, wide: bool, cx: &mut Context<Player>) -> gpui::Div {
    let audio = &player.sound.audio;
    let contexts = audio["contexts"].as_array().cloned().unwrap_or_default();
    let nodes = audio["nodes"].as_array().cloned().unwrap_or_default();
    let buffers = audio["buffers"].as_array().cloned().unwrap_or_default();
    let elements = audio["elements"].as_array().cloned().unwrap_or_default();
    let patches = audio["patches"].as_array().cloned().unwrap_or_default();

    if player.session().is_none() {
        return div().child(note("No session."));
    }

    if contexts.is_empty() && elements.is_empty() {
        return div().child(note("No audio yet: the game has made no audio context and has no audio element."));
    }

    let outputs = card("Output", GREEN).children(contexts.iter().map(|context| {
        div()
            .flex()
            .flex_col()
            .gap_1()
            .child(row(
                context["id"].as_str().unwrap_or("?").to_string(),
                format!(
                    "{} · {} Hz · {} s",
                    context["state"].as_str().unwrap_or("?"),
                    number(context["sampleRate"].as_f64().unwrap_or(0.0)),
                    number((context["currentTime"].as_f64().unwrap_or(0.0) * 10.0).round() / 10.0)
                ),
            ))
            .child(level(&context["level"]))
    }));

    let findings = audio["findings"].as_array().cloned().unwrap_or_default();
    let worth = (!findings.is_empty() || !patches.is_empty()).then(|| {
        card("Worth a look", AMBER)
            .children(findings.iter().filter_map(Value::as_str).map(|finding| div().text_xs().text_color(tint(AMBER, 1.0)).child(finding.to_string())))
            .children(patches.iter().map(|patch| row("Changed", patch["text"].as_str().unwrap_or("").to_string())))
            .when(!patches.is_empty(), |card| {
                card.child(div().flex().child(icon_label("audio-undo", "undo", "Undo all", ORANGE).on_click(cx.listener(|this, _, _, cx| {
                    this.undo_audio_patches();
                    cx.notify();
                }))))
            })
    });

    let graph = card(format!("Graph · {} nodes", nodes.len()), CYAN).child(
        div()
            .id("audio-graph")
            .flex()
            .flex_col()
            .max_h(px(420.0))
            .overflow_y_scroll()
            .children(nodes.iter().enumerate().map(|(index, node)| node_row(player, node, index, cx))),
    );

    let total = audio["bufferBytes"].as_f64().unwrap_or(0.0);
    let stored = card(format!("Buffers · {}", megabytes(total)), PURPLE)
        .child(
            div().id("audio-buffers").flex().flex_col().max_h(px(200.0)).overflow_y_scroll().children(buffers.iter().map(|buffer| {
                let file = buffer["file"].as_f64().map(|file| format!(" ({})", megabytes(file))).unwrap_or_default();
                let from = buffer["url"].as_str().map(|url| url.rsplit('/').next().unwrap_or(url).to_string()).unwrap_or_else(|| buffer["origin"].as_str().unwrap_or("").to_string());

                row(
                    format!("{} {from}", buffer["id"].as_str().unwrap_or("?")),
                    format!("{} s · {}{file}", number((buffer["duration"].as_f64().unwrap_or(0.0) * 10.0).round() / 10.0), megabytes(buffer["bytes"].as_f64().unwrap_or(0.0))),
                )
            })),
        )
        .children(elements.iter().map(|element| {
            let src = element["src"].as_str().unwrap_or("");

            row(
                format!("{} {}", element["id"].as_str().unwrap_or("?"), src.rsplit('/').next().unwrap_or(src)),
                format!("{} {} s{}", if element["paused"] == true { "paused" } else { "playing" }, number(element["currentTime"].as_f64().unwrap_or(0.0).round()), if element["muted"] == true { " · muted" } else { "" }),
            )
        }));

    let detail = node_card(player, cx);

    if wide {
        div()
            .flex()
            .gap_2()
            .child(div().flex_1().min_w_0().flex().flex_col().gap_2().child(outputs).child(graph))
            .child(div().flex_1().min_w_0().flex().flex_col().gap_2().children(worth).children(detail).child(stored))
    } else {
        div().flex().flex_col().gap_2().child(outputs).children(worth).child(graph).children(detail).child(stored)
    }
}

/// Takes: record the input from here, and play a take back to where it ended.
fn takes_tab(player: &Player, cx: &mut Context<Player>) -> gpui::Div {
    if player.session().is_none() {
        return div().child(note("No session."));
    }

    let recording = player.status["take"].clone();
    let frame = player.status["frame"].as_u64().unwrap_or(0);
    let editing = player.live.entry.clone();
    let typed = player.live.typed.clone();

    let control = if recording.is_object() {
        card("Recording", RED)
            .child(row(
                recording["name"].as_str().unwrap_or("take").to_string(),
                format!("frames {}–{frame} · plays from {}", recording["start"], recording["from"].as_str().unwrap_or("load")),
            ))
            .child(div().flex().child(icon_label("take-stop", "pause", "Stop and keep", RED).on_click(cx.listener(|this, _, _, cx| {
                this.take_action("stop", None);
                cx.notify();
            }))))
    } else {
        card("Record", RED)
            .child(note("Records the input from now: yours or the agent's. Stop keeps it as a take anyone can play by name."))
            .child(div().flex().child(icon_label("take-start", "video", "Record", RED).on_click(cx.listener(|this, _, _, cx| {
                this.take_action("start", None);
                cx.notify();
            }))))
    };

    let list = player.sound.takes["takes"].as_array().cloned().unwrap_or_default();
    let rows = list.iter().enumerate().map(|(index, take)| {
        let name = take["take"].as_str().unwrap_or("").to_string();
        let here = Entry::Rename { name: name.clone() };
        let is_editing = editing.as_ref() == Some(&here);
        let (play, capture, remove, rename) = (name.clone(), name.clone(), name.clone(), name.clone());

        div()
            .flex()
            .items_center()
            .gap_2()
            .px_2()
            .h(px(40.0))
            .rounded(px(5.0))
            .hover(|row| row.bg(rgb(RAISED)))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .child(
                        div()
                            .id(SharedString::from(format!("take-name-{index}")))
                            .text_xs()
                            .font_family(MONO)
                            .cursor_text()
                            .text_color(rgb(TEXT))
                            .when(is_editing, |cell| cell.bg(rgb(FIELD)).border_1().border_color(tint(CYAN, 0.8)).px_1())
                            .on_mouse_down(
                                MouseButton::Left,
                                cx.listener(move |this, _, window, cx| {
                                    cx.stop_propagation();
                                    this.start_watch_entry(Entry::Rename { name: rename.clone() }, rename.clone(), window, cx);
                                }),
                            )
                            .child(if is_editing { format!("{typed}▏") } else { name.clone() }),
                    )
                    .child(div().overflow_hidden().whitespace_nowrap().text_size(px(10.5)).text_color(rgb(DIM)).child(format!(
                        "frames {}–{} · {} · from {}{}",
                        take["start"],
                        take["end"],
                        take["input"].as_str().unwrap_or(""),
                        take["from"].as_str().unwrap_or("load"),
                        if take["deterministic"] == true { " · exact" } else { "" }
                    ))),
            )
            .child(
                group()
                    .child(tab_button(SharedString::from(format!("take-play-{index}")), "Play", GREEN, false).on_click(cx.listener(move |this, _, _, cx| {
                        this.take_action("play", Some((play.clone(), "pause")));
                        cx.notify();
                    })))
                    .child(tab_button(SharedString::from(format!("take-capture-{index}")), "Play + capture", PURPLE, false).on_click(cx.listener(move |this, _, _, cx| {
                        this.take_action("play", Some((capture.clone(), "capture")));
                        cx.notify();
                    }))),
            )
            .child(icon_button(SharedString::from(format!("take-remove-{index}")), "close", DIM, false).on_click(cx.listener(move |this, _, _, cx| {
                this.take_action("remove", Some((remove.clone(), "")));
                cx.notify();
            })))
    });

    div()
        .flex()
        .flex_col()
        .gap_2()
        .child(control)
        .child(card(format!("Takes · {}", list.len()), GREEN).when(list.is_empty(), |card| card.child(note("None yet."))).children(rows))
}

pub fn render(player: &mut Player, _window: &mut Window, cx: &mut Context<Player>) -> AnyElement {
    let wide = player.panel_px >= 780.0;
    let tab = player.tab("game").min(1);
    // The parameters' values take typing through this, which holds the keyboard while one is edited.
    let content = div()
        .id("game-keys")
        .track_focus(&player.watch_focus)
        .on_key_down(cx.listener(|this, event: &gpui::KeyDownEvent, _, cx| this.type_watch(event, cx)))
        .child(if tab == 1 { takes_tab(player, cx) } else { audio_tab(player, wide, cx) });

    crate::panels::tabbed(player, "game", "Game", CYAN, &["Audio", "Takes"], cx, div().child(content))
}
