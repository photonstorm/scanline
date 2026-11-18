//! A film: a recording made by stepping, as an MP4 for sharing.
//!
//! `video` keeps the last few hundred frames of a page as it runs, at whatever pace the
//! machine managed, with no sound. A film is the other way about: nothing is filmed but the
//! frames the page is stepped through, each one is, and each lasts exactly a sixtieth of a
//! second in the file however long it took to draw. Between frames the page's sound is let
//! play for exactly that long and recorded with them (probe/src/film.ts, audio.ts). The
//! result is H.264 with AAC in an MP4, which is what sites that take video want.
//!
//!   film(action: "start")   then step, policy or replay_run, then film(action: "stop")
//!   film(frames: 600)       the next 600 frames
//!   film(run: "run_3")      a kept run, played again from the page's load and filmed
//!
//! The encoding is the browser's (WebCodecs); the file is written here (mp4.rs).

use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, bail};
use base64::Engine;
use serde_json::{Value, json};

use crate::commands::{SHORT, choose_context, primary, step};
use crate::mp4;
use crate::session::Session;
use crate::{Host, result};

/// The sampling rates AAC names by number, in order.
const RATES: [u32; 13] = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

pub async fn film(host: &Arc<Host>, session: &Arc<Session>, params: &Value) -> Result<Value> {
    match params["action"].as_str() {
        Some("start") => start(session, params).await,
        Some("stop") => stop(host, session, params).await,
        Some(other) => bail!("film takes action: \"start\" or \"stop\", not \"{other}\"; or frames: n, or run: \"run_N\", to film in one call."),
        None if params["run"].is_string() => {
            let run = params["run"].as_str().unwrap_or("").to_string();
            let mut asked = json!({ "run": run, "film": wanted(params) });

            for name in ["to_frame", "until_mark"] {
                if !params[name].is_null() {
                    asked[name] = params[name].clone();
                }
            }

            if let Some(from) = params["from_frame"].as_u64() {
                asked["film"]["from_frame"] = json!(from);
            }

            let replayed = crate::runs::replay_run(host, session, &asked).await;

            finish(host, session, params, replayed).await
        }
        None if params["frames"].is_number() => {
            let frames = params["frames"]
                .as_u64()
                .filter(|frames| (1..=36_000).contains(frames))
                .ok_or_else(|| anyhow!("frames is how many frames to film, from 1 to 36000 (ten minutes)."))?;

            start(session, params).await?;

            let stepped =
                step(session, &json!({ "frames": frames, "fast": true, "hold": params["hold"], "events": params["events"], "observe": { "state": false } }))
                    .await;

            finish(host, session, params, stepped).await
        }
        None => bail!(
            "film needs one of: action: \"start\" (then step, policy or replay_run, then action: \"stop\"); frames: n, to film the next n frames; or run: \"run_N\", to play a kept run again and film it."
        ),
    }
}

/// What a film is asked to be: the arguments film.start takes.
fn wanted(params: &Value) -> Value {
    let mut out = json!({});

    for name in ["context", "width", "height", "max_edge", "bitrate", "sound", "source"] {
        if !params[name].is_null() {
            out[name] = params[name].clone();
        }
    }

    out
}

/// Ends a film that was made in one call, whatever the play it was of came to.
async fn finish(host: &Arc<Host>, session: &Arc<Session>, params: &Value, played: Result<Value>) -> Result<Value> {
    if session.state.lock().unwrap().film.is_none() {
        // The play failed before the film began: there is nothing to end.
        return played;
    }

    let mut made = stop(host, session, params).await?;

    match played {
        Ok(played) => {
            // What the play said (a replay's fingerprints, say) is worth keeping under the film's.
            let said = played["summary"].as_str().unwrap_or("").lines().take(3).collect::<Vec<_>>().join("\n");

            if !said.is_empty() && params["run"].is_string() {
                made["summary"] = json!(format!("{}\n{said}", made["summary"].as_str().unwrap_or("")));
            }

            made["data"]["played"] = played["data"].clone();

            Ok(made)
        }
        Err(error) => {
            made["summary"] = json!(format!("{}\nThe play it was of stopped early: {error:#}", made["summary"].as_str().unwrap_or("")));

            Ok(made)
        }
    }
}

/// Begins a film of the page's canvas. Every frame stepped from now is in it.
pub(crate) async fn start(session: &Arc<Session>, params: &Value) -> Result<Value> {
    if session.state.lock().unwrap().film.is_some() {
        bail!("A film is already being made. film(action: \"stop\") ends it and writes the file.");
    }

    for name in ["width", "height", "max_edge"] {
        if let Some(value) = params[name].as_f64() {
            if !(16.0..=4096.0).contains(&value) {
                bail!("{name} is a size in pixels from 16 to 4096; {value} is outside that.");
            }
        }
    }

    if let Some(bitrate) = params["bitrate"].as_f64() {
        if !(200_000.0..=100_000_000.0).contains(&bitrate) {
            bail!("bitrate is in bits a second, from 200000 to 100000000; {bitrate} is outside that.");
        }
    }

    let of_page = match params["source"].as_str() {
        None | Some("canvas") => false,
        Some("page") => true,
        Some(other) => bail!(
            "source is \"canvas\" (the canvas as the GPU drew it, the default) or \"page\" (the page as composited, with what it draws outside its canvas), not \"{other}\"."
        ),
    };

    // A film is of stepped frames: the page is held, and moves only when it is stepped.
    session.probe_all("pause", json!({}), SHORT).await;

    let mut asked = wanted(params);
    let (instance, what) = if of_page {
        // The page's size is whatever a picture of it is.
        let first = page_picture(session, true).await?;
        let picture = scanline_image::Image::from_png(&base64::engine::general_purpose::STANDARD.decode(&first).context("reading a picture of the page")?)?;

        asked["page"] = json!({ "width": picture.width, "height": picture.height });

        (session.top()?, "the page as composited".to_string())
    } else {
        let context = choose_context(session, params).await?;

        asked["context"] = json!(context.local);

        (context.instance.clone(), context.handle.clone())
    };

    let began = session.probe(&instance, "film.start", asked, Duration::from_secs(20)).await?;

    session.state.lock().unwrap().film = Some((Instant::now(), instance, of_page));

    Ok(result(
        format!(
            "Filming {what} at {}×{}{}, 60 frames a second, H.264 at {:.1} Mbit/s, {}. Every frame the page is stepped through from now is in the film, each a sixtieth of a second of it: step(frames: n, fast: true), policy, replay_run. film(action: \"stop\") ends it and writes the MP4.",
            began["width"],
            began["height"],
            if began["scaled"] == true {
                format!(" ({} is {}×{})", if of_page { "the page" } else { "the canvas" }, began["canvas"]["width"], began["canvas"]["height"])
            } else {
                String::new()
            },
            began["bitrate"].as_f64().unwrap_or(0.0) / 1e6,
            if began["sound"] == true { "with the page's sound" } else { "silent" },
        ),
        json!({ "filming": true, "source": if of_page { "page" } else { "canvas" }, "width": began["width"], "height": began["height"], "fps": 60, "bitrate": began["bitrate"], "sound": began["sound"] }),
    ))
}

/// A picture of the page as composited, as the browser encodes it (base64). The one the
/// film's size is read from is lossless; the one taken after every frame is a JPEG of high
/// quality, which the browser makes and sends in a fifth of the time and which the video
/// encoder would not have kept more of.
async fn page_picture(session: &Arc<Session>, lossless: bool) -> Result<String> {
    let format =
        if lossless { json!({ "format": "png", "optimizeForSpeed": true }) } else { json!({ "format": "jpeg", "quality": 95, "optimizeForSpeed": true }) };
    let shot = session.page_command("Page.captureScreenshot", format).await?;

    shot["data"].as_str().map(str::to_string).ok_or_else(|| anyhow!("The browser gave no picture of the page."))
}

/// After a frame has been stepped: where the film is of the page, its picture is taken and
/// handed to the film. Called by everything that steps (step, policy), one frame at a time.
pub(crate) async fn after_frame(session: &Arc<Session>) -> Result<()> {
    let filming = session.state.lock().unwrap().film.as_ref().filter(|film| film.2).map(|film| film.1.clone());

    if let Some(instance) = filming {
        let picture = page_picture(session, false).await?;

        session.probe(&instance, "film.picture", json!({ "data": picture, "type": "image/jpeg" }), Duration::from_secs(30)).await?;
    }

    Ok(())
}

/// Whether a film of the page is being made: stepping then goes a frame at a time.
pub(crate) fn of_page(session: &Session) -> bool {
    session.state.lock().unwrap().film.as_ref().is_some_and(|film| film.2)
}

/// One track of a film, read out of the page a few megabytes at a time.
async fn read(session: &Arc<Session>, instance: &crate::session::Instance, track: &str) -> Result<Vec<mp4::Sample>> {
    let mut samples = Vec::new();
    let mut from = 0u64;

    loop {
        let part = session.probe(instance, "film.read", json!({ "track": track, "from": from }), Duration::from_secs(60)).await?;
        let bytes = base64::engine::general_purpose::STANDARD.decode(part["data"].as_str().unwrap_or("")).context("reading the film out of the page")?;
        let mut at = 0usize;

        for packet in part["packets"].as_array().into_iter().flatten() {
            let size = packet[0].as_u64().unwrap_or(0) as usize;

            if at + size > bytes.len() {
                bail!("The film came out of the page damaged: a packet runs past the end of what was sent.");
            }

            samples.push(mp4::Sample { data: bytes[at..at + size].to_vec(), key: packet[1] == 1 });
            at += size;
        }

        match part["next"].as_u64() {
            Some(next) => from = next,
            None => break,
        }
    }

    Ok(samples)
}

/// Ends the film and writes it as an MP4.
pub(crate) async fn stop(host: &Arc<Host>, session: &Arc<Session>, params: &Value) -> Result<Value> {
    if session.state.lock().unwrap().film.is_none() {
        bail!("No film is being made. film(action: \"start\") begins one; film(frames: n) films the next n frames in one call.");
    }

    // Where it goes (decided before the film is ended, so that a path that will not do loses nothing): where asked (a file the tiers allow), or with the session's own files.
    let path = match params["path"].as_str() {
        Some(given) => {
            let path = crate::tiers::file(host, given, "The film")?;

            if path.extension().and_then(|extension| extension.to_str()) != Some("mp4") {
                bail!("path is where to write the film, and must end in .mp4; \"{given}\" does not.");
            }

            path
        }
        None => {
            let dir = session.dir.join("films");
            let number = std::fs::read_dir(&dir).map(|entries| entries.count()).unwrap_or(0) + 1;

            dir.join(format!("film-{number:03}.mp4"))
        }
    };

    let Some((started, instance, _)) = session.state.lock().unwrap().film.take() else {
        bail!("No film is being made.");
    };

    let _busy = session.begin("film", "Finishing the encoding");
    let made = session.probe(&instance, "film.stop", json!({}), Duration::from_secs(120)).await?;
    let frames = made["frames"].as_u64().unwrap_or(0);

    if frames == 0 {
        let _ = session.probe(&instance, "film.forget", json!({}), SHORT).await;

        bail!(
            "The film has no frames: none were stepped while it was being made{}. Start it, then step(frames: n, fast: true), then stop it; or film(frames: n) in one call.",
            made["error"].as_str().map(|error| format!(" ({error})")).unwrap_or_default()
        );
    }

    session.stage("Reading the film out of the page");

    let decode = |text: &Value| text.as_str().and_then(|text| base64::engine::general_purpose::STANDARD.decode(text).ok()).unwrap_or_default();
    let video = mp4::Video {
        width: made["width"].as_u64().unwrap_or(0) as u32,
        height: made["height"].as_u64().unwrap_or(0) as u32,
        fps: made["fps"].as_u64().unwrap_or(60) as u32,
        avcc: decode(&made["video"]["description"]),
        samples: read(session, &instance, "video").await?,
    };

    let mut notes: Vec<String> = made["notes"].as_array().into_iter().flatten().filter_map(|note| note.as_str().map(str::to_string)).collect();

    if let Some(error) = made["error"].as_str() {
        notes.push(format!("{error}. The film holds the frames before that."));
    }

    // An encoder gives back a frame for each it is given; fewer means it failed part-way.
    if (video.samples.len() as u64) < frames {
        notes.push(format!("Only {} of the {frames} frames stepped were encoded.", video.samples.len()));
    }

    let audio = if made["audio"].is_object() {
        let rate = made["audio"]["rate"].as_u64().unwrap_or(48000) as u32;
        let mut config = decode(&made["audio"]["description"]);

        // AAC-LC at this rate, in two channels, where the encoder did not say.
        if config.is_empty() {
            let index = RATES.iter().position(|known| *known == rate).unwrap_or(3) as u8;

            config = vec![(2 << 3) | (index >> 1), ((index & 1) << 7) | (2 << 3)];
        }

        // What the decoder must drop at the start: the encoder's priming, which it reports
        // as a first packet that begins before zero, and otherwise the 2112 sample frames an
        // AAC encoder is defined to add (one packet of delay and the filter's reach).
        let first = made["audio"]["first"].as_f64().unwrap_or(0.0);
        let skip = if first < 0.0 { (-first * rate as f64 / 1e6).round() as u32 } else { 2112 };

        Some(mp4::Audio {
            rate,
            channels: 2,
            config,
            packet: 1024,
            skip,
            length: made["audio"]["samples"].as_u64().unwrap_or(0),
            bitrate: 192_000,
            samples: read(session, &instance, "audio").await?,
        })
    } else {
        None
    };

    let _ = session.probe(&instance, "film.forget", json!({}), SHORT).await;

    session.stage("Writing the file");

    let file = mp4::write(&video, audio.as_ref())?;

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).with_context(|| format!("creating {}", parent.display()))?;
    }

    std::fs::write(&path, &file).with_context(|| format!("writing {}", path.display()))?;

    let seconds = video.samples.len() as f64 / video.fps.max(1) as f64;
    let megabytes = file.len() as f64 / 1_048_576.0;
    let took = started.elapsed().as_secs_f64();
    let at = primary(&session.probe_all("status", json!({}), SHORT).await).ok().and_then(|status| status["frame"].as_u64());

    let mut lines = vec![format!(
        "The film is {}: {} frames at {} a second ({seconds:.1} s), {}×{} H.264 {}, {megabytes:.1} MB. Every frame stepped is in it, each lasting exactly 1/{} s; it took {took:.0} s to make.",
        path.display(),
        video.samples.len(),
        video.fps,
        video.width,
        video.height,
        match &audio {
            Some(audio) => format!("with AAC sound ({} kHz stereo)", audio.rate as f64 / 1000.0),
            None if params["sound"] == false => "with no sound (none was asked for)".to_string(),
            None => "with no sound (the page played none through Web Audio while it was filmed)".to_string(),
        },
        video.fps,
    )];

    lines.extend(notes.iter().map(|note| format!("Note: {note}")));
    lines.push(match at {
        Some(frame) => format!("The page is paused at frame {frame}."),
        None => "The page is paused.".to_string(),
    });

    Ok(result(
        lines.join("\n"),
        json!({
            "film": path,
            "frames": video.samples.len(),
            "fps": video.fps,
            "seconds": seconds,
            "width": video.width,
            "height": video.height,
            "bytes": file.len(),
            "video": { "codec": made["video"]["codec"], "bytes": made["video"]["bytes"] },
            "audio": audio.as_ref().map(|audio| json!({ "codec": "mp4a.40.2", "rate": audio.rate, "channels": 2, "samples": audio.length, "packets": audio.samples.len(), "skip": audio.skip, "first_packet_us": made["audio"]["first"] })),
            "notes": notes,
            "took_s": took,
        }),
    ))
}
