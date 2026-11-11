//! The pinned browser: one version of Chrome for Testing that this version of Scanline was
//! built and tested against, kept in Scanline's own directory so that the person's Chrome
//! updating itself does not change what a page is debugged in.
//!
//! Installing it is the person's to do, from a shell (`scanline browser install`). It is
//! not a command of the control API: an agent cannot make Scanline download anything.

use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{Context, Result, bail};

/// The version of Chrome for Testing this version of Scanline is pinned to.
pub const PINNED: &str = "157.0.8103.50";

/// Chrome for Testing's name for this platform, and where the binary is inside its archive.
fn platform() -> Option<(&'static str, &'static str)> {
    const MAC: &str = "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";

    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Some(("mac-arm64", MAC)),
        ("macos", "x86_64") => Some(("mac-x64", MAC)),
        ("windows", "x86_64") => Some(("win64", "chrome.exe")),
        ("linux", "x86_64") => Some(("linux64", "chrome")),
        _ => None,
    }
}

fn unsupported() -> anyhow::Error {
    anyhow::anyhow!(
        "Chrome for Testing is not published for {} on {}. Install Chrome, Edge or Chromium, or set SCANLINE_BROWSER to a Chromium binary.",
        std::env::consts::OS,
        std::env::consts::ARCH
    )
}

/// Where the archive of the pinned version is downloaded from.
pub fn download_url() -> Result<String> {
    let (name, _) = platform().ok_or_else(unsupported)?;

    Ok(format!("https://storage.googleapis.com/chrome-for-testing-public/{PINNED}/{name}/chrome-{name}.zip"))
}

/// The directory the pinned version is unpacked into.
pub fn pinned_dir(home: &Path) -> PathBuf {
    home.join("browser").join(PINNED)
}

/// The pinned browser's binary, if it has been installed.
pub fn pinned_binary(home: &Path) -> Option<PathBuf> {
    let (name, inside) = platform()?;
    let binary = pinned_dir(home).join(format!("chrome-{name}")).join(inside);

    binary.exists().then_some(binary)
}

/// Installs the pinned browser: from an archive already on disk, or by downloading it.
/// With `dry_run`, says what would be done and does nothing.
pub fn install(home: &Path, from: Option<&Path>, dry_run: bool) -> Result<String> {
    let (name, inside) = platform().ok_or_else(unsupported)?;
    let url = download_url()?;
    let dir = pinned_dir(home);
    let binary = dir.join(format!("chrome-{name}")).join(inside);

    if binary.exists() {
        return Ok(format!(
            "Chrome for Testing {PINNED} is already installed at {}. Scanline uses it unless launch names another browser or SCANLINE_BROWSER is set.",
            dir.display()
        ));
    }

    let source = match from {
        Some(path) => format!("the archive at {}", path.display()),
        None => format!("{url} (about 170 MB)"),
    };

    if dry_run {
        return Ok(format!(
            "Dry run: nothing was downloaded or written.\n  version   Chrome for Testing {PINNED}\n  from      {source}\n  into      {}\n  binary    {}\nRun `scanline browser install` to do it. Scanline then uses that browser unless launch names another or SCANLINE_BROWSER is set.",
            dir.display(),
            binary.display()
        ));
    }

    let parent = dir.parent().unwrap_or(home);

    std::fs::create_dir_all(parent).with_context(|| format!("creating {}", parent.display()))?;

    // The archive: the one given, or one fetched over HTTPS only.
    let fetched = parent.join(format!("{PINNED}.zip.partial"));
    let archive = match from {
        Some(path) => {
            if !path.exists() {
                bail!("There is no archive at {}.", path.display());
            }

            path.to_path_buf()
        }
        None => {
            let status = Command::new("curl")
                .args(["--fail", "--location", "--proto", "=https", "--tlsv1.2", "--silent", "--show-error", "--output"])
                .arg(&fetched)
                .arg(&url)
                .status()
                .context("running curl to download the browser")?;

            if !status.success() {
                let _ = std::fs::remove_file(&fetched);

                bail!("Downloading {url} failed ({status}). Download it yourself and run `scanline browser install --from <the zip>`.");
            }

            fetched.clone()
        }
    };

    // Unpacked beside its final place and renamed, so a half-unpacked browser is never used.
    let partial = parent.join(format!("{PINNED}.partial"));
    let _ = std::fs::remove_dir_all(&partial);

    std::fs::create_dir_all(&partial).with_context(|| format!("creating {}", partial.display()))?;

    // ditto keeps what a macOS application bundle needs (links, permissions). Windows has
    // no unzip, but the tar it ships with reads zip archives; it is named by its full path
    // because a tar from elsewhere on the PATH (Git's, say) may not. unzip elsewhere.
    let unpacked = if cfg!(target_os = "macos") {
        Command::new("ditto").args(["-x", "-k"]).arg(&archive).arg(&partial).status()
    } else if cfg!(windows) {
        let system = PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into())).join("System32");

        Command::new(system.join("tar.exe")).arg("-xf").arg(&archive).arg("-C").arg(&partial).status()
    } else {
        Command::new("unzip").arg("-q").arg(&archive).arg("-d").arg(&partial).status()
    };

    let _ = std::fs::remove_file(&fetched);

    let clean = |why: String| -> anyhow::Error {
        let _ = std::fs::remove_dir_all(&partial);

        anyhow::anyhow!(why)
    };

    match unpacked {
        Ok(status) if status.success() => {}
        Ok(status) => return Err(clean(format!("Unpacking {} failed ({status}).", archive.display()))),
        Err(error) => return Err(clean(format!("Could not run the unpacker on {}: {error}.", archive.display()))),
    }

    if !partial.join(format!("chrome-{name}")).join(inside).exists() {
        return Err(clean(format!(
            "{} is not Chrome for Testing for this platform: it has no chrome-{name}/{inside}. The archive for this machine is {url}.",
            archive.display()
        )));
    }

    let _ = std::fs::remove_dir_all(&dir);

    std::fs::rename(&partial, &dir).with_context(|| format!("moving the browser into {}", dir.display()))?;

    Ok(format!(
        "Installed Chrome for Testing {PINNED} at {}. Scanline uses it from the next launch, unless launch names another browser or SCANLINE_BROWSER is set.",
        dir.display()
    ))
}

/// Which browser a launch would use, and why, in words.
pub fn describe(home: &Path) -> String {
    let pinned = pinned_binary(home);
    let chosen = if let Some(path) = std::env::var_os("SCANLINE_BROWSER") {
        format!("{} (SCANLINE_BROWSER is set)", PathBuf::from(path).display())
    } else if let Some(path) = &pinned {
        format!("{} (the pinned Chrome for Testing {PINNED})", path.display())
    } else {
        match crate::find_browser(None) {
            Ok(path) => format!("{} (the first installed browser found)", path.display()),
            Err(error) => format!("none: {error}"),
        }
    };

    format!(
        "A launch would use: {chosen}\nPinned version: Chrome for Testing {PINNED}, {}.\n\n  scanline browser install             download and unpack the pinned version\n  scanline browser install --dry-run   say what that would do, and do nothing\n  scanline browser install --from zip  unpack an archive you have already downloaded",
        match &pinned {
            Some(_) => format!("installed at {}", pinned_dir(home).display()),
            None => format!("not installed (it would go in {})", pinned_dir(home).display()),
        }
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_dry_run_writes_nothing() {
        let home = std::env::temp_dir().join(format!("scanline-pin-{}", std::process::id()));
        let said = install(&home, None, true).unwrap();

        assert!(said.starts_with("Dry run: nothing was downloaded or written."));
        assert!(said.contains(PINNED) && said.contains("https://storage.googleapis.com/chrome-for-testing-public/"));
        assert!(!home.exists());
        assert!(pinned_binary(&home).is_none());
    }

    #[test]
    fn an_archive_that_is_missing_is_said_to_be() {
        let home = std::env::temp_dir().join(format!("scanline-pin-missing-{}", std::process::id()));
        let error = install(&home, Some(Path::new("/nowhere/chrome.zip")), false).unwrap_err().to_string();

        assert_eq!(error, "There is no archive at /nowhere/chrome.zip.");

        let _ = std::fs::remove_dir_all(&home);
    }
}
