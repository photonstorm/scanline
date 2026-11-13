//! Notes (docs/GAME.md, section 6): the person freezes the game, marks the picture and writes a
//! line, and the agent receives it with everything that goes with that frame.
//!
//! The marks arrive as shapes in canvas pixels (pen strokes, arrows, boxes, ellipses, and
//! numbered text pins) and the host draws them onto the frame itself, so the marked picture is
//! exactly the frame plus the marks. A note is kept in `<home>/notes/note_N/`: note.json, the
//! picture with and without the marks, and the handles of its capture and its take.
//!
//! The text and the marks' words are the person's. The note is an event the agent can wait for.

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result, anyhow, bail};
use scanline_image::Image;
use serde_json::{Value, json};

use crate::commands::{SHORT, grab, page_text};
use crate::session::Session;
use crate::{Host, result};

/// The five colours a mark can be drawn in.
const COLOURS: &[(&str, [u8; 3])] = &[("red", [239, 68, 68]), ("yellow", [250, 204, 21]), ("green", [74, 222, 128]), ("cyan", [34, 211, 238]), ("white", [255, 255, 255])];

const MARKS: usize = 200;

fn dir(host: &Host) -> PathBuf {
    host.store.root().join("notes")
}

fn colour_of(mark: &Value) -> [u8; 3] {
    let name = mark["colour"].as_str().unwrap_or("red");

    COLOURS.iter().find(|(known, _)| *known == name).map_or(COLOURS[0].1, |(_, rgb)| *rgb)
}

/// A filled disc: what a stroke is drawn with.
fn dot(image: &mut Image, cx: f64, cy: f64, radius: f64, rgb: [u8; 3]) {
    let (width, height) = (image.width as i64, image.height as i64);
    let reach = radius.ceil() as i64;

    for y in (cy as i64 - reach)..=(cy as i64 + reach) {
        for x in (cx as i64 - reach)..=(cx as i64 + reach) {
            if x < 0 || y < 0 || x >= width || y >= height {
                continue;
            }

            let (dx, dy) = (x as f64 + 0.5 - cx, y as f64 + 0.5 - cy);

            if dx * dx + dy * dy <= radius * radius {
                let at = ((y * width + x) * 4) as usize;

                image.data[at..at + 4].copy_from_slice(&[rgb[0], rgb[1], rgb[2], 255]);
            }
        }
    }
}

fn line(image: &mut Image, (ax, ay): (f64, f64), (bx, by): (f64, f64), radius: f64, rgb: [u8; 3]) {
    let length = ((bx - ax).powi(2) + (by - ay).powi(2)).sqrt();
    let steps = (length / (radius * 0.5).max(0.5)).ceil().max(1.0) as usize;

    for step in 0..=steps {
        let t = step as f64 / steps as f64;

        dot(image, ax + (bx - ax) * t, ay + (by - ay) * t, radius, rgb);
    }
}

fn point(value: &Value) -> Option<(f64, f64)> {
    Some((value[0].as_f64()?, value[1].as_f64()?))
}

/// Draws the marks onto the frame. Returns the text pins, numbered as they are drawn.
pub(crate) fn draw(image: &mut Image, marks: &[Value]) -> Vec<(usize, (f64, f64), String)> {
    let radius = (image.width.max(image.height) as f64 / 400.0).clamp(1.5, 6.0);
    let mut pins = Vec::new();

    for mark in marks.iter().take(MARKS) {
        let rgb = colour_of(mark);
        let (x, y, w, h) = (mark["x"].as_f64().unwrap_or(0.0), mark["y"].as_f64().unwrap_or(0.0), mark["w"].as_f64().unwrap_or(0.0), mark["h"].as_f64().unwrap_or(0.0));

        match mark["tool"].as_str().unwrap_or("") {
            "pen" => {
                let points: Vec<(f64, f64)> = mark["points"].as_array().into_iter().flatten().take(4000).filter_map(point).collect();

                for pair in points.windows(2) {
                    line(image, pair[0], pair[1], radius, rgb);
                }

                if let [only] = points.as_slice() {
                    dot(image, only.0, only.1, radius, rgb);
                }
            }
            "arrow" => {
                let (Some(from), Some(to)) = (point(&mark["from"]), point(&mark["to"])) else { continue };
                let angle = (to.1 - from.1).atan2(to.0 - from.0);
                let head = (radius * 6.0).max(10.0);

                line(image, from, to, radius, rgb);

                for side in [-0.5f64, 0.5] {
                    let back = angle + std::f64::consts::PI + side;

                    line(image, to, (to.0 + head * back.cos(), to.1 + head * back.sin()), radius, rgb);
                }
            }
            "rect" => {
                for (a, b) in [((x, y), (x + w, y)), ((x + w, y), (x + w, y + h)), ((x + w, y + h), (x, y + h)), ((x, y + h), (x, y))] {
                    line(image, a, b, radius, rgb);
                }
            }
            "ellipse" => {
                let (cx, cy, rx, ry) = (x + w / 2.0, y + h / 2.0, w.abs() / 2.0, h.abs() / 2.0);
                let steps = ((rx + ry) * 2.0).clamp(24.0, 720.0) as usize;
                let at = |step: usize| {
                    let angle = step as f64 / steps as f64 * std::f64::consts::TAU;

                    (cx + rx * angle.cos(), cy + ry * angle.sin())
                };

                for step in 0..steps {
                    line(image, at(step), at(step + 1), radius, rgb);
                }
            }
            "text" => {
                // A pin: a ring with a dot, numbered in the note's words.
                let number = pins.len() + 1;
                let ring = radius * 4.0;
                let steps = 48;

                for step in 0..steps {
                    let (a, b) = (step as f64 / steps as f64 * std::f64::consts::TAU, (step + 1) as f64 / steps as f64 * std::f64::consts::TAU);

                    line(image, (x + ring * a.cos(), y + ring * a.sin()), (x + ring * b.cos(), y + ring * b.sin()), radius * 0.6, rgb);
                }

                dot(image, x, y, radius * 1.2, rgb);
                pins.push((number, (x, y), mark["text"].as_str().unwrap_or("").chars().take(200).collect()));
            }
            _ => {}
        }
    }

    pins
}

fn mark_words(mark: &Value) -> String {
    let at = |value: &Value| point(value).map(|(x, y)| format!("{x:.0},{y:.0}")).unwrap_or_default();
    let colour = mark["colour"].as_str().unwrap_or("red");
    let (x, y, w, h) = (mark["x"].as_f64().unwrap_or(0.0), mark["y"].as_f64().unwrap_or(0.0), mark["w"].as_f64().unwrap_or(0.0), mark["h"].as_f64().unwrap_or(0.0));

    match mark["tool"].as_str().unwrap_or("") {
        "pen" => {
            let points: Vec<(f64, f64)> = mark["points"].as_array().into_iter().flatten().filter_map(point).collect();
            let (left, right) = points.iter().fold((f64::MAX, f64::MIN), |(lo, hi), p| (lo.min(p.0), hi.max(p.0)));
            let (top, bottom) = points.iter().fold((f64::MAX, f64::MIN), |(lo, hi), p| (lo.min(p.1), hi.max(p.1)));

            if points.is_empty() { String::new() } else { format!("a {colour} stroke over x {left:.0}–{right:.0}, y {top:.0}–{bottom:.0}") }
        }
        "arrow" => format!("a {colour} arrow from {} pointing at {}", at(&mark["from"]), at(&mark["to"])),
        "rect" => format!("a {colour} box from {x:.0},{y:.0}, {w:.0}×{h:.0}"),
        "ellipse" => format!("a {colour} ring round {:.0},{:.0}, {w:.0}×{h:.0}", x + w / 2.0, y + h / 2.0),
        _ => String::new(),
    }
}

fn next_id(host: &Host) -> String {
    let highest = std::fs::read_dir(dir(host))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| entry.file_name().to_str()?.strip_prefix("note_")?.parse::<u32>().ok())
        .max()
        .unwrap_or(0);

    format!("note_{}", highest + 1)
}

fn load(host: &Host, id: &str) -> Result<Value> {
    let valid = id.strip_prefix("note_").is_some_and(|number| !number.is_empty() && number.bytes().all(|byte| byte.is_ascii_digit()));
    let path = dir(host).join(id).join("note.json");

    if !valid || !path.exists() {
        bail!("There is no note \"{}\". notes() lists them.", page_text(id, 40));
    }

    serde_json::from_slice(&std::fs::read(&path)?).context("reading the note")
}

/// What the agent reads of a note.
fn describe(note: &Value) -> (String, Vec<Value>) {
    let id = note["note"].as_str().unwrap_or("?");
    let mut lines = vec![format!(
        "{id}, from the person at frame {} of «{}»: «{}»",
        note["frame"],
        page_text(note["url"].as_str().unwrap_or(""), 80),
        page_text(note["text"].as_str().unwrap_or(""), 600)
    )];

    let marks: Vec<String> = note["marks"].as_array().into_iter().flatten().map(mark_words).filter(|words| !words.is_empty()).collect();

    if !marks.is_empty() {
        lines.push(format!("Marked on the picture (canvas pixels): {}.", marks.join("; ")));
    }

    for pin in note["pins"].as_array().into_iter().flatten() {
        lines.push(format!("Pin {} at {:.0},{:.0}: «{}»", pin["number"], pin["x"].as_f64().unwrap_or(0.0), pin["y"].as_f64().unwrap_or(0.0), page_text(pin["text"].as_str().unwrap_or(""), 200)));
    }

    if let Some(capture) = note["capture"].as_str() {
        lines.push(match note["captured_frame"].as_u64() {
            Some(frame) if Some(frame) != note["frame"].as_u64() => {
                format!("Capture: {capture}, of frame {frame}, the one drawn next (a capture records a frame as it is drawn). draw_list, pixel_source and the rest work on it.")
            }
            _ => format!("Capture of that frame: {capture} (draw_list, pixel_source and the rest work on it)."),
        });
    }

    if let Some(take) = note["take"].as_str() {
        lines.push(format!("Take to reach it again: take(action: \"play\", name: \"{take}\") plays the input from the page's load to this frame."));
    }

    for watch in note["watches"]["watches"].as_array().into_iter().flatten() {
        lines.push(format!("Watch: {}", crate::watch::watch_line(watch)));
    }

    if note["audio"].is_object() {
        let contexts = note["audio"]["contexts"].as_array().cloned().unwrap_or_default();
        let playing = note["audio"]["playing"].as_array().map_or(0, Vec::len);
        let levels: Vec<String> = contexts
            .iter()
            .map(|context| format!("{} {} at {}", context["id"].as_str().unwrap_or("?"), context["state"].as_str().unwrap_or("?"), crate::audio::decibels(&context["level"]["peak"])))
            .collect();

        lines.push(format!("Audio then: {playing} source{} playing; {}. audio(view: \"playing\") reads it now.", if playing == 1 { "" } else { "s" }, levels.join(", ")));
    }

    let images = [("marked", "the frame with the person's marks"), ("original", "the frame as it was")]
        .iter()
        .filter_map(|(key, what)| note["pictures"][key].as_str().map(|path| json!({ "view": path, "original": path, "label": what })))
        .collect();

    (lines.join("\n"), images)
}

/// Takes a note: freezes the frame, draws the marks, and keeps it with what goes with it.
async fn make(host: &Arc<Host>, session: &Arc<Session>, params: &Value) -> Result<Value> {
    let text: String = params["text"].as_str().unwrap_or("").chars().take(2000).collect();
    let marks: Vec<Value> = params["marks"].as_array().cloned().unwrap_or_default().into_iter().take(MARKS).collect();

    if text.trim().is_empty() && marks.is_empty() {
        bail!("A note needs text or marks: what the person sees, and where.");
    }

    session.probe_all("pause", json!({}), SHORT).await;

    let id = next_id(host);
    let folder = dir(host).join(&id);

    std::fs::create_dir_all(&folder).with_context(|| format!("creating {}", folder.display()))?;

    let shot = grab(session, &json!({})).await?;
    let original = shot.image.opaque();
    let mut marked = original.clone();
    let pins = draw(&mut marked, &marks);
    let original_path = folder.join("original.png");
    let marked_path = folder.join("marked.png");

    std::fs::write(&original_path, original.to_png()?).context("writing the picture")?;
    std::fs::write(&marked_path, marked.to_png()?).context("writing the marked picture")?;

    let top = session.top()?;
    let frame = session.probe(&top, "status", json!({}), SHORT).await?["frame"].clone();

    // What goes with it: each is kept when it can be had, and the note is sent either way.
    let watches = session.probe(&top, "watch.list", json!({ "history": 120 }), SHORT).await.ok().filter(|list| list["watches"].as_array().is_some_and(|all| !all.is_empty())).unwrap_or(Value::Null);
    let audio = session.probe(&top, "audio.state", json!({ "view": "playing" }), SHORT).await.ok().filter(|state| state["contexts"].as_array().is_some_and(|all| !all.is_empty())).unwrap_or(Value::Null);
    let take = match crate::runs::collect(session).await {
        Ok(run) => crate::takes::keep(host, &id, run).ok(),
        Err(_) => None,
    };
    let capture = if params["capture"] == false {
        None
    } else {
        crate::capture::capture(host, session, &json!({ "quick": true })).await.ok().filter(|taken| taken["data"]["capture"].is_string())
    };
    let captured_frame = capture.as_ref().map(|taken| taken["data"]["frame"].clone()).unwrap_or(Value::Null);
    let capture = capture.and_then(|taken| taken["data"]["capture"].as_str().map(str::to_string));
    let request = session.state.lock().unwrap().request.as_ref().map(|request| request.id.clone());
    let made = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |since| since.as_secs());

    let note = json!({
        "note": id,
        "text": text,
        "url": session.url(),
        "session": session.id,
        "frame": frame,
        "made": made,
        "marks": marks,
        "pins": pins.iter().map(|(number, (x, y), words)| json!({ "number": number, "x": x, "y": y, "text": words })).collect::<Vec<_>>(),
        "pictures": { "marked": marked_path, "original": original_path, "width": marked.width, "height": marked.height },
        "capture": capture,
        "captured_frame": captured_frame,
        "take": take,
        "watches": watches,
        "audio": audio,
        "request": request,
    });

    std::fs::write(folder.join("note.json"), serde_json::to_vec_pretty(&note)?).context("writing the note")?;

    // The agent hears of it as an event, with the handles it needs.
    session.queue("note", json!({ "note": id, "text": text, "frame": frame, "capture": capture, "take": take, "request": request }));

    let (summary, images) = describe(&note);

    Ok(json!({ "summary": format!("Sent to the agent.\n{summary}"), "data": note, "images": images }))
}

/// `note`: one note to read (`id`), or a new one from `text` and `marks`.
pub async fn note(host: &Arc<Host>, session: Option<&Arc<Session>>, params: &Value) -> Result<Value> {
    if let Some(id) = params["id"].as_str() {
        let note = load(host, id)?;
        let (summary, images) = describe(&note);

        return Ok(json!({ "summary": summary, "data": note, "images": images }));
    }

    let session = session.ok_or_else(|| anyhow!("A new note needs a session with a page to freeze. note(id: \"note_1\") reads one."))?;

    make(host, session, params).await
}

pub fn notes(host: &Arc<Host>) -> Result<Value> {
    let mut all: Vec<Value> = std::fs::read_dir(dir(host))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| load(host, entry.file_name().to_str()?).ok())
        .collect();

    all.sort_by_key(|note| std::cmp::Reverse(note["made"].as_u64().unwrap_or(0)));

    if all.is_empty() {
        return Ok(result("No notes. The person makes one with Note in the Scanline app (⇧⌘N); wait(kinds: [\"note\"]) waits for one.", json!({ "notes": [] })));
    }

    let mut lines = vec![format!("{} note{}, newest first:", all.len(), if all.len() == 1 { "" } else { "s" })];

    lines.extend(all.iter().map(|note| {
        format!(
            "  {}  frame {}  «{}»{}",
            note["note"].as_str().unwrap_or("?"),
            note["frame"],
            page_text(note["text"].as_str().unwrap_or(""), 100),
            note["capture"].as_str().map(|capture| format!("  {capture}")).unwrap_or_default()
        )
    }));
    lines.push("note(id) has one in full, with its pictures.".into());

    let rows: Vec<Value> = all.iter().map(|note| json!({ "note": note["note"], "frame": note["frame"], "text": note["text"], "capture": note["capture"], "take": note["take"], "made": note["made"], "url": note["url"] })).collect();

    Ok(result(lines.join("\n"), json!({ "notes": rows })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marks_are_drawn_where_they_say() {
        let mut image = Image::new(100, 100, vec![0; 100 * 100 * 4]).unwrap();
        let pins = draw(
            &mut image,
            &[
                json!({ "tool": "rect", "x": 10, "y": 10, "w": 30, "h": 20, "colour": "green" }),
                json!({ "tool": "arrow", "from": [90, 90], "to": [60, 60] }),
                json!({ "tool": "text", "x": 80, "y": 20, "text": "this flickers" }),
            ],
        );

        assert_eq!(image.pixel(10, 20), [74, 222, 128, 255], "the box's left edge");
        assert_eq!(image.pixel(25, 20), [0, 0, 0, 0], "inside the box is untouched");
        assert_eq!(image.pixel(75, 75), [239, 68, 68, 255], "the arrow's shaft, red by default");
        assert_eq!(pins, vec![(1, (80.0, 20.0), "this flickers".to_string())]);
    }

    #[test]
    fn marks_read_as_words() {
        assert_eq!(mark_words(&json!({ "tool": "arrow", "from": [90, 90], "to": [60, 61], "colour": "cyan" })), "a cyan arrow from 90,90 pointing at 60,61");
        assert_eq!(mark_words(&json!({ "tool": "ellipse", "x": 10, "y": 10, "w": 20, "h": 10 })), "a red ring round 20,15, 20×10");
    }
}
