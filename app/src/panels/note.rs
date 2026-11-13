//! Note: the frozen frame, to mark and send to the agent (docs/GAME.md, section 6).
//!
//! The person draws on the frame with a pen, arrows, boxes, rings and numbered pins, in five
//! colours, writes what is wrong, and sends it. The marks go to the host as shapes in canvas
//! pixels, and the host draws them onto the frame itself.

use std::cell::Cell;
use std::path::PathBuf;
use std::rc::Rc;

use gpui::{AnyElement, Bounds, Context, MouseButton, ObjectFit, Pixels, SharedString, Window, canvas, div, img, point, prelude::*, px, rgb};
use serde_json::{Value, json};

use crate::panels::live::Entry;
use crate::player::Player;
use crate::theme::*;

pub const TOOLS: &[(&str, &str)] = &[("pen", "Pen"), ("arrow", "Arrow"), ("rect", "Box"), ("ellipse", "Ring"), ("text", "Pin")];
pub const COLOURS: &[(&str, u32)] = &[("red", 0xef4444), ("yellow", 0xfacc15), ("green", 0x4ade80), ("cyan", 0x22d3ee), ("white", 0xffffff)];

pub struct Marking {
    /// The frame as it was frozen, and its size in canvas pixels.
    pub picture: PathBuf,
    pub size: (f32, f32),
    pub marks: Vec<Value>,
    /// The shape being drawn now.
    pub drawing: Option<Value>,
    pub tool: &'static str,
    pub colour: &'static str,
    pub text: String,
    pub sending: bool,
    pub place: Rc<Cell<Option<Bounds<Pixels>>>>,
}

impl Marking {
    pub fn new(picture: PathBuf, size: (f32, f32)) -> Self {
        Marking { picture, size, marks: Vec::new(), drawing: None, tool: "arrow", colour: "red", text: String::new(), sending: false, place: Rc::new(Cell::new(None)) }
    }

    /// Where the frame sits in its box: left and top in the window, and its scale.
    fn fit(bounds: Bounds<Pixels>, (width, height): (f32, f32)) -> (f32, f32, f32) {
        let (box_w, box_h) = (f32::from(bounds.size.width), f32::from(bounds.size.height));
        let scale = (box_w / width.max(1.0)).min(box_h / height.max(1.0));

        (f32::from(bounds.origin.x) + (box_w - width * scale) / 2.0, f32::from(bounds.origin.y) + (box_h - height * scale) / 2.0, scale)
    }

    /// A point of the window as canvas pixels, kept on the frame.
    pub fn at(&self, position: gpui::Point<Pixels>) -> Option<(f64, f64)> {
        let (left, top, scale) = Self::fit(self.place.get()?, self.size);
        let x = ((f32::from(position.x) - left) / scale).clamp(0.0, self.size.0 - 1.0);
        let y = ((f32::from(position.y) - top) / scale).clamp(0.0, self.size.1 - 1.0);

        Some((x.round() as f64, y.round() as f64))
    }

    /// Begins a shape where the pointer went down. A pin is placed at once.
    pub fn down(&mut self, (x, y): (f64, f64)) -> Option<usize> {
        let colour = self.colour;

        match self.tool {
            "pen" => self.drawing = Some(json!({ "tool": "pen", "points": [[x, y]], "colour": colour })),
            "arrow" => self.drawing = Some(json!({ "tool": "arrow", "from": [x, y], "to": [x, y], "colour": colour })),
            "rect" | "ellipse" => self.drawing = Some(json!({ "tool": self.tool, "sx": x, "sy": y, "x": x, "y": y, "w": 0, "h": 0, "colour": colour })),
            _ => {
                self.marks.push(json!({ "tool": "text", "x": x, "y": y, "text": "", "colour": colour }));

                return Some(self.marks.len() - 1);
            }
        }

        None
    }

    pub fn moved(&mut self, (x, y): (f64, f64)) {
        let Some(shape) = self.drawing.as_mut() else { return };

        match shape["tool"].as_str().unwrap_or("") {
            "pen" => {
                if let Some(points) = shape["points"].as_array_mut() {
                    if points.len() < 4000 {
                        points.push(json!([x, y]));
                    }
                }
            }
            "arrow" => shape["to"] = json!([x, y]),
            _ => {
                let (sx, sy) = (shape["sx"].as_f64().unwrap_or(x), shape["sy"].as_f64().unwrap_or(y));

                shape["x"] = json!(sx.min(x));
                shape["y"] = json!(sy.min(y));
                shape["w"] = json!((x - sx).abs());
                shape["h"] = json!((y - sy).abs());
            }
        }
    }

    pub fn up(&mut self) {
        if let Some(mut shape) = self.drawing.take() {
            if let Some(object) = shape.as_object_mut() {
                object.remove("sx");
                object.remove("sy");
            }

            self.marks.push(shape);
        }
    }

    /// What is sent: the words, and every mark.
    pub fn sent(&self) -> Value {
        json!({ "text": self.text.trim(), "marks": self.marks })
    }
}

fn colour_value(name: &str) -> u32 {
    COLOURS.iter().find(|(known, _)| *known == name).map_or(COLOURS[0].1, |(_, value)| *value)
}

/// Draws the marks over the frame, in the window, as the host will draw them onto it.
fn paint(window: &mut Window, bounds: Bounds<Pixels>, size: (f32, f32), marks: &[Value]) {
    let (left, top, scale) = Marking::fit(bounds, size);
    let at = |x: f64, y: f64| point(px(left + x as f32 * scale), px(top + y as f32 * scale));
    // Strokes are rows of small round quads: a path is drawn under a picture beside it, a quad is not.
    let stroke = |window: &mut Window, points: &[(f64, f64)], colour: u32| {
        let radius = 1.5f32;

        for pair in points.windows(2) {
            let (a, b) = (at(pair[0].0, pair[0].1), at(pair[1].0, pair[1].1));
            let (dx, dy) = (f32::from(b.x - a.x), f32::from(b.y - a.y));
            let steps = ((dx * dx + dy * dy).sqrt() / 1.2).ceil().max(1.0) as usize;

            for step in 0..=steps {
                let t = step as f32 / steps as f32;
                let centre = point(a.x + px(dx * t), a.y + px(dy * t));

                window.paint_quad(
                    gpui::fill(gpui::Bounds::new(point(centre.x - px(radius), centre.y - px(radius)), gpui::size(px(radius * 2.0), px(radius * 2.0))), tint(colour, 1.0))
                        .corner_radii(px(radius)),
                );
            }
        }
    };

    for mark in marks {
        let colour = colour_value(mark["colour"].as_str().unwrap_or("red"));
        let (x, y, w, h) = (mark["x"].as_f64().unwrap_or(0.0), mark["y"].as_f64().unwrap_or(0.0), mark["w"].as_f64().unwrap_or(0.0), mark["h"].as_f64().unwrap_or(0.0));
        let pair = |value: &Value| (value[0].as_f64().unwrap_or(0.0), value[1].as_f64().unwrap_or(0.0));

        match mark["tool"].as_str().unwrap_or("") {
            "pen" => {
                let points: Vec<(f64, f64)> = mark["points"].as_array().into_iter().flatten().map(pair).collect();

                stroke(window, &points, colour);
            }
            "arrow" => {
                let (from, to) = (pair(&mark["from"]), pair(&mark["to"]));
                let angle = (to.1 - from.1).atan2(to.0 - from.0);
                let head = 12.0 / scale as f64;

                stroke(window, &[from, to], colour);

                for side in [-0.5f64, 0.5] {
                    let back = angle + std::f64::consts::PI + side;

                    stroke(window, &[to, (to.0 + head * back.cos(), to.1 + head * back.sin())], colour);
                }
            }
            "rect" => stroke(window, &[(x, y), (x + w, y), (x + w, y + h), (x, y + h), (x, y)], colour),
            "ellipse" => {
                let points: Vec<(f64, f64)> = (0..=72)
                    .map(|step| {
                        let angle = step as f64 / 72.0 * std::f64::consts::TAU;

                        (x + w / 2.0 + w / 2.0 * angle.cos(), y + h / 2.0 + h / 2.0 * angle.sin())
                    })
                    .collect();

                stroke(window, &points, colour);
            }
            "text" => {
                let ring = 8.0 / scale as f64;
                let points: Vec<(f64, f64)> = (0..=36).map(|step| step as f64 / 36.0 * std::f64::consts::TAU).map(|angle| (x + ring * angle.cos(), y + ring * angle.sin())).collect();

                stroke(window, &points, colour);
            }
            _ => {}
        }
    }
}

pub fn render(player: &mut Player, _window: &mut Window, cx: &mut Context<Player>) -> AnyElement {
    let Some(marking) = player.marking.as_ref() else { return div().into_any_element() };
    let typing = player.live.entry.clone();
    let typed = player.live.typed.clone();
    let place = marking.place.clone();
    let size = marking.size;
    let mut shown: Vec<Value> = marking.marks.clone();

    shown.extend(marking.drawing.clone());

    let tools = group().children(TOOLS.iter().map(|(tool, word)| {
        let tool = *tool;

        tab_button(SharedString::from(format!("note-tool-{tool}")), *word, RED, marking.tool == tool).on_click(cx.listener(move |this, _, _, cx| {
            if let Some(marking) = this.marking.as_mut() {
                marking.tool = tool;
            }

            cx.notify();
        }))
    }));

    let colours = group().children(COLOURS.iter().map(|(name, value)| {
        let name = *name;
        let on = marking.colour == name;

        div()
            .id(SharedString::from(format!("note-colour-{name}")))
            .size(px(22.0))
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(5.0))
            .cursor_pointer()
            .when(on, |swatch| swatch.bg(rgb(RAISED)))
            .child(div().size(px(13.0)).rounded_full().bg(rgb(*value)).when(on, |dot| dot.border_2().border_color(rgb(0xffffff))))
            .on_click(cx.listener(move |this, _, _, cx| {
                if let Some(marking) = this.marking.as_mut() {
                    marking.colour = name;
                }

                cx.notify();
            }))
    }));

    // Each pin's number, over the frame where it was put.
    let pins: Vec<(usize, f64, f64, u32)> = marking
        .marks
        .iter()
        .filter(|mark| mark["tool"] == "text")
        .enumerate()
        .map(|(index, mark)| (index + 1, mark["x"].as_f64().unwrap_or(0.0), mark["y"].as_f64().unwrap_or(0.0), colour_value(mark["colour"].as_str().unwrap_or("red"))))
        .collect();
    let labels = place.get().map(|bounds| {
        let (left, top, scale) = Marking::fit(bounds, size);
        let (origin_x, origin_y) = (f32::from(bounds.origin.x), f32::from(bounds.origin.y));

        pins.iter()
            .map(|(number, x, y, colour)| {
                div()
                    .absolute()
                    .left(px(left - origin_x + *x as f32 * scale + 10.0))
                    .top(px(top - origin_y + *y as f32 * scale - 9.0))
                    .px_1()
                    .rounded(px(3.0))
                    .bg(rgb(*colour))
                    .text_xs()
                    .font_weight(gpui::FontWeight::BOLD)
                    .text_color(rgb(0x000000))
                    .child(number.to_string())
            })
            .collect::<Vec<_>>()
    });

    let picture = div()
        .id("note-picture")
        .relative()
        .flex_1()
        .min_h_0()
        .rounded(px(7.0))
        .bg(rgb(0x000000))
        .border_1()
        .border_color(rgb(LINE))
        .cursor_crosshair()
        .overflow_hidden()
        .child(div().absolute().size_full().child(img(marking.picture.clone()).size_full().object_fit(ObjectFit::Contain)))
        .children(labels.into_iter().flatten())
        .child(div().absolute().size_full().child(canvas(move |bounds, _, _| place.set(Some(bounds)), move |bounds, _, window, _| paint(window, bounds, size, &shown)).size_full()))
        .on_mouse_down(
            MouseButton::Left,
            cx.listener(|this, event: &gpui::MouseDownEvent, window, cx| {
                this.mark_down(event.position, window, cx);
                cx.notify();
            }),
        )
        .on_mouse_move(cx.listener(|this, event: &gpui::MouseMoveEvent, _, cx| {
            if event.pressed_button == Some(MouseButton::Left) {
                if let Some(marking) = this.marking.as_mut() {
                    if let Some(at) = marking.at(event.position) {
                        marking.moved(at);
                        cx.notify();
                    }
                }
            }
        }))
        .on_mouse_up(
            MouseButton::Left,
            cx.listener(|this, _, _, cx| {
                if let Some(marking) = this.marking.as_mut() {
                    marking.up();
                }

                cx.notify();
            }),
        )
        .on_mouse_up_out(
            MouseButton::Left,
            cx.listener(|this, _, _, cx| {
                if let Some(marking) = this.marking.as_mut() {
                    marking.up();
                }

                cx.notify();
            }),
        );

    // The words: the note's own, or the pin being labelled.
    let (field_text, field_on, hint) = match &typing {
        Some(Entry::Pin { index }) => (format!("{typed}▏"), true, format!("Words for pin {}", marking.marks[..=(*index).min(marking.marks.len().saturating_sub(1))].iter().filter(|mark| mark["tool"] == "text").count())),
        Some(Entry::NoteText) => (format!("{typed}▏"), true, String::new()),
        _ => (marking.text.clone(), false, String::new()),
    };
    let empty = field_text.is_empty() && !field_on;

    let field = div()
        .id("note-text")
        .flex()
        .items_center()
        .gap_2()
        .px_2()
        .h(px(32.0))
        .rounded(px(6.0))
        .text_sm()
        .bg(rgb(FIELD))
        .border_1()
        .border_color(if field_on { tint(RED, 0.8) } else { rgb(LINE) })
        .text_color(if empty { rgb(DIM) } else { rgb(TEXT) })
        .overflow_hidden()
        .whitespace_nowrap()
        .cursor_text()
        .on_mouse_down(
            MouseButton::Left,
            cx.listener(|this, _, window, cx| {
                cx.stop_propagation();

                let current = this.marking.as_ref().map(|marking| marking.text.clone()).unwrap_or_default();

                this.start_watch_entry(Entry::NoteText, current, window, cx);
            }),
        )
        .child(crate::icons::icon("edit", 13.0, tint(DIM, 1.0)))
        .when(!hint.is_empty(), |field| field.child(div().text_xs().text_color(tint(RED, 1.0)).child(hint)))
        .child(if empty { "What is wrong here?".to_string() } else { field_text });

    let sending = marking.sending;
    let count = marking.marks.len();

    div()
        .id("note-keys")
        .track_focus(&player.watch_focus)
        .on_key_down(cx.listener(|this, event: &gpui::KeyDownEvent, _, cx| this.type_watch(event, cx)))
        .size_full()
        .flex()
        .flex_col()
        .child(
            crate::panels::header("edit", "Note", RED)
                .child(div().flex_1())
                .child(button("note-cancel", "Cancel", DIM).on_click(cx.listener(|this, _, _, cx| {
                    this.cancel_note();
                    cx.notify();
                })))
                .child(icon_label("note-send", "send", if sending { "Sending…" } else { "Send to agent" }, RED).on_click(cx.listener(|this, _, _, cx| {
                    this.send_note();
                    cx.notify();
                }))),
        )
        .child(
            div()
                .flex_1()
                .min_h_0()
                .flex()
                .flex_col()
                .gap_2()
                .p_3()
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap_2()
                        .child(tools)
                        .child(colours)
                        .child(div().flex_1())
                        .child(icon_label("note-undo", "undo", "Undo", DIM).on_click(cx.listener(|this, _, _, cx| {
                            if let Some(marking) = this.marking.as_mut() {
                                marking.marks.pop();
                            }

                            cx.notify();
                        })))
                        .child(button("note-clear", "Clear", DIM).on_click(cx.listener(|this, _, _, cx| {
                            if let Some(marking) = this.marking.as_mut() {
                                marking.marks.clear();
                            }

                            cx.notify();
                        }))),
                )
                .child(picture)
                .child(field)
                .child(note(format!(
                    "{count} mark{}. The agent gets the frame with and without them, your words, a capture, the take that leads here, the watches and the audio.",
                    if count == 1 { "" } else { "s" }
                ))),
        )
        .into_any_element()
}
