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
        "resources" => &["kind"],
        "draw_list" | "pass_tree" => &["capture"],
        "draw" => &["capture", "draw"],
        "draw_diff" => &["capture", "a", "b"],
        "pixel_source" => &["capture", "x", "y"],
        "query" => &["capture", "sql"],
        "resource" => &["handle"],
        "diff" => &["a", "b"],
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
        "`scanline help` explains the workflow; `scanline help capture`, `input`, `sql` and `limits` the rest.".into(),
        "`scanline <command> --help` lists one command's arguments, with an example.".into(),
        format!("Files are kept in {} (set SCANLINE_HOME to move them).", scanline_core::default_home().display()),
    ]);

    lines.join("\n")
}

/// How the help's examples, written as calls, are typed on the command line.
const CALLS: &str = "\
On the command line a call such as draw(capture: \"cap_1\", draw: 7) is typed
  scanline draw --capture cap_1 --draw 7        every argument as --name value
  scanline draw cap_1 7                         or its leading arguments by position
`scanline <command> --help` lists one command's arguments. `scanline --help` lists the commands.
";

/// One command's arguments, from its schema.
pub fn command_usage(name: &str) -> Option<String> {
    let tool = TOOLS.iter().find(|tool| tool.name == name)?;
    let schema: Value = serde_json::from_str(tool.schema).ok()?;
    let places = positional(name);
    let required: Vec<&str> = schema["required"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
    let properties = schema["properties"].as_object().cloned().unwrap_or_default();

    let mut lines = vec![
        format!(
            "scanline {name}{}{}",
            places.iter().map(|place| if required.contains(place) { format!(" <{place}>") } else { format!(" [{place}]") }).collect::<String>(),
            if properties.keys().any(|key| !places.contains(&key.as_str())) { " [--name value …]" } else { "" }
        ),
        String::new(),
        tool.description.to_string(),
    ];

    if !properties.is_empty() {
        lines.push(String::new());
        lines.push("Arguments (each can be given as --name value)".into());

        // Positional ones first, in their order.
        let mut names: Vec<&String> = properties.keys().collect();

        names.sort_by_key(|key| places.iter().position(|place| place == key).unwrap_or(places.len()));

        for key in names {
            let property = &properties[key];
            let kind = match property["enum"].as_array() {
                Some(values) => values.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" | "),
                None => property["type"].as_str().unwrap_or("value").to_string(),
            };
            let mut notes = Vec::new();

            if let Some(place) = places.iter().position(|place| place == key) {
                notes.push(format!("position {}", place + 1));
            }

            if required.contains(&key.as_str()) {
                notes.push("required".into());
            }

            lines.push(format!(
                "  --{:<14} {kind}{}{}",
                key,
                if notes.is_empty() { String::new() } else { format!("  ({})", notes.join(", ")) },
                property["description"].as_str().map(|text| format!("\n                   {text}")).unwrap_or_default()
            ));
        }
    }

    let example = match name {
        "launch" => "scanline launch http://localhost:5173 --paused --headless",
        "step" => "scanline step 30 --screenshot 512 --session ses_1",
        "capture" => "scanline capture --session ses_1",
        "draw_list" => "scanline draw_list cap_1 --filter \"blend = 1\"",
        "draw" => "scanline draw cap_1 7",
        "draw_diff" => "scanline draw_diff cap_1 6 7",
        "pixel_source" => "scanline pixel_source cap_1 240 200",
        "query" => "scanline query cap_1 \"select draw, viewport from draws\"",
        "resources" => "scanline resources texture --sort created",
        "resource" => "scanline resource tex_3 --preview",
        "pixels" => "scanline pixels 640 600",
        "screenshot" => "scanline screenshot --region 0,0,64,64 --zoom 8",
        "run_until" => "scanline run_until --until '{\"expr\": \"game.level === 2\"}'",
        "eval" => "scanline eval \"game.score\"",
        "memory" => "scanline memory --snapshot before",
        _ => "",
    };

    if !example.is_empty() {
        lines.push(String::new());
        lines.push(format!("Example: {example}"));
    }

    lines.push("Also: --json prints the whole result; --out file.png copies the returned image.".into());

    Some(lines.join("\n"))
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
    help: bool,
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
    let mut help = false;
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
            params[*place] = if matches!(*place, "url" | "expression" | "topic" | "kind" | "handle" | "capture" | "sql")
                || (command == "diff" && matches!(*place, "a" | "b"))
            {
                Value::String(arg.clone())
            } else {
                value(arg)
            };
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
            "help" => help = true,
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

    Ok(Parsed { command, params, json: json_out, out, help })
}

pub async fn run(args: Vec<String>) -> Result<ExitCode> {
    let parsed = parse(args)?;

    // Help needs no host and no browser.
    let result = if parsed.help {
        json!({ "summary": command_usage(&parsed.command).unwrap_or_else(usage), "data": {}, "images": [] })
    } else if parsed.command == "help" {
        // A command's name is a topic too.
        let topic = parsed.params["topic"].as_str();
        let is_topic = |topic: &str| ["workflow", "input", "capture", "sql", "limits", "help"].contains(&topic);
        let text = match topic.filter(|topic| !is_topic(topic)).and_then(|topic| command_usage(&topic.replace('-', "_"))) {
            Some(usage) => usage,
            None => format!("{}\n\n{CALLS}", scanline_core::help(topic)),
        };

        json!({ "summary": text, "data": {}, "images": [] })
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
    fn every_command_explains_itself() {
        for tool in TOOLS {
            let usage = command_usage(tool.name).unwrap();

            assert!(usage.starts_with(&format!("scanline {}", tool.name)), "{usage}");
        }

        let usage = command_usage("draw").unwrap();

        assert!(usage.starts_with("scanline draw <capture> <draw>"), "{usage}");
        assert!(usage.contains("--capture") && usage.contains("position 1"), "{usage}");
        assert!(parse(vec!["launch".into(), "--help".into()]).unwrap().help);
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
