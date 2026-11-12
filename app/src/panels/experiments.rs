//! Experiments: change how the running game draws and see what changes. Every control here is
//! a host command an agent can run too (help(topic: "patch")): live_view, patch_state,
//! patch_draws, patch_texture, patch_shader, experiment and patches. Each change is a patch,
//! undone with a click; the page's own objects are never touched.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use gpui::{AnyElement, Context, ObjectFit, Window, div, img, prelude::*, px, rgb};
use serde_json::{Value, json};

use crate::player::Player;
use crate::theme::*;

#[derive(Default)]
pub struct State {
    /// What is in force, as patches() lists it.
    pub patches: Vec<Value>,
    /// The app's own switches, by a key it chose ("prg_2:skip"), and the patch each made.
    pub active: HashMap<String, String>,
    /// Switches asked for and not yet answered.
    pub waiting: HashSet<String>,
    /// The view the frame is drawn in: "" for the page's own.
    pub view: String,
    pub programs: Vec<Value>,
    pub textures: Vec<Value>,
    /// The last measurement, and the one under way.
    pub measured: Option<Value>,
    pub measuring: Option<String>,
    /// A shader being edited in the person's own editor: the program, the shader, the file and
    /// when it was last written.
    pub editing: Option<Edit>,
}

#[derive(Clone)]
pub struct Edit {
    pub program: String,
    pub shader: String,
    pub path: PathBuf,
    pub written: Option<std::time::SystemTime>,
}

impl State {
    pub fn listed(&mut self, data: &Value) {
        self.patches = data["patches"].as_array().cloned().unwrap_or_default();

        // A switch whose patch has gone (a reload, an undo elsewhere) is off.
        let live: HashSet<String> = self.patches.iter().filter_map(|patch| patch["patch"].as_str().map(str::to_string)).collect();

        self.active.retain(|_, patch| live.contains(patch));

        // The view is the page's own again once its patch has gone, unless one is on its way.
        if !self.active.contains_key("view") && !self.waiting.contains("view") {
            self.view.clear();
        }
    }

    pub fn on(&self, key: &str) -> bool {
        self.active.contains_key(key)
    }
}

/// A switch: lit when its patch is in force, waiting while it is asked for.
fn switch(player: &Player, key: &str, label: &str, colour: u32, method: &'static str, params: Value, cx: &mut Context<Player>) -> gpui::Stateful<gpui::Div> {
    let on = player.experiments.on(key);
    let waiting = player.experiments.waiting.contains(key);
    let chosen = key.to_string();
    let base = button(format!("switch-{key}"), if waiting { format!("{label}…") } else { label.to_string() }, if on { colour } else { DIM });

    let base = if on { base.bg(tint(colour, 0.32)).border_color(tint(colour, 0.9)).shadow(glow(colour, 0.4)) } else { base };

    base.on_click(cx.listener(move |this, _, _, cx| {
        this.toggle_patch(chosen.clone(), method, params.clone());
        cx.notify();
    }))
}

pub fn render(player: &mut Player, _window: &mut Window, cx: &mut Context<Player>) -> AnyElement {
    let wide = player.panel_px >= 720.0;

    // The frame drawn another way.
    let views = [("", "Normal"), ("wireframe", "Wireframe"), ("overdraw", "Overdraw"), ("depth", "Depth"), ("draw_id", "Draw ID")];
    let current = player.experiments.view.clone();
    let view_card = card("See the frame another way", CYAN)
        .child(note("The running game, drawn as each draw's outline, how often each pixel is drawn, its depth, or a colour per draw. Offscreen passes too."))
        .child(div().flex().flex_wrap().gap_1().children(views.into_iter().map(|(view, label)| {
            let on = current == view;

            button(format!("view-{label}"), label, if on { CYAN } else { DIM })
                .when(on, |button| button.bg(tint(CYAN, 0.3)).border_color(tint(CYAN, 0.9)))
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.set_view(view);
                    cx.notify();
                }))
        })));

    // The whole frame's state.
    let state_card = card("Every draw", AMBER)
        .child(note("Switch a test off for the whole frame: is the thing missing because it is culled, hidden by depth, or blended away?"))
        .child(
            div()
                .flex()
                .flex_wrap()
                .gap_1()
                .child(switch(player, "all:cull", "Culling off", AMBER, "patch_state", json!({ "state": { "cull": false } }), cx))
                .child(switch(player, "all:depth_test", "Depth test off", AMBER, "patch_state", json!({ "state": { "depth_test": false } }), cx))
                .child(switch(player, "all:depth_write", "Depth writes off", AMBER, "patch_state", json!({ "state": { "depth_write": false } }), cx))
                .child(switch(player, "all:blend", "Blending off", AMBER, "patch_state", json!({ "state": { "blend": false } }), cx))
                .child(switch(player, "all:solid", "Every draw flat", AMBER, "patch_draws", json!({ "mode": "solid" }), cx)),
        );

    // Programs: a three.js material, a pass, a post effect. Hide one, draw it flat, or draw
    // only it.
    let webgpu = player.status["contexts"].as_array().and_then(|contexts| contexts.first()).is_some_and(|context| context["api"] == "webgpu");
    let key_name = if webgpu { "pipeline" } else { "program" };
    let programs = player.experiments.programs.clone();
    let programs_card = card(if webgpu { "Pipelines" } else { "Programs" }, PURPLE)
        .child(note("Each is one shader pair: a material, a pass, a post effect. Hide its draws, draw them in one flat colour, or draw nothing else."))
        .when(programs.is_empty(), |card| card.child(note("None yet.")))
        .children(programs.iter().take(60).map(|row| {
            let handle = row["handle"].as_str().unwrap_or("").to_string();
            let label = row["label"].as_str().map(|label| format!(" «{label}»")).unwrap_or_default();
            let what = format!("{}{label}", row["what"].as_str().unwrap_or(""));
            let filter = json!({ key_name: handle });

            div()
                .flex()
                .items_center()
                .gap_2()
                .py(px(2.0))
                .child({
                    let open = handle.clone();

                    div()
                        .id(gpui::SharedString::from(format!("open-{handle}")))
                        .w(px(56.0))
                        .flex_none()
                        .font_family(MONO)
                        .text_xs()
                        .text_color(rgb(PURPLE))
                        .cursor_pointer()
                        .hover(|label| label.text_color(rgb(TEXT)))
                        .child(handle.clone())
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.show(crate::panels::Panel::Resources);
                            this.select_resource(open.clone());
                            cx.notify();
                        }))
                })
                .child(div().flex_1().min_w_0().overflow_hidden().whitespace_nowrap().text_xs().text_color(rgb(TEXT)).child(what))
                .child(switch(player, &format!("{handle}:skip"), "Hide", PURPLE, "patch_draws", json!({ "filter": filter, "mode": "skip" }), cx))
                .child(switch(player, &format!("{handle}:solid"), "Flat", PURPLE, "patch_draws", json!({ "filter": filter, "mode": "solid" }), cx))
                .child(switch(player, &format!("{handle}:isolate"), "Only", PURPLE, "patch_draws", json!({ "filter": filter, "mode": "isolate" }), cx))
        }));

    // Textures: a stand-in for each, to see where it lands, or to rule it out.
    let textures = player.experiments.textures.clone();
    let textures_card = card("Textures", GREEN)
        .child(note(
            "Put a stand-in in a texture's place: a checkerboard shows where and how it is mapped; white or black rules it out; mips colours each level.",
        ))
        .when(textures.is_empty(), |card| card.child(note("None yet.")))
        .children(textures.iter().take(60).map(|row| {
            let handle = row["handle"].as_str().unwrap_or("").to_string();
            let picture = match player.resources.thumbs.get(&handle) {
                Some(crate::panels::resources::Thumb::Ready(path)) => Some(path.clone()),
                _ => None,
            };
            let what = row["what"].as_str().unwrap_or("").to_string();

            div()
                .flex()
                .items_center()
                .gap_2()
                .py(px(2.0))
                .child(
                    div()
                        .size(px(34.0))
                        .flex_none()
                        .rounded_sm()
                        .bg(rgb(0x000000))
                        .overflow_hidden()
                        .when_some(picture, |frame, path: PathBuf| frame.child(img(path).size_full().object_fit(ObjectFit::Cover))),
                )
                .child(div().w(px(50.0)).flex_none().font_family(MONO).text_xs().text_color(rgb(GREEN)).child(handle.clone()))
                .child(div().flex_1().min_w_0().overflow_hidden().whitespace_nowrap().text_xs().text_color(rgb(TEXT)).child(what))
                .children(["checker", "white", "black", "mips"].into_iter().map(|with| {
                    let label = match with {
                        "checker" => "Checker",
                        "white" => "White",
                        "black" => "Black",
                        _ => "Mips",
                    };

                    switch(player, &format!("{handle}:{with}"), label, GREEN, "patch_texture", json!({ "handle": handle, "with": with }), cx)
                }))
        }));

    // Where the time goes.
    let measuring = player.experiments.measuring.clone();
    let measured = player.experiments.measured.clone();
    let measure_card = card("Where the GPU time goes", BLUE)
        .child(note("Each measures the frame with and without a change, a few times each way, then puts the page back."))
        .child(div().flex().flex_wrap().gap_1().children(
            [("scissor_1px", "Fill: draw one pixel"), ("flat_fragment", "Shading: flat colour"), ("textures_2x2", "Textures: 2×2")].into_iter().map(
                |(kind, label)| {
                    let running = measuring.as_deref() == Some(kind);

                    button(format!("measure-{kind}"), if running { format!("{label}…") } else { label.to_string() }, BLUE).on_click(cx.listener(
                        move |this, _, _, cx| {
                            this.measure(kind);
                            cx.notify();
                        },
                    ))
                },
            ),
        ))
        .when_some(measured, |card, measured| {
            let gpu = &measured["data"]["gpu_ms"];
            let without = gpu["without"].as_f64().unwrap_or(0.0);
            let with = gpu["with"].as_f64().unwrap_or(0.0);
            let steady = gpu["steady"] != false;
            let ceiling = without.max(with).max(0.001);
            let bar = |label: &str, value: f64, colour: u32| {
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .child(div().w(px(64.0)).text_xs().text_color(rgb(DIM)).child(label.to_string()))
                    .child(div().flex_1().child(meter(30, (value / ceiling) as f32, colour)))
                    .child(div().w(px(80.0)).text_xs().font_family(MONO).text_color(rgb(TEXT)).child(format!("{value:.3} ms")))
            };

            card.child(bar("as it is", without, BLUE)).child(bar("changed", with, GREEN)).child(
                div()
                    .text_xs()
                    .text_color(rgb(if steady { TEXT } else { AMBER }))
                    .child(measured["summary"].as_str().unwrap_or("").lines().take(3).collect::<Vec<_>>().join(" ")),
            )
        });

    // What is in force.
    let patches = player.experiments.patches.clone();
    let force_card = card("In force", RED)
        .when(patches.is_empty(), |card| card.child(note("Nothing: the game draws as its own code says.")))
        .when(!patches.is_empty(), |card| {
            card.child(div().flex().child(div().flex_1()).child(button("undo-all", "Undo all", RED).on_click(cx.listener(|this, _, _, cx| {
                this.revert_patch("all".to_string());
                cx.notify();
            }))))
        })
        .children(patches.into_iter().map(|patch| {
            let handle = patch["patch"].as_str().unwrap_or("").to_string();
            let chosen = handle.clone();
            let draws = patch["draws"].as_u64().map(|draws| format!("{draws} draws a frame")).unwrap_or_default();

            div()
                .flex()
                .items_center()
                .gap_2()
                .py(px(2.0))
                .child(div().w(px(44.0)).flex_none().font_family(MONO).text_xs().text_color(rgb(RED)).child(handle))
                .child(div().flex_1().min_w_0().text_xs().text_color(rgb(TEXT)).child(patch["description"].as_str().unwrap_or("").to_string()))
                .child(div().flex_none().text_xs().text_color(rgb(DIM)).child(draws))
                .child(button(format!("undo-{chosen}"), "Undo", RED).on_click(cx.listener(move |this, _, _, cx| {
                    this.revert_patch(chosen.clone());
                    cx.notify();
                })))
        }));

    let editing = player.experiments.editing.clone().map(|edit| {
        card("Editing a shader", ORANGE)
            .child(
                div()
                    .text_xs()
                    .text_color(rgb(TEXT))
                    .child(format!("{} of {} is open in your editor. Each time you save it, the game draws with it.", edit.shader, edit.program)),
            )
            .child(div().text_xs().font_family(MONO).text_color(rgb(DIM)).child(edit.path.display().to_string()))
            .child(button("stop-editing", "Stop and put the shader back", ORANGE).on_click(cx.listener(|this, _, _, cx| {
                this.stop_editing_shader();
                cx.notify();
            })))
    });

    let content = if wide {
        div()
            .flex()
            .gap_2()
            .child(
                div().flex_1().min_w_0().flex().flex_col().gap_2().children(editing).child(view_card).child(state_card).child(measure_card).child(force_card),
            )
            .child(div().flex_1().min_w_0().flex().flex_col().gap_2().child(programs_card).child(textures_card))
    } else {
        div()
            .flex()
            .flex_col()
            .gap_2()
            .children(editing)
            .child(view_card)
            .child(force_card)
            .child(state_card)
            .child(programs_card)
            .child(textures_card)
            .child(measure_card)
    };

    crate::panels::frame("experiments", "Experiments", ORANGE, content)
}
