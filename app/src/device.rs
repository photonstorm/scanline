//! Sizes a game can be given in place of its view's own: windows on a desktop and phones and
//! tablets, as DevTools' device mode gives them. The page is told the size and pixel ratio
//! (the host's emulate), and what it draws is scaled to fit the game area, which keeps its size.

use serde_json::{Value, json};

pub struct Preset {
    pub name: &'static str,
    pub group: &'static str,
    /// CSS pixels, upright for a phone or tablet.
    pub width: u32,
    pub height: u32,
    /// The device's own pixel ratio. A desktop size takes 1, or 2 with Retina.
    pub dpr: f32,
    pub mobile: bool,
}

pub const PRESETS: &[Preset] = &[
    Preset { name: "720p", group: "Desktop", width: 1280, height: 720, dpr: 1.0, mobile: false },
    Preset { name: "Laptop 1366", group: "Desktop", width: 1366, height: 768, dpr: 1.0, mobile: false },
    Preset { name: "Laptop 1440", group: "Desktop", width: 1440, height: 900, dpr: 1.0, mobile: false },
    Preset { name: "1080p", group: "Desktop", width: 1920, height: 1080, dpr: 1.0, mobile: false },
    Preset { name: "1440p", group: "Desktop", width: 2560, height: 1440, dpr: 1.0, mobile: false },
    Preset { name: "4K", group: "Desktop", width: 3840, height: 2160, dpr: 1.0, mobile: false },
    Preset { name: "iPhone SE", group: "Phone", width: 375, height: 667, dpr: 2.0, mobile: true },
    Preset { name: "iPhone 15", group: "Phone", width: 393, height: 852, dpr: 3.0, mobile: true },
    Preset { name: "iPhone 15 Pro Max", group: "Phone", width: 430, height: 932, dpr: 3.0, mobile: true },
    Preset { name: "Pixel 8", group: "Phone", width: 412, height: 915, dpr: 2.625, mobile: true },
    Preset { name: "Galaxy S24", group: "Phone", width: 360, height: 780, dpr: 3.0, mobile: true },
    Preset { name: "iPad", group: "Tablet", width: 820, height: 1180, dpr: 2.0, mobile: true },
    Preset { name: "iPad Pro 13", group: "Tablet", width: 1032, height: 1376, dpr: 2.0, mobile: true },
];

/// A preset as chosen: Retina for a desktop size, turned on its side for a phone or tablet.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Size {
    pub preset: usize,
    pub retina: bool,
    pub landscape: bool,
}

impl Size {
    pub fn preset(&self) -> &'static Preset {
        &PRESETS[self.preset.min(PRESETS.len() - 1)]
    }

    /// CSS pixels, as the page is given them.
    pub fn css(&self) -> (u32, u32) {
        let preset = self.preset();

        if preset.mobile && self.landscape { (preset.height, preset.width) } else { (preset.width, preset.height) }
    }

    pub fn dpr(&self) -> f32 {
        let preset = self.preset();

        if preset.mobile { preset.dpr } else if self.retina { 2.0 } else { 1.0 }
    }

    /// What it is called in the toolbar and remembered by: "1080p @2x", "iPhone 15 landscape".
    pub fn name(&self) -> String {
        let preset = self.preset();

        match (preset.mobile, self.retina, self.landscape) {
            (false, true, _) => format!("{} @2x", preset.name),
            (true, _, true) => format!("{} landscape", preset.name),
            _ => preset.name.to_string(),
        }
    }

    pub fn from_name(name: &str) -> Option<Size> {
        let (base, retina, landscape) = match (name.strip_suffix(" @2x"), name.strip_suffix(" landscape")) {
            (Some(base), _) => (base, true, false),
            (_, Some(base)) => (base, false, true),
            _ => (name, false, false),
        };

        PRESETS.iter().position(|preset| preset.name == base).map(|preset| Size { preset, retina, landscape })
    }

    /// The host's emulate, scaled so the page fits a game area of `area` points.
    pub fn emulate(&self, area: (f32, f32)) -> Value {
        let (width, height) = self.css();
        let scale = (area.0 / width as f32).min(area.1 / height as f32).clamp(0.05, 1.0);

        json!({ "width": width, "height": height, "dpr": self.dpr(), "mobile": self.preset().mobile, "scale": (scale * 1000.0).floor() / 1000.0 })
    }

    /// What the toolbar says of it: "1920×1080 @2x · 45%".
    pub fn detail(&self, area: (f32, f32)) -> String {
        let (width, height) = self.css();
        let scale = self.emulate(area)["scale"].as_f64().unwrap_or(1.0);

        format!("{width}×{height} @{}x · {:.0}%", trim(self.dpr()), scale * 100.0)
    }
}

fn trim(value: f32) -> String {
    let text = format!("{value:.3}");

    text.trim_end_matches('0').trim_end_matches('.').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_size_is_remembered_by_its_name() {
        for size in [Size { preset: 3, retina: true, landscape: false }, Size { preset: 7, retina: false, landscape: true }, Size { preset: 0, retina: false, landscape: false }] {
            assert_eq!(Size::from_name(&size.name()), Some(size));
        }
    }

    #[test]
    fn a_large_size_is_drawn_smaller_to_fit_and_a_small_one_at_its_own_size() {
        let hd = Size { preset: 3, retina: false, landscape: false };

        assert_eq!(hd.emulate((960.0, 700.0))["scale"], json!(0.5));
        assert_eq!(Size { preset: 7, retina: false, landscape: false }.emulate((960.0, 900.0))["scale"], json!(1.0));
        assert_eq!(Size { preset: 7, retina: false, landscape: true }.css(), (852, 393));
        assert_eq!(hd.detail((960.0, 700.0)), "1920×1080 @1x · 50%");
    }
}
