//! What the host lets a client do, decided when the host starts and never through the
//! control API: a client cannot widen its own reach.
//!
//! Four tiers. Read (looking, inventory, capture, analysis) is always on. Control (time,
//! input, hand-off) is on. Patch and evaluate (live patches, `eval`, `policy`) is on for
//! pages served from this machine and off for any other origin. Files and navigation
//! (import and export outside the artefact directory, navigation) is on, with navigation
//! kept to the origin the session was launched on.
//!
//! `SCANLINE_DENY` switches tiers off: any of `control`, `patch`, `files`.
//! `SCANLINE_ALLOW` widens the two defaults that are narrow: `remote-patch` lets the patch
//! tier work on pages from other machines, `navigate` lets a session go to another origin.
//!
//! None of this is a boundary against a client that can run commands on the machine: it
//! can start a host of its own with any settings. The tiers limit what a client that only
//! speaks the control API (an agent over MCP) can be talked into by a page.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Result, bail};
use serde_json::Value;

use crate::{Host, Session};

#[derive(Clone, Debug, PartialEq)]
pub struct Tiers {
    pub control: bool,
    pub patch: bool,
    pub files: bool,
    /// The patch tier on pages that are not served from this machine.
    pub remote_patch: bool,
    /// Navigation away from the origin a session was launched on.
    pub navigate: bool,
    /// The native-capture profile: a browser whose GPU process has no sandbox.
    pub native_capture: bool,
}

impl Default for Tiers {
    fn default() -> Self {
        Tiers { control: true, patch: true, files: true, remote_patch: false, navigate: false, native_capture: false }
    }
}

const HOW: &str = "Tiers are fixed when the host starts: stop it (scanline stop), set SCANLINE_ALLOW or SCANLINE_DENY, and start it again. Only the person running Scanline can do that";

impl Tiers {
    /// The tiers the environment asks for. A word it does not know is an error, not ignored:
    /// a misspelt denial that silently allowed everything would be the worst outcome.
    pub fn from_env() -> Result<Self> {
        Self::from_words(&std::env::var("SCANLINE_ALLOW").unwrap_or_default(), &std::env::var("SCANLINE_DENY").unwrap_or_default())
    }

    pub fn from_words(allow: &str, deny: &str) -> Result<Self> {
        let mut tiers = Tiers::default();
        let words = |list: &str| list.split([',', ' ']).map(str::trim).filter(|word| !word.is_empty()).map(str::to_lowercase).collect::<Vec<_>>();

        for word in words(allow) {
            match word.as_str() {
                "remote-patch" => tiers.remote_patch = true,
                "navigate" => tiers.navigate = true,
                "native-capture" => tiers.native_capture = true,
                other => {
                    bail!(
                        "SCANLINE_ALLOW holds \"{other}\", which is not something it can allow. It takes remote-patch, navigate and native-capture, separated by commas."
                    )
                }
            }
        }

        // Denials are read last, so that a tier named in both lists is off.
        for word in words(deny) {
            match word.as_str() {
                "control" => tiers.control = false,
                "patch" => {
                    tiers.patch = false;
                    tiers.remote_patch = false;
                }
                "files" => {
                    tiers.files = false;
                    tiers.navigate = false;
                }
                "read" => bail!(
                    "SCANLINE_DENY holds \"read\". The read tier cannot be switched off: without it Scanline does nothing. Do not start the host instead."
                ),
                other => bail!("SCANLINE_DENY holds \"{other}\", which is not a tier. It takes control, patch and files, separated by commas."),
            }
        }

        Ok(tiers)
    }

    /// The tiers in force, in words.
    pub fn describe(&self) -> String {
        let on = |on: bool| if on { "on" } else { "off" };

        [
            "  read (looking, inventory, capture, analysis): on".to_string(),
            format!("  control (time, input, hand-off, replaying a run): {}", on(self.control)),
            format!(
                "  patch and evaluate (patch_*, experiment, eval, policy): {}",
                match (self.patch, self.remote_patch) {
                    (false, _) => "off",
                    (true, false) => "on for pages served from this machine, off for others",
                    (true, true) => "on for every page",
                }
            ),
            format!(
                "  files and navigation: import and export outside the artefact directory {}; navigate {}",
                on(self.files),
                if self.navigate { "may go to any origin" } else { "keeps to the origin the session was launched on" }
            ),
            format!("  the native-capture profile (a browser whose GPU process has no sandbox, for a native debugger): {}", on(self.native_capture)),
        ]
        .join("\n")
    }
}

/// Whether a URL is served from this machine: a loopback address, a `.localhost` name, a
/// file, or a page with no origin at all.
pub fn is_local(url: &str) -> bool {
    if url.is_empty() || url.starts_with("about:") || url.starts_with("file:") || url.starts_with("data:") {
        return true;
    }

    let host = host_of(url);

    host == "localhost" || host.ends_with(".localhost") || host == "[::1]" || host == "0.0.0.0" || is_loopback_v4(&host)
}

fn is_loopback_v4(host: &str) -> bool {
    let parts: Vec<&str> = host.split('.').collect();

    parts.len() == 4 && parts[0] == "127" && parts.iter().all(|part| part.parse::<u8>().is_ok())
}

/// The host of a URL, lower-cased, without credentials or port.
fn host_of(url: &str) -> String {
    let rest = url.split_once("://").map(|(_, rest)| rest).unwrap_or(url);
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = authority.rsplit_once('@').map(|(_, host)| host).unwrap_or(authority);

    // An IPv6 address keeps its brackets; the port comes after them.
    let host = if host.starts_with('[') {
        host.split_once(']').map(|(inside, _)| format!("{inside}]")).unwrap_or_else(|| host.to_string())
    } else {
        host.split(':').next().unwrap_or("").to_string()
    };

    host.to_lowercase()
}

/// Scheme, host and port: what must match for two URLs to be one origin.
pub fn origin_of(url: &str) -> String {
    let Some((scheme, rest)) = url.split_once("://") else {
        return url.split(':').next().unwrap_or("").to_lowercase();
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let authority = authority.rsplit_once('@').map(|(_, host)| host).unwrap_or(authority).to_lowercase();
    let scheme = scheme.to_lowercase();

    // The scheme's own port, written or not, is the same origin.
    let authority = match scheme.as_str() {
        "http" => authority.strip_suffix(":80").unwrap_or(&authority).to_string(),
        "https" => authority.strip_suffix(":443").unwrap_or(&authority).to_string(),
        _ => authority,
    };

    if scheme == "file" { "file://".to_string() } else { format!("{scheme}://{authority}") }
}

/// Refuses a command its tier does not allow.
pub(crate) fn check(host: &Arc<Host>, method: &str, params: &Value, session: Option<&Arc<Session>>) -> Result<()> {
    let page = session.map(|session| Page { url: session.url(), launch_origin: session.launch_origin.clone(), launch_url: session.launch_url.clone() });

    match refusal(&host.tiers, method, params, page.as_ref()) {
        Some(why) => bail!("{why}"),
        None => Ok(()),
    }
}

/// What the check needs to know of a session.
pub(crate) struct Page {
    pub url: String,
    pub launch_origin: String,
    pub launch_url: String,
}

/// Why a command is refused, if it is.
pub(crate) fn refusal(tiers: &Tiers, method: &str, params: &Value, page: Option<&Page>) -> Option<String> {
    // Making kept patches again is making patches.
    if method == "patches" && params["again"] == true {
        return refusal(tiers, "patch_state", &Value::Null, page).map(|why| why.replacen("patch_state is", "patches(again) makes patches, which is", 1));
    }

    // An expression run in the page is eval by another name.
    let expression = match method {
        "run_until" => params["until"]["expr"].is_string().then_some("run_until with until: {expr}"),
        "capture" => params["when"]["expr"].is_string().then_some("capture with when: {expr}"),
        _ => None,
    };

    if let Some(what) = expression {
        if let Some(why) = refusal(tiers, "eval", params, page) {
            return Some(why.replacen("eval is", &format!("{what} runs an expression in the page, as eval does, and that is"), 1));
        }
    }

    // Scanline's own live views draw the page with shaders of Scanline's making: a patch.
    if method == "live_view" && matches!(params["view"].as_str(), Some("overdraw" | "wireframe" | "draw_id" | "depth")) {
        if let Some(why) = refusal(tiers, "patch_state", &Value::Null, page) {
            return Some(why.replacen("patch_state is", "live_view with one of Scanline's own views patches the page's draws, which is", 1));
        }
    }

    // A browser with part of its sandbox off is the person's to allow, not the client's to ask for.
    if method == "launch" && matches!(params["profile"].as_str(), Some("native-capture" | "native")) && !tiers.native_capture {
        return Some(format!(
            "The native-capture profile starts a browser whose GPU process has no sandbox, so that a native GPU debugger can attach to it. That is weaker than a normal browser, and the person has not allowed it. To allow it, the host must be started with SCANLINE_ALLOW=native-capture. {HOW}."
        ));
    }

    match method {
        "pause" | "resume" | "step" | "run_until" | "input" | "request_human" | "take_control" | "debug" | "strip" | "replay_run" | "live_view"
            if !tiers.control =>
        {
            Some(format!(
                "{method} is in the control tier (time, input, hand-off), which this host was started without. Looking, capturing and analysis still work. {HOW}."
            ))
        }
        "page" if !tiers.control && matches!(params["call"].as_str(), Some("set_control" | "time" | "checkpoint" | "restore")) => Some(format!(
            "page with call: \"{}\" changes the game, which is in the control tier, and this host was started without it. page still reads: state, controls, views, groups, passes, marks. {HOW}.",
            params["call"].as_str().unwrap_or("")
        )),
        "patch_draws" | "patch_state" | "patch_uniform" | "patch_shader" | "patch_texture" | "experiment" | "eval" | "policy" => {
            if !tiers.patch {
                return Some(format!(
                    "{method} is in the patch-and-evaluate tier, which this host was started without. Looking, capturing and analysis still work. {HOW}."
                ));
            }

            let url = &page?.url;

            (!tiers.remote_patch && !is_local(url)).then(|| {
                format!(
                    "{method} is in the patch-and-evaluate tier, which is off for pages not served from this machine, and this page is {}. Running your code in somebody else's page is a bigger step than looking at it, and the person has not allowed it. Looking, capturing and analysis still work. To allow it, the host must be started with SCANLINE_ALLOW=remote-patch. {HOW}.",
                    origin_of(url)
                )
            })
        }
        "navigate" if !tiers.navigate => {
            let page = page?;
            let url = params["url"].as_str()?;
            let from = &page.launch_origin;
            let to = origin_of(url);

            // Files have no origin to speak of: one may go to its neighbours, not to the rest of the disk.
            if from == "file://" && to == "file://" {
                let dir = page.launch_url.rsplit_once('/').map(|(dir, _)| format!("{dir}/")).unwrap_or_default();
                let lower = url.to_lowercase();

                return (!url.starts_with(&dir) || lower.contains("/../") || lower.ends_with("/..") || lower.contains("%2e")).then(|| {
                    format!(
                        "navigate keeps a session launched on a file to that file's directory ({dir}), and {} is outside it. Launch a session on the other file instead. To let navigate go anywhere, the host must be started with SCANLINE_ALLOW=navigate. {HOW}.",
                        clip(url, 120)
                    )
                });
            }

            (*from != to).then(|| {
                format!(
                    "navigate keeps to the origin the session was launched on ({from}), and {to} is another. To look at another site, launch a session on it: launch(url: \"{}\"). To let navigate go anywhere, the host must be started with SCANLINE_ALLOW=navigate. {HOW}.",
                    clip(url, 120)
                )
            })
        }
        _ => None,
    }
}

fn clip(text: &str, most: usize) -> String {
    if text.chars().count() > most { format!("{}…", text.chars().take(most).collect::<String>()) } else { text.to_string() }
}

/// A file a command was asked to read or write. Inside the artefact directory is always
/// allowed; anywhere else needs the files tier. Returns the path made absolute.
pub(crate) fn file(host: &Host, given: &str, what: &str) -> Result<PathBuf> {
    let path = PathBuf::from(given);
    let path = if path.is_absolute() { path } else { std::env::current_dir().unwrap_or_default().join(path) };

    if !host.tiers.files && !inside(&path, &host.artefacts()) {
        bail!(
            "{what} {} is outside Scanline's artefact directory ({}), and this host was started without the files tier. Use a path inside that directory. {HOW}.",
            path.display(),
            host.artefacts().display()
        );
    }

    Ok(path)
}

/// Whether a path is inside a directory once links and `..` are resolved. A file that does
/// not exist yet is judged by the directory it would be made in.
fn inside(path: &Path, dir: &Path) -> bool {
    let Ok(dir) = dir.canonicalize() else { return false };
    let mut at = path.to_path_buf();
    let mut tail = Vec::new();

    loop {
        if let Ok(real) = at.canonicalize() {
            let whole = tail.iter().rev().fold(real, |so_far, part| so_far.join(part));

            return whole.starts_with(&dir) && !tail.iter().any(|part| part == "..");
        }

        match (at.file_name().map(|name| name.to_os_string()), at.parent().map(Path::to_path_buf)) {
            (Some(name), Some(parent)) => {
                tail.push(name);
                at = parent;
            }
            _ => return false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_and_words() {
        let tiers = Tiers::from_words("", "").unwrap();

        assert_eq!(tiers, Tiers::default());
        assert!(tiers.control && tiers.patch && tiers.files && !tiers.remote_patch && !tiers.navigate);

        let tiers = Tiers::from_words("remote-patch, navigate", "control").unwrap();

        assert!(!tiers.control && tiers.remote_patch && tiers.navigate);

        // A denial wins over an allowance of the same thing.
        let tiers = Tiers::from_words("remote-patch,navigate", "patch files").unwrap();

        assert!(!tiers.patch && !tiers.remote_patch && !tiers.files && !tiers.navigate);

        assert!(Tiers::from_words("everything", "").is_err());
        assert!(Tiers::from_words("", "pach").is_err());
        assert!(Tiers::from_words("", "read").is_err());
    }

    #[test]
    fn what_counts_as_this_machine() {
        for url in [
            "http://localhost:5173/",
            "http://127.0.0.1:8765/a?b",
            "http://[::1]:3000/",
            "https://game.localhost/",
            "file:///Users/me/game/index.html",
            "about:blank",
            "http://127.5.6.7/",
        ] {
            assert!(is_local(url), "{url}");
        }

        for url in [
            "https://example.com/",
            "http://localhost.example.com/",
            "http://127.0.0.1.example.com/",
            "https://user:pw@example.com:8443/x",
            "http://192.168.1.4/",
            "https://example.com/?next=http://localhost/",
        ] {
            assert!(!is_local(url), "{url}");
        }
    }

    #[test]
    fn origins() {
        assert_eq!(origin_of("http://localhost:5173/game/index.html?x=1#y"), "http://localhost:5173");
        assert_eq!(origin_of("HTTPS://Example.com:443/a"), "https://example.com");
        assert_eq!(origin_of("http://example.com:80"), "http://example.com");
        assert_eq!(origin_of("https://user:pw@example.com:8443/x"), "https://example.com:8443");
        assert_eq!(origin_of("file:///a/b.html"), "file://");
        assert_eq!(origin_of("about:blank"), "about");
        assert_ne!(origin_of("http://localhost:5173/"), origin_of("http://localhost:5174/"));
    }

    fn page(url: &str) -> Page {
        Page { url: url.to_string(), launch_origin: origin_of(url), launch_url: url.to_string() }
    }

    #[test]
    fn what_each_tier_refuses() {
        use serde_json::json;

        let usual = Tiers::default();
        let local = page("http://localhost:5173/game/");
        let remote = page("https://games.example.com/play");
        let none = json!({});

        // The defaults: everything on a local page.
        for method in ["step", "input", "eval", "patch_shader", "policy", "screenshot", "capture", "export"] {
            assert_eq!(refusal(&usual, method, &none, Some(&local)), None, "{method}");
        }

        // A remote page may be looked at and driven, not patched or evaluated in.
        for method in ["step", "input", "screenshot", "capture", "pixel_history", "resources"] {
            assert_eq!(refusal(&usual, method, &none, Some(&remote)), None, "{method}");
        }

        for method in ["eval", "patch_draws", "patch_state", "patch_uniform", "patch_shader", "patch_texture", "experiment", "policy"] {
            let why = refusal(&usual, method, &none, Some(&remote)).unwrap_or_else(|| panic!("{method} was allowed on a remote page"));

            assert!(why.contains("https://games.example.com") && why.contains("SCANLINE_ALLOW=remote-patch"), "{why}");
        }

        let wide = Tiers::from_words("remote-patch", "").unwrap();

        assert_eq!(refusal(&wide, "eval", &none, Some(&remote)), None);

        // An expression in another command is eval too.
        let until = json!({ "until": { "expr": "game.level === 2" } });
        let when = json!({ "when": { "expr": "game.over" } });

        assert_eq!(refusal(&usual, "run_until", &until, Some(&local)), None);
        assert_eq!(refusal(&usual, "run_until", &json!({ "until": { "frames": 10 } }), Some(&remote)), None);
        assert!(refusal(&usual, "run_until", &until, Some(&remote)).unwrap().starts_with("run_until with until: {expr} runs an expression in the page"));
        assert!(refusal(&usual, "capture", &when, Some(&remote)).is_some());
        assert_eq!(refusal(&usual, "capture", &json!({ "when": { "error": true } }), Some(&remote)), None);
        assert!(refusal(&Tiers::from_words("", "patch").unwrap(), "capture", &when, Some(&local)).is_some());

        // Navigation keeps to the launch origin, wherever the page has got to since.
        let to = |url: &str| json!({ "url": url });

        assert_eq!(refusal(&usual, "navigate", &to("http://localhost:5173/other.html"), Some(&local)), None);
        assert_eq!(refusal(&usual, "navigate", &json!({ "reload": true }), Some(&local)), None);
        assert!(refusal(&usual, "navigate", &to("http://localhost:5174/"), Some(&local)).is_some());
        assert!(refusal(&usual, "navigate", &to("https://example.com/"), Some(&local)).is_some());
        assert!(refusal(&usual, "navigate", &to("file:///etc/passwd"), Some(&local)).is_some());
        assert_eq!(refusal(&Tiers::from_words("navigate", "").unwrap(), "navigate", &to("https://example.com/"), Some(&local)), None);

        // A file may go to its neighbours only.
        let file = page("file:///Users/me/game/index.html");

        assert_eq!(refusal(&usual, "navigate", &to("file:///Users/me/game/levels/two.html"), Some(&file)), None);
        assert!(refusal(&usual, "navigate", &to("file:///Users/me/secrets.html"), Some(&file)).is_some());
        assert!(refusal(&usual, "navigate", &to("file:///Users/me/game/../secrets.html"), Some(&file)).is_some());
        assert!(refusal(&usual, "navigate", &to("file:///Users/me/game/%2E%2e/secrets.html"), Some(&file)).is_some());
        assert!(refusal(&usual, "navigate", &to("https://example.com/"), Some(&file)).is_some());

        // Tiers switched off.
        let bare = Tiers::from_words("remote-patch,navigate", "control,patch,files").unwrap();

        for method in [
            "pause",
            "resume",
            "step",
            "run_until",
            "input",
            "request_human",
            "take_control",
            "debug",
            "strip",
            "replay_run",
            "eval",
            "policy",
            "patch_state",
            "experiment",
        ] {
            assert!(refusal(&bare, method, &none, Some(&local)).is_some(), "{method}");
        }

        assert!(refusal(&bare, "page", &json!({ "call": "set_control" }), Some(&local)).is_some());
        assert_eq!(refusal(&bare, "page", &json!({ "call": "state" }), Some(&local)), None);
        assert_eq!(refusal(&bare, "page", &none, Some(&local)), None);
        assert!(refusal(&bare, "navigate", &to("https://example.com/"), Some(&local)).is_some());

        for method in ["launch", "screenshot", "pixels", "capture", "draw", "resources", "memory", "lint", "close", "patches"] {
            assert_eq!(refusal(&bare, method, &none, Some(&local)), None, "{method}");
        }
    }

    #[test]
    fn inside_resolves_dots_and_missing_files() {
        let dir = std::env::temp_dir().join(format!("scanline-tiers-{}", std::process::id()));

        std::fs::create_dir_all(dir.join("exports")).unwrap();

        assert!(inside(&dir.join("exports/new.scanline"), &dir));
        assert!(inside(&dir.join("not/made/yet.scanline"), &dir));
        assert!(!inside(&dir.join("../elsewhere.scanline"), &dir));
        assert!(!inside(&dir.join("exports/../../elsewhere.scanline"), &dir));
        assert!(!inside(&dir.join("not/made/../../../elsewhere.scanline"), &dir));
        assert!(!inside(Path::new("/etc/hosts"), &dir));

        std::fs::remove_dir_all(&dir).unwrap();
    }
}
