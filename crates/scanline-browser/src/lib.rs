//! Finds, launches and supervises the Chromium that Scanline debugs.
//!
//! The browser is a child process with a Scanline-owned profile directory, driven over
//! `--remote-debugging-pipe` (02-ARCHITECTURE.md, section 2). The host contains no Chromium
//! code: whatever the page does to the browser, the host keeps running.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use scanline_cdp::Client;
use serde_json::json;
use tokio::process::Child;
use tokio::sync::Mutex;

/// Launch profiles (02-ARCHITECTURE.md, section 2.4). Every measurement names its profile.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Profile {
    /// As close to a normal browser as possible.
    Stock,
    /// WebGPU developer features, Dawn toggles for readable translated shaders.
    Deep,
    /// Software rasteriser: separates logic bugs from driver bugs. For CI.
    Software,
}

impl Profile {
    pub fn parse(name: &str) -> Result<Self> {
        match name {
            "stock" => Ok(Profile::Stock),
            "deep" => Ok(Profile::Deep),
            "software" => Ok(Profile::Software),
            other => bail!("Unknown profile \"{other}\". Profiles are: stock, deep, software."),
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Profile::Stock => "stock",
            Profile::Deep => "deep",
            Profile::Software => "software",
        }
    }

    fn switches(self) -> &'static [&'static str] {
        match self {
            Profile::Stock => &[],
            Profile::Deep => &[
                "--enable-unsafe-webgpu",
                "--enable-webgpu-developer-features",
                "--enable-dawn-features=dump_shaders,use_user_defined_labels_in_backend,disable_symbol_renaming",
            ],
            Profile::Software => &["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--use-webgpu-adapter=swiftshader"],
        }
    }
}

/// Switches every launch uses.
const ALWAYS_ON: &[&str] = &[
    "--remote-debugging-pipe",
    "--no-first-run",
    "--no-default-browser-check",
    // Frames must keep flowing when the window is covered.
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--disable-features=CalculateNativeWinOcclusion",
    "--autoplay-policy=no-user-gesture-required",
    "--disable-search-engine-choice-screen",
    "--disable-sync",
    // Spike S1: a branded Chrome otherwise starts extension service workers of its own.
    "--disable-extensions",
    "--disable-component-extensions-with-background-pages",
    // The disposable profile must never touch the user's keychain or their own browser's data.
    "--password-store=basic",
    "--use-mock-keychain",
    "--disable-breakpad",
];

pub struct LaunchOptions {
    pub url: String,
    pub profile: Profile,
    pub headless: bool,
    pub width: u32,
    pub height: u32,
    /// A specific browser binary. Otherwise `SCANLINE_BROWSER`, then the usual install paths.
    pub browser: Option<PathBuf>,
    /// Where the disposable profile goes. It is deleted when the browser closes.
    pub user_data_dir: PathBuf,
    pub extra_args: Vec<String>,
}

/// A running browser.
pub struct Browser {
    pub client: Client,
    pub executable: PathBuf,
    pub profile: Profile,
    pub headless: bool,
    pub pid: Option<u32>,
    user_data_dir: PathBuf,
    child: Arc<Mutex<Child>>,
}

/// Where a Chromium can be found on this machine.
pub fn find_browser(explicit: Option<&Path>) -> Result<PathBuf> {
    if let Some(path) = explicit {
        if path.exists() {
            return Ok(path.to_path_buf());
        }

        bail!("No browser at {}.", path.display());
    }

    if let Some(path) = std::env::var_os("SCANLINE_BROWSER") {
        let path = PathBuf::from(path);

        if path.exists() {
            return Ok(path);
        }

        bail!("SCANLINE_BROWSER is set to {}, which does not exist.", path.display());
    }

    let candidates: &[&str] = if cfg!(target_os = "macos") {
        &[
            "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        ]
    } else if cfg!(target_os = "windows") {
        &[
            "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        ]
    } else {
        &["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"]
    };

    candidates
        .iter()
        .map(PathBuf::from)
        .find(|path| path.exists())
        .ok_or_else(|| anyhow!("No Chrome, Edge or Chromium found. Install one, or set SCANLINE_BROWSER to a Chromium binary."))
}

impl Browser {
    pub async fn launch(options: LaunchOptions) -> Result<Self> {
        let executable = find_browser(options.browser.as_deref())?;

        std::fs::create_dir_all(&options.user_data_dir)
            .with_context(|| format!("creating the browser profile directory {}", options.user_data_dir.display()))?;

        let mut args: Vec<String> = ALWAYS_ON.iter().chain(options.profile.switches()).map(|s| s.to_string()).collect();

        args.push(format!("--user-data-dir={}", options.user_data_dir.display()));
        args.push(format!("--crash-dumps-dir={}", options.user_data_dir.join("crashes").display()));
        args.push(format!("--window-size={},{}", options.width, options.height));
        args.extend(options.extra_args.iter().cloned());

        if options.headless {
            args.push("--headless=new".into());
            args.push(options.url.clone());
        } else {
            // A chrome-less app window: no tabs, no address bar.
            args.push(format!("--app={}", options.url));
        }

        let (child, client) = spawn_with_pipe(&executable, &args)?;
        let pid = child.id();

        let browser = Browser {
            client,
            executable,
            profile: options.profile,
            headless: options.headless,
            pid,
            user_data_dir: options.user_data_dir,
            child: Arc::new(Mutex::new(child)),
        };

        // The first reply proves the pipe works. A managed machine can block remote debugging
        // by policy, in which case the browser starts but never answers.
        browser
            .client
            .send_with_timeout("Browser.getVersion", json!({}), None, Duration::from_secs(20))
            .await
            .context("The browser started but did not answer over the debugging pipe. A policy on this machine may block remote debugging.")?;

        Ok(browser)
    }

    /// Resolves when the browser process has exited, with its exit code if it had one.
    pub async fn wait_exit(&self) -> Option<i32> {
        let mut child = self.child.lock().await;

        child.wait().await.ok().and_then(|status| status.code())
    }

    /// Closes the browser and deletes its profile directory.
    pub async fn close(&self) {
        let _ = self.client.send_with_timeout("Browser.close", json!({}), None, Duration::from_secs(2)).await;

        {
            let mut child = self.child.lock().await;

            if tokio::time::timeout(Duration::from_secs(3), child.wait()).await.is_err() {
                let _ = child.kill().await;
            }
        }

        // The browser's helper processes can hold files for a moment after it exits.
        for _ in 0..5 {
            if std::fs::remove_dir_all(&self.user_data_dir).is_ok() || !self.user_data_dir.exists() {
                break;
            }

            tokio::time::sleep(Duration::from_millis(150)).await;
        }
    }
}

#[cfg(unix)]
fn spawn_with_pipe(executable: &Path, args: &[String]) -> Result<(Child, Client)> {
    use std::os::fd::FromRawFd;

    // Two pipes. The browser reads commands on descriptor 3 and writes replies on 4.
    let (commands_read, commands_write) = pipe()?;
    let (replies_read, replies_write) = pipe()?;

    // Move the browser's two ends well clear of 3 and 4, so the dup2 calls in the child
    // cannot overwrite one with the other, and keep our own two ends out of the child.
    let child_reads = dup_above(commands_read, 10)?;
    let child_writes = dup_above(replies_write, 10)?;

    unsafe {
        libc::close(commands_read);
        libc::close(replies_write);
    }

    set_cloexec(commands_write)?;
    set_cloexec(replies_read)?;

    let mut command = tokio::process::Command::new(executable);

    command.args(args).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).kill_on_drop(true);

    // Runs in the child between fork and exec. Only async-signal-safe calls are allowed here.
    unsafe {
        command.pre_exec(move || {
            if libc::dup2(child_reads, 3) < 0 || libc::dup2(child_writes, 4) < 0 {
                return Err(std::io::Error::last_os_error());
            }

            Ok(())
        });
    }

    let spawned = command.spawn().with_context(|| format!("starting {}", executable.display()));

    unsafe {
        libc::close(child_reads);
        libc::close(child_writes);
    }

    let child = spawned?;

    let to_browser = tokio::fs::File::from_std(unsafe { std::fs::File::from_raw_fd(commands_write) });
    let from_browser = tokio::fs::File::from_std(unsafe { std::fs::File::from_raw_fd(replies_read) });

    Ok((child, Client::new(from_browser, to_browser)))
}

#[cfg(unix)]
fn pipe() -> Result<(i32, i32)> {
    let mut ends = [0i32; 2];

    if unsafe { libc::pipe(ends.as_mut_ptr()) } != 0 {
        return Err(std::io::Error::last_os_error()).context("creating a pipe to the browser");
    }

    Ok((ends[0], ends[1]))
}

#[cfg(unix)]
fn dup_above(fd: i32, minimum: i32) -> Result<i32> {
    let duplicate = unsafe { libc::fcntl(fd, libc::F_DUPFD, minimum) };

    if duplicate < 0 {
        return Err(std::io::Error::last_os_error()).context("duplicating a pipe end");
    }

    Ok(duplicate)
}

#[cfg(unix)]
fn set_cloexec(fd: i32) -> Result<()> {
    if unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
        return Err(std::io::Error::last_os_error()).context("marking a pipe end close-on-exec");
    }

    Ok(())
}

#[cfg(not(unix))]
fn spawn_with_pipe(_executable: &Path, _args: &[String]) -> Result<(Child, Client)> {
    // Windows passes the pipe as inherited handles named in --remote-debugging-io-pipes.
    // Not written yet: nothing in this repository has been run on Windows.
    bail!("Launching the browser over the debugging pipe is not implemented on this platform yet.")
}
