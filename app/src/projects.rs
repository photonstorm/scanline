//! The games the person has opened: each one's address, title, when it was last open, a
//! picture of it, and what the app remembers for it (muted, the size it was given). Kept in
//! `<home>/app-projects.json`, with the pictures in `<home>/pictures`. The start page a window
//! opens on when it is given no address is written from them: a card for each, a click away.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// How many games are remembered.
const KEEP: usize = 48;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Project {
    pub url: String,
    #[serde(default)]
    pub title: String,
    /// Seconds since 1970 when it was last opened.
    #[serde(default)]
    pub opened: u64,
    /// The file name of its picture in `<home>/pictures`.
    #[serde(default)]
    pub picture: Option<String>,
    #[serde(default)]
    pub muted: bool,
    /// The size it was last given (a preset's name), if not its window's own.
    #[serde(default)]
    pub size: Option<String>,
}

pub fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|since| since.as_secs()).unwrap_or(0)
}

/// What a game is known by: its address without the part after #.
pub fn key(url: &str) -> String {
    url.split('#').next().unwrap_or(url).to_string()
}

/// Whether an address is a game worth remembering, not a page of the app's own.
pub fn worth_keeping(url: &str) -> bool {
    url.starts_with("http:") || url.starts_with("https:")
}

pub fn load(home: &Path) -> Vec<Project> {
    if let Some(projects) = std::fs::read_to_string(home.join("app-projects.json")).ok().and_then(|text| serde_json::from_str::<Vec<Project>>(&text).ok()) {
        return projects;
    }

    // The list kept before projects: addresses alone, newest first.
    let recent: Vec<String> = std::fs::read_to_string(home.join("app-recent.json")).ok().and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default();
    let started = now();

    recent.into_iter().enumerate().map(|(index, url)| Project { url, opened: started.saturating_sub(index as u64), ..Default::default() }).collect()
}

pub fn save(home: &Path, projects: &[Project]) {
    let _ = std::fs::write(home.join("app-projects.json"), serde_json::to_string_pretty(projects).unwrap_or_default());
}

/// The project for an address, made if it is new, and moved to the front when `opened`.
pub fn touch<'a>(projects: &'a mut Vec<Project>, url: &str, opened: bool) -> &'a mut Project {
    let wanted = key(url);
    let at = match projects.iter().position(|project| key(&project.url) == wanted) {
        Some(at) => at,
        None => {
            projects.insert(0, Project { url: url.to_string(), opened: now(), ..Default::default() });
            projects.truncate(KEEP);
            0
        }
    };

    if opened {
        let mut project = projects.remove(at);

        project.url = url.to_string();
        project.opened = now();
        projects.insert(0, project);

        return &mut projects[0];
    }

    &mut projects[at]
}

/// Where a game's picture is kept, by its address.
pub fn picture_name(url: &str) -> String {
    // FNV-1a: a stable name from the address, and nothing of it in the file name.
    let mut hash: u64 = 0xcbf29ce484222325;

    for byte in key(url).bytes() {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }

    format!("{hash:016x}.png")
}

pub fn pictures(home: &Path) -> PathBuf {
    home.join("pictures")
}

/// Text made safe to put in HTML, in an element or an attribute.
fn escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&#39;")
}

pub fn file_url(path: &Path) -> String {
    let text = path.display().to_string().replace('\\', "/");
    let encoded: String = text
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'/' | b'-' | b'_' | b'.' | b'~' | b':' => (byte as char).to_string(),
            other => format!("%{other:02X}"),
        })
        .collect();

    if encoded.starts_with('/') { format!("file://{encoded}") } else { format!("file:///{encoded}") }
}

/// How long ago, in words.
fn ago(then: u64) -> String {
    let seconds = now().saturating_sub(then);

    match seconds {
        0..=89 => "just now".into(),
        90..=3599 => format!("{} minutes ago", seconds / 60),
        3600..=7199 => "an hour ago".into(),
        7200..=86_399 => format!("{} hours ago", seconds / 3600),
        86_400..=172_799 => "yesterday".into(),
        _ => format!("{} days ago", seconds / 86_400),
    }
}

/// The cards of the start page's Projects section.
fn cards(home: &Path, projects: &[Project]) -> String {
    let shown: Vec<&Project> = projects.iter().filter(|project| worth_keeping(&project.url)).collect();

    if shown.is_empty() {
        return "<p class=\"lead\">No projects yet. <kbd>⌘L</kbd> to open one.</p>".into();
    }

    let mut out = String::from("<div class=\"projects\">");

    for project in shown {
        let picture = project
            .picture
            .as_ref()
            .map(|name| pictures(home).join(name))
            .filter(|path| path.exists())
            .map(|path| {
                let stamp = std::fs::metadata(&path).and_then(|meta| meta.modified()).ok().and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |since| since.as_secs());

                format!("<img src=\"{}?v={stamp}\" alt=\"\">", escape(&file_url(&path)))
            })
            .unwrap_or_else(|| "<div class=\"blank\"></div>".into());
        let title = if project.title.trim().is_empty() { project.url.clone() } else { project.title.clone() };
        let mut notes = vec![ago(project.opened)];

        if project.muted {
            notes.push("muted".into());
        }

        if let Some(size) = &project.size {
            notes.push(size.clone());
        }

        out.push_str(&format!(
            "<a class=\"project\" href=\"{}\">{picture}<span class=\"title\">{}</span><span class=\"url\">{}</span><span class=\"when\">{}</span></a>",
            escape(&project.url),
            escape(&title),
            escape(&project.url),
            escape(&notes.join(" · "))
        ));
    }

    out.push_str("</div>");
    out
}

/// The app's own start page, in the bundle's Resources on a Mac and beside the executable on
/// Windows.
pub fn template(me: &Path) -> Option<PathBuf> {
    let folder = me.parent();
    let page = if cfg!(windows) { folder.map(|folder| folder.join("start.html")) } else { folder.and_then(Path::parent).map(|contents| contents.join("Resources/start.html")) };

    page.filter(|page| page.exists())
}

/// Writes the start page with the projects in it, and returns its path; the bundled page as it
/// is where it cannot be written.
pub fn start_page(home: &Path, me: &Path) -> Option<PathBuf> {
    let template = template(me)?;
    let text = std::fs::read_to_string(&template).ok()?;
    let written = home.join("start.html");
    let page = text.replace("<!-- projects -->", &cards(home, &load(home)));

    match std::fs::write(&written, page) {
        Ok(()) => Some(written),
        Err(_) => Some(template),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_page_title_cannot_add_markup() {
        assert_eq!(escape("<script>alert('x')</script> & \"y\""), "&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt; &amp; &quot;y&quot;");
    }

    #[test]
    fn a_game_is_one_project_whatever_its_hash() {
        let mut projects = Vec::new();

        touch(&mut projects, "https://a.example/game#level1", true).muted = true;
        touch(&mut projects, "https://b.example/", true);

        assert!(touch(&mut projects, "https://a.example/game#level2", true).muted);
        assert_eq!(projects.len(), 2);
        assert_eq!(projects[0].url, "https://a.example/game#level2");
        assert_eq!(picture_name("https://a.example/game#x"), picture_name("https://a.example/game"));
    }

    #[test]
    fn a_picture_path_is_a_file_url() {
        assert_eq!(file_url(Path::new("/Users/me/Application Support/a.png")), "file:///Users/me/Application%20Support/a.png");
    }
}
