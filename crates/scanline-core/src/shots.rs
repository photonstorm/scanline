//! Pictures taken along the way: at chosen frames, or every so many, while `step`, `policy`
//! or `smoke` runs, and handed back as one labelled sheet as well as files.
//!
//! An agent that wants to see how a stretch of play went should not have to step it in
//! pieces and look at each: one call, one picture to look at, with the frame written over
//! each cell, and the full-size files on disk for the one that turns out to matter.

use std::sync::Arc;

use anyhow::{Context, Result, bail};
use scanline_image::Image;
use serde_json::{Value, json};

use crate::commands::{save, screenshot};
use crate::session::Session;

/// The most pictures one call takes: each is a readback and a file.
const MOST: usize = 64;

pub(crate) struct Shots {
    /// Every so many frames of the call.
    every: Option<u64>,
    /// After this many frames of the call have run (0 is before the first), in order.
    at: Vec<u64>,
    /// What screenshot is asked for each: source, context, region, max_edge.
    asked: Value,
    /// The longer edge of a picture on the sheet.
    cell: u32,
    /// Whether to make the sheet, or leave the pictures to the caller (smoke makes one of them all).
    sheet: bool,
    pub taken: Vec<Value>,
    /// Pictures that could not be taken, and why.
    missed: Vec<String>,
}

impl Shots {
    /// What `shots` asks for, if it asks for anything: {every: 60}, {at: [0, 30, 90]}, or both.
    pub fn parse(wanted: &Value, frames: u64) -> Result<Option<Shots>> {
        if wanted.is_null() || *wanted == json!(false) {
            return Ok(None);
        }

        let explain = "shots is {every: n} (a picture every n frames), {at: [0, 30, 90]} (after that many frames of this call; 0 is before the first), or both. It also takes source (\"canvas\" or \"page\"), max_edge (the size of each picture on the sheet, default 256), context and region.";

        if !wanted.is_object() {
            bail!("{explain}");
        }

        let every = match &wanted["every"] {
            Value::Null => None,
            value => Some(
                value.as_u64().filter(|every| *every >= 1).ok_or_else(|| anyhow::anyhow!("shots.every is a whole number of frames, 1 or more. {explain}"))?,
            ),
        };

        let mut at: Vec<u64> = match &wanted["at"] {
            Value::Null => Vec::new(),
            Value::Array(list) => list
                .iter()
                .map(|offset| {
                    offset.as_u64().ok_or_else(|| anyhow::anyhow!("shots.at is a list of whole numbers of frames from the start of this call. {explain}"))
                })
                .collect::<Result<_>>()?,
            _ => bail!("shots.at is a list. {explain}"),
        };

        if every.is_none() && at.is_empty() {
            bail!("shots names no frames. {explain}");
        }

        if let Some(late) = at.iter().find(|offset| **offset > frames) {
            bail!(
                "A picture is asked for after {late} frames, but this call runs only {frames}. Offsets count from 0 (before the first frame) to {frames} (after the last)."
            );
        }

        at.sort_unstable();
        at.dedup();

        let source = wanted["source"].as_str().unwrap_or("canvas");

        if source != "canvas" && source != "page" {
            bail!(
                "shots.source is \"canvas\" (the canvas as the GPU drew it, the default) or \"page\" (the page as composited, with what is drawn outside the canvas), not \"{source}\"."
            );
        }

        let shots = Shots {
            every,
            at,
            asked: json!({ "source": source, "context": wanted["context"], "region": wanted["region"], "max_edge": 4096 }),
            cell: wanted["max_edge"].as_u64().unwrap_or(256).clamp(32, 1024) as u32,
            sheet: wanted["sheet"] != json!(false),
            taken: Vec::new(),
            missed: Vec::new(),
        };

        let count = (0..=frames).filter(|done| shots.due(*done)).count();

        if count > MOST {
            bail!(
                "That is {count} pictures in one call, and the most is {MOST}: each is read back and written to disk. Ask for fewer (a larger every), or for a recording: capture(when: {{frames: n}}, flight_frames: n) keeps every frame."
            );
        }

        Ok(Some(shots))
    }

    /// Whether a picture is wanted once `done` frames of the call have run.
    pub fn due(&self, done: u64) -> bool {
        self.at.binary_search(&done).is_ok() || self.every.is_some_and(|every| done > 0 && done.is_multiple_of(every))
    }

    /// The next count of frames, after `done` and no more than `frames`, at which one is wanted.
    pub fn next(&self, done: u64, frames: u64) -> Option<u64> {
        let listed = self.at.iter().copied().find(|offset| *offset > done);
        let regular = self.every.map(|every| (done / every + 1) * every);

        [listed, regular].into_iter().flatten().min().filter(|next| *next <= frames)
    }

    /// Takes a picture of the page as it stands, paused, at `frame`.
    pub async fn take(&mut self, session: &Arc<Session>, frame: &Value) -> Result<()> {
        let taken = match screenshot(session, &self.asked).await {
            Ok(taken) => taken,
            // Before a page has drawn anything there is no picture of its canvas to take:
            // that is one picture fewer, not a step that failed.
            Err(error) if error.to_string().contains("no retained image") => {
                self.missed.push(format!("none at frame {frame}: the canvas had not been drawn to yet"));

                return Ok(());
            }
            Err(error) => return Err(error),
        };
        let image = &taken["images"][0];

        // A picture of the page says its size; one of a canvas, the region it is of.
        let size = |name: &str, short: &str| if taken["data"][name].is_null() { image["region"][short].clone() } else { taken["data"][name].clone() };

        self.taken.push(json!({ "frame": frame, "original": image["original"], "width": size("width", "w"), "height": size("height", "h") }));

        Ok(())
    }

    /// The pictures as one sheet, each under its frame number, written beside them. Adds a
    /// line saying so, the sheet as the result's image, and the files to its data.
    pub fn finish(self, session: &Session, value: &mut Value, lines: &mut Vec<String>) -> Result<()> {
        if !self.missed.is_empty() {
            lines.push(format!("No picture could be taken at one of the frames asked for ({}).", self.missed.join("; ")));
            value["data"]["shots_missed"] = json!(self.missed);
        }

        if self.taken.is_empty() {
            return Ok(());
        }

        let frames: Vec<String> = self.taken.iter().map(|shot| shot["frame"].to_string()).collect();

        value["data"]["shots"] = json!(self.taken);

        if !self.sheet {
            return Ok(());
        }

        let (sheet, columns, path) = sheet_of(session, &self.taken, self.cell)?;

        lines.push(format!(
            "{} taken along the way, at frame{} {}: one sheet, {} across in reading order, each under its frame number. The full-size files are in the result's data. Sheet: {}",
            match self.taken.len() {
                1 => "1 picture".to_string(),
                count => format!("{count} pictures"),
            },
            if frames.len() == 1 { "" } else { "s" },
            frames.join(", "),
            columns,
            path.display()
        ));

        let image = json!({ "view": path, "original": path, "width": sheet.width, "height": sheet.height, "scale": 1.0, "space": "contact_sheet", "columns": columns, "frames": self.taken.iter().map(|shot| shot["frame"].clone()).collect::<Vec<_>>() });

        value["data"]["sheet"] = json!({ "path": path, "columns": columns, "width": sheet.width, "height": sheet.height });

        match value["images"].as_array_mut() {
            Some(images) => images.push(image),
            None => value["images"] = json!([image]),
        }

        Ok(())
    }
}

/// Makes one sheet of pictures already on disk, each under "FRAME n", and writes it with the
/// session's images.
pub(crate) fn sheet_of(session: &Session, shots: &[Value], cell: u32) -> Result<(Image, u32, std::path::PathBuf)> {
    let mut pictures = Vec::new();

    for shot in shots {
        let path = shot["original"].as_str().unwrap_or("");
        let picture = Image::from_png(&std::fs::read(path).with_context(|| format!("reading {path}"))?)?;

        pictures.push((picture, format!("FRAME {}", shot["frame"])));
    }

    // Wide enough for a row of pictures at their size, and no wider than is comfortable to look at.
    let (sheet, columns) = scanline_image::contact_sheet(&pictures, cell, 1600)?;
    let path = save(session, "sheet", &sheet)?;

    Ok((sheet, columns, path))
}
