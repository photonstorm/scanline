//! The look (docs/APP.md, section 6): a near-black window, cards tinted with their own
//! colour, segmented meters that glow, line graphs with a fading fill, a light display face
//! for titles and tabular figures for numbers.

use gpui::{
    BoxShadow, Div, FontWeight, Hsla, IntoElement, ParentElement, PathBuilder, Rgba, SharedString, Stateful, Styled, canvas, div, point, prelude::*, px, rgb,
};

pub const WINDOW: u32 = 0x08090c;
pub const SIDEBAR: u32 = 0x0d0f13;
pub const CARD: u32 = 0x111419;
pub const FIELD: u32 = 0x06070a;
pub const TEXT: u32 = 0xdde2e8;
pub const DIM: u32 = 0x7d8695;
pub const FAINT: u32 = 0x3a404b;

pub const GREEN: u32 = 0x4ade80;
pub const BLUE: u32 = 0x60a5fa;
pub const PURPLE: u32 = 0xc084fc;
pub const AMBER: u32 = 0xfbbf24;
pub const RED: u32 = 0xf87171;
pub const CYAN: u32 = 0x22d3ee;
pub const ORANGE: u32 = 0xfb923c;

/// Numbers in a face whose figures are all one width, so columns do not jitter.
pub const MONO: &str = "Menlo";

pub fn tint(colour: u32, alpha: f32) -> Rgba {
    let mut c = rgb(colour);

    c.a = alpha;
    c
}

pub fn glow(colour: u32, strength: f32) -> Vec<BoxShadow> {
    vec![BoxShadow { color: Hsla::from(tint(colour, strength)), offset: point(px(0.0), px(0.0)), blur_radius: px(6.0), spread_radius: px(0.0) }]
}

/// A card: a rounded panel faintly tinted and edged with its colour, with a title.
pub fn card(title: impl Into<SharedString>, colour: u32) -> Div {
    div().flex().flex_col().gap_1p5().p_3().rounded_lg().bg(rgb(CARD)).border_1().border_color(tint(colour, 0.32)).child(heading(title, colour))
}

/// A card's title: the light display face.
pub fn heading(title: impl Into<SharedString>, colour: u32) -> Div {
    div().text_color(tint(colour, 0.95)).text_base().font_weight(FontWeight::LIGHT).child(title.into())
}

/// A large figure, such as a frame rate.
pub fn figure(text: impl Into<SharedString>, colour: u32) -> Div {
    div().text_2xl().font_family(MONO).text_color(rgb(colour)).child(text.into())
}

/// A row of segments like a hardware level meter: `fraction` of them lit in `colour`.
pub fn meter(count: usize, fraction: f32, colour: u32) -> Div {
    let lit = (fraction.clamp(0.0, 1.0) * count as f32).round() as usize;

    div().flex().gap(px(2.0)).children((0..count).map(move |index| {
        let on = index < lit;
        let segment = div().flex_1().h(px(12.0)).rounded(px(2.0));

        if on { segment.bg(tint(colour, 0.95)).shadow(glow(colour, 0.55)) } else { segment.bg(tint(colour, 0.10)) }
    }))
}

/// A vertical meter, for a column of them side by side.
pub fn column_meter(count: usize, fraction: f32, colour: u32, height: f32) -> Div {
    let lit = (fraction.clamp(0.0, 1.0) * count as f32).round() as usize;
    let gap = 2.0;
    let each = ((height - gap * (count as f32 - 1.0)) / count as f32).max(1.0);

    div().flex().flex_col_reverse().gap(px(gap)).w(px(26.0)).children((0..count).map(move |index| {
        let on = index < lit;
        let segment = div().w_full().h(px(each)).rounded(px(1.5));

        if on { segment.bg(tint(colour, 0.95)).shadow(glow(colour, 0.5)) } else { segment.bg(tint(colour, 0.09)) }
    }))
}

/// A line graph of `values` against `ceiling`, with a faint grid, a fading fill and a glow.
pub fn graph(values: Vec<f32>, ceiling: f32, colour: u32, height: f32) -> impl IntoElement {
    let ceiling = ceiling.max(f32::EPSILON);

    canvas(
        move |_, _, _| (),
        move |bounds, _, window, _| {
            let (x0, y0) = (bounds.origin.x, bounds.origin.y);
            let (w, h) = (bounds.size.width, bounds.size.height);

            // The grid: quarters across, eighths along.
            for step in 1..4 {
                let y = y0 + h * (step as f32 / 4.0);

                window.paint_quad(gpui::fill(gpui::Bounds::new(point(x0, y), gpui::size(w, px(1.0))), tint(FAINT, 0.35)));
            }

            for step in 1..8 {
                let x = x0 + w * (step as f32 / 8.0);

                window.paint_quad(gpui::fill(gpui::Bounds::new(point(x, y0), gpui::size(px(1.0), h)), tint(FAINT, 0.25)));
            }

            if values.len() < 2 {
                return;
            }

            let count = values.len() as f32 - 1.0;
            let at = |index: usize, value: f32| point(x0 + w * (index as f32 / count), y0 + h * (1.0 - (value / ceiling).clamp(0.0, 1.0)));

            // The fill under the line.
            let mut area = PathBuilder::fill();

            area.move_to(point(x0, y0 + h));

            for (index, value) in values.iter().enumerate() {
                area.line_to(at(index, *value));
            }

            area.line_to(point(x0 + w, y0 + h));
            area.close();

            if let Ok(path) = area.build() {
                window.paint_path(path, tint(colour, 0.13));
            }

            // The glow, then the line over it.
            for (width, alpha) in [(5.0, 0.16), (1.6, 1.0)] {
                let mut line = PathBuilder::stroke(px(width));

                for (index, value) in values.iter().enumerate() {
                    if index == 0 { line.move_to(at(index, *value)) } else { line.line_to(at(index, *value)) }
                }

                if let Ok(path) = line.build() {
                    window.paint_path(path, tint(colour, alpha));
                }
            }
        },
    )
    .w_full()
    .h(px(height))
}

/// A button in a colour.
pub fn button(id: impl Into<SharedString>, label: impl Into<SharedString>, colour: u32) -> Stateful<Div> {
    let id: SharedString = id.into();

    div()
        .id(id)
        .px_2()
        .py(px(3.0))
        .rounded_md()
        .text_sm()
        .cursor_pointer()
        .bg(tint(colour, 0.12))
        .border_1()
        .border_color(tint(colour, 0.38))
        .text_color(tint(colour, 1.0))
        .hover(move |style| style.bg(tint(colour, 0.26)))
        .active(move |style| style.bg(tint(colour, 0.4)))
        .child(label.into())
}

/// A label on the left, a value on the right.
pub fn row(label: impl Into<SharedString>, value: impl Into<SharedString>) -> Div {
    div()
        .flex()
        .justify_between()
        .gap_3()
        .text_xs()
        .child(div().flex_none().text_color(rgb(DIM)).child(label.into()))
        .child(div().min_w_0().overflow_hidden().whitespace_nowrap().text_color(rgb(TEXT)).font_family(MONO).child(value.into()))
}

/// Small grey text.
pub fn note(text: impl Into<SharedString>) -> Div {
    div().text_xs().text_color(rgb(DIM)).child(text.into())
}

/// Bytes as a person reads them.
pub fn bytes(value: f64) -> String {
    let units = ["B", "KB", "MB", "GB"];
    let mut amount = value.max(0.0);
    let mut unit = 0;

    while amount >= 1024.0 && unit < units.len() - 1 {
        amount /= 1024.0;
        unit += 1;
    }

    if unit == 0 { format!("{amount:.0} {}", units[unit]) } else { format!("{amount:.1} {}", units[unit]) }
}
