//! Captures: the session's captured frames; one opened to its draws, the target as it stood
//! after the chosen one, and that draw's state; "Worth a look" first; Send to agent.

use std::cell::Cell;
use std::path::PathBuf;
use std::rc::Rc;

use gpui::{AnyElement, Bounds, Context, MouseButton, MouseDownEvent, ObjectFit, Pixels, Window, canvas, div, img, prelude::*, px, rgb, uniform_list};
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
    /// The picture's place on screen, for turning a click into a pixel.
    pub picture: Rc<Cell<Option<Bounds<Pixels>>>>,
    /// The pixel clicked, and what pixel_source said of it.
    pub pixel: Option<(u32, u32)>,
    pub story: Option<Value>,
    /// The flight recording opened, and what recording() said of it.
    pub recording: Option<String>,
    pub frames: Option<Value>,
    /// The capture's passes, from its events, and which are open in the navigator.
    pub passes: Vec<Pass>,
    pub open_passes: std::collections::HashSet<i64>,
    /// A picture of each pass's target as the pass left it, by pass number.
    pub pass_pictures: std::collections::HashMap<i64, Option<PathBuf>>,
    /// The chosen draw's attachments (attachments()), and the one shown large, if any.
    pub attachments: Option<Value>,
    pub enlarged: Option<usize>,
    /// GPU time by draw, in nanoseconds (profile()), once measured; and whether it is being.
    pub timing: Option<std::collections::HashMap<i64, f64>>,
    pub measuring: bool,
    /// A box being dragged on the picture, corner to corner, in the target's pixels.
    pub drag: Option<((u32, u32), (u32, u32))>,
    /// The region magnified, if one is.
    pub magnifier: Option<Magnifier>,
    pub next_magnifier: u64,
}

/// Which picture of the region the magnifier shows.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Showing {
    After,
    Before,
    Changed,
}

/// A picture of the region: enlarged (with a pixel grid from 8×) and as read, for its values.
pub struct Shot {
    pub view: PathBuf,
    pub original: PathBuf,
    pub pixels: Option<image::RgbaImage>,
}

/// A region of the chosen draw's target, enlarged, as it stood after the draw and before it,
/// and what the draw changed in it.
pub struct Magnifier {
    pub seq: u64,
    pub draw: i64,
    pub target: String,
    pub region: (u32, u32, u32, u32),
    pub zoom: u32,
    pub after: Option<Shot>,
    pub before: Option<Shot>,
    pub changed: Option<PathBuf>,
    pub summary: Option<String>,
    /// The draw changed nothing in the region.
    pub unchanged: bool,
    pub showing: Showing,
    pub hover: Option<(u32, u32)>,
    pub error: Option<String>,
    pub place: Rc<Cell<Option<Bounds<Pixels>>>>,
}

/// A run of events on one target.
#[derive(Clone, Debug)]
pub struct Pass {
    pub number: i64,
    pub target: String,
    /// Positions in the event list, first and last.
    pub first: usize,
    pub last: usize,
    pub draws: usize,
    pub clears: usize,
}

/// One row of the navigator: a pass, or an event in an open one.
#[derive(Clone, Copy)]
enum Row {
    Pass(usize),
    Event(usize),
}

impl State {
    /// The recordings the captures came from, newest first.
    pub fn recordings(&self) -> Vec<String> {
        let mut seen = Vec::new();

        for row in &self.rows {
            if let Some(recording) = row["recording"].as_str() {
                if !seen.iter().any(|known| known == recording) {
                    seen.push(recording.to_string());
                }
            }
        }

        seen
    }

    pub fn list(&mut self, data: &Value) {
        self.rows = data["captures"].as_array().cloned().unwrap_or_default();

        // A capture opened before the list came (an agent showed it) gets its facts now, and
        // one that has finished in the background its replay check and findings.
        if let Some(opened) = &self.opened {
            let row = self.rows.iter().find(|row| row["capture"].as_str() == Some(opened.as_str())).cloned();
            let stale = match (&self.made, &row) {
                (Some(made), Some(row)) => made["capture"].as_str() != Some(opened.as_str()) || made["replay"] != row["replay"],
                (None, Some(_)) => true,
                _ => false,
            };

            if stale {
                self.made = row;
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
            self.pixel = None;
            self.story = None;
            self.passes.clear();
            self.open_passes.clear();
            self.pass_pictures.clear();
            self.attachments = None;
            self.enlarged = None;
            self.timing = None;
            self.measuring = false;
            self.drag = None;
            self.magnifier = None;

            if self.made.as_ref().and_then(|made| made["capture"].as_str()) != Some(capture) {
                self.made = self.rows.iter().find(|row| row["capture"].as_str() == Some(capture)).cloned();
            }
        }

        self.opened = Some(capture.to_string());
        self.error = None;
        self.loading = true;
    }

    /// A page of the capture's events: the first in place of what was there, the rest after it.
    pub fn page(&mut self, capture: &str, data: &Value, first: bool) {
        if self.opened.as_deref() != Some(capture) {
            return;
        }

        let events = data["events"].as_array().cloned().unwrap_or_default();

        if first {
            self.events = events;
        } else {
            self.events.extend(events);
        }

        self.passes = passes_of(&self.events);
    }

    /// The capture's events are all in. Returns the one to show first: the one asked for, else
    /// the last draw, which made the frame's final picture.
    pub fn events(&mut self, capture: &str) -> Option<i64> {
        if self.opened.as_deref() != Some(capture) {
            return None;
        }

        self.loading = false;

        // The list again for the capture in view (once it has finished in the background):
        // the draw chosen stays chosen.
        if self.selected.is_some() {
            return self.want_draw.take();
        }

        self.want_draw
            .take()
            .or_else(|| self.events.iter().rev().find(|event| event["kind"] == "draw").or(self.events.last()).and_then(|event| event["draw"].as_i64()))
    }

    pub fn select(&mut self, draw: i64) {
        self.selected = Some(draw);
        self.draw = None;
        self.error = None;
        self.attachments = None;
        self.enlarged = None;

        // The pass it is in opens in the navigator.
        if let Some(position) = self.events.iter().position(|event| event["draw"].as_i64() == Some(draw)) {
            if let Some(pass) = self.passes.iter().find(|pass| (pass.first..=pass.last).contains(&position)) {
                self.open_passes.insert(pass.number);
            }
        }
    }

    pub fn got_timing(&mut self, capture: &str, data: &Value) {
        if self.opened.as_deref() == Some(capture) {
            self.measuring = false;
            let rows = if data["every"].is_array() { &data["every"] } else { &data["rows"] };

            self.timing = Some(rows.as_array().into_iter().flatten().filter_map(|row| Some((row["draw"].as_i64()?, row["ns"].as_f64()?))).collect());
        }
    }

    pub fn got_attachments(&mut self, capture: &str, draw: i64, data: &Value) {
        if self.opened.as_deref() == Some(capture) && self.selected == Some(draw) {
            self.attachments = Some(data.clone());
        }
    }

    pub fn got_pass_picture(&mut self, capture: &str, pass: i64, value: &Value) {
        if self.opened.as_deref() == Some(capture) {
            let path = value["images"][0]["view"].as_str().or(value["images"][0]["original"].as_str()).map(PathBuf::from);

            self.pass_pictures.insert(pass, path);
        }
    }

    /// Passes whose picture has not been asked for: each as (number, its last event, target).
    pub fn wanted_pass_pictures(&mut self) -> Vec<(i64, i64, String)> {
        let wanted: Vec<(i64, i64, String)> = self
            .passes
            .iter()
            .filter(|pass| !self.pass_pictures.contains_key(&pass.number))
            .filter_map(|pass| Some((pass.number, self.events.get(pass.last)?["draw"].as_i64()?, pass.target.clone())))
            .collect();

        for (number, _, _) in &wanted {
            self.pass_pictures.insert(*number, None);
        }

        wanted
    }

    /// The textures the chosen draw has bound, by handle, for their pictures.
    pub fn bound_textures(&self) -> Vec<String> {
        let mut out = Vec::new();

        for unit in self.draw.as_ref().map(|draw| draw["state"]["textures"].as_array().cloned().unwrap_or_default()).unwrap_or_default() {
            for key in ["t2d", "cube", "t3d", "array"] {
                if let Some(id) = unit[key].as_i64() {
                    let handle = format!("tex_{id}");

                    if !out.contains(&handle) {
                        out.push(handle);
                    }
                }
            }
        }

        out
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

    /// The size of the picture shown: the selected draw's target, else the capture's canvas.
    fn target_size(&self) -> Option<(f32, f32)> {
        let size = &self.draw.as_ref()?["state"]["targetSize"];

        match (size[0].as_f64(), size[1].as_f64()) {
            (Some(width), Some(height)) => Some((width as f32, height as f32)),
            _ => {
                let made = self.made.as_ref()?;

                Some((made["width"].as_f64()? as f32, made["height"].as_f64()? as f32))
            }
        }
    }

    /// The pixel under a click on the picture, which is fitted inside its box.
    pub fn pixel_at(&self, event: &MouseDownEvent) -> Option<(u32, u32)> {
        self.pixel_under(event.position, false)
    }

    /// The pixel under a point of the picture; `clamp` keeps a point past its edge on it, for a
    /// box dragged out beyond the picture.
    pub fn pixel_under(&self, position: gpui::Point<Pixels>, clamp: bool) -> Option<(u32, u32)> {
        let (left, top, scale, width, height) = self.fitting()?;
        let x = (f32::from(position.x) - left) / scale;
        let y = (f32::from(position.y) - top) / scale;

        if clamp {
            return Some((x.clamp(0.0, width - 1.0) as u32, y.clamp(0.0, height - 1.0) as u32));
        }

        (x >= 0.0 && y >= 0.0 && x < width && y < height).then_some((x as u32, y as u32))
    }

    /// Where the target sits in the picture's box: its left and top in the window, its scale,
    /// and its size in pixels.
    fn fitting(&self) -> Option<(f32, f32, f32, f32, f32)> {
        let bounds = self.picture.get()?;
        let (width, height) = self.target_size()?;
        let (box_w, box_h) = (f32::from(bounds.size.width), f32::from(bounds.size.height));
        let scale = (box_w / width).min(box_h / height);

        Some((f32::from(bounds.origin.x) + (box_w - width * scale) / 2.0, f32::from(bounds.origin.y) + (box_h - height * scale) / 2.0, scale, width, height))
    }

    /// A box of the target's pixels as a box of the picture's own: left, top, width, height.
    pub fn box_in_picture(&self, (x, y, w, h): (u32, u32, u32, u32)) -> Option<(f32, f32, f32, f32)> {
        let bounds = self.picture.get()?;
        let (left, top, scale, _, _) = self.fitting()?;

        Some((left - f32::from(bounds.origin.x) + x as f32 * scale, top - f32::from(bounds.origin.y) + y as f32 * scale, w as f32 * scale, h as f32 * scale))
    }

    /// The box dragged so far, as x, y, width, height.
    pub fn dragged(&self) -> Option<(u32, u32, u32, u32)> {
        let ((ax, ay), (bx, by)) = self.drag?;

        Some((ax.min(bx), ay.min(by), ax.abs_diff(bx) + 1, ay.abs_diff(by) + 1))
    }

    pub fn story(&mut self, capture: &str, pixel: (u32, u32), value: &Value) {
        if self.opened.as_deref() == Some(capture) && self.pixel == Some(pixel) {
            self.story = Some(value["data"].clone());
        }
    }

    pub fn failed(&mut self, capture: &str, draw: i64, error: String) {
        if self.opened.as_deref() == Some(capture) && self.selected == Some(draw) {
            self.error = Some(error);
        }
    }
}

/// Passes from the event list: each run of events with one pass number.
fn passes_of(events: &[Value]) -> Vec<Pass> {
    let mut passes: Vec<Pass> = Vec::new();

    for (position, event) in events.iter().enumerate() {
        let number = event["pass"].as_i64().unwrap_or(-1);
        let kind = event["kind"].as_str().unwrap_or("");

        match passes.last_mut() {
            Some(pass) if pass.number == number => {
                pass.last = position;
                pass.draws += (kind == "draw") as usize;
                pass.clears += (kind == "clear") as usize;
            }
            _ => passes.push(Pass {
                number,
                target: event["target"].as_str().unwrap_or("canvas").to_string(),
                first: position,
                last: position,
                draws: (kind == "draw") as usize,
                clears: (kind == "clear") as usize,
            }),
        }
    }

    passes
}

/// The icon and colour for an event by its kind.
fn kind_look(kind: &str) -> (&'static str, u32) {
    match kind {
        "clear" => ("clear", CYAN),
        "blit" | "copy" => ("blit", ORANGE),
        "dispatch" => ("program", AMBER),
        _ => ("draw", PURPLE),
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
    let recordings = player.captures.recordings();
    let store = player.options.home.join("artefacts").join("captures");
    let columns = ((player.panel_px - 40.0) / 250.0).floor().clamp(1.0, 6.0) as usize;

    let mut grid = div().flex().flex_col().gap_2();
    let mut row = div().flex().gap_2();
    let mut in_row = 0;

    for capture_row in rows.iter() {
        let capture = capture_row["capture"].as_str().unwrap_or("").to_string();
        let chosen = capture.clone();
        let draws = capture_row["counts"]["draws"].as_u64().or(capture_row["draws"].as_u64()).map(|draws| format!("{draws} draws")).unwrap_or_default();
        let frame = capture_row["frame"].as_u64().map(|frame| format!("frame {frame}")).unwrap_or_default();
        let url = capture_row["url"].as_str().unwrap_or("").trim_end_matches('/').rsplit('/').next().unwrap_or("").to_string();
        let api = capture_row["api"].as_str().unwrap_or("").to_string();
        let identical = capture_row["replay_matches"] == true;
        let waiting = capture_row["pending"] == true;
        let picture = store.join(&capture).join("final.png");

        row = row.child(
            div()
                .id(gpui::SharedString::from(format!("capture-{capture}")))
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .rounded(px(7.0))
                .overflow_hidden()
                .cursor_pointer()
                .bg(rgb(CARD))
                .border_1()
                .border_color(rgb(LINE))
                .hover(|card| card.border_color(tint(PURPLE, 0.8)).shadow(glow(PURPLE, 0.3)))
                .child(
                    div()
                        .h(px(130.0))
                        .bg(rgb(0x000000))
                        .overflow_hidden()
                        .when(picture.exists(), |frame| frame.child(img(picture.clone()).size_full().object_fit(ObjectFit::Cover))),
                )
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .gap_1()
                        .p_2()
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap_2()
                                .child(div().font_family(MONO).text_sm().text_color(rgb(PURPLE)).child(capture.clone()))
                                .child(div().flex_1())
                                .child(crate::icons::icon(
                                    if identical { "check" } else if waiting { "timer" } else { "warning" },
                                    12.0,
                                    rgb(if identical { GREEN } else if waiting { CYAN } else { AMBER }),
                                )),
                        )
                        .child(div().text_xs().text_color(rgb(TEXT)).child(format!("{frame} · {api} · {draws}")))
                        .child(div().text_xs().text_color(rgb(DIM)).overflow_hidden().whitespace_nowrap().child(url)),
                )
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.open_capture(chosen.clone(), cx);
                    cx.notify();
                })),
        );
        in_row += 1;

        if in_row == columns {
            grid = grid.child(row);
            row = div().flex().gap_2();
            in_row = 0;
        }
    }

    if in_row > 0 {
        for _ in in_row..columns {
            row = row.child(div().flex_1());
        }

        grid = grid.child(row);
    }

    div()
        .flex()
        .flex_col()
        .gap_3()
        .child(
            div()
                .flex()
                .items_center()
                .gap_2()
                .child(icon_label("capture-now", "capture", "Capture", PURPLE).on_click(cx.listener(|this, _, _, cx| {
                    this.capture();
                    cx.notify();
                })))
                .child(icon_label("record", "video", "Record 2s", ORANGE).on_click(cx.listener(|this, _, _, cx| {
                    this.record(120);
                    cx.notify();
                })))
                .child(note("⇧⌘C")),
        )
        .when(!recordings.is_empty(), |list| {
            list.child(section("Recordings")).child(div().flex().flex_wrap().gap_1().children(recordings.into_iter().map(|recording| {
                let chosen = recording.clone();

                icon_label(format!("open-{recording}"), "video", recording, ORANGE).on_click(cx.listener(move |this, _, _, cx| {
                    this.open_recording(chosen.clone());
                    cx.notify();
                }))
            })))
        })
        .when(!rows.is_empty(), |list| list.child(section(format!("{} captures", rows.len()))))
        .when(rows.is_empty(), |list| list.child(note("No captures.")))
        .child(grid)
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
            list.child(section("Textures")).children(textures.into_iter().map(|unit| {
                let bound: Vec<String> =
                    ["t2d", "cube", "t3d", "array"].iter().filter_map(|key| unit[*key].as_i64().map(|id| format!("{key} tex_{id}"))).collect();

                row(format!("unit {}", unit["unit"]), bound.join(", "))
            }))
        })
        .when(!uniforms.is_empty(), |list| {
            list.child(section("Uniforms")).children(uniforms.into_iter().take(40).map(|(name, value)| {
                let text = value.to_string();

                row(name, if text.len() > 120 { format!("{}…", &text[..120]) } else { text })
            }))
        })
        .when(!groups.is_empty(), |list| {
            list.child(section("Bind groups")).children(groups.into_iter().take(12).map(|group| {
                let text = group.to_string();

                div().text_xs().font_family(MONO).text_color(rgb(TEXT)).child(if text.len() > 300 { format!("{}…", &text[..300]) } else { text })
            }))
        })
}

/// The navigator: the capture's passes, each with a picture of what it drew, opening onto its
/// events. One list, so that a frame of thousands of draws scrolls as easily as a short one.
fn navigator(player: &Player, height: f32, cx: &mut Context<Player>) -> impl IntoElement {
    let state = &player.captures;
    let mut rows = Vec::new();

    for (index, pass) in state.passes.iter().enumerate() {
        rows.push(Row::Pass(index));

        if state.open_passes.contains(&pass.number) {
            rows.extend((pass.first..=pass.last).map(Row::Event));
        }
    }

    let rows = Rc::new(rows);
    let count = rows.len();

    div()
        .flex()
        .flex_col()
        .rounded(px(7.0))
        .bg(rgb(CARD))
        .border_1()
        .border_color(rgb(LINE))
        .overflow_hidden()
        .child(
            div()
                .flex()
                .items_center()
                .gap_2()
                .h(px(30.0))
                .px_2p5()
                .border_b_1()
                .border_color(rgb(LINE))
                .child(crate::icons::icon("pass", 13.0, rgb(PURPLE)))
                .child(section(format!("{} passes · {} events", state.passes.len(), state.events.len()))),
        )
        .child(
            uniform_list(
                "navigator",
                count,
                cx.processor(move |this, range: std::ops::Range<usize>, _, cx| {
                    range
                        .filter_map(|index| rows.get(index).copied().map(|row| (index, row)))
                        .map(|(index, row)| match row {
                            Row::Pass(at) => {
                                let pass = this.captures.passes[at].clone();
                                let open = this.captures.open_passes.contains(&pass.number);
                                let picture = this.captures.pass_pictures.get(&pass.number).cloned().flatten();
                                let holds_choice = this.captures.selected.is_some_and(|draw| {
                                    this.captures.events.iter().position(|event| event["draw"].as_i64() == Some(draw)).is_some_and(|position| (pass.first..=pass.last).contains(&position))
                                });
                                let number = pass.number;

                                div()
                                    .id(("pass", index))
                                    .w_full()
                                    .h(px(30.0))
                                    .flex()
                                    .items_center()
                                    .gap_2()
                                    .px_2()
                                    .cursor_pointer()
                                    .bg(if holds_choice { tint(PURPLE, 0.08) } else { tint(TEXT, 0.02) })
                                    .border_b_1()
                                    .border_color(rgb(LINE))
                                    .hover(|row| row.bg(tint(PURPLE, 0.1)))
                                    .child(crate::icons::chevron(open, 11.0, tint(DIM, 1.0)))
                                    .child(
                                        div()
                                            .flex_none()
                                            .w(px(40.0))
                                            .h(px(22.0))
                                            .rounded(px(3.0))
                                            .overflow_hidden()
                                            .bg(rgb(0x000000))
                                            .border_1()
                                            .border_color(rgb(LINE))
                                            .when_some(picture, |frame, path| frame.child(img(path).size_full().object_fit(ObjectFit::Cover))),
                                    )
                                    .child(div().flex_none().text_xs().font_weight(gpui::FontWeight::SEMIBOLD).text_color(rgb(TEXT)).child(format!("Pass {}", pass.number)))
                                    .child(div().flex_1().min_w_0().overflow_hidden().whitespace_nowrap().text_xs().font_family(MONO).text_color(rgb(DIM)).child(format!("→ {}", pass.target)))
                                    .child(div().flex_none().text_xs().text_color(rgb(DIM)).child(match (pass.draws, pass.clears) {
                                        (0, 0) => "—".to_string(),
                                        (1, 0) => "1 draw".to_string(),
                                        (draws, 0) => format!("{draws} draws"),
                                        (0, clears) => format!("{clears} clear{}", if clears == 1 { "" } else { "s" }),
                                        (draws, clears) => format!("{draws} draw{} · {clears} clear{}", if draws == 1 { "" } else { "s" }, if clears == 1 { "" } else { "s" }),
                                    }))
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        if !this.captures.open_passes.remove(&number) {
                                            this.captures.open_passes.insert(number);
                                        }

                                        cx.notify();
                                    }))
                            }
                            Row::Event(position) => {
                                let event = this.captures.events.get(position).cloned().unwrap_or(Value::Null);
                                let draw = event["draw"].as_i64().unwrap_or(position as i64);
                                let on = this.captures.selected == Some(draw);
                                let kind = event["kind"].as_str().unwrap_or("draw").to_string();
                                let nothing = event["pixels_changed"] == 0 && kind == "draw";
                                let (glyph, colour) = kind_look(&kind);

                                div()
                                    .id(("event", index))
                                    .w_full()
                                    .h(px(30.0))
                                    .flex()
                                    .items_center()
                                    .gap_2()
                                    .pl(px(28.0))
                                    .pr_2()
                                    .text_xs()
                                    .cursor_pointer()
                                    .bg(if on { tint(PURPLE, 0.26) } else { tint(TEXT, 0.0) })
                                    .when(on, |row| row.border_l_2().border_color(rgb(PURPLE)))
                                    .hover(|row| row.bg(tint(PURPLE, 0.12)))
                                    .child(crate::icons::icon(glyph, 12.0, if nothing { tint(DIM, 0.7) } else { tint(colour, 0.95) }))
                                    .child(div().w(px(34.0)).flex_none().font_family(MONO).text_color(rgb(DIM)).child(draw.to_string()))
                                    .child(
                                        div()
                                            .flex_1()
                                            .min_w_0()
                                            .overflow_hidden()
                                            .whitespace_nowrap()
                                            .text_color(if nothing { rgb(DIM) } else { rgb(TEXT) })
                                            .child(event_line(&event)),
                                    )
                                    .when(nothing, |row| row.child(crate::icons::icon("warning", 11.0, tint(RED, 0.9))))
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        this.select_draw(draw, cx);
                                        cx.notify();
                                    }))
                            }
                        })
                        .collect()
                }),
            )
            .h(px(height)),
        )
}

/// One row of the bound-resources table: what, where it is bound, and its type.
fn binding_row(icon: &'static str, colour: u32, label: String, binding: String, kind: String, picture: Option<PathBuf>) -> gpui::Div {
    div()
        .flex()
        .items_center()
        .gap_2()
        .h(px(26.0))
        .px_2()
        .text_xs()
        .border_b_1()
        .border_color(tint(LINE, 0.6))
        .child(
            div()
                .flex()
                .items_center()
                .gap_2()
                .flex_1()
                .min_w_0()
                .child(match picture {
                    Some(path) => div()
                        .flex_none()
                        .size(px(18.0))
                        .rounded(px(3.0))
                        .overflow_hidden()
                        .border_1()
                        .border_color(rgb(LINE))
                        .child(img(path).size_full().object_fit(ObjectFit::Cover))
                        .into_any_element(),
                    None => crate::icons::icon(icon, 13.0, tint(colour, 0.95)).into_any_element(),
                })
                .child(div().min_w_0().overflow_hidden().whitespace_nowrap().text_color(rgb(TEXT)).child(label)),
        )
        .child(div().w(px(110.0)).flex_none().overflow_hidden().whitespace_nowrap().text_color(rgb(DIM)).child(binding))
        .child(div().w(px(130.0)).flex_none().overflow_hidden().whitespace_nowrap().font_family(MONO).text_color(tint(DIM, 0.9)).child(kind))
}

fn table_section(title: &str) -> gpui::Div {
    div()
        .flex()
        .items_center()
        .gap_1p5()
        .h(px(26.0))
        .px_2()
        .bg(tint(TEXT, 0.03))
        .border_b_1()
        .border_color(rgb(LINE))
        .child(crate::icons::chevron(true, 10.0, tint(DIM, 1.0)))
        .child(div().text_xs().font_weight(gpui::FontWeight::SEMIBOLD).text_color(rgb(TEXT)).child(title.to_string()))
}

/// What the chosen draw has bound, as Metal's debugger lays it out: the pipeline, the vertex
/// inputs, the textures and the attachments it draws to.
fn bound_resources(player: &Player, draw: &Value, cx: &mut Context<Player>) -> gpui::Div {
    let state = &draw["state"];
    let thumbs = &player.resources.thumbs;
    let picture = |handle: &str| match thumbs.get(handle) {
        Some(crate::panels::resources::Thumb::Ready(path)) => Some(path.clone()),
        _ => None,
    };
    let program = state["programName"].as_str().or(state["pipeline"].as_str()).map(str::to_string);
    let mut table = div().flex().flex_col().rounded(px(7.0)).bg(rgb(CARD)).border_1().border_color(rgb(LINE)).overflow_hidden().child(
        div()
            .flex()
            .items_center()
            .gap_2()
            .h(px(30.0))
            .px_2()
            .border_b_1()
            .border_color(rgb(LINE))
            .text_xs()
            .text_color(rgb(DIM))
            .child(div().flex_1().child(section("Bound resources")))
            .child(div().w(px(110.0)).child(section("Binding")))
            .child(div().w(px(130.0)).child(section("Type"))),
    );

    table = table.child(table_section("Pipeline"));

    if let Some(program) = &program {
        let chosen = program.clone();

        table = table.child(
            div()
                .id("bound-program")
                .cursor_pointer()
                .hover(|row| row.bg(tint(AMBER, 0.08)))
                .child(binding_row("program", AMBER, program.clone(), "Program".into(), String::new(), None))
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.show(crate::panels::Panel::Resources);
                    this.select_resource(chosen.clone());
                    cx.notify();
                })),
        );
    }

    table = table.child(binding_row(
        "draw",
        PURPLE,
        format!("{} ×{}", state["mode"].as_str().unwrap_or(state["method"].as_str().unwrap_or("draw")), state["count"]),
        state["method"].as_str().unwrap_or("").to_string(),
        state["instances"].as_i64().filter(|count| *count > 1).map(|count| format!("{count} instances")).unwrap_or_default(),
        None,
    ));

    let attributes = state["attributes"].as_array().cloned().unwrap_or_default();

    if !attributes.is_empty() || state["elementBuffer"].is_number() {
        table = table.child(table_section("Vertex"));

        for attribute in attributes.iter().filter(|attribute| attribute["enabled"] != false) {
            let kind = match attribute["type"].as_u64().unwrap_or(0) {
                0x1406 => "float",
                0x1405 => "uint",
                0x1404 => "int",
                0x1401 => "ubyte",
                0x1400 => "byte",
                0x1403 => "ushort",
                0x1402 => "short",
                0x140B => "half",
                _ => "?",
            };

            table = table.child(binding_row(
                "buffer",
                BLUE,
                attribute["buffer"].as_i64().map(|id| format!("buf_{id}")).unwrap_or_else(|| "constant".into()),
                format!("Attribute {}", attribute["index"]),
                format!("{kind}×{}{}", attribute["size"], if attribute["divisor"].as_u64().unwrap_or(0) > 0 { " per instance" } else { "" }),
                None,
            ));
        }

        if let Some(id) = state["elementBuffer"].as_i64() {
            table = table.child(binding_row("buffer", BLUE, format!("buf_{id}"), "Indices".into(), state["indexType"].as_str().unwrap_or("").to_string(), None));
        }
    }

    let units = state["textures"].as_array().cloned().unwrap_or_default();

    if !units.is_empty() {
        table = table.child(table_section("Fragment"));

        for unit in &units {
            for (key, kind) in [("t2d", "Texture 2D"), ("cube", "Texture Cube"), ("t3d", "Texture 3D"), ("array", "Texture 2DArray")] {
                if let Some(id) = unit[key].as_i64() {
                    let handle = format!("tex_{id}");
                    let chosen = handle.clone();

                    table = table.child(
                        div()
                            .id(gpui::SharedString::from(format!("bound-{handle}-{}", unit["unit"])))
                            .cursor_pointer()
                            .hover(|row| row.bg(tint(AMBER, 0.08)))
                            .child(binding_row("texture", AMBER, handle.clone(), format!("Texture {}", unit["unit"]), kind.to_string(), picture(&handle)))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.show(crate::panels::Panel::Resources);
                                this.select_resource(chosen.clone());
                                cx.notify();
                            })),
                    );
                }
            }
        }
    }

    let uniforms = state["uniforms"].as_object().cloned().unwrap_or_default();

    if !uniforms.is_empty() {
        table = table.child(table_section("Uniforms"));

        for (name, value) in uniforms.into_iter().take(40) {
            let text = match &value {
                Value::String(text) => text.clone(),
                other => other.to_string(),
            };

            table = table.child(binding_row("shader", CYAN, name, "Uniform".into(), if text.len() > 40 { format!("{}…", &text[..40]) } else { text }, None));
        }
    }

    if let Some(attachments) = &player.captures.attachments {
        table = table.child(table_section("Attachments"));

        for attachment in attachments["attachments"].as_array().cloned().unwrap_or_default() {
            let handle = attachment["handle"].as_str().unwrap_or("").to_string();
            let label = attachment["label"].as_str().filter(|label| !label.is_empty()).map(|label| format!("{label} ({handle})")).unwrap_or(handle);

            table = table.child(binding_row(
                if attachment["attachment"].as_str().is_some_and(|name| name.starts_with("Depth")) { "depth" } else { "framebuffer" },
                GREEN,
                label,
                attachment["attachment"].as_str().unwrap_or("").to_string(),
                attachment["what"].as_str().unwrap_or("").to_string(),
                attachment["image"].as_str().map(PathBuf::from),
            ));
        }
    }

    table
}

/// A colour for a program, the same each time: draws by one shader read as one block.
fn program_colour(program: &str) -> u32 {
    const PALETTE: [u32; 10] = [0x7c83fd, 0x4ade80, 0xfbbf24, 0xf472b6, 0x22d3ee, 0xfb923c, 0xa78bfa, 0x34d399, 0xf87171, 0x60a5fa];
    let sum = program.bytes().fold(7u32, |sum, byte| sum.wrapping_mul(31).wrapping_add(byte as u32));

    PALETTE[(sum % PALETTE.len() as u32) as usize]
}

/// The frame laid out in time, as Nsight's GPU trace does: its passes, and beneath them their
/// draws, each as wide as the GPU time it took (or all alike until measured), coloured by
/// program. A click chooses a draw.
fn timeline(player: &Player, cx: &mut Context<Player>) -> gpui::Div {
    let state = &player.captures;
    let timing = state.timing.as_ref();
    let events = &state.events;
    // Each event's share of the frame: its GPU time, or one part in the count.
    let weight = |event: &Value| -> f64 {
        match timing {
            Some(timing) => event["draw"].as_i64().and_then(|draw| timing.get(&draw)).copied().unwrap_or(0.0).max(1.0),
            None => 1.0,
        }
    };
    let weights: Vec<f64> = events.iter().map(weight).collect();
    let total: f64 = weights.iter().sum::<f64>().max(1.0);
    let mut starts = Vec::with_capacity(weights.len());
    let mut at = 0.0;

    for weight in &weights {
        starts.push(at / total);
        at += weight;
    }

    let total_ms = timing.map(|timing| timing.values().sum::<f64>() / 1e6);
    let chosen = state.selected;
    let caption = match (chosen, timing) {
        (Some(draw), Some(timing)) => timing.get(&draw).map(|ns| format!("event {draw}: {:.3} ms · {:.1}%", ns / 1e6, ns / 1e6 / total_ms.unwrap_or(1.0) * 100.0)),
        _ => None,
    };

    let passes = div().relative().w_full().h(px(22.0)).children(state.passes.iter().enumerate().map(|(index, pass)| {
        let left = starts.get(pass.first).copied().unwrap_or(0.0);
        let width: f64 = weights[pass.first..=pass.last.min(weights.len().saturating_sub(1))].iter().sum::<f64>() / total;
        let ms = timing.map(|timing| (pass.first..=pass.last).filter_map(|position| events[position]["draw"].as_i64()).filter_map(|draw| timing.get(&draw)).sum::<f64>() / 1e6);
        let colour = [0x7c83fd, 0x22d3ee, 0xa78bfa, 0x34d399][index % 4];
        let first = events.get(pass.first).and_then(|event| event["draw"].as_i64());

        div()
            .id(("timeline-pass", index))
            .absolute()
            .top_0()
            .left(gpui::relative(left as f32))
            .w(gpui::relative(width as f32))
            .h_full()
            .px_1()
            .flex()
            .items_center()
            .overflow_hidden()
            .whitespace_nowrap()
            .rounded(px(3.0))
            .bg(tint(colour, 0.28))
            .border_1()
            .border_color(tint(colour, 0.7))
            .text_size(px(10.0))
            .text_color(rgb(TEXT))
            .cursor_pointer()
            .hover(move |bar| bar.bg(tint(colour, 0.45)))
            .child(match ms {
                Some(ms) => format!("Pass {} → {} · {ms:.2} ms", pass.number, pass.target),
                None => format!("Pass {} → {}", pass.number, pass.target),
            })
            .on_click(cx.listener(move |this, _, _, cx| {
                if let Some(draw) = first {
                    this.select_draw(draw, cx);
                }

                cx.notify();
            }))
    }));

    let draws = div().relative().w_full().h(px(26.0)).children(events.iter().enumerate().map(|(position, event)| {
        let draw = event["draw"].as_i64().unwrap_or(position as i64);
        let kind = event["kind"].as_str().unwrap_or("draw");
        let colour = if kind == "draw" { program_colour(event["program"].as_str().unwrap_or("")) } else { DIM };
        let on = chosen == Some(draw);

        div()
            .id(("timeline-draw", position))
            .absolute()
            .top_0()
            .left(gpui::relative(starts[position] as f32))
            .w(gpui::relative((weights[position] / total) as f32))
            .h_full()
            .bg(tint(colour, if on { 1.0 } else { 0.75 }))
            .border_r_1()
            .border_color(tint(0x000000, 0.35))
            .when(on, |bar| bar.border_2().border_color(rgb(0xffffff)).shadow(glow(0xffffff, 0.6)))
            .cursor_pointer()
            .hover(|bar| bar.bg(rgb(0xffffff)))
            .on_click(cx.listener(move |this, _, _, cx| {
                this.select_draw(draw, cx);
                cx.notify();
            }))
    }));

    div()
        .flex()
        .flex_col()
        .gap_1p5()
        .p_2()
        .rounded(px(7.0))
        .bg(rgb(CARD))
        .border_1()
        .border_color(rgb(LINE))
        .child(
            div()
                .flex()
                .items_center()
                .gap_2()
                .child(crate::icons::icon("timer", 13.0, rgb(CYAN)))
                .child(section("Timeline"))
                .when_some(total_ms, |row, ms| row.child(note(format!("{ms:.2} ms GPU"))))
                .when(state.measuring, |row| row.child(note("Measuring…")))
                .child(div().flex_1())
                .when_some(caption, |row, caption| row.child(div().text_xs().font_family(MONO).text_color(rgb(TEXT)).child(caption)))
                .when(timing.is_none(), |row| {
                    row.child(icon_label("measure", "timer", "Measure", CYAN).on_click(cx.listener(|this, _, _, cx| {
                        this.measure_capture();
                        cx.notify();
                    })))
                }),
        )
        .child(passes)
        .child(draws)
}

/// A pixel's value as text, and as a colour for its swatch.
fn texel(pixels: Option<&image::RgbaImage>, (x, y): (u32, u32)) -> Option<([u8; 4], String)> {
    let pixel = pixels?.get_pixel_checked(x, y)?.0;

    Some((pixel, format!("({}, {}, {}, {})", pixel[0], pixel[1], pixel[2], pixel[3])))
}

/// The magnifier: the region dragged on the picture, enlarged with no smoothing (a grid from
/// 8×), as the draw left it, as it was before the draw, or what the draw changed; the exact
/// value of the pixel under the pointer, before and after.
fn magnifier_card(player: &Player, cx: &mut Context<Player>) -> Option<gpui::Div> {
    let magnifier = player.captures.magnifier.as_ref()?;
    let (x, y, w, h) = magnifier.region;
    let showing = magnifier.showing;
    let picture = match showing {
        Showing::After => magnifier.after.as_ref().map(|shot| shot.view.clone()),
        Showing::Before => magnifier.before.as_ref().map(|shot| shot.view.clone()),
        Showing::Changed => magnifier.changed.clone(),
    };
    let tab = |id: &'static str, label: String, which: Showing, ready: bool| {
        tool_button(id, match which {
            Showing::After => "eye",
            Showing::Before => "undo",
            Showing::Changed => "search",
        }, label, CYAN, showing == which)
        .when(!ready, |button| button.opacity(0.45))
        .on_click(cx.listener(move |this, _, _, cx| {
            if let Some(magnifier) = this.captures.magnifier.as_mut() {
                magnifier.showing = which;
            }

            cx.notify();
        }))
    };
    let place = magnifier.place.clone();
    let hover = magnifier.hover;
    let after = hover.and_then(|at| texel(magnifier.after.as_ref().and_then(|shot| shot.pixels.as_ref()), at));
    let before = hover.and_then(|at| texel(magnifier.before.as_ref().and_then(|shot| shot.pixels.as_ref()), at));
    let swatch = |rgba: [u8; 4]| div().size(px(14.0)).rounded(px(3.0)).border_1().border_color(rgb(LINE)).bg(rgb(((rgba[0] as u32) << 16) | ((rgba[1] as u32) << 8) | rgba[2] as u32));
    let height = ((h as f32 / w as f32) * 420.0).clamp(140.0, 420.0);

    Some(
        card(format!("{} · {w}×{h} at {x}, {y} · {}×", magnifier.target, magnifier.zoom), CYAN)
            .child(
                group()
                    .child(tab("magnify-after", "After".into(), Showing::After, magnifier.after.is_some()))
                    .child(tab("magnify-before", "Before".into(), Showing::Before, magnifier.before.is_some()))
                    .child(tab("magnify-changed", "Diff".into(), Showing::Changed, magnifier.changed.is_some() || magnifier.unchanged))
                    .child(icon_button("magnify-close", "close", DIM, false).on_click(cx.listener(|this, _, _, cx| {
                        this.captures.magnifier = None;
                        cx.notify();
                    }))),
            )
            .child(
                div()
                    .id("magnified")
                    .relative()
                    .w_full()
                    .h(px(height))
                    .rounded(px(6.0))
                    .overflow_hidden()
                    .bg(rgb(0x000000))
                    .border_1()
                    .border_color(rgb(LINE))
                    .cursor_crosshair()
                    .child(canvas(move |bounds, _, _| place.set(Some(bounds)), |_, _, _, _| {}).absolute().size_full())
                    .on_mouse_move(cx.listener(move |this, event: &gpui::MouseMoveEvent, _, cx| {
                        let Some(magnifier) = this.captures.magnifier.as_mut() else { return };
                        let Some(bounds) = magnifier.place.get() else { return };
                        let (_, _, w, h) = magnifier.region;
                        let (box_w, box_h) = (f32::from(bounds.size.width), f32::from(bounds.size.height));
                        let scale = (box_w / w as f32).min(box_h / h as f32);
                        let left = f32::from(bounds.origin.x) + (box_w - w as f32 * scale) / 2.0;
                        let top = f32::from(bounds.origin.y) + (box_h - h as f32 * scale) / 2.0;
                        let px = (f32::from(event.position.x) - left) / scale;
                        let py = (f32::from(event.position.y) - top) / scale;
                        let under = (px >= 0.0 && py >= 0.0 && px < w as f32 && py < h as f32).then_some((px as u32, py as u32));

                        if under != magnifier.hover {
                            magnifier.hover = under;
                            cx.notify();
                        }
                    }))
                    .child(match (&picture, &magnifier.error) {
                        (_, Some(error)) => div().p_3().text_xs().text_color(rgb(RED)).child(error.clone()).into_any_element(),
                        (None, None) if showing == Showing::Changed && magnifier.unchanged => div()
                            .size_full()
                            .flex()
                            .items_center()
                            .justify_center()
                            .gap_2()
                            .child(crate::icons::icon("check", 14.0, rgb(GREEN)))
                            .child(note("No change"))
                            .into_any_element(),
                        (Some(path), None) => img(path.clone()).size_full().object_fit(ObjectFit::Contain).into_any_element(),
                        (None, None) => div().size_full().flex().items_center().justify_center().child(note("Reading…")).into_any_element(),
                    }),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .h(px(20.0))
                    .text_xs()
                    .font_family(MONO)
                    .text_color(rgb(TEXT))
                    .child(match hover {
                        Some((hx, hy)) => format!("x {} y {}", x + hx, y + hy),
                        None => String::new(),
                    })
                    .when_some(before.clone(), |row, (rgba, text)| row.child(div().text_color(rgb(DIM)).child("before")).child(swatch(rgba)).child(text))
                    .when_some(after.clone(), |row, (rgba, text)| row.child(div().text_color(rgb(DIM)).child("after")).child(swatch(rgba)).child(text))
                    .when(before.as_ref().zip(after.as_ref()).is_some_and(|(b, a)| b.0 != a.0), |row| row.child(div().text_color(rgb(AMBER)).child("changed"))),
            )
            .when_some(magnifier.summary.clone(), |card, summary| card.child(note(summary))),
    )
}

/// A finding as the person reads it: without the sentences that tell an agent which command to
/// call next ("draw(draw: 10) says which test rejected it").
fn for_people(text: &str) -> String {
    let calls = |sentence: &str| {
        sentence.char_indices().any(|(at, c)| c == '(' && at > 0 && sentence[..at].chars().last().is_some_and(|before| before.is_ascii_lowercase() || before == '_') && sentence[at..].contains(':'))
    };
    let kept: Vec<&str> = text.split_inclusive(". ").filter(|sentence| !calls(sentence)).collect();

    if kept.is_empty() { text.to_string() } else { kept.concat().trim_end().to_string() }
}

/// The depth attachment's picture for the chosen draw, if it has one.
fn depth_picture(state: &State) -> Option<PathBuf> {
    state.attachments.as_ref()?["attachments"]
        .as_array()?
        .iter()
        .find(|tile| tile["attachment"].as_str().is_some_and(|name| name.starts_with("Depth")))
        .and_then(|tile| tile["image"].as_str().map(PathBuf::from))
}

/// Every attachment of the chosen draw's target, side by side, as it stood after the draw.
fn attachments_grid(player: &Player, columns: usize, cx: &mut Context<Player>) -> gpui::Div {
    let state = &player.captures;
    let target = state.draw.as_ref().and_then(|draw| draw["state"]["targetName"].as_str().map(str::to_string));
    let mut grid = div().flex().flex_col().gap_2().p_2().rounded(px(7.0)).bg(rgb(CARD)).border_1().border_color(rgb(LINE)).child(
        div()
            .flex()
            .items_center()
            .gap_2()
            .child(crate::icons::icon("framebuffer", 13.0, rgb(GREEN)))
            .child(section(match &target {
                Some(target) => format!("Attachments · {target}"),
                None => "Attachments".to_string(),
            })),
    );

    let Some(attachments) = &state.attachments else {
        return grid.child(note(if state.selected.is_some() { "Reading…" } else { "" }));
    };

    let tiles: Vec<Value> = attachments["attachments"].as_array().cloned().unwrap_or_default();
    let enlarged = state.enlarged;
    let mut row = div().flex().gap_2();
    let mut in_row = 0;
    let mut rows = Vec::new();

    for (index, tile) in tiles.into_iter().enumerate() {
        let name = tile["attachment"].as_str().unwrap_or("").to_string();
        let handle = tile["handle"].as_str().unwrap_or("").to_string();
        let label = tile["label"].as_str().filter(|label| !label.is_empty()).map(str::to_string).unwrap_or_else(|| handle.clone());
        let depth = name.starts_with("Depth");
        // What the draw wrote: every colour attachment of its target.
        let own = !depth;
        let on = enlarged == Some(index);
        let colour = if depth { BLUE } else { GREEN };

        let picture = match (tile["image"].as_str(), tile["error"].as_str()) {
            (Some(path), _) => img(PathBuf::from(path)).size_full().object_fit(ObjectFit::Contain).into_any_element(),
            (None, Some(error)) => div().p_2().text_xs().text_color(rgb(DIM)).child(error.to_string()).into_any_element(),
            _ => note("…").into_any_element(),
        };

        row = row.child(
            div()
                .id(("attachment", index))
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .rounded(px(6.0))
                .overflow_hidden()
                .cursor_pointer()
                .border_2()
                .border_color(if on { tint(PURPLE, 1.0) } else if own { tint(GREEN, 0.85) } else { rgb(LINE) })
                .when(own || on, |tile| tile.shadow(glow(if on { PURPLE } else { GREEN }, 0.35)))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap_1p5()
                        .h(px(24.0))
                        .px_2()
                        .bg(rgb(RAISED))
                        .text_xs()
                        .child(crate::icons::icon(if depth { "depth" } else { "texture" }, 11.0, rgb(colour)))
                        .child(div().flex_none().font_weight(gpui::FontWeight::SEMIBOLD).text_color(rgb(TEXT)).child(format!("{name}:")))
                        .child(div().min_w_0().overflow_hidden().whitespace_nowrap().text_color(rgb(DIM)).child(label)),
                )
                .child(div().h(px(150.0)).bg(rgb(0x000000)).flex().items_center().justify_center().child(picture))
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.captures.enlarged = if this.captures.enlarged == Some(index) { None } else { Some(index) };
                    cx.notify();
                })),
        );
        in_row += 1;

        if in_row == columns {
            rows.push(row);
            row = div().flex().gap_2();
            in_row = 0;
        }
    }

    if in_row > 0 {
        // Empty places keep the last row's tiles the width of the others.
        for _ in in_row..columns {
            row = row.child(div().flex_1());
        }

        rows.push(row);
    }

    grid = grid.children(rows);

    grid
}

fn workspace(player: &mut Player, tab: usize, cx: &mut Context<Player>) -> gpui::Div {
    let state = &player.captures;
    let capture = state.opened.clone().unwrap_or_default();
    let count = state.events.len();
    let selected = state.selected;
    let loading = state.loading;
    let made = state.made.clone().unwrap_or(Value::Null);
    let findings = made["findings"].as_array().cloned().unwrap_or_default();
    let width = player.panel_px;
    let identical = made["replay_matches"] == true;
    let waiting = made["pending"] == true || made["replay"].as_str().is_some_and(|replay| replay.starts_with("still to come"));

    let header = div()
        .flex()
        .items_center()
        .gap_2()
        .child(icon_label("back", "home", "All", DIM).on_click(cx.listener(|this, _, _, cx| {
            this.captures.opened = None;
            cx.notify();
        })))
        .child(div().font_family(MONO).text_sm().text_color(rgb(PURPLE)).child(capture.clone()))
        .child(note(format!(
            "frame {} · {} · {count} events",
            made["frame"].as_u64().map(|frame| frame.to_string()).unwrap_or_else(|| "?".into()),
            made["api"].as_str().unwrap_or(""),
        )))
        .child(
            div()
                .flex()
                .items_center()
                .gap_1()
                .px_1p5()
                .py(px(1.0))
                .rounded(px(4.0))
                .text_xs()
                .bg(tint(if identical { GREEN } else if waiting { CYAN } else { AMBER }, 0.14))
                .text_color(rgb(if identical { GREEN } else if waiting { CYAN } else { AMBER }))
                .child(crate::icons::icon(if identical { "check" } else if waiting { "timer" } else { "warning" }, 11.0, rgb(if identical { GREEN } else if waiting { CYAN } else { AMBER })))
                .child(if identical { "replay identical" } else if waiting { "textures on their way" } else { "replay differs" }),
        )
        .child(div().flex_1())
        .child(icon_label("wide", "wide", if player.wide { "Narrow" } else { "Wide" }, DIM).on_click(cx.listener(|this, _, _, cx| {
            this.toggle_wide();
            cx.notify();
        })))
        .child(icon_label("send", "send", "Send", BLUE).on_click(cx.listener(|this, _, _, cx| {
            this.send_to_agent();
            cx.notify();
        })));

    // A note of the person's own, sent with the capture, draw and pixel.
    let noting = player.noting;
    let shown =
        if player.note.is_empty() && !noting { "Note for the agent".to_string() } else { player.note.clone() };
    let note_field = div()
        .id("note")
        .track_focus(&player.note_focus)
        .flex()
        .items_center()
        .gap_2()
        .px_2()
        .h(px(28.0))
        .rounded(px(6.0))
        .text_xs()
        .bg(rgb(FIELD))
        .border_1()
        .border_color(if noting { tint(BLUE, 0.8) } else { rgb(LINE) })
        .text_color(if player.note.is_empty() && !noting { rgb(DIM) } else { rgb(TEXT) })
        .overflow_hidden()
        .whitespace_nowrap()
        .cursor_text()
        .on_mouse_down(
            MouseButton::Left,
            cx.listener(|this, _, window, cx| {
                cx.stop_propagation();
                this.start_noting(window, cx);
            }),
        )
        .on_key_down(cx.listener(|this, event: &gpui::KeyDownEvent, _, cx| this.type_note(event, cx)))
        .child(crate::icons::icon("edit", 12.0, tint(DIM, 1.0)))
        .child(format!("{shown}{}", if noting { "▏" } else { "" }));

    let worth = (!findings.is_empty()).then(|| {
        card("Findings", RED).children(findings.into_iter().take(8).map(|finding| {
            let text = finding.as_str().or(finding["text"].as_str()).or(finding["summary"].as_str()).map(str::to_string).unwrap_or_else(|| finding.to_string());
            let text = for_people(&text);

            div().flex().gap_2().text_xs().text_color(rgb(TEXT)).child(crate::icons::icon("warning", 12.0, tint(RED, 0.85))).child(div().flex_1().min_w_0().child(text))
        }))
    });

    // The big picture: the draw's own target, or an attachment chosen in the grid.
    let enlarged = state.enlarged.and_then(|index| state.attachments.as_ref()?["attachments"][index]["image"].as_str().map(PathBuf::from));
    let caption = match (state.enlarged.and_then(|index| state.attachments.as_ref().map(|all| all["attachments"][index].clone())), selected) {
        (Some(tile), Some(draw)) => format!("{} · {} · event {draw}", tile["attachment"].as_str().unwrap_or(""), tile["handle"].as_str().unwrap_or("")),
        (None, Some(draw)) if state.error.is_some() && depth_picture(state).is_some() => {
            format!("{} depth · event {draw}", state.draw.as_ref().and_then(|draw| draw["state"]["targetName"].as_str()).unwrap_or("target"))
        }
        (None, Some(draw)) => format!("{} · event {draw}", state.draw.as_ref().and_then(|draw| draw["state"]["targetName"].as_str()).unwrap_or("target")),
        _ => String::new(),
    };
    let place = state.picture.clone();
    // The box being dragged, or the region the magnifier shows, drawn over the picture.
    let marked = state
        .dragged()
        .map(|region| (region, CYAN, true))
        .or_else(|| state.magnifier.as_ref().filter(|magnifier| Some(magnifier.draw) == selected).map(|magnifier| (magnifier.region, CYAN, false)))
        .and_then(|(region, colour, live)| state.box_in_picture(region).map(|place| (place, colour, live)));
    let picture = div()
        .id("picture")
        .relative()
        .cursor_crosshair()
        .on_mouse_down(
            MouseButton::Left,
            cx.listener(|this, event: &MouseDownEvent, _, cx| {
                if let Some(pixel) = this.captures.pixel_at(event) {
                    this.captures.drag = Some((pixel, pixel));
                }

                cx.notify();
            }),
        )
        .on_mouse_move(cx.listener(|this, event: &gpui::MouseMoveEvent, _, cx| {
            if event.pressed_button == Some(MouseButton::Left) {
                if let (Some((start, _)), Some(end)) = (this.captures.drag, this.captures.pixel_under(event.position, true)) {
                    this.captures.drag = Some((start, end));
                    cx.notify();
                }
            }
        }))
        .on_mouse_up(MouseButton::Left, cx.listener(|this, _, _, cx| {
            this.finish_drag();
            cx.notify();
        }))
        .on_mouse_up_out(MouseButton::Left, cx.listener(|this, _, _, cx| {
            this.finish_drag();
            cx.notify();
        }))
        .child(canvas(move |bounds, _, _| place.set(Some(bounds)), |_, _, _, _| {}).absolute().size_full())
        .w_full()
        .h(px(if width >= 760.0 { (width * 0.36).clamp(260.0, 520.0) } else { 240.0 }))
        .rounded(px(7.0))
        .bg(rgb(0x000000))
        .border_1()
        .border_color(rgb(LINE))
        .flex()
        .items_center()
        .justify_center()
        .overflow_hidden()
        .child(match (enlarged.clone().or(state.target.clone()), &state.error) {
            // A target with no colour (a shadow map's): its depth, from the attachments.
            (_, Some(_)) if enlarged.is_none() && depth_picture(state).is_some() => {
                img(depth_picture(state).unwrap_or_default()).size_full().object_fit(ObjectFit::Contain).into_any_element()
            }
            (_, Some(error)) => div().p_3().text_xs().text_color(rgb(RED)).child(error.clone()).into_any_element(),
            (Some(path), None) => img(path).size_full().object_fit(ObjectFit::Contain).into_any_element(),
            (None, None) => note(if selected.is_some() { "Replaying…" } else { "" }).into_any_element(),
        })
        // Over the picture, so drawn after it.
        .when_some(marked, |frame, ((left, top, width, height), colour, live)| {
            frame.child(
                div()
                    .absolute()
                    .left(px(left))
                    .top(px(top))
                    .w(px(width.max(2.0)))
                    .h(px(height.max(2.0)))
                    .border_1()
                    .border_color(tint(colour, if live { 1.0 } else { 0.8 }))
                    .bg(tint(colour, if live { 0.12 } else { 0.05 }))
                    .shadow(glow(colour, 0.5)),
            )
        })
        .when(!caption.is_empty(), |frame| {
            frame.child(div().absolute().left(px(8.0)).top(px(8.0)).px_1p5().py(px(1.0)).rounded(px(4.0)).bg(tint(0x000000, 0.65)).text_xs().text_color(rgb(TEXT)).child(caption))
        });

    // What a click on the picture found: the pixel's value and every event that changed it.
    let story = state.pixel.map(|(x, y)| {
        let found = card(format!("Pixel ({x}, {y})"), CYAN);

        match &state.story {
            None => found.child(note("Reading…")),
            Some(story) => {
                let swatch = |rgba: &Value| -> gpui::Div {
                    let channel = |index: usize| rgba[index].as_u64().unwrap_or(0) as u32;
                    let colour = (channel(0) << 16) | (channel(1) << 8) | channel(2);

                    div().size(px(14.0)).rounded_sm().border_1().border_color(rgb(LINE)).bg(rgb(colour))
                };
                let finished = story["final"].clone();

                found
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap_2()
                            .text_xs()
                            .child(swatch(&finished))
                            .child(div().font_family(MONO).child(format!("final {finished}"))),
                    )
                    .children(story["changes"].as_array().cloned().unwrap_or_default().into_iter().map(|change| {
                        let draw = change["draw"].as_i64().unwrap_or(0);

                        div()
                            .id(("change", draw as usize))
                            .flex()
                            .items_center()
                            .gap_2()
                            .text_xs()
                            .cursor_pointer()
                            .hover(|line| line.bg(tint(CYAN, 0.1)))
                            .child(div().w(px(70.0)).font_family(MONO).text_color(rgb(CYAN)).child(format!("event {draw}")))
                            .child(swatch(&change["after"]))
                            .child(div().font_family(MONO).text_color(rgb(TEXT)).child(change["after"].to_string()))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.select_draw(draw, cx);
                                cx.notify();
                            }))
                    }))
            }
        }
    });

    let draw = state.draw.clone();
    let said = draw.as_ref().map(|draw| {
        let effect = &draw["effect"];

        match (effect["changed"].as_u64(), draw["why"].as_str().or(draw["rejected"].as_str())) {
            (_, Some(why)) => why.to_string(),
            (Some(0), None) => "No change".to_string(),
            (Some(changed), None) => format!("{changed} pixels changed"),
            _ => String::new(),
        }
    });
    let table = match (&draw, selected) {
        (_, None) => note("").into_any_element(),
        (None, Some(_)) => note("Reading…").into_any_element(),
        (Some(draw), Some(_)) => bound_resources(player, draw, cx).into_any_element(),
    };
    let magnified = magnifier_card(player, cx);
    let state_card = draw.as_ref().zip(selected).map(|(draw, number)| card(format!("Draw {number}"), PURPLE).when_some(said.clone(), |card, said| card.child(div().text_xs().text_color(rgb(TEXT)).child(said))).child(state_of(draw)));

    // One tab at a time beside the navigator: the frame, the bindings, the state, or the
    // timeline over the whole width.
    let navigator_width = if width >= 1100.0 { 310.0 } else { 270.0 };
    let tall = if width >= 1100.0 { 640.0 } else { 520.0 };
    let side = width >= 760.0;
    let main = match tab {
        0 if width >= 1100.0 => div()
            .flex()
            .gap_3()
            .child(div().flex_1().min_w_0().flex().flex_col().gap_2().child(picture).children(magnified))
            .child(div().w(px((width * 0.28).clamp(300.0, 480.0))).flex_none().flex().flex_col().gap_2().child(attachments_grid(player, 1, cx)).children(story)),
        0 => div().flex().flex_col().gap_2().child(picture).children(magnified).children(story).child(attachments_grid(player, 2, cx)),
        1 => div().flex().flex_col().gap_2().child(table),
        2 => div().flex().flex_col().gap_2().children(worth).children(state_card),
        _ => div().flex().flex_col().gap_2().children((!player.captures.events.is_empty()).then(|| timeline(player, cx))).child(picture),
    };
    let body = if side {
        div().flex().gap_3().child(div().w(px(navigator_width)).flex_none().child(navigator(player, tall, cx))).child(div().flex_1().min_w_0().child(main))
    } else {
        div().flex().flex_col().gap_2().child(navigator(player, 220.0, cx)).child(main)
    };

    div().flex().flex_col().gap_2().child(header).child(note_field).when(loading, |content| content.child(note("Reading…"))).child(body)
}

/// A recording: its contact sheet, what the host says of it, and its frames, any of which
/// becomes a capture with a click.
fn recording(player: &mut Player, cx: &mut Context<Player>) -> gpui::Div {
    let state = &player.captures;
    let name = state.recording.clone().unwrap_or_default();
    let value = state.frames.clone().unwrap_or(Value::Null);
    let sheet =
        value["images"].as_array().and_then(|images| images.first()).and_then(|image| image["view"].as_str().or(image["original"].as_str())).map(PathBuf::from);
    let summary: Vec<String> = value["summary"]
        .as_str()
        .unwrap_or("Reading the recording…")
        .lines()
        .filter(|line| !line.contains("Contact sheet"))
        .take(6)
        .map(str::to_string)
        .collect();
    let frames = value["data"]["frames"].as_array().cloned().unwrap_or_default();

    div()
        .flex()
        .flex_col()
        .gap_2()
        .child(
            div()
                .flex()
                .items_center()
                .gap_2()
                .child(icon_label("back-recording", "undo", "All", DIM).on_click(cx.listener(|this, _, _, cx| {
                    this.captures.recording = None;
                    cx.notify();
                })))
                .child(div().font_family(MONO).text_color(rgb(ORANGE)).child(name)),
        )
        .children(summary.into_iter().map(|line| div().text_xs().text_color(rgb(TEXT)).child(line)))
        .when_some(sheet, |content, sheet| {
            content.child(
                div()
                    .w_full()
                    .h(px(200.0))
                    .rounded_md()
                    .bg(rgb(0x000000))
                    .border_1()
                    .border_color(tint(FAINT, 0.8))
                    .overflow_hidden()
                    .child(img(sheet).size_full().object_fit(ObjectFit::Contain)),
            )
        })
        .child(div().flex().flex_wrap().gap_1().children(frames.into_iter().map(|frame| {
            let number = frame["frame"].as_u64().unwrap_or(0);
            let unusual = frame["unusual"] == true;

            div()
                .id(("frame", number as usize))
                .px_1p5()
                .py(px(2.0))
                .rounded_sm()
                .text_xs()
                .font_family(MONO)
                .cursor_pointer()
                .bg(tint(if unusual { RED } else { ORANGE }, if unusual { 0.3 } else { 0.08 }))
                .border_1()
                .border_color(tint(if unusual { RED } else { ORANGE }, 0.35))
                .text_color(rgb(if unusual { RED } else { TEXT }))
                .hover(|chip| chip.bg(tint(ORANGE, 0.3)))
                .child(number.to_string())
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.capture_frame(number);
                    cx.notify();
                }))
        })))
}

pub fn render(player: &mut Player, _window: &mut Window, cx: &mut Context<Player>) -> AnyElement {
    if player.captures.opened.is_some() {
        let tab = player.tab("captures").min(3);
        let content = workspace(player, tab, cx);

        return crate::panels::tabbed(player, "captures", "Captures", PURPLE, &["Frame", "Bindings", "State", "Timeline"], cx, content);
    }

    let content = if player.captures.recording.is_some() { recording(player, cx) } else { list_of_captures(player, cx) };

    crate::panels::frame("captures", "Captures", PURPLE, content)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_finding_keeps_its_facts_and_loses_the_agent_s_next_step() {
        assert_eq!(
            for_people("33 draws changed no pixels: events 11–15, 25–28. draw(draw: 11) says which test rejected it."),
            "33 draws changed no pixels: events 11–15, 25–28."
        );
        assert_eq!(for_people("Event 9 blends, but opaque events 11–12 are drawn after it."), "Event 9 blends, but opaque events 11–12 are drawn after it.");
    }
}
