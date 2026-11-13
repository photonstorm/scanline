//! The panels beside the game, and the rail that picks between them.

pub mod agent;
pub mod captures;
pub mod console;
pub mod experiments;
pub mod game;
pub mod live;
pub mod resources;

use gpui::{AnyElement, Context, IntoElement, Window, div, prelude::*, px, rgb};

use crate::player::Player;
use crate::theme::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Panel {
    Live,
    Game,
    Resources,
    Captures,
    Experiments,
    Console,
    Agent,
}

impl Panel {
    const ALL: [Panel; 7] = [Panel::Live, Panel::Game, Panel::Resources, Panel::Captures, Panel::Experiments, Panel::Console, Panel::Agent];

    fn icon(self) -> &'static str {
        match self {
            Panel::Live => "live",
            Panel::Game => "sound",
            Panel::Resources => "resources",
            Panel::Captures => "capture",
            Panel::Experiments => "experiments",
            Panel::Console => "console",
            Panel::Agent => "agent",
        }
    }

    fn name(self) -> &'static str {
        match self {
            Panel::Live => "Live",
            Panel::Game => "Game",
            Panel::Resources => "Resources",
            Panel::Captures => "Captures",
            Panel::Experiments => "Experiment",
            Panel::Console => "Console",
            Panel::Agent => "Agent",
        }
    }

    fn colour(self) -> u32 {
        match self {
            Panel::Live => GREEN,
            Panel::Game => CYAN,
            Panel::Resources => AMBER,
            Panel::Captures => PURPLE,
            Panel::Experiments => ORANGE,
            Panel::Console => CYAN,
            Panel::Agent => BLUE,
        }
    }
}

/// The column of panel buttons between the game and the panel.
pub fn rail(player: &mut Player, cx: &mut Context<Player>) -> impl IntoElement {
    let current = player.panel;
    let errors = player.console.errors_unseen;
    let asked = player.status["request"].is_object();
    let changed = !player.experiments.patches.is_empty();

    div()
        .w(px(66.0))
        .flex_none()
        .flex()
        .flex_col()
        .items_center()
        .gap(px(2.0))
        .pt_2()
        .bg(rgb(SIDEBAR))
        .border_l_1()
        .border_r_1()
        .border_color(rgb(LINE))
        .children(Panel::ALL.into_iter().map(|panel| {
            let on = panel == current;
            let colour = panel.colour();
            let badge = match panel {
                Panel::Console if errors > 0 => Some(RED),
                Panel::Agent if asked => Some(AMBER),
                Panel::Experiments if changed => Some(ORANGE),
                _ => None,
            };

            div()
                .id(panel.name())
                .relative()
                .w(px(58.0))
                .pt(px(9.0))
                .pb(px(7.0))
                .flex()
                .flex_col()
                .items_center()
                .gap(px(5.0))
                .rounded(px(7.0))
                .cursor_pointer()
                .when(on, |button| button.bg(tint(colour, 0.12)))
                .hover(move |button| button.bg(tint(colour, 0.08)))
                // The panel open now: a lit bar at the rail's edge.
                .when(on, |button| {
                    button.child(div().absolute().left(px(-4.0)).top(px(10.0)).bottom(px(10.0)).w(px(3.0)).rounded(px(1.5)).bg(rgb(colour)).shadow(glow(colour, 0.7)))
                })
                .child(crate::icons::icon(panel.icon(), 18.0, if on { tint(colour, 1.0) } else { tint(TEXT, 0.62) }))
                .child(div().text_size(px(9.5)).text_color(if on { tint(colour, 1.0) } else { tint(DIM, 1.0) }).child(panel.name()))
                .when_some(badge, |button, colour| {
                    button.child(div().absolute().top(px(5.0)).right(px(10.0)).size(px(7.0)).rounded_full().bg(rgb(colour)).shadow(glow(colour, 0.7)))
                })
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.show(panel);
                    cx.notify();
                }))
        }))
}

pub fn render(player: &mut Player, window: &mut Window, cx: &mut Context<Player>) -> AnyElement {
    match player.panel {
        Panel::Live => live::render(player, window, cx),
        Panel::Game => game::render(player, window, cx),
        Panel::Resources => resources::render(player, window, cx),
        Panel::Captures => captures::render(player, window, cx),
        Panel::Experiments => experiments::render(player, window, cx),
        Panel::Console => console::render(player, window, cx),
        Panel::Agent => agent::render(player, window, cx),
    }
}

/// A panel's header: its icon and title on a bar of their own, edged with a hairline.
pub fn header(name: &'static str, title: &str, colour: u32) -> gpui::Div {
    div()
        .flex()
        .flex_none()
        .items_center()
        .gap_2()
        .h(px(38.0))
        .px_3()
        .border_b_1()
        .border_color(rgb(LINE))
        .child(crate::icons::icon(name, 15.0, rgb(colour)))
        .child(div().text_sm().font_weight(gpui::FontWeight::SEMIBOLD).text_color(rgb(TEXT)).child(title.to_string()))
}

/// The icon a panel is shown with, by its frame's id.
fn icon_of(id: &str) -> &'static str {
    match id {
        id if id.starts_with("live") => "live",
        id if id.starts_with("game") => "sound",
        id if id.starts_with("resource") => "resources",
        id if id.starts_with("capture") => "capture",
        id if id.starts_with("experiment") => "experiments",
        id if id.starts_with("console") => "console",
        id if id.starts_with("agent") => "agent",
        _ => "info",
    }
}

/// A panel with tabs: its header with the tab strip at the right, then the chosen tab's
/// content, made by the caller for `player.tab(id)`.
pub fn tabbed(player: &Player, id: &'static str, title: &str, colour: u32, tabs: &[&'static str], cx: &mut Context<Player>, content: gpui::Div) -> AnyElement {
    let current = player.tab(id).min(tabs.len().saturating_sub(1));
    let strip = group().children(tabs.iter().enumerate().map(|(index, name)| {
        tab_button(gpui::SharedString::from(format!("{id}-tab-{index}")), *name, colour, index == current).on_click(cx.listener(move |this, _, _, cx| {
            this.set_tab(id, index);
            cx.notify();
        }))
    }));

    div()
        .size_full()
        .flex()
        .flex_col()
        .child(header(icon_of(id), title, colour).child(div().flex_1()).child(strip))
        .child(div().id(id).flex_1().min_h_0().flex().flex_col().gap_2().p_3().overflow_y_scroll().child(content))
        .into_any_element()
}

/// A panel's frame: its header, then its content, scrolling under it.
pub fn frame(id: &'static str, title: &str, colour: u32, content: impl IntoElement) -> AnyElement {
    div()
        .size_full()
        .flex()
        .flex_col()
        .child(header(icon_of(id), title, colour))
        .child(div().id(id).flex_1().min_h_0().flex().flex_col().gap_2().p_3().overflow_y_scroll().child(content))
        .into_any_element()
}
