//! Assertions for a test run (06-BUILD-PLAN.md, M8: "CI assertions and baselines").
//!
//! One command, `assert`, that checks the running page against what it should be and says
//! PASS or FAIL for each thing asked: the canvas against a baseline picture, a pixel
//! against a colour, the console against "no errors", and a frame's draws, triangles and
//! GPU time against budgets. From a shell it exits 2 when anything fails, so a CI script is
//!
//!   scanline launch http://localhost:5173 --headless --paused --deterministic
//!   scanline step 120
//!   scanline assert --baseline tests/baselines/title.png --no_errors --max_draws 200
//!   scanline stop
//!
//! and the first run, with --update, saves the baseline.

use std::sync::Arc;

use anyhow::{Context, Result, bail};
use scanline_image::Image;
use serde_json::{Value, json};

use crate::commands::{console, grab, pixels, stats};
use crate::session::Session;
use crate::{Host, result};

struct Check {
    name: String,
    passed: bool,
    said: String,
    data: Value,
}

pub async fn assert(host: &Arc<Host>, session: &Arc<Session>, params: &Value) -> Result<Value> {
    let mut checks: Vec<Check> = Vec::new();
    let mut images = Vec::new();

    // ---- The canvas against a picture kept from a run that was right ----

    if let Some(given) = params["baseline"].as_str() {
        let path = crate::tiers::file(host, given, "The baseline")?;

        if path.extension().and_then(|extension| extension.to_str()) != Some("png") {
            bail!("baseline is the path of a PNG file, such as tests/baselines/title.png, not \"{given}\".");
        }

        let now = grab(session, &json!({ "context": params["context"], "region": params["region"] })).await?.image;

        if params["update"] == true {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).with_context(|| format!("creating {}", parent.display()))?;
            }

            std::fs::write(&path, now.to_png()?).with_context(|| format!("writing {}", path.display()))?;

            checks.push(Check {
                name: "baseline".into(),
                passed: true,
                said: format!("saved the canvas ({}×{}) as the baseline {}", now.width, now.height, path.display()),
                data: json!({ "saved": path }),
            });
        } else {
            let tolerance = params["tolerance"].as_u64().unwrap_or(0).min(255) as u8;
            let allowed = params["max_changed"].as_u64().unwrap_or(0);

            let check = match std::fs::read(&path) {
                Err(_) => Check {
                    name: "baseline".into(),
                    passed: false,
                    said: format!(
                        "there is no baseline at {}. Run once with update: true (--update) when the picture is right, and keep the file with the tests",
                        path.display()
                    ),
                    data: json!({ "missing": path }),
                },
                Ok(bytes) => {
                    let kept = Image::from_png(&bytes).with_context(|| format!("reading {}", path.display()))?;

                    if kept.width != now.width || kept.height != now.height {
                        Check {
                            name: "baseline".into(),
                            passed: false,
                            said: format!("the canvas is {}×{} and the baseline {} is {}×{}", now.width, now.height, path.display(), kept.width, kept.height),
                            data: json!({ "size": [now.width, now.height], "baseline_size": [kept.width, kept.height] }),
                        }
                    } else {
                        let difference = kept.difference(&now, tolerance)?;
                        let passed = difference.changed <= allowed;
                        let mut said = format!(
                            "{} of {} pixels differ from {} by more than {tolerance} in a channel (allowed: {allowed}; the largest difference is {})",
                            difference.changed,
                            difference.pixels,
                            path.display(),
                            difference.max
                        );
                        let mut data = json!({ "changed": difference.changed, "pixels": difference.pixels, "max": difference.max, "allowed": allowed, "tolerance": tolerance });

                        if !passed {
                            // What it is now, and where it differs, for whoever reads the failure.
                            let dir = session.dir.join("images");

                            std::fs::create_dir_all(&dir).ok();

                            let stem = path.file_stem().and_then(|stem| stem.to_str()).unwrap_or("baseline");
                            let (actual, heat) = (dir.join(format!("{stem}-actual.png")), dir.join(format!("{stem}-difference.png")));

                            std::fs::write(&actual, now.to_png()?).with_context(|| format!("writing {}", actual.display()))?;
                            std::fs::write(&heat, difference.heat.to_png()?).with_context(|| format!("writing {}", heat.display()))?;

                            if let Some((x, y, w, h)) = difference.bounds {
                                said.push_str(&format!(", within x {x} y {y} {w}×{h}"));
                                data["bounds"] = json!({ "x": x, "y": y, "w": w, "h": h });
                            }

                            said.push_str(&format!(". The canvas now: {}. Where it differs: {}", actual.display(), heat.display()));
                            data["actual"] = json!(actual);
                            data["difference"] = json!(heat);
                            images
                                .push(json!({ "view": heat, "original": heat, "width": now.width, "height": now.height, "scale": 1.0, "space": "canvas_px" }));
                        }

                        Check { name: "baseline".into(), passed, said, data }
                    }
                }
            };

            checks.push(check);
        }
    }

    // ---- One pixel against a colour ----

    if params["pixel"].is_object() {
        let wanted = &params["pixel"];
        let (Some(x), Some(y), Some(rgba)) = (wanted["x"].as_i64(), wanted["y"].as_i64(), wanted["rgba"].as_array()) else {
            bail!("pixel is {{\"x\": 100, \"y\": 50, \"rgba\": [255, 0, 0, 255]}}, with an optional tolerance. rgba may leave alpha out.");
        };
        let tolerance = wanted["tolerance"].as_i64().unwrap_or(0);
        let read = pixels(session, &json!({ "x": x, "y": y, "context": params["context"] })).await?;
        let found: Vec<i64> = read["data"]["rgba8"].as_array().into_iter().flatten().filter_map(Value::as_i64).collect();
        let passed = !found.is_empty() && rgba.iter().zip(&found).all(|(want, have)| (want.as_i64().unwrap_or(-999) - have).abs() <= tolerance);

        checks.push(Check {
            name: "pixel".into(),
            passed,
            said: format!(
                "the pixel at ({x}, {y}) is ({}) and should be ({}){}",
                found.iter().map(i64::to_string).collect::<Vec<_>>().join(", "),
                rgba.iter().map(Value::to_string).collect::<Vec<_>>().join(", "),
                if tolerance > 0 { format!(", give or take {tolerance}") } else { String::new() }
            ),
            data: json!({ "x": x, "y": y, "found": found, "wanted": rgba }),
        });
    }

    // ---- Nothing in the console that is an error ----

    if params["no_errors"] == true {
        let logged = console(session, &json!({ "level": "error", "limit": 5 })).await?;
        let total = logged["data"]["total"].as_u64().unwrap_or(0);
        let first = logged["data"]["lines"][0]["text"].as_str().unwrap_or("");

        checks.push(Check {
            name: "no_errors".into(),
            passed: total == 0,
            said: if total == 0 {
                "the page has logged no errors".to_string()
            } else {
                format!(
                    "the page has logged {total} error{}; the first: «{}». console(level: \"error\") lists them",
                    if total == 1 { "" } else { "s" },
                    crate::commands::page_text(first, 200)
                )
            },
            data: json!({ "errors": total }),
        });
    }

    // ---- A frame's cost against budgets ----

    let budgets = [
        ("max_draws", "draws", "draws a frame"),
        ("max_triangles", "triangles", "triangles a frame"),
        ("max_calls", "calls", "API calls a frame"),
        ("max_gpu_ms", "gpu", "ms of GPU time a frame (mean)"),
        ("max_cpu_ms", "cpu", "ms of CPU time in frame callbacks (mean)"),
    ];

    if budgets.iter().any(|(key, _, _)| params[*key].is_number()) {
        let figures = stats(session, &json!({ "context": params["context"], "window_frames": params["window_frames"] })).await?;
        let data = &figures["data"];

        if data["frames"].as_u64().unwrap_or(0) == 0 {
            bail!("No frames have run yet, so there is nothing to hold to a budget. Step or resume first.");
        }

        for (key, which, words) in budgets {
            let Some(most) = params[key].as_f64() else { continue };

            // The worst frame for counts; the mean for times, which jitter.
            let found = match which {
                "gpu" => data["gpu"]["ms"]["mean"].as_f64(),
                "cpu" => data["cpuMs"]["mean"].as_f64(),
                counter => data["counters"][counter]["max"].as_f64(),
            };

            checks.push(match found {
                Some(found) => Check {
                    name: key.to_string(),
                    passed: found <= most,
                    said: format!(
                        "{} {words}, and the budget is {most}",
                        if which == "gpu" || which == "cpu" { format!("{found:.3}") } else { format!("{found:.0}") }
                    ),
                    data: json!({ "found": found, "budget": most }),
                },
                None => Check {
                    name: key.to_string(),
                    passed: false,
                    said: format!("{words} could not be measured here, so the budget of {most} cannot be held (GPU time needs the browser's timer queries)"),
                    data: json!({ "found": null, "budget": most }),
                },
            });
        }
    }

    if checks.is_empty() {
        bail!(
            "assert needs something to check: baseline (a PNG to compare the canvas with; update: true saves it), pixel ({{x, y, rgba}}), no_errors: true, or a budget: max_draws, max_triangles, max_calls, max_gpu_ms, max_cpu_ms."
        );
    }

    let failed = checks.iter().filter(|check| !check.passed).count();
    let mut lines = vec![if failed == 0 {
        format!("PASS: {} check{} held.", checks.len(), if checks.len() == 1 { "" } else { "s" })
    } else {
        format!("FAIL: {failed} of {} check{} did not hold.", checks.len(), if checks.len() == 1 { "" } else { "s" })
    }];

    for check in &checks {
        lines.push(format!("  {} {}: {}.", if check.passed { "pass" } else { "FAIL" }, check.name, check.said));
    }

    let mut value = result(
        lines.join("\n"),
        json!({
            "passed": failed == 0,
            // What a shell reads: `scanline assert` exits 2 when this is false.
            "met": failed == 0,
            "checks": checks.iter().map(|check| json!({ "name": check.name, "passed": check.passed, "detail": check.data })).collect::<Vec<_>>(),
        }),
    );

    value["images"] = json!(images);

    Ok(value)
}
