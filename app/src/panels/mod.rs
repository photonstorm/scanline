//! The panels beside the game, and the rail that picks between them.

pub mod agent;
pub mod captures;
pub mod console;
pub mod live;
pub mod resources;

use gpui::{AnyElement, Context, IntoElement, Window, div, prelude::*, px, rgb};

use crate::player::Player;
use crate::theme::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Panel {
    Live,
    Resources,
    Captures,
    Console,
    Agent,
}

impl Panel {
    const ALL: [Panel; 5] = [Panel::Live, Panel::Resources, Panel::Captures, Panel::Console, Panel::Agent];

    fn glyph(self) -> &'static str {
        match self {
            Panel::Live => "∿",
            Panel::Resources => "▦",
            Panel::Captures => "◉",
            Panel::Console => "≡",
            Panel::Agent => "✦",
        }
    }

    fn name(self) -> &'static str {
        match self {
            Panel::Live => "Live",
            Panel::Resources => "Resources",
            Panel::Captures => "Captures",
            Panel::Console => "Console",
            Panel::Agent => "Agent",
        }
    }

    fn colour(self) -> u32 {
        match self {
            Panel::Live => GREEN,
            Panel::Resources => AMBER,
            Panel::Captures => PURPLE,
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

    div()
        .w(px(62.0))
        .flex_none()
        .flex()
        .flex_col()
        .items_center()
        .gap_1()
        .pt_2()
        .bg(rgb(SIDEBAR))
        .border_l_1()
        .border_r_1()
        .border_color(tint(FAINT, 0.6))
        .children(Panel::ALL.into_iter().map(|panel| {
            let on = panel == current;
            let colour = panel.colour();
            let badge = match panel {
                Panel::Console if errors > 0 => Some(RED),
                Panel::Agent if asked => Some(AMBER),
                _ => None,
            };

            div()
                .id(panel.name())
                .relative()
                .w(px(54.0))
                .py_1p5()
                .flex()
                .flex_col()
                .items_center()
                .rounded_md()
                .cursor_pointer()
                .when(on, |button| button.bg(tint(colour, 0.16)).border_1().border_color(tint(colour, 0.45)))
                .hover(move |button| button.bg(tint(colour, 0.1)))
                .child(div().text_lg().text_color(if on { tint(colour, 1.0) } else { tint(DIM, 1.0) }).child(panel.glyph()))
                .child(div().text_size(px(9.0)).text_color(if on { tint(colour, 1.0) } else { tint(DIM, 1.0) }).child(panel.name()))
                .when_some(badge, |button, colour| {
                    button.child(div().absolute().top(px(4.0)).right(px(6.0)).size(px(7.0)).rounded_full().bg(rgb(colour)).shadow(glow(colour, 0.7)))
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
        Panel::Resources => resources::render(player, window, cx),
        Panel::Captures => captures::render(player, window, cx),
        Panel::Console => console::render(player, window, cx),
        Panel::Agent => agent::render(player, window, cx),
    }
}

/// A panel's frame: its title, then its content, scrolling.
pub fn frame(id: &'static str, title: &str, colour: u32, content: impl IntoElement) -> AnyElement {
    div()
        .id(id)
        .size_full()
        .flex()
        .flex_col()
        .gap_2()
        .p_3()
        .overflow_y_scroll()
        .child(div().text_xl().font_weight(gpui::FontWeight::LIGHT).text_color(tint(colour, 1.0)).child(title.to_string()))
        .child(content)
        .into_any_element()
}
