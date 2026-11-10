//! The command line: the same commands as the MCP tools, with the same arguments.
//!
//!   scanline launch http://localhost:5173 --paused
//!   scanline step 30 --screenshot 512
//!   scanline pixels 640 600
//!   scanline run_until --until '{"expr": "game.level === 2"}'
//!
//! Text out by default, `--json` for the whole result. Nothing binary goes to standard
//! output: images are written to files and their paths printed.

use std::process::ExitCode;

use anyhow::{Result, anyhow, bail};
use scanline_core::TOOLS;
use serde_json::{Value, json};

use crate::control::Link;

/// The arguments a command takes by position, in order.
fn positional(command: &str) -> &'static [&'static str] {
    match command {
        "launch" | "navigate" => &["url"],
        "step" => &["frames"],
        "pixels" => &["x", "y", "w", "h"],
        "eval" => &["expression"],
        "help" => &["topic"],
        _ => &[],
    }
}

pub fn usage() -> String {
    let mut lines = vec![
        format!("scanline {}: a browser for debugging WebGL and WebGPU rendering.", env!("CARGO_PKG_VERSION")),
        String::new(),
        "Usage: scanline <command> [arguments] [--name value …] [--json]".into(),
        String::new(),
        "Commands".into(),
    ];

    for tool in TOOLS {
        let first = tool.description.split(". ").next().unwrap_or(tool.description).trim_end_matches('.');
        let places = positional(tool.name).iter().map(|name| format!(" <{name}>")).collect::<String>();

        lines.push(format!("  {:<24} {first}.", format!("{}{places}", tool.name)));
    }

    lines.extend([
        String::new(),
        "  serve                    Run the host in this terminal (it is started for you otherwise).".into(),
        "  stop                     Stop the host and close its browsers.".into(),
        "  mcp                      Serve these commands to an agent over MCP on stdio.".into(),
        String::new(),
        "Arguments".into(),
        "  --name value             Any argument of the command. Values are read as JSON where they parse".into(),
        "                           (numbers, true, {\"expr\": \"…\"}), otherwise as text.".into(),
        "  --session ses_1          Which session. May be left out when one is open.".into(),
        "  --paused                 launch: hold the first frame (start: \"paused\").".into(),
        "  --screenshot [edge]      step, run_until: return a screenshot, optionally with its longest edge.".into(),
        "  --hold KeyA,Space        step: keys held from now on. --hold '' releases everything.".into(),
        "  --region x,y,w,h         screenshot: part of the canvas.".into(),
        "  --out file.png           Copy the returned image to this path.".into(),
        "  --json                   Print the whole result as JSON.".into(),
        String::new(),
        "Exit status: 0 done, 1 error, 2 ran but found nothing (a wait that timed out, a run_until not met).".into(),
        String::new(),
        "`scanline help` explains the workflow; `scanline help input` and `scanline help limits` the rest.".into(),
        format!("Files are kept in {} (set SCANLINE_HOME to move them).", scanline_core::default_home().display()),
    ]);

    lines.join("\n")
}

/// A value from the command line: JSON where it parses as JSON, text otherwise.
fn value(text: &str) -> Value {
    serde_json::from_str(text).unwrap_or_else(|_| Value::String(text.to_string()))
}

struct Parsed {
    command: String,
    params: Value,
    json: bool,
    out: Option<String>,
}

fn parse(args: Vec<String>) -> Result<Parsed> {
    let command = args[0].replace('-', "_");

    if !TOOLS.iter().any(|tool| tool.name == command) {
        bail!("Unknown command \"{}\".\n\n{}", args[0], usage());
    }

    let places = positional(&command);
    let mut params = json!({});
    let mut json_out = false;
    let mut out = None;
    let mut placed = 0;
    let mut i = 1;

    while i < args.len() {
        let arg = &args[i];

        i += 1;

        let Some(name) = arg.strip_prefix("--") else {
            let Some(place) = places.get(placed) else {
                bail!(
                    "{command} takes {} positional argument{}; \"{arg}\" is one too many. Use --name value for the rest.",
                    places.len(),
                    if places.len() == 1 { "" } else { "s" }
                );
            };

            // An expression or a URL is text even when it happens to parse as JSON.
            params[*place] = if matches!(*place, "url" | "expression" | "topic") { Value::String(arg.clone()) } else { value(arg) };
            placed += 1;

            continue;
        };

        let name = name.replace('-', "_");

        // The next argument is this one's value unless it is another option.
        let take = |i: &mut usize| -> Option<String> {
            let next = args.get(*i).filter(|next| !next.starts_with("--"))?.clone();

            *i += 1;

            Some(next)
        };

        match name.as_str() {
            "json" => json_out = true,
            "out" => out = Some(take(&mut i).ok_or_else(|| anyhow!("--out needs a file path."))?),
            "paused" => params["start"] = json!("paused"),
            "screenshot" => {
                params["observe"]["screenshot"] = match take(&mut i) {
                    Some(edge) => json!({ "max_edge": value(&edge) }),
                    None => json!(true),
                };
            }
            "stats" if command != "stats" => params["observe"]["stats"] = json!(true),
            "hold" => {
                let keys: Vec<String> = take(&mut i).unwrap_or_default().split(',').map(str::trim).filter(|key| !key.is_empty()).map(str::to_string).collect();

                params["hold"] = json!({ "keys_down": keys });
            }
            "region" => {
                let text = take(&mut i).ok_or_else(|| anyhow!("--region needs x,y,w,h."))?;
                let parts: Vec<f64> = text.split(',').filter_map(|part| part.trim().parse().ok()).collect();

                if parts.len() != 4 {
                    bail!("--region needs four numbers: x,y,w,h. Got \"{text}\".");
                }

                params["region"] = json!({ "x": parts[0], "y": parts[1], "w": parts[2], "h": parts[3] });
            }
            _ => {
                params[name.as_str()] = match take(&mut i) {
                    Some(text) => value(&text),
                    None => json!(true),
                };
            }
        }
    }

    Ok(Parsed { command, params, json: json_out, out })
}

pub async fn run(args: Vec<String>) -> Result<ExitCode> {
    let parsed = parse(args)?;

    // Help needs no host and no browser.
    let result = if parsed.command == "help" {
        json!({ "summary": scanline_core::help(parsed.params["topic"].as_str()), "data": {}, "images": [] })
    } else {
        Link::connect().await?.call(&parsed.command, parsed.params).await?
    };

    if let Some(out) = &parsed.out {
        let view = result["images"][0]["view"].as_str().ok_or_else(|| anyhow!("--out was given, but this command returned no image."))?;

        std::fs::copy(view, out).map_err(|error| anyhow!("Could not copy the image to {out}: {error}"))?;
    }

    if parsed.json {
        println!("{}", serde_json::to_string_pretty(&result)?);
    } else {
        println!("{}", result["summary"].as_str().unwrap_or(""));

        for image in result["images"].as_array().into_iter().flatten() {
            println!("image: {}", image["view"].as_str().unwrap_or(""));
        }
    }

    let nothing = result["data"]["still_waiting"] == true || result["data"]["met"] == false;

    Ok(if nothing { ExitCode::from(2) } else { ExitCode::SUCCESS })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params(line: &str) -> Value {
        parse(line.split(' ').map(str::to_string).collect()).unwrap().params
    }

    #[test]
    fn positionals_and_options_become_arguments() {
        assert_eq!(params("launch http://localhost:5173 --paused --headless"), json!({ "url": "http://localhost:5173", "start": "paused", "headless": true }));
        assert_eq!(params("step 30 --screenshot 512"), json!({ "frames": 30, "observe": { "screenshot": { "max_edge": 512 } } }));
        assert_eq!(
            params("step --hold ArrowRight,Space --screenshot"),
            json!({ "hold": { "keys_down": ["ArrowRight", "Space"] }, "observe": { "screenshot": true } })
        );
        assert_eq!(params("pixels 640 600 --session ses_2"), json!({ "x": 640, "y": 600, "session": "ses_2" }));
        assert_eq!(params("screenshot --region 10,20,30,40 --zoom 8"), json!({ "region": { "x": 10.0, "y": 20.0, "w": 30.0, "h": 40.0 }, "zoom": 8 }));
        assert_eq!(params("resume --time-scale 0.25"), json!({ "time_scale": 0.25 }));
    }

    #[test]
    fn json_values_pass_through_and_text_stays_text() {
        let parsed = parse(vec!["run_until".into(), "--until".into(), r#"{"expr": "game.level === 2"}"#.into(), "--timeout-s".into(), "10".into()]).unwrap();

        assert_eq!(parsed.params, json!({ "until": { "expr": "game.level === 2" }, "timeout_s": 10 }));

        // An expression that is also valid JSON is still an expression.
        let parsed = parse(vec!["eval".into(), "42".into()]).unwrap();

        assert_eq!(parsed.params, json!({ "expression": "42" }));
    }

    #[test]
    fn mistakes_are_explained() {
        let error = parse(vec!["frobnicate".into()]).err().unwrap().to_string();

        assert!(error.starts_with("Unknown command \"frobnicate\"."));
        assert!(error.contains("launch <url>"));

        let error = parse(vec!["pause".into(), "now".into()]).err().unwrap().to_string();

        assert!(error.contains("takes 0 positional arguments"), "{error}");
    }
}
