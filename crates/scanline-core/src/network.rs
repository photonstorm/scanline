//! Recorded network, for runs that replay exactly (02-ARCHITECTURE.md, section 6).
//!
//! A deterministic session fixes the clock and the random numbers. What a page fetches
//! while it runs is the other thing that differs between two runs: the bytes may change,
//! and the frame they arrive on always does. So in a deterministic session every response
//! is kept as it passes, with the frame it was handed to the page on, and a replay answers
//! the page's requests from what was kept, on the same frames.
//!
//! To make "the frame it arrived on" mean one thing in both, a response is always handed
//! over between two frames, with the page held: while recording the page is paused for a
//! moment as each response goes in, and while replaying the response waits for the frame
//! the replay loop has reached.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};

use crate::commands::SHORT;
use crate::session::Session;

/// A response is not kept if its body is larger than this (as base64 text).
const LIMIT: usize = 24 * 1024 * 1024;

pub(crate) const OFF: u8 = 0;
pub(crate) const RECORDING: u8 = 1;
pub(crate) const REPLAYING: u8 = 2;

async fn intercept(session: &Session, stage: &str) {
    let page = Some(session.page.as_str());
    let _ = session.client.send("Fetch.disable", json!({}), page).await;
    let _ = session.client.send("Fetch.enable", json!({ "patterns": [{ "urlPattern": "*", "requestStage": stage }] }), page).await;
}

/// Starts keeping every response the page is given. For a deterministic session.
pub(crate) async fn record(session: &Session) {
    {
        let mut state = session.state.lock().unwrap();

        state.net_mode = RECORDING;
        state.net_log.clear();
        state.net_pending.clear();
    }

    intercept(session, "Response").await;
}

/// A new page load: what was kept belongs to the last one.
pub(crate) fn reset(session: &Session) {
    let mut state = session.state.lock().unwrap();

    if state.net_mode == RECORDING {
        state.net_log.clear();
    }

    // Until the new document's probe says hello there is no page to hold: the old one is
    // on its way out and would not answer.
    state.net_loading = true;
}

/// Whether a page load is under way and its probe is not there yet.
fn loading(session: &Session) -> bool {
    session.state.lock().unwrap().net_loading
}

/// Answers the page's requests from a run's kept responses from now on.
pub(crate) async fn replay(session: &Session, entries: Vec<Value>) {
    {
        let mut state = session.state.lock().unwrap();

        state.net_mode = REPLAYING;
        state.net_served = vec![false; entries.len()];
        state.net_log = entries;
        state.net_pending.clear();
        state.net_missed = 0;
        state.net_unasked = 0;
    }

    intercept(session, "Request").await;
}

/// Ends a replay: how many kept responses were used, and how many requests had none.
/// The session goes back to recording, if it is one that records.
pub(crate) async fn finish(session: &Session, recording: bool) -> (usize, usize, u64) {
    let (used, total, missed) = {
        let mut state = session.state.lock().unwrap();
        let used = state.net_served.iter().filter(|served| **served).count().saturating_sub(state.net_unasked as usize);
        let out = (used, state.net_log.len(), state.net_missed);

        state.net_mode = if recording { RECORDING } else { OFF };
        state.net_pending.clear();

        out
    };

    if recording {
        intercept(session, "Response").await;
    } else {
        let _ = session.client.send("Fetch.disable", json!({}), Some(session.page.as_str())).await;
    }

    (used, total, missed)
}

/// The next frame, after this one, on which a kept response is due.
pub(crate) fn next_frame(session: &Session, after: u64) -> Option<u64> {
    let state = session.state.lock().unwrap();

    if state.net_mode != REPLAYING {
        return None;
    }

    state
        .net_log
        .iter()
        .zip(&state.net_served)
        .filter(|(_, served)| !**served)
        .filter_map(|(entry, _)| entry["frame"].as_u64())
        .chain(state.net_pending.iter().filter_map(|(_, index)| state.net_log[*index]["frame"].as_u64()))
        .filter(|frame| *frame > after)
        .min()
}

/// Lets the page's event loop turn, so that what it does with a response is done before
/// the next frame. The probe's frame gate does not hold a message channel.
async fn settle(session: &Session) {
    let turn = "new Promise((done) => { const channel = new MessageChannel(); channel.port1.onmessage = () => done(1); channel.port2.postMessage(0); })";

    for _ in 0..3 {
        let _ = session
            .client
            .send_with_timeout("Runtime.evaluate", json!({ "expression": turn, "awaitPromise": true }), Some(session.page.as_str()), Duration::from_secs(2))
            .await;
    }

    tokio::time::sleep(Duration::from_millis(8)).await;
}

/// Hands something to the page between two frames, and says which frame had just ended.
/// A running page is paused for it and set going again.
async fn between_frames(session: &Arc<Session>, method: &str, params: Value) -> u64 {
    let _one_at_a_time = session.net_gate.lock().await;

    hand_over(session, method, params).await
}

/// The same, for a caller that already has the gate.
async fn hand_over(session: &Arc<Session>, method: &str, params: Value) -> u64 {
    let send = || session.client.send_with_timeout(method, params.clone(), Some(session.page.as_str()), Duration::from_secs(10));

    // Before the page's probe is there (the document itself, and what it loads first)
    // there are no frames to speak of.
    if loading(session) {
        let _ = send().await;

        return 0;
    }

    let Ok(top) = session.top() else {
        let _ = send().await;

        return 0;
    };

    // Frames stop between two of them. A page that is running, or part-way through a
    // step, carries on from there when the hold is let go.
    let Ok(held) = session.probe(&top, "net.hold", json!({}), SHORT).await else {
        let _ = send().await;

        return 0;
    };

    let _ = send().await;

    settle(session).await;

    let _ = session.probe(&top, "net.release", json!({}), SHORT).await;

    held["frame"].as_u64().unwrap_or(0)
}

/// A request or a response the browser is holding for the host to decide on.
pub(crate) fn paused(session: &Arc<Session>, params: &Value) {
    let mode = session.state.lock().unwrap().net_mode;

    if mode == OFF {
        return;
    }

    let session = session.clone();
    let params = params.clone();

    tokio::spawn(async move {
        if mode == RECORDING {
            keep(&session, &params).await;
        } else {
            answer(&session, &params).await;
        }
    });
}

async fn keep(session: &Arc<Session>, params: &Value) {
    let id = params["requestId"].clone();
    let page = Some(session.page.as_str());
    let go_on = json!({ "requestId": id });

    // An error, or a stage with no response yet: nothing to keep.
    let Some(status) = params["responseStatusCode"].as_u64() else {
        let _ = session.client.send("Fetch.continueRequest", go_on, page).await;

        return;
    };

    // A redirect has no body of its own.
    let body = if (300..400).contains(&status) {
        None
    } else {
        session.client.send_with_timeout("Fetch.getResponseBody", json!({ "requestId": id }), page, Duration::from_secs(20)).await.ok()
    };

    let frame = between_frames(session, "Fetch.continueRequest", go_on).await;
    let size = body.as_ref().and_then(|body| body["body"].as_str()).map_or(0, str::len);
    let mut entry = json!({
        "url": params["request"]["url"],
        "method": params["request"]["method"],
        "status": status,
        "headers": params["responseHeaders"],
        "frame": frame,
    });

    match body {
        Some(body) if size <= LIMIT => {
            entry["body"] = body["body"].clone();
            entry["base64"] = body["base64Encoded"].clone();
        }
        Some(_) => entry["skipped"] = json!("too large to keep"),
        None if (300..400).contains(&status) => {}
        None => entry["skipped"] = json!("its body could not be read"),
    }

    let mut state = session.state.lock().unwrap();

    // The page may have been reloaded, or a replay begun, while this was in hand.
    if state.net_mode == RECORDING {
        state.net_log.push(entry);
    }
}

async fn answer(session: &Arc<Session>, params: &Value) {
    let id = params["requestId"].as_str().unwrap_or("").to_string();
    let page = Some(session.page.as_str());
    let (url, method) = (&params["request"]["url"], &params["request"]["method"]);

    // Matching a request and deciding when to answer it is one step: the replay loop,
    // which hands over what is due at each frame it stops on, must not come in between.
    let _one_at_a_time = session.net_gate.lock().await;

    // The first kept response for this address that has not been used.
    let found = {
        let mut state = session.state.lock().unwrap();
        let at = (0..state.net_log.len()).find(|index| {
            !state.net_served[*index]
                && state.net_log[*index]["url"] == *url
                && state.net_log[*index]["method"] == *method
                && state.net_log[*index]["skipped"].is_null()
        });

        match at {
            Some(index) => {
                state.net_served[index] = true;

                Some((index, state.net_log[index]["frame"].as_u64().unwrap_or(0)))
            }
            None => {
                state.net_missed += 1;

                None
            }
        }
    };

    let Some((index, due)) = found else {
        // Not in the recording: the network answers, and the replay says so at the end.
        let _ = session.client.send("Fetch.continueRequest", json!({ "requestId": id }), page).await;

        return;
    };

    let now = match session.top() {
        Ok(top) if !loading(session) => session.probe(&top, "status", json!({}), SHORT).await.ok().and_then(|status| status["frame"].as_u64()),
        _ => None,
    };

    match now {
        Some(frame) if due > frame => session.state.lock().unwrap().net_pending.push((id, index)),
        _ => fulfil(session, &id, index).await,
    }
}

/// Answers a held request with a kept response. The caller has the gate.
async fn fulfil(session: &Arc<Session>, id: &str, index: usize) {
    let entry = session.state.lock().unwrap().net_log.get(index).cloned().unwrap_or(Value::Null);
    let text = entry["body"].as_str().unwrap_or("");

    // The protocol takes the body as base64 whatever it was kept as.
    let body = if entry["base64"] == true {
        text.to_string()
    } else {
        use base64::Engine;

        base64::engine::general_purpose::STANDARD.encode(text)
    };

    hand_over(session, "Fetch.fulfillRequest", json!({ "requestId": id, "responseCode": entry["status"], "responseHeaders": entry["headers"], "body": body }))
        .await;
}

/// Hands over the kept responses that are due by this frame. The page is paused there.
///
/// A response due by now whose request has not reached the host yet is waited for, for a
/// moment: the page asked a frame or two ago, and the browser's word of it may still be on
/// its way. If the page never asks (it has parted from the recording) the wait runs out.
pub(crate) async fn release(session: &Arc<Session>, frame: u64) {
    let deadline = tokio::time::Instant::now() + Duration::from_millis(800);

    loop {
        let expected = {
            let _one_at_a_time = session.net_gate.lock().await;
            let due: Vec<(String, usize)> = {
                let mut state = session.state.lock().unwrap();
                let (now, later): (Vec<_>, Vec<_>) = state
                    .net_pending
                    .drain(..)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .partition(|(_, index)| state.net_log[*index]["frame"].as_u64().unwrap_or(0) <= frame);

                state.net_pending = later;
                now
            };

            for (id, index) in due {
                fulfil(session, &id, index).await;
            }

            // Kept responses that were handed over by this frame in the recording, and
            // that the page has not asked for yet. Those before the first frame belong
            // to the page's loading, which is over by the time this is called.
            let state = session.state.lock().unwrap();

            state.net_mode == REPLAYING
                && state
                    .net_log
                    .iter()
                    .zip(&state.net_served)
                    .any(|(entry, served)| !*served && entry["skipped"].is_null() && entry["frame"].as_u64().is_some_and(|due| due > 0 && due <= frame))
        };

        if !expected {
            return;
        }

        if tokio::time::Instant::now() >= deadline {
            // The page did not ask. It is not waited for again: every later frame would
            // otherwise wait as long.
            let mut state = session.state.lock().unwrap();

            for index in 0..state.net_log.len() {
                if !state.net_served[index]
                    && state.net_log[index]["skipped"].is_null()
                    && state.net_log[index]["frame"].as_u64().is_some_and(|due| due > 0 && due <= frame)
                {
                    state.net_served[index] = true;
                    state.net_unasked += 1;
                }
            }

            return;
        }

        tokio::time::sleep(Duration::from_millis(4)).await;
    }
}
