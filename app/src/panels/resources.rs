//! Resources: every live GPU object, by kind. Textures as a gallery of their pictures, each
//! opening to its levels, its texels and its stand-ins; shaders as coloured source; programs
//! with their uniforms, their shaders a click away and switches to hide or flatten their draws;
//! buffers as bytes, in hex or as numbers.

use std::cell::Cell;
use std::collections::HashMap;
use std::ops::Range;
use std::path::PathBuf;
use std::rc::Rc;

use gpui::{
    AnyElement, Bounds, Context, HighlightStyle, MouseButton, MouseDownEvent, ObjectFit, Pixels, StyledText, Window, canvas, div, img, prelude::*, px, rgb,
    uniform_list,
};
use serde_json::{Value, json};

use crate::player::Player;
use crate::theme::*;

/// How many bytes of a buffer a page shows.
pub const PAGE: u64 = 512;

/// A texture's picture in the gallery.
#[derive(Clone)]
pub enum Thumb {
    Waiting,
    Ready(PathBuf),
    Failed(String),
}

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
    /// The texture's picture on screen, the texel clicked, and what pixels() read there.
    pub picture: Rc<Cell<Option<Bounds<Pixels>>>>,
    pub texel: Option<(u32, u32)>,
    pub texel_value: Option<String>,
    /// The gallery's pictures, by handle.
    pub thumbs: HashMap<String, Thumb>,
    /// The shader shown, coloured: its lines and whether they are the browser's translation.
    pub code: Vec<(String, Vec<(Range<usize>, HighlightStyle)>)>,
    pub code_of: Option<(String, bool)>,
    pub translated: bool,
}

impl Default for State {
    fn default() -> Self {
        State {
            kind: "texture".into(),
            kinds: Vec::new(),
            list: Vec::new(),
            selected: None,
            detail: None,
            error: None,
            level: 0,
            offset: 0,
            floats: false,
            picture: Rc::new(Cell::new(None)),
            texel: None,
            texel_value: None,
            thumbs: HashMap::new(),
            code: Vec::new(),
            code_of: None,
            translated: false,
        }
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

fn plural(kind: &str) -> String {
    match kind {
        "vertex_array" => "vertex arrays".into(),
        other => format!("{other}s"),
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

        // The ones worth looking at first, then the rest by size.
        let rank = |kind: &str| match kind {
            "texture" => 0,
            "shader" => 1,
            "program" | "pipeline" => 2,
            "buffer" => 3,
            _ => 4,
        };

        kinds.sort_by(|a, b| rank(&a.0).cmp(&rank(&b.0)).then(b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal)));
        self.kinds = kinds;
    }

    pub fn rows(&mut self, kind: &str, data: &Value) {
        if kind == self.kind {
            self.list = data["rows"].as_array().cloned().unwrap_or_default();
        }
    }

    /// Up to `most` textures whose pictures have not been asked for, for the next request.
    pub fn wanted_thumbs(&mut self, most: usize) -> Vec<String> {
        if self.kind != "texture" {
            return Vec::new();
        }

        let wanted: Vec<String> = self
            .list
            .iter()
            .filter_map(|row| row["handle"].as_str().map(str::to_string))
            .filter(|handle| !self.thumbs.contains_key(handle))
            .take(most)
            .collect();

        for handle in &wanted {
            self.thumbs.insert(handle.clone(), Thumb::Waiting);
        }

        wanted
    }

    pub fn got_thumbs(&mut self, data: &Value) {
        for row in data["thumbnails"].as_array().into_iter().flatten() {
            let Some(handle) = row["handle"].as_str() else { continue };
            let thumb = match row["image"].as_str() {
                Some(path) => Thumb::Ready(PathBuf::from(path)),
                None => Thumb::Failed(row["error"].as_str().unwrap_or("no picture").to_string()),
            };

            self.thumbs.insert(handle.to_string(), thumb);
        }
    }

    pub fn select(&mut self, handle: &str) {
        if self.selected.as_deref() != Some(handle) {
            self.level = 0;
            self.offset = 0;
            self.detail = None;
            self.texel = None;
            self.texel_value = None;
            self.code.clear();
            self.code_of = None;
        }

        self.selected = Some(handle.to_string());
        self.error = None;
    }

    /// A texture's size at the level shown, from what is known of it so far.
    fn size_of(&self, handle: &str) -> Option<(u64, u64)> {
        let from_detail = self.detail.as_ref().filter(|value| value["data"]["handle"].as_str() == Some(handle)).and_then(|value| {
            let detail = &value["data"]["detail"];

            Some((detail["width"].as_u64()?, detail["height"].as_u64()?))
        });
        let from_list = || {
            let row = self.list.iter().find(|row| row["handle"].as_str() == Some(handle))?;
            let what = row["what"].as_str()?;
            let (width, rest) = what.split_once('×')?;
            let height: String = rest.chars().take_while(char::is_ascii_digit).collect();

            Some((width.trim().parse().ok()?, height.parse().ok()?))
        };

        from_detail.or_else(from_list).map(|(width, height): (u64, u64)| ((width >> self.level).max(1), (height >> self.level).max(1)))
    }

    /// The resource call for what is selected: a texture's preview at its level, a page of a
    /// buffer's bytes, everything else in full.
    pub fn request(&self, handle: &str) -> Value {
        match kind_of(handle) {
            "texture" => {
                // A small texture is enlarged by the host, texel by texel, rather than blurred here.
                let size = self.size_of(handle);
                let zoom = size.map(|(width, height)| (512 / width.max(height).max(1)).clamp(1, 32)).unwrap_or(1);

                json!({ "handle": handle, "preview": { "max_edge": 1024, "level": self.level, "zoom": zoom } })
            }
            "buffer" => json!({ "handle": handle, "offset": self.offset, "length": PAGE }),
            _ => json!({ "handle": handle, "detail": "full" }),
        }
    }

    pub fn detail(&mut self, handle: &str, value: &Value) {
        if self.selected.as_deref() == Some(handle) {
            self.detail = Some(value.clone());
            self.error = None;
            self.colour_code();
        }
    }

    /// Colours the selected shader's source, or the browser's translation of it.
    pub fn colour_code(&mut self) {
        let Some(handle) = self.selected.clone() else { return };

        if kind_of(&handle) != "shader" {
            return;
        }

        let detail = self.detail.as_ref().map(|value| value["data"]["detail"].clone()).unwrap_or(Value::Null);
        let source = if self.translated { detail["translated"].as_str() } else { detail["source"].as_str().or(detail["code"].as_str()) };

        self.code = crate::code::lines(source.unwrap_or(""));
        self.code_of = Some((handle, self.translated));
    }

    /// The texel under a click on a texture's picture, at the level shown.
    pub fn texel_at(&self, event: &MouseDownEvent) -> Option<(u32, u32)> {
        let handle = self.selected.as_deref()?;
        let bounds = self.picture.get()?;
        let (width, height) = self.size_of(handle)?;
        let (width, height) = (width as f32, height as f32);
        let (box_w, box_h) = (f32::from(bounds.size.width), f32::from(bounds.size.height));
        let scale = (box_w / width).min(box_h / height);
        let left = f32::from(bounds.origin.x) + (box_w - width * scale) / 2.0;
        let top = f32::from(bounds.origin.y) + (box_h - height * scale) / 2.0;
        let x = (f32::from(event.position.x) - left) / scale;
        let y = (f32::from(event.position.y) - top) / scale;

        (x >= 0.0 && y >= 0.0 && x < width && y < height).then_some((x as u32, y as u32))
    }

    pub fn failed(&mut self, handle: &str, error: String) {
        if self.selected.as_deref() == Some(handle) {
            self.error = Some(error);
        }
    }
}

// ── Pieces ────────────────────────────────────────────────────────────────────────────────

fn facts(detail: &Value, keys: &[&str]) -> gpui::Div {
    div().flex().flex_col().gap(px(3.0)).children(keys.iter().filter_map(|key| {
        let value = &detail[*key];

        let text = match value {
            Value::Null => return None,
            Value::String(text) if text.is_empty() => return None,
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

fn made_at(detail: &Value) -> Option<gpui::Div> {
    let site = detail["site"].as_str().filter(|site| !site.is_empty())?;

    Some(div().flex().flex_col().gap_1().child(note("Made at")).child(div().text_xs().font_family(MONO).text_color(rgb(DIM)).child(site.replace(" < ", "\n"))))
}

fn back(id: &'static str, label: &'static str, cx: &mut Context<Player>) -> gpui::Stateful<gpui::Div> {
    button(id, label, DIM).on_click(cx.listener(|this, _, _, cx| {
        this.resources.selected = None;
        this.resources.detail = None;
        cx.notify();
    }))
}

// ── Textures ──────────────────────────────────────────────────────────────────────────────

fn gallery(player: &mut Player, cx: &mut Context<Player>) -> gpui::Div {
    let columns = ((player.panel_px - 40.0) / 190.0).floor().max(2.0) as usize;
    let width = ((player.panel_px - 40.0) / columns as f32 - 8.0).max(120.0);
    let rows = player.resources.list.clone();

    div().flex().flex_wrap().gap_2().children(rows.into_iter().map(|row| {
        let handle = row["handle"].as_str().unwrap_or("").to_string();
        let chosen = handle.clone();
        let what = row["what"].as_str().unwrap_or("").to_string();
        let label = row["label"].as_str().map(str::to_string);
        let size = bytes(row["bytes"].as_f64().unwrap_or(0.0));
        let thumb = player.resources.thumbs.get(&handle).cloned();
        let stood_in = ["checker", "white", "black", "mips"].iter().any(|with| player.experiments.on(&format!("{handle}:{with}")));

        div()
            .id(gpui::SharedString::from(format!("thumb-{handle}")))
            .w(px(width))
            .flex()
            .flex_col()
            .rounded_lg()
            .overflow_hidden()
            .bg(rgb(CARD))
            .border_1()
            .border_color(tint(if stood_in { GREEN } else { AMBER }, if stood_in { 0.8 } else { 0.25 }))
            .cursor_pointer()
            .hover(|card| card.border_color(tint(AMBER, 0.8)).shadow(glow(AMBER, 0.35)))
            .child(div().w_full().h(px(width * 0.75)).bg(rgb(0x000000)).flex().items_center().justify_center().child(match thumb {
                Some(Thumb::Ready(path)) => img(path).size_full().object_fit(ObjectFit::Contain).into_any_element(),
                Some(Thumb::Failed(why)) => div().p_2().text_xs().text_color(rgb(DIM)).child(why.chars().take(80).collect::<String>()).into_any_element(),
                _ => div().text_xs().text_color(rgb(DIM)).child("reading…").into_any_element(),
            }))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(2.0))
                    .p_2()
                    .child(
                        div()
                            .flex()
                            .justify_between()
                            .child(div().font_family(MONO).text_xs().text_color(rgb(AMBER)).child(handle.clone()))
                            .child(div().font_family(MONO).text_xs().text_color(rgb(DIM)).child(size)),
                    )
                    .child(div().text_xs().text_color(rgb(TEXT)).overflow_hidden().whitespace_nowrap().child(what))
                    .when_some(label, |card, label| {
                        card.child(div().text_xs().text_color(rgb(DIM)).overflow_hidden().whitespace_nowrap().child(format!("«{label}»")))
                    }),
            )
            .on_click(cx.listener(move |this, _, _, cx| {
                this.select_resource(chosen.clone());
                cx.notify();
            }))
    }))
}

fn texture(player: &mut Player, value: &Value, cx: &mut Context<Player>) -> gpui::Div {
    let state = &player.resources;
    let detail = value["data"]["detail"].clone();
    let handle = state.selected.clone().unwrap_or_default();
    let picture =
        value["images"].as_array().and_then(|images| images.first()).and_then(|image| image["view"].as_str().or(image["original"].as_str())).map(PathBuf::from);
    let levels = detail["levels"].as_u64().unwrap_or(1).max(1);
    let level = state.level.min(levels - 1);
    let width = detail["width"].as_u64().unwrap_or(0) >> level;
    let height = detail["height"].as_u64().unwrap_or(0) >> level;
    let place = state.picture.clone();
    let texel = state.texel.map(|(x, y)| format!("texel ({x}, {y}): {}", state.texel_value.clone().unwrap_or_else(|| "reading…".into())));
    let tall = (player.panel_px * 0.7).clamp(260.0, 640.0);

    let viewer = div()
        .id("texture-picture")
        .relative()
        .cursor_crosshair()
        .on_mouse_down(
            MouseButton::Left,
            cx.listener(|this, event: &MouseDownEvent, _, cx| {
                if let Some(texel) = this.resources.texel_at(event) {
                    this.read_texel(texel);
                }

                cx.notify();
            }),
        )
        .child(canvas(move |bounds, _, _| place.set(Some(bounds)), |_, _, _, _| {}).absolute().size_full())
        .w_full()
        .h(px(tall))
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
            None => note(value["summary"].as_str().unwrap_or("No picture of this texture.").lines().last().unwrap_or("").to_string()).p_3().into_any_element(),
        });

    let stand_ins = div().flex().items_center().gap_1().child(note("Stand in:")).children(["checker", "white", "black", "mips"].into_iter().map(|with| {
        let key = format!("{handle}:{with}");
        let on = player.experiments.on(&key);
        let chosen = handle.clone();
        let label = match with {
            "checker" => "Checker",
            "white" => "White",
            "black" => "Black",
            _ => "Mips",
        };

        button(format!("stand-{with}"), label, if on { GREEN } else { DIM })
            .when(on, |button| button.bg(tint(GREEN, 0.3)).border_color(tint(GREEN, 0.9)))
            .on_click(cx.listener(move |this, _, _, cx| {
                this.toggle_patch(format!("{chosen}:{with}"), "patch_texture", json!({ "handle": chosen, "with": with }));
                cx.notify();
            }))
    }));

    div()
        .flex()
        .flex_col()
        .gap_2()
        .child(viewer)
        .child(
            div()
                .flex()
                .items_center()
                .gap_2()
                .child(button("level-down", "◀", AMBER).on_click(cx.listener(|this, _, _, cx| {
                    if this.resources.level > 0 {
                        this.resources.level -= 1;
                        this.resources.texel = None;
                        this.fetch_resource();
                    }

                    cx.notify();
                })))
                .child(div().text_sm().font_family(MONO).child(format!("level {level} of {levels} · {}×{}", width.max(1), height.max(1))))
                .child(button("level-up", "▶", AMBER).on_click(cx.listener(move |this, _, _, cx| {
                    if this.resources.level + 1 < levels {
                        this.resources.level += 1;
                        this.resources.texel = None;
                        this.fetch_resource();
                    }

                    cx.notify();
                })))
                .child(div().flex_1())
                .child(match texel {
                    Some(texel) => div().text_xs().font_family(MONO).text_color(rgb(CYAN)).child(texel),
                    None => note("Click the picture for a texel's exact value."),
                }),
        )
        .child(stand_ins)
        .child(card("Facts", AMBER).child(facts(
            &detail,
            &[
                "what",
                "format",
                "target",
                "width",
                "height",
                "depth",
                "levels",
                "bytes",
                "compressed",
                "renderTarget",
                "immutable",
                "generatedMips",
                "used",
                "written",
            ],
        )))
        .children(made_at(&detail))
}

// ── Shaders ───────────────────────────────────────────────────────────────────────────────

fn shader(player: &mut Player, value: &Value, cx: &mut Context<Player>) -> gpui::Div {
    let detail = value["data"]["detail"].clone();
    let translated = player.resources.translated;
    let count = player.resources.code.len();
    let has_translation = detail["translated"].as_str().is_some_and(|text| !text.is_empty());
    let log = detail["log"].as_str().filter(|log| !log.trim().is_empty()).map(str::to_string);
    let tall = (count as f32 * 17.0 + 12.0).clamp(160.0, 900.0);

    let code = uniform_list(
        "shader-lines",
        count,
        cx.processor(|this, range: Range<usize>, _, _| {
            range
                .filter_map(|index| this.resources.code.get(index).cloned().map(|line| (index, line)))
                .map(|(index, (text, ranges))| {
                    div()
                        .id(index)
                        .flex()
                        .w_full()
                        .gap_3()
                        .text_size(px(12.0))
                        .font_family(MONO)
                        .child(div().w(px(36.0)).flex_none().text_color(rgb(FAINT)).child(format!("{:>4}", index + 1)))
                        .child(div().flex_1().whitespace_nowrap().text_color(rgb(TEXT)).child(StyledText::new(text).with_highlights(ranges)))
                })
                .collect()
        }),
    )
    .h(px(tall));

    div()
        .flex()
        .flex_col()
        .gap_2()
        .child(
            div()
                .flex()
                .items_center()
                .gap_2()
                .child(div().text_sm().text_color(rgb(TEXT)).child(format!("{} shader · {count} lines", detail["type"].as_str().unwrap_or(""))))
                .child(div().flex_1())
                .child(button("source", "Source", if translated { DIM } else { CYAN }).when(!translated, |button| button.bg(tint(CYAN, 0.25))).on_click(
                    cx.listener(|this, _, _, cx| {
                        this.resources.translated = false;
                        this.resources.colour_code();
                        cx.notify();
                    }),
                ))
                .when(has_translation, |bar| {
                    bar.child(
                        button("translated", "As the GPU gets it", if translated { CYAN } else { DIM })
                            .when(translated, |button| button.bg(tint(CYAN, 0.25)))
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.resources.translated = true;
                                this.resources.colour_code();
                                cx.notify();
                            })),
                    )
                }),
        )
        .when_some(log, |content, log| content.child(card("Compile log", RED).child(div().text_xs().font_family(MONO).text_color(rgb(RED)).child(log))))
        .child(div().rounded_md().bg(rgb(FIELD)).border_1().border_color(tint(FAINT, 0.8)).p_2().child(code))
        .child(note("To change a shader, open its program and press Edit: it opens in your own editor, and each save is tried in the game at once."))
        .children(made_at(&detail))
}

// ── Programs ──────────────────────────────────────────────────────────────────────────────

fn program(player: &mut Player, value: &Value, cx: &mut Context<Player>) -> gpui::Div {
    let detail = value["data"]["detail"].clone();
    let handle = player.resources.selected.clone().unwrap_or_default();
    let shaders: Vec<String> =
        detail["shaders"].as_array().map(|ids| ids.iter().filter_map(Value::as_u64).map(|id| format!("shd_{id}")).collect()).unwrap_or_default();
    let uniforms = detail["uniforms"].as_array().cloned().unwrap_or_default();
    let attributes = detail["attributes"].as_array().cloned().unwrap_or_default();
    let filter_key = if kind_of(&handle) == "pipeline" { "pipeline" } else { "program" };

    let switches = div().flex().items_center().gap_1().child(note("Its draws:")).children(
        [("skip", "Hide"), ("solid", "Flat"), ("isolate", "Only")].into_iter().map(|(mode, label)| {
            let key = format!("{handle}:{mode}");
            let on = player.experiments.on(&key);
            let chosen = handle.clone();

            button(format!("program-{mode}"), label, if on { PURPLE } else { DIM })
                .when(on, |button| button.bg(tint(PURPLE, 0.3)).border_color(tint(PURPLE, 0.9)))
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.toggle_patch(format!("{chosen}:{mode}"), "patch_draws", json!({ "filter": { filter_key: chosen }, "mode": mode }));
                    cx.notify();
                }))
        }),
    );

    let shader_buttons = div().flex().flex_wrap().items_center().gap_1().child(note("Shaders:")).children(shaders.iter().flat_map(|shader| {
        let open = shader.clone();
        let edit = shader.clone();
        let program = handle.clone();

        [
            button(format!("open-{shader}"), shader.clone(), CYAN).on_click(cx.listener(move |this, _, _, cx| {
                this.select_resource(open.clone());
                cx.notify();
            })),
            button(format!("edit-{shader}"), "Edit", ORANGE).on_click(cx.listener(move |this, _, _, cx| {
                this.edit_shader(program.clone(), edit.clone());
                cx.notify();
            })),
        ]
    }));

    let table = |title: &str, rows: Vec<Value>, colour: u32| {
        card(format!("{title} · {}", rows.len()), colour).children(rows.into_iter().map(|entry| {
            let name = entry["name"].as_str().unwrap_or("?").to_string();
            let kind = entry["type"].as_str().unwrap_or("").to_string();
            let value = match (&entry["value"], &entry["location"]) {
                (Value::Null, Value::Null) => String::new(),
                (Value::Null, location) => format!("location {location}"),
                (value, _) => value.to_string(),
            };
            let value = if value.len() > 160 { format!("{}…", &value[..160]) } else { value };

            div()
                .flex()
                .gap_2()
                .py(px(1.0))
                .text_xs()
                .child(div().w(px(150.0)).flex_none().overflow_hidden().whitespace_nowrap().font_family(MONO).text_color(rgb(TEXT)).child(name))
                .child(div().w(px(70.0)).flex_none().font_family(MONO).text_color(rgb(CYAN)).child(kind))
                .child(div().flex_1().min_w_0().font_family(MONO).text_color(rgb(AMBER)).child(value))
        }))
    };

    div()
        .flex()
        .flex_col()
        .gap_2()
        .child(switches)
        .child(shader_buttons)
        .child(table("Uniforms, with the value last set", uniforms, AMBER))
        .child(table("Attributes", attributes, CYAN))
        .child(card("Facts", PURPLE).child(facts(&detail, &["what", "linked", "links", "used", "log"])))
        .children(made_at(&detail))
}

// ── Buffers ───────────────────────────────────────────────────────────────────────────────

fn buffer(player: &mut Player, value: &Value, cx: &mut Context<Player>) -> gpui::Div {
    let state = &player.resources;
    let wide = player.panel_px >= 620.0;
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
                    .map(|four| format!("{:>12.5}", f32::from_le_bytes([four[0], four[1], four[2], four[3]])))
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
                .gap_2()
                .child(button("page-back", "◀", AMBER).on_click(cx.listener(|this, _, _, cx| {
                    this.resources.offset = this.resources.offset.saturating_sub(PAGE);
                    this.fetch_resource();
                    cx.notify();
                })))
                .child(div().text_sm().font_family(MONO).child(format!("bytes {}–{} of {size}", start, (start + data.len() as u64).min(size))))
                .child(button("page-on", "▶", AMBER).on_click(cx.listener(move |this, _, _, cx| {
                    if this.resources.offset + PAGE < size {
                        this.resources.offset += PAGE;
                        this.fetch_resource();
                    }

                    cx.notify();
                })))
                .child(div().flex_1())
                .child(button("as", if floats { "As hex" } else { "As float32" }, CYAN).on_click(cx.listener(|this, _, _, cx| {
                    this.resources.floats = !this.resources.floats;
                    cx.notify();
                }))),
        )
        .child(div().p_2().rounded_md().bg(rgb(FIELD)).border_1().border_color(tint(FAINT, 0.8)).flex().flex_col().children(lines.into_iter().map(
            |(offset, line)| {
                div()
                    .flex()
                    .gap_3()
                    .text_size(px(11.5))
                    .font_family(MONO)
                    .child(div().text_color(rgb(DIM)).child(format!("{offset:06x}")))
                    .child(div().text_color(rgb(TEXT)).whitespace_nowrap().child(line))
            },
        )))
        .child(card("Facts", AMBER).child(facts(detail, &["what", "size", "usage", "target", "element", "used", "written"])))
        .children(made_at(detail))
}

/// Any other kind: what the host says of it.
fn other(value: &Value) -> gpui::Div {
    let detail = &value["data"]["detail"];
    let keys: Vec<String> = detail
        .as_object()
        .map(|object| object.keys().filter(|key| !["id", "kind", "context", "site", "destroyedAt"].contains(&key.as_str())).cloned().collect())
        .unwrap_or_default();

    div()
        .flex()
        .flex_col()
        .gap_2()
        .child(card("Facts", AMBER).child(facts(detail, &keys.iter().map(String::as_str).collect::<Vec<_>>())))
        .children(made_at(detail))
        .when(detail.is_null(), |content| {
            content.child(div().text_xs().font_family(MONO).text_color(rgb(TEXT)).child(value["summary"].as_str().unwrap_or("").to_string()))
        })
}

/// The list of one kind, as rows.
fn listing(player: &mut Player, cx: &mut Context<Player>) -> AnyElement {
    let count = player.resources.list.len();
    let tall = (count as f32 * 24.0 + 10.0).clamp(80.0, 600.0);

    uniform_list(
        "resource-rows",
        count,
        cx.processor(|this, range: Range<usize>, _, cx| {
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
                        .px_2()
                        .py(px(4.0))
                        .text_xs()
                        .rounded_sm()
                        .cursor_pointer()
                        .bg(if on {
                            tint(AMBER, 0.2)
                        } else if index % 2 == 0 {
                            tint(TEXT, 0.03)
                        } else {
                            tint(TEXT, 0.0)
                        })
                        .hover(|row| row.bg(tint(AMBER, 0.1)))
                        .child(div().w(px(64.0)).flex_none().font_family(MONO).text_color(rgb(if on { AMBER } else { TEXT })).child(handle))
                        .child(div().flex_1().min_w_0().overflow_hidden().whitespace_nowrap().text_color(rgb(TEXT)).child(what))
                        .child(div().flex_none().font_family(MONO).text_color(rgb(DIM)).child(size))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.select_resource(chosen.clone());
                            cx.notify();
                        }))
                })
                .collect()
        }),
    )
    .h(px(tall))
    .into_any_element()
}

pub fn render(player: &mut Player, _window: &mut Window, cx: &mut Context<Player>) -> AnyElement {
    let kind = player.resources.kind.clone();
    let count = player.resources.list.len();
    let mut kinds = player.resources.kinds.clone();

    if kinds.is_empty() {
        kinds = ["texture", "shader", "program", "buffer"].iter().map(|kind| (kind.to_string(), 0, 0.0)).collect();
    }

    // The kinds, as tabs: how many of each are alive and how much memory they hold.
    let tabs = div().flex().flex_wrap().gap_1().children(kinds.into_iter().map(|(name, alive, total)| {
        let on = name == kind;
        let label = if total > 0.0 { format!("{} {alive} · {}", plural(&name), bytes(total)) } else { format!("{} {alive}", plural(&name)) };
        let chosen = name.clone();

        button(format!("kind-{name}"), label, if on { AMBER } else { DIM })
            .when(on, |button| button.bg(tint(AMBER, 0.28)).border_color(tint(AMBER, 0.9)))
            .on_click(cx.listener(move |this, _, _, cx| {
                this.show_kind(chosen.clone());
                cx.notify();
            }))
    }));

    let selected = player.resources.selected.clone().filter(|handle| kind_of(handle) == kind || kind_of(handle) == "other" || kind == "other");
    let detail = player.resources.detail.clone();
    let error = player.resources.error.clone();

    let body: AnyElement = match (&selected, detail, error) {
        // A texture's gallery, or one texture.
        (None, _, _) if kind == "texture" => div()
            .flex()
            .flex_col()
            .gap_2()
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .child(note(if count == 0 {
                        "No textures are alive.".to_string()
                    } else {
                        format!("{count} textures, largest first. Click one to open it.")
                    }))
                    .child(div().flex_1())
                    .child(button("refresh-thumbs", "Refresh pictures", DIM).on_click(cx.listener(|this, _, _, cx| {
                        this.resources.thumbs.clear();
                        cx.notify();
                    }))),
            )
            .child(gallery(player, cx))
            .into_any_element(),
        (None, _, _) => div()
            .flex()
            .flex_col()
            .gap_2()
            .child(note(if count == 0 { format!("No {} are alive.", plural(&kind)) } else { format!("{count} alive, largest first. Click one to open it.") }))
            .child(div().rounded_md().border_1().border_color(tint(FAINT, 0.8)).p_1().child(listing(player, cx)))
            .into_any_element(),
        (Some(handle), _, Some(error)) => div()
            .flex()
            .flex_col()
            .gap_2()
            .child(div().flex().gap_2().child(back("back-error", "◀  All", cx)).child(div().font_family(MONO).text_color(rgb(AMBER)).child(handle.clone())))
            .child(div().text_xs().text_color(rgb(RED)).child(error))
            .into_any_element(),
        (Some(handle), None, None) => div()
            .flex()
            .flex_col()
            .gap_2()
            .child(div().flex().gap_2().child(back("back-reading", "◀  All", cx)).child(div().font_family(MONO).text_color(rgb(AMBER)).child(handle.clone())))
            .child(note(format!("Reading {handle}…")))
            .into_any_element(),
        (Some(handle), Some(value), None) => {
            let handle = handle.clone();
            let back_label = match kind_of(&handle) {
                "texture" => "◀  All textures",
                "shader" => "◀  All shaders",
                "program" => "◀  All programs",
                _ => "◀  All",
            };
            let title = value["data"]["detail"]["what"].as_str().unwrap_or("").to_string();
            let content = match kind_of(&handle) {
                "texture" => texture(player, &value, cx),
                "shader" => shader(player, &value, cx),
                "program" | "pipeline" => program(player, &value, cx),
                "buffer" => buffer(player, &value, cx),
                _ => other(&value),
            };

            div()
                .flex()
                .flex_col()
                .gap_2()
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap_2()
                        .child(back("back", back_label, cx))
                        .child(div().text_lg().font_family(MONO).text_color(rgb(AMBER)).child(handle))
                        .child(div().text_sm().text_color(rgb(TEXT)).overflow_hidden().whitespace_nowrap().child(title)),
                )
                .child(content)
                .into_any_element()
        }
    };

    crate::panels::frame("resources", "Resources", AMBER, div().flex().flex_col().gap_3().child(tabs).child(body))
}
