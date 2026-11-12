//! The app's icons: Streamline Core Line – Free (CC BY 4.0; resources/icons/LICENSE.md), and a
//! chevron of Scanline's own. Each is compiled in and drawn by GPUI as a mask in the colour
//! asked for, so one white drawing serves every state.

use std::borrow::Cow;

use gpui::{AssetSource, Hsla, Radians, SharedString, Styled, Svg, Transformation, px, svg};

macro_rules! icons {
    ($($name:literal),* $(,)?) => {
        fn find(path: &str) -> Option<&'static [u8]> {
            match path {
                $(concat!("icons/", $name, ".svg") => Some(include_bytes!(concat!("../resources/icons/", $name, ".svg"))),)*
                _ => None,
            }
        }

        const ALL: &[&str] = &[$(concat!("icons/", $name, ".svg")),*];
    };
}

icons!(
    "agent", "blit", "buffer", "capture", "check", "chevron", "clear", "close", "console", "depth", "draw", "edit", "error", "experiments", "eye", "flag",
    "framebuffer", "fullscreen", "home", "info", "live", "memory", "mute", "pass", "pause", "play", "pointer", "program", "reload", "resources", "screenshot",
    "search", "send", "shader", "size", "sound", "speed", "step", "texture", "timer", "undo", "user", "video", "warning", "wide", "wireframe",
);

pub struct Assets;

impl AssetSource for Assets {
    fn load(&self, path: &str) -> gpui::Result<Option<Cow<'static, [u8]>>> {
        Ok(find(path).map(Cow::Borrowed))
    }

    fn list(&self, path: &str) -> gpui::Result<Vec<SharedString>> {
        Ok(ALL.iter().filter(|known| known.starts_with(path)).map(|known| SharedString::from(*known)).collect())
    }
}

/// An icon by name, `size` points square, in `colour`.
pub fn icon(name: &'static str, size: f32, colour: impl Into<Hsla>) -> Svg {
    svg().path(SharedString::from(format!("icons/{name}.svg"))).size(px(size)).flex_none().text_color(colour.into())
}

/// The disclosure chevron, pointing right, or down when open.
pub fn chevron(open: bool, size: f32, colour: impl Into<Hsla>) -> Svg {
    let turned = icon("chevron", size, colour);

    if open { turned.with_transformation(Transformation::rotate(Radians(std::f32::consts::FRAC_PI_2))) } else { turned }
}
