//! Resources: every live GPU object by kind, largest first, with the line that made it; a
//! texture opened to its levels, a buffer to its bytes, a shader to its source.

use std::path::PathBuf;

use gpui::{AnyElement, Context, ObjectFit, Window, div, img, prelude::*, px, rgb, uniform_list};
use serde_json::{Value, json};

use crate::player::Player;
use crate::theme::*;

/// How many bytes of a buffer a page shows.
pub const PAGE: u64 = 512;

pub struct State {
    pub kind: String,
    pub kinds: Vec<(String, u64, f64)>,
    pub list: Vec<Value>,
    pub selected: Option<String>,
    pub detail: Option<Value>,
    pub error: Option<String>,
    pub level: u64,
    pub offset: u64,
    pub floats: bool,
}

impl Default for State {
    fn default() -> Self {
        State { kind: "texture".into(), kinds: Vec::new(), list: Vec::new(), selected: None, detail: None, error: None, level: 0, offset: 0, floats: false }
    }
}

pub fn kind_of(handle: &str) -> &'static str {
    match handle.split('_').next().unwrap_or("") {
        "tex" => "texture",
        "buf" => "buffer",
        "shd" => "shader",
        "prg" => "program",
        "pip" => "pipeline",
        "fbo" => "framebuffer",
        "smp" => "sampler",
        _ => "other",
    }
}

impl State {
    pub fn counts(&mut self, data: &Value) {
        let mut kinds: Vec<(String, u64, f64)> = data["kinds"]
            .as_object()
            .map(|kinds| {
                kinds
                    .iter()
                    .map(|(kind, entry)| (kind.clone(), entry["alive"].as_u64().unwrap_or(0), entry["bytes"].as_f64().unwrap_or(0.0)))
                    .filter(|(_, alive, _)| *alive > 0)
                    .collect()
            })
            .unwrap_or_default();

        kinds.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal).then(b.1.cmp(&a.1)));
        self.kinds = kinds;
    }

    pub fn rows(&mut self, kind: &str, data: &Value) {
        if kind == self.kind {
            self.list = data["rows"].as_array().cloned().unwrap_or_default();
        }
    }

    pub fn select(&mut self, handle: &str) {
        if self.selected.as_deref() != Some(handle) {
            self.level = 0;
            self.offset = 0;
            self.detail = None;
        }

        self.selected = Some(handle.to_string());
        self.error = None;
    }

    /// The resource call for what is selected: a texture's preview at its level, a page of a
    /// buffer's bytes.
    pub fn request(&self, handle: &str) -> Value {
        match kind_of(handle) {
            "texture" => json!({ "handle": handle, "preview": { "max_edge": 640, "level": self.level } }),
            "buffer" => json!({ "handle": handle, "offset": self.offset, "length": PAGE }),
            _ => json!({ "handle": handle, "detail": "full" }),
        }
    }

    pub fn detail(&mut self, handle: &str, value: &Value) {
        if self.selected.as_deref() == Some(handle) {
            self.detail = Some(value.clone());
            self.error = None;
        }
    }

    pub fn failed(&mut self, handle: &str, error: String) {
        if self.selected.as_deref() == Some(handle) {
            self.error = Some(error);
        }
    }
}

fn texture(state: &State, value: &Value, cx: &mut Context<Player>) -> gpui::Div {
    let detail = &value["data"]["detail"];
    let picture =
        value["images"].as_array().and_then(|images| images.first()).and_then(|image| image["view"].as_str().or(image["original"].as_str())).map(PathBuf::from);
    let levels = detail["levels"].as_u64().unwrap_or(1).max(1);
    let level = state.level.min(levels - 1);
    let width = detail["width"].as_u64().unwrap_or(0) >> level;
    let height = detail["height"].as_u64().unwrap_or(0) >> level;

    div()
        .flex()
        .flex_col()
        .gap_2()
        .child(
            div()
                .w_full()
                .h(px(300.0))
                .rounded_md()
                .bg(rgb(0x000000))
                .border_1()
                .border_color(tint(FAINT, 0.8))
                .flex()
                .items_center()
                .justify_center()
                .overflow_hidden()
                .child(match picture {
                    Some(path) => img(path).size_full().object_fit(ObjectFit::Contain).into_any_element(),
                    None => note(value["summary"].as_str().unwrap_or("No picture of this texture.").lines().last().unwrap_or("").to_string())
                        .p_3()
                        .into_any_element(),
                }),
        )
        .child(
            div()
                .flex()
                .items_center()
                .justify_between()
                .child(button("level-down", "◀", AMBER).on_click(cx.listener(|this, _, _, cx| {
                    if this.resources.level > 0 {
                        this.resources.level -= 1;
                        this.fetch_resource();
                    }

                    cx.notify();
                })))
                .child(div().text_sm().font_family(MONO).child(format!("level {level} of {levels} · {}×{}", width.max(1), height.max(1))))
                .child(button("level-up", "▶", AMBER).on_click(cx.listener(move |this, _, _, cx| {
                    if this.resources.level + 1 < levels {
                        this.resources.level += 1;
                        this.fetch_resource();
                    }

                    cx.notify();
                }))),
        )
        .child(facts(
            detail,
            &["what", "format", "target", "width", "height", "depth", "levels", "bytes", "compressed", "renderTarget", "immutable", "generatedMips"],
        ))
}

fn buffer(state: &State, value: &Value, wide: bool, cx: &mut Context<Player>) -> gpui::Div {
    let detail = &value["data"]["detail"];
    let size = detail["size"].as_u64().or(detail["bytes"].as_u64()).unwrap_or(0);
    let head = &value["data"]["head"];
    let start = head["offset"].as_u64().unwrap_or(state.offset);
    let data: Vec<u8> = head["bytes"].as_array().map(|all| all.iter().map(|byte| byte.as_u64().unwrap_or(0) as u8).collect()).unwrap_or_default();
    let floats = state.floats;

    let lines: Vec<(u64, String)> = if floats {
        data.chunks(16)
            .enumerate()
            .map(|(row, chunk)| {
                let values: Vec<String> = chunk
                    .chunks(4)
                    .filter(|four| four.len() == 4)
                    .map(|four| format!("{:>11.4}", f32::from_le_bytes([four[0], four[1], four[2], four[3]])))
                    .collect();

                (start + row as u64 * 16, values.join(" "))
            })
            .collect()
    } else {
        data.chunks(16)
            .enumerate()
            .map(|(row, chunk)| {
                let hex: Vec<String> = chunk.iter().map(|byte| format!("{byte:02x}")).collect();
                let text: String = chunk.iter().map(|byte| if byte.is_ascii_graphic() { *byte as char } else { '·' }).collect();

                // The characters too, where there is room for them.
                (start + row as u64 * 16, if wide { format!("{:<48} {text}", hex.join(" ")) } else { hex.join(" ") })
            })
            .collect()
    };

    div()
        .flex()
        .flex_col()
        .gap_2()
        .child(
            div()
                .flex()
                .items_center()
                .justify_between()
                .child(button("page-back", "◀", AMBER).on_click(cx.listener(|this, _, _, cx| {
                    this.resources.offset = this.resources.offset.saturating_sub(PAGE);
                    this.fetch_resource();
                    cx.notify();
                })))
                .child(div().text_sm().font_family(MONO).child(format!("bytes {}–{} of {size}", start, (start + data.len() as u64).min(size))))
                .child(button("as", if floats { "as hex" } else { "as float32" }, CYAN).on_click(cx.listener(|this, _, _, cx| {
                    this.resources.floats = !this.resources.floats;
                    cx.notify();
                })))
                .child(button("page-on", "▶", AMBER).on_click(cx.listener(move |this, _, _, cx| {
                    if this.resources.offset + PAGE < size {
                        this.resources.offset += PAGE;
                        this.fetch_resource();
                    }

                    cx.notify();
                }))),
        )
        .child(div().p_2().rounded_md().bg(rgb(FIELD)).border_1().border_color(tint(FAINT, 0.8)).flex().flex_col().children(lines.into_iter().map(
            |(offset, line)| {
                div()
                    .flex()
                    .gap_3()
                    .text_size(px(11.0))
                    .font_family(MONO)
                    .child(div().text_color(rgb(DIM)).child(format!("{offset:06x}")))
                    .child(div().text_color(rgb(TEXT)).whitespace_nowrap().child(line))
            },
        )))
        .child(facts(detail, &["what", "size", "usage", "target", "element", "used", "written"]))
}

/// The other kinds: what the host says of them, with any source or log in full.
fn other(value: &Value) -> gpui::Div {
    let detail = &value["data"]["detail"];
    let mut blocks = Vec::new();

    for key in ["source", "log", "translated", "infoLog", "compileLog", "linkLog", "code"] {
        if let Some(text) = detail[key].as_str().filter(|text| !text.trim().is_empty()) {
            blocks.push((key.to_string(), text.to_string()));
        }
    }

    let keys: Vec<String> =
        detail.as_object().map(|object| object.keys().filter(|key| !blocks.iter().any(|(block, _)| block == *key)).cloned().collect()).unwrap_or_default();

    div()
        .flex()
        .flex_col()
        .gap_2()
        .child(facts(detail, &keys.iter().map(String::as_str).collect::<Vec<_>>()))
        .children(blocks.into_iter().map(|(name, text)| {
            div().flex().flex_col().gap_1().child(note(name)).child(
                div().p_2().rounded_md().bg(rgb(FIELD)).border_1().border_color(tint(FAINT, 0.8)).text_xs().font_family(MONO).text_color(rgb(TEXT)).child(text),
            )
        }))
        .when(detail.is_null(), |content| {
            content.child(div().text_xs().font_family(MONO).text_color(rgb(TEXT)).child(value["summary"].as_str().unwrap_or("").to_string()))
        })
}

fn facts(detail: &Value, keys: &[&str]) -> gpui::Div {
    div().flex().flex_col().gap(px(3.0)).children(keys.iter().filter_map(|key| {
        let value = &detail[*key];

        let text = match value {
            Value::Null => return None,
            Value::String(text) => text.clone(),
            Value::Bool(flag) => if *flag { "yes" } else { "no" }.to_string(),
            Value::Number(number) if *key == "bytes" || *key == "size" => bytes(number.as_f64().unwrap_or(0.0)),
            other => {
                let text = other.to_string();

                if text.len() > 160 { format!("{}…", &text[..160]) } else { text }
            }
        };

        Some(row(key.to_string(), text))
    }))
}

pub fn render(player: &mut Player, _window: &mut Window, cx: &mut Context<Player>) -> AnyElement {
    let wide = player.wide;
    let state = &player.resources;
    let kind = state.kind.clone();
    let count = state.list.len();
    let mut kinds = state.kinds.clone();

    if kinds.is_empty() {
        kinds = ["texture", "buffer", "shader", "program"].iter().map(|kind| (kind.to_string(), 0, 0.0)).collect();
    }

    let chips = div().flex().flex_wrap().gap_1().children(kinds.into_iter().map(|(name, alive, total)| {
        let on = name == kind;
        let label = if alive > 0 { format!("{name}s {alive} · {}", bytes(total)) } else { format!("{name}s") };
        let chosen = name.clone();

        button(format!("kind-{name}"), label, if on { AMBER } else { DIM }).on_click(cx.listener(move |this, _, _, cx| {
            this.show_kind(chosen.clone());
            cx.notify();
        }))
    }));

    let list = uniform_list(
        "resource-rows",
        count,
        cx.processor(|this, range: std::ops::Range<usize>, _, _| {
            range
                .filter_map(|index| this.resources.list.get(index).cloned().map(|row| (index, row)))
                .map(|(index, entry)| {
                    let handle = entry["handle"].as_str().unwrap_or("").to_string();
                    let on = this.resources.selected.as_deref() == Some(handle.as_str());
                    let label = entry["label"].as_str().map(|label| format!(" «{label}»")).unwrap_or_default();
                    let what = format!("{}{label}", entry["what"].as_str().unwrap_or(""));
                    let size = bytes(entry["bytes"].as_f64().unwrap_or(0.0));
                    let chosen = handle.clone();

                    div()
                        .id(index)
                        .w_full()
                        .flex()
                        .gap_2()
                        .px_1()
                        .py(px(3.0))
                        .text_xs()
                        .cursor_pointer()
                        .bg(if on {
                            tint(AMBER, 0.2)
                        } else if index % 2 == 0 {
                            tint(TEXT, 0.03)
                        } else {
                            tint(TEXT, 0.0)
                        })
                        .child(div().w(px(64.0)).flex_none().font_family(MONO).text_color(rgb(if on { AMBER } else { TEXT })).child(handle))
                        .child(div().flex_1().min_w_0().overflow_hidden().whitespace_nowrap().text_color(rgb(TEXT)).child(what))
                        .child(div().flex_none().font_family(MONO).text_color(rgb(DIM)).child(size))
                        .on_click({
                            let chosen = chosen.clone();

                            move |_, _, cx| {
                                let chosen = chosen.clone();

                                crate::player::with_current(cx, move |this, _| this.select_resource(chosen));
                            }
                        })
                })
                .collect()
        }),
    )
    .h(px(230.0));

    let detail = match (&state.selected, &state.detail, &state.error) {
        (None, _, _) => note("Pick an object to see inside it.").into_any_element(),
        (Some(_), _, Some(error)) => div().text_xs().text_color(rgb(RED)).child(error.clone()).into_any_element(),
        (Some(handle), None, None) => note(format!("Reading {handle}…")).into_any_element(),
        (Some(handle), Some(value), None) => {
            let site = value["data"]["detail"]["site"].as_str().unwrap_or("").to_string();
            let body = match kind_of(handle) {
                "texture" => texture(state, value, cx),
                "buffer" => buffer(state, value, wide, cx),
                _ => other(value),
            };

            card(handle.clone(), AMBER)
                .child(body)
                .when(!site.is_empty(), |card| {
                    card.child(note("Made at")).child(div().text_xs().font_family(MONO).text_color(rgb(DIM)).child(site.replace(" < ", "\n")))
                })
                .into_any_element()
        }
    };

    crate::panels::frame(
        "resources",
        "Resources",
        AMBER,
        div()
            .flex()
            .flex_col()
            .gap_2()
            .child(chips)
            .child(note(if count == 0 { "None of this kind are alive.".to_string() } else { format!("{count} alive, largest first. Sizes are estimates.") }))
            .child(div().rounded_md().border_1().border_color(tint(FAINT, 0.8)).p_1().child(list))
            .child(detail),
    )
}
