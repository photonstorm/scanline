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
        "eval" | "watch" => &["expression"],
        "unwatch" | "watches" => &["name"],
        "watch_set" => &["name", "prop", "value"],
        "audio" => &["view"],
        "take" => &["action", "name"],
        "audio_node" => &["handle"],
        "audio_patch" => &["handle", "mode"],
        "resources" => &["kind"],
        "draw_list" | "pass_tree" | "profile" | "export" => &["capture"],
        "import" => &["path"],
        "draw" | "geometry" => &["capture", "draw"],
        "view" => &["capture", "view"],
        "draw_diff" => &["capture", "a", "b"],
        "pixel_source" | "pixel_history" => &["capture", "x", "y"],
        "query" => &["capture", "sql"],
        "resource" | "shader_analysis" | "patch_shader" | "patch_texture" => &["handle"],
        "experiment" => &["kind"],
        "page" => &["call"],
        "policy" => &["source"],
        "live_view" => &["view"],
        "request_human" => &["instruction"],
        "recording" => &["recording"],
        "video" => &["action"],
        "replay_run" => &["run"],
        "diff" | "compare" => &["a", "b"],
        "help" => &["topic"],
        _ => &[],
    }
}

/// `scanline skill`: the skills held in this binary. Listed, printed, or written out as the
/// folders an agent loads skills from.
pub fn skill(args: &[String]) -> Result<String> {
    use scanline_core::skills;

    let mut name = None;
    let mut to = None;
    let mut i = 0;

    while i < args.len() {
        match args[i].as_str() {
            "--to" => {
                i += 1;
                to = Some(args.get(i).ok_or_else(|| anyhow!("--to needs a directory: scanline skill --to ~/.claude/skills"))?.clone());
            }
            "--help" | "-h" => {
                return Ok(format!(
                    "scanline skill                    list the skills\nscanline skill <name>             print one (wrong-pixels is short for scanline-wrong-pixels)\nscanline skill --to <dir>         write every skill as <dir>/<name>/SKILL.md, for an agent that loads skills from folders\nscanline skill <name> --to <dir>  write one\n\n{}",
                    skills::list()
                ));
            }
            other if other.starts_with("--") => bail!("scanline skill does not take {other}. It takes a skill's name and --to <dir>."),
            other => name = Some(other.to_string()),
        }

        i += 1;
    }

    let chosen = match &name {
        Some(name) => vec![skills::find(name).ok_or_else(|| anyhow!("There is no skill \"{name}\".\n\n{}", skills::list()))?],
        None => skills::SKILLS.iter().collect(),
    };

    let Some(to) = to else {
        return Ok(match name {
            Some(_) => chosen[0].file.to_string(),
            None => format!("{}\n\nPrint one with `scanline skill <name>`. Write them out for an agent with `scanline skill --to <dir>`.", skills::list()),
        });
    };

    let to = std::path::PathBuf::from(to);
    let mut lines = Vec::new();

    for skill in chosen {
        let dir = to.join(skill.name);
        let file = dir.join("SKILL.md");

        std::fs::create_dir_all(&dir).map_err(|error| anyhow!("Could not create {}: {error}", dir.display()))?;
        std::fs::write(&file, skill.file).map_err(|error| anyhow!("Could not write {}: {error}", file.display()))?;
        lines.push(format!("  {}", file.display()));
    }

    Ok(format!("Wrote {} skill{} of scanline {}:\n{}", lines.len(), if lines.len() == 1 { "" } else { "s" }, env!("CARGO_PKG_VERSION"), lines.join("\n")))
}

/// `scanline browser`: which browser a launch would use, and installing the pinned one.
/// Only from a shell: a download is the person's to start, never a client's.
pub fn browser(args: &[String]) -> Result<String> {
    use scanline_browser::pinned;

    let home = scanline_core::default_home();

    match args.first().map(String::as_str) {
        None => Ok(pinned::describe(&home)),
        Some("install") => {
            let mut from = None;
            let mut dry_run = false;
            let mut i = 1;

            while i < args.len() {
                match args[i].as_str() {
                    "--dry-run" | "--dry_run" => dry_run = true,
                    "--from" => {
                        i += 1;
                        from = Some(std::path::PathBuf::from(args.get(i).ok_or_else(|| anyhow!("--from needs the path of a Chrome for Testing zip."))?));
                    }
                    other => bail!("scanline browser install does not take {other}. It takes --dry-run and --from <zip>."),
                }

                i += 1;
            }

            pinned::install(&home, from.as_deref(), dry_run)
        }
        Some("--help" | "-h") => Ok(pinned::describe(&home)),
        Some(other) => bail!("scanline browser does not take {other}. Use `scanline browser` or `scanline browser install`."),
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
        "  serve --http [port]      The same, and MCP over HTTP on 127.0.0.1, for a client that cannot spawn `scanline mcp`. Requests need the token in the file http-token.".into(),
        "  stop                     Stop the host and close its browsers.".into(),
        "  mcp [--lean]             Serve these commands to an agent over MCP on stdio: each as a tool, or (--lean) two tools that run any command and give its parameters.".into(),
        "  browser [install]        Which browser a launch would use; install the pinned Chrome for Testing (--dry-run to see first).".into(),
        "  skill [name] [--to dir]  Print a skill (the recipe for one kind of job), list them, or write them as folders for an agent.".into(),
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
        "  --ascii                  Print ASCII only (<< >> for the marks round page text, x, ->, us), for a".into(),
        "                           shell that garbles UTF-8. SCANLINE_ASCII=1 does the same for every command.".into(),
        String::new(),
        "Exit status: 0 done, 1 error, 2 ran but found nothing (a wait that timed out, a run_until not met).".into(),
        String::new(),
        "`scanline help` explains the workflow; `scanline help capture`, `analysis`, `patch`, `handoff`, `input`, `sql`, `testing` and `limits` the rest.".into(),
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
        "pixel_history" => "scanline pixel_history cap_1 240 200",
        "query" => "scanline query cap_1 \"select draw, viewport from draws\"",
        "resources" => "scanline resources texture --sort created",
        "resource" => "scanline resource tex_3 --preview",
        "pixels" => "scanline pixels 640 600",
        "screenshot" => "scanline screenshot --region 0,0,64,64 --zoom 8",
        "run_until" => "scanline run_until --until '{\"expr\": \"game.level === 2\"}'",
        "eval" => "scanline eval \"game.score\"",
        "memory" => "scanline memory --snapshot before",
        "request_human" => "scanline request_human \"Play until the water flickers, then press Debug\"",
        "wait" => "scanline wait --request req_1",
        "debug" => "scanline debug --x 412 --y 288 --note \"this corner\"",
        "recording" => "scanline recording rec_1",
        "video" => "scanline video start, then scanline video stop",
        "compare" => "scanline compare cap_2 cap_3",
        "shader_analysis" => "scanline shader_analysis prg_1",
        "lint" => "scanline lint --capture cap_1",
        "geometry" => "scanline geometry cap_1 6",
        "export" => "scanline export cap_1 --path ~/Desktop/water-flicker.scanline",
        "import" => "scanline import ~/Downloads/water-flicker.scanline",
        "trace" => "scanline trace --frames 120",
        "view" => "scanline view cap_1 overdraw",
        "profile" => "scanline profile cap_1 --by shader",
        "patch_state" => "scanline patch_state --filter '{\"program\": \"prg_1\"}' --state '{\"cull\": false}'",
        "patch_draws" => "scanline patch_draws --filter '{\"draws\": [6, 8]}'",
        "patch_uniform" => "scanline patch_uniform --target prg_1 --name tint --value '[1, 0, 0, 1]'",
        "patch_shader" => "scanline patch_shader prg_1 --edits '[{\"find\": \"64\", \"replace\": \"24\"}]'",
        "patch_texture" => "scanline patch_texture tex_3 --with checker",
        "patches" => "scanline patches --revert all",
        "experiment" => "scanline experiment scissor_1px",
        "page" => "scanline page set_control --id sun.height --value 0.3",
        "live_view" => "scanline live_view bounds",
        "policy" => "scanline policy \"s => ({keys_down: s.x < 200 ? ['ArrowRight'] : [], stop: s.x >= 200})\" --frames 300",
        "strip" => "scanline strip --open",
        "take_control" => "scanline take_control",
        "save_run" => "scanline save_run",
        "replay_run" => "scanline replay_run run_1 --to-frame 900",
        _ => "",
    };

    if !example.is_empty() {
        lines.push(String::new());

        if cfg!(windows) && windows_quoting(example) != example {
            lines.push(format!("Example: {}", windows_quoting(example)));
            lines.push(
                "(JSON is written here with single quotes inside double quotes, which cmd and every PowerShell pass on whole. Scanline reads it as JSON.)"
                    .into(),
            );
        } else {
            lines.push(format!("Example: {example}"));
        }
    }

    lines.push("Also: --json prints the whole result; --out file.png copies the returned image.".into());

    Some(lines.join("\n"))
}

/// A value from the command line: JSON where it parses as JSON, text otherwise.
///
/// An object or a list may be written with single quotes for its double ones:
/// `"{'draws': [6, 8]}"`. A Unix shell passes `'{"draws": [6, 8]}'` on whole, but cmd does
/// not treat single quotes as quotes and Windows PowerShell drops the double quotes inside
/// them; this is the one spelling every shell on every platform leaves alone.
fn value(text: &str) -> Value {
    if let Ok(parsed) = serde_json::from_str(text) {
        return parsed;
    }

    if text.starts_with(['{', '[']) && text.contains('\'') && !text.contains('"') {
        if let Ok(parsed) = serde_json::from_str(&text.replace('\'', "\"")) {
            return parsed;
        }
    }

    Value::String(text.to_string())
}

/// An example as a Windows shell needs it: each argument in single quotes that holds
/// double quotes is turned inside out, to double quotes holding single ones.
fn windows_quoting(example: &str) -> String {
    let mut out = String::new();
    let mut rest = example;

    // An argument of JSON starts after a space, with a quote and then a bracket. A single
    // quote anywhere else (inside an expression, say) is left as it is.
    while let Some(start) = [" '{", " '["].iter().filter_map(|opening| rest.find(opening)).min().map(|at| at + 1) {
        let Some(length) = rest[start + 1..].find('\'') else { break };
        let inside = &rest[start + 1..start + 1 + length];

        out.push_str(&rest[..start]);
        out.push('"');
        out.push_str(&inside.replace('"', "'"));
        out.push('"');
        rest = &rest[start + length + 2..];
    }

    out.push_str(rest);
    out
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
        // Asked for often enough to be worth an answer of its own.
        if matches!(args[0].as_str(), "calls" | "commands") {
            bail!(
                "There is no \"{}\" command. The calls of a captured frame are a table, read with query:\n  scanline query cap_1 \"select command, method, args from commands where for_draw = 7\"\n`scanline help sql` lists the tables and their columns.",
                args[0]
            );
        }

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
            params[*place] = if matches!(
                *place,
                "url" | "expression" | "topic" | "kind" | "handle" | "capture" | "sql" | "instruction" | "recording" | "run" | "view" | "path"
            ) || (matches!(command.as_str(), "diff" | "compare") && matches!(*place, "a" | "b"))
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

    // The host has a working directory of its own: a file named here is named from here.
    let named = match command.as_str() {
        "export" | "import" => Some("path"),
        "assert" => Some("baseline"),
        _ => None,
    };

    if let Some(key) = named {
        if let Some(path) = params[key].as_str().map(std::path::PathBuf::from).filter(|path| path.is_relative()) {
            params[key] = json!(std::env::current_dir().unwrap_or_default().join(path));
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
        let is_topic = |topic: &str| {
            ["workflow", "input", "capture", "analysis", "patch", "page", "handoff", "sql", "testing", "security", "limits", "skills", "help"].contains(&topic)
        };
        let text = match topic.filter(|topic| !is_topic(topic)).and_then(|topic| command_usage(&topic.replace('-', "_"))) {
            Some(usage) => usage,
            // What is in force is the running host's to say. With none running, what a host
            // started from here would have.
            None if topic == Some("security") => match Link::try_connect().await {
                Some(mut link) => link.call("help", json!({ "topic": "security" })).await?["summary"].as_str().unwrap_or("").to_string(),
                None => format!(
                    "{}\n\nNo host is running. One started from this shell would have:\n{}",
                    scanline_core::help(topic),
                    scanline_core::tiers::Tiers::from_env()?.describe()
                ),
            },
            // Something that is neither a topic nor a command: say so, and not the workflow again.
            None if topic.is_some_and(|topic| !is_topic(topic)) => bail!(
                "There is no help topic or command named \"{}\". Topics: workflow, input, capture, analysis, patch, page, handoff, sql, testing, security, limits, skills. `scanline --help` lists the commands, and `scanline <command> --help` gives one command's arguments.{}",
                topic.unwrap_or(""),
                if matches!(topic, Some("calls" | "commands")) {
                    "\nThe calls of a captured frame are a table: scanline query cap_1 \"select command, method, args from commands where for_draw = 7\"."
                } else {
                    ""
                }
            ),
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

    // Whoever reads the output may stop early (`| head`). That is not an error, and must
    // not be a panic, so nothing is printed with println!.
    let mut text = if parsed.json { serde_json::to_string_pretty(&result)? } else { result["summary"].as_str().unwrap_or("").to_string() };

    text.push('\n');

    if !parsed.json {
        for image in result["images"].as_array().into_iter().flatten() {
            text.push_str(&format!("image: {}\n", image["view"].as_str().unwrap_or("")));
        }
    }

    say_as(&text, parsed.json);

    let nothing = result["data"]["still_waiting"] == true || result["data"]["met"] == false;

    Ok(if nothing { ExitCode::from(2) } else { ExitCode::SUCCESS })
}

/// Whether what is printed keeps to ASCII: `--ascii`, or SCANLINE_ASCII in the environment.
static ASCII: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Takes `--ascii` out of the arguments, and says whether output is to keep to ASCII.
/// Some shells decode what they capture with a code page that is not UTF-8 (Windows
/// PowerShell, by default), and turn the characters Scanline writes into nonsense.
pub fn ascii_asked(args: &mut Vec<String>) {
    let flagged = args.iter().any(|arg| arg == "--ascii");
    let set = std::env::var("SCANLINE_ASCII").is_ok_and(|value| !matches!(value.to_ascii_lowercase().as_str(), "" | "0" | "off" | "false" | "no"));

    args.retain(|arg| arg != "--ascii");
    ASCII.store(flagged || set, std::sync::atomic::Ordering::Relaxed);
}

/// Text in ASCII only. The characters Scanline itself writes are spelt out (`<<` and `>>`
/// round text from the page, `x`, `->`, `us`); anything else, which can only be the
/// page's, is written as its code point. In JSON every such character is a `\u` escape,
/// which a JSON reader turns back into the character: nothing is lost there.
pub fn plain(text: &str, json: bool) -> String {
    let mut out = String::with_capacity(text.len());

    for character in text.chars() {
        if character.is_ascii() {
            out.push(character);
            continue;
        }

        if json {
            let mut units = [0u16; 2];

            for unit in character.encode_utf16(&mut units) {
                out.push_str(&format!("\\u{unit:04x}"));
            }

            continue;
        }

        match character {
            '«' => out.push_str("<<"),
            '»' => out.push_str(">>"),
            '×' => out.push('x'),
            '…' => out.push_str("..."),
            '–' | '—' | '−' => out.push('-'),
            '→' => out.push_str("->"),
            '←' => out.push_str("<-"),
            '↔' => out.push_str("<->"),
            '⇒' => out.push_str("=>"),
            '≤' => out.push_str("<="),
            '≥' => out.push_str(">="),
            'µ' | 'μ' => out.push('u'),
            '•' => out.push('*'),
            '∅' => out.push_str("NULL"),
            '’' | '‘' => out.push('\''),
            '“' | '”' => out.push('"'),
            other => out.push_str(&format!("\\u{{{:x}}}", other as u32)),
        }
    }

    out
}

/// Writes to standard output, and lets a closed pipe pass.
pub fn say(text: &str) {
    say_as(text, false);
}

/// The same, for text that is JSON where it matters how a character is spelt.
pub fn say_as(text: &str, json: bool) {
    use std::io::Write;

    let mut out = std::io::stdout().lock();

    if ASCII.load(std::sync::atomic::Ordering::Relaxed) {
        let _ = out.write_all(plain(text, json).as_bytes());
    } else {
        let _ = out.write_all(text.as_bytes());
    }

    let _ = out.flush();
}

/// Writes an error to standard error, in ASCII if that was asked for.
pub fn complain(text: &str) {
    if ASCII.load(std::sync::atomic::Ordering::Relaxed) {
        eprintln!("{}", plain(text, false));
    } else {
        eprintln!("{text}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ascii_spells_out_what_scanline_writes_and_escapes_the_rest() {
        assert_eq!(plain("tex_1 «crate» 256×256 → canvas ⇒ 35 px, 4.1 µs…", false), "tex_1 <<crate>> 256x256 -> canvas => 35 px, 4.1 us...");
        assert_eq!(plain("events 6–8, ∅, «é😀»", false), "events 6-8, NULL, <<\\u{e9}\\u{1f600}>>");

        // In JSON nothing is lost: a reader turns each escape back into its character.
        let escaped = plain("{\"text\": \"«é😀» 2×2\"}", true);

        assert!(escaped.is_ascii());
        assert_eq!(serde_json::from_str::<Value>(&escaped).unwrap()["text"], "«é😀» 2×2");
    }

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

        // Single quotes for double, which every shell on Windows passes on whole.
        let parsed = parse(vec!["patch_draws".into(), "--filter".into(), "{'draws': [6, 8]}".into(), "--note".into(), "it's fine".into()]).unwrap();

        assert_eq!(parsed.params, json!({ "filter": { "draws": [6, 8] }, "note": "it's fine" }));
        assert_eq!(
            windows_quoting(r#"scanline patch_state --filter '{"program": "prg_1"}' --state '{"cull": false}'"#),
            r#"scanline patch_state --filter "{'program': 'prg_1'}" --state "{'cull': false}""#
        );

        let policy = r#"scanline policy "s => ({keys_down: s.x < 200 ? ['ArrowRight'] : []})" --frames 300"#;

        assert_eq!(windows_quoting(policy), policy);

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
