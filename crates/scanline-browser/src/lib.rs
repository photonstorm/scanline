//! Finds, launches and supervises the Chromium that Scanline debugs.
//!
//! The browser is a child process with a Scanline-owned profile directory, driven over
//! `--remote-debugging-pipe` (02-ARCHITECTURE.md, section 2). The host contains no Chromium
//! code: whatever the page does to the browser, the host keeps running.

pub mod pinned;

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
    /// For attaching a native GPU debugger to the browser's GPU process: its sandbox is
    /// off, its watchdog does not kill it while it is stopped, and labels reach the native
    /// API as the page wrote them. Weaker than a normal browser, so asked for by name.
    Native,
}

impl Profile {
    pub fn parse(name: &str) -> Result<Self> {
        match name {
            "stock" => Ok(Profile::Stock),
            "deep" => Ok(Profile::Deep),
            "software" => Ok(Profile::Software),
            "native-capture" | "native" => Ok(Profile::Native),
            other => bail!("Unknown profile \"{other}\". Profiles are: stock, deep, software, native-capture."),
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Profile::Stock => "stock",
            Profile::Deep => "deep",
            Profile::Software => "software",
            Profile::Native => "native-capture",
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
            Profile::Native => &[
                "--disable-gpu-sandbox",
                "--disable-gpu-watchdog",
                "--enable-unsafe-webgpu",
                "--enable-webgpu-developer-features",
                "--enable-dawn-features=use_user_defined_labels_in_backend,disable_symbol_renaming",
            ],
        }
    }

    /// What the browser's processes are started with in their environment.
    fn environment(self) -> &'static [(&'static str, &'static str)] {
        match self {
            // Metal lets a debugger capture a process's GPU work only if the process was
            // started saying it may. Both spellings: the name changed between releases.
            Profile::Native => &[("MTL_CAPTURE_ENABLED", "1"), ("METAL_CAPTURE_ENABLED", "1")],
            _ => &[],
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

/// Where the Scanline app's executable is (docs/APP.md): `SCANLINE_APP` (the app, or its
/// executable), else the app this binary is inside, else the usual places for applications.
/// The host launches it as it launches a browser: it is a Chromium that takes the same switches.
pub fn find_app() -> Result<PathBuf> {
    let inside =
        |app: PathBuf| -> PathBuf { if app.extension().is_some_and(|extension| extension == "app") { app.join("Contents/MacOS/Scanline") } else { app } };

    if let Some(path) = std::env::var_os("SCANLINE_APP") {
        let path = inside(PathBuf::from(path));

        if path.exists() {
            return Ok(path);
        }

        bail!("SCANLINE_APP names {}, which does not exist.", path.display());
    }

    let mut candidates = Vec::new();

    // The command line inside the app's bundle (Scanline.app/Contents/MacOS/scanline-cli) uses its own app.
    if let Ok(me) = std::env::current_exe() {
        if let Some(folder) = me.parent() {
            candidates.push(folder.join("Scanline"));
        }
    }

    if cfg!(target_os = "macos") {
        if let Some(home) = std::env::var_os("HOME") {
            candidates.push(PathBuf::from(home).join("Applications/Scanline.app/Contents/MacOS/Scanline"));
        }

        candidates.push(PathBuf::from("/Applications/Scanline.app/Contents/MacOS/Scanline"));
    }

    if cfg!(windows) {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            candidates.push(PathBuf::from(local).join("Programs/Scanline/Scanline.exe"));
        }
    }

    candidates
        .into_iter()
        .find(|path| path.exists())
        .ok_or_else(|| anyhow!("The Scanline app is not installed: no Scanline.app in /Applications or ~/Applications. Install it, set SCANLINE_APP to it, or launch with display: \"window\"."))
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

    // Chrome installed for one user only, which needs no administrator, lives in their profile.
    if cfg!(target_os = "windows") {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            let path = PathBuf::from(local).join("Google").join("Chrome").join("Application").join("chrome.exe");

            if path.exists() {
                return Ok(path);
            }
        }
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

        let (child, client) = spawn_with_pipe(&executable, &args, options.profile.environment())?;
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
fn spawn_with_pipe(executable: &Path, args: &[String], environment: &[(&str, &str)]) -> Result<(Child, Client)> {
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
    command.envs(environment.iter().copied());

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

/// The memory a process holds, as the operating system counts it: on macOS its physical
/// footprint, which is the figure Activity Monitor shows and which includes the GPU
/// allocations made on its behalf; on Linux its resident set; on Windows its private bytes
/// (the system memory it has committed for itself alone, in memory or paged out), which is
/// the figure Task Manager shows as "Commit size" and which does not count memory on a
/// graphics card. None where it cannot be read.
pub fn process_memory(pid: i64) -> Option<u64> {
    #[cfg(target_os = "macos")]
    {
        let mut usage: libc::rusage_info_v2 = unsafe { std::mem::zeroed() };
        let found =
            unsafe { libc::proc_pid_rusage(pid as libc::c_int, libc::RUSAGE_INFO_V2, &mut usage as *mut libc::rusage_info_v2 as *mut libc::rusage_info_t) };

        if found == 0 { Some(usage.ri_phys_footprint) } else { None }
    }

    #[cfg(target_os = "linux")]
    {
        let status = std::fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
        let line = status.lines().find(|line| line.starts_with("VmRSS:"))?;

        line.split_whitespace().nth(1)?.parse::<u64>().ok().map(|kilobytes| kilobytes * 1024)
    }

    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::ProcessStatus::{K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX};
        use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid as u32) };

        if process.is_null() {
            return None;
        }

        let mut counters: PROCESS_MEMORY_COUNTERS_EX = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32;
        let found = unsafe { K32GetProcessMemoryInfo(process, (&raw mut counters).cast::<PROCESS_MEMORY_COUNTERS>(), size) };

        unsafe { CloseHandle(process) };

        if found != 0 { Some(counters.PrivateUsage as u64) } else { None }
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
    {
        let _ = pid;

        None
    }
}

/// What `process_memory` counts on this platform, for the sentence that quotes the figure.
pub fn process_memory_measure() -> &'static str {
    if cfg!(target_os = "macos") {
        "its physical footprint, as the operating system counts it"
    } else if cfg!(windows) {
        "its private bytes, as the operating system counts them: the system memory it has committed for itself, which leaves out what it holds in a graphics card's own memory"
    } else {
        "its resident set, as the operating system counts it"
    }
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

/// Windows has no numbered descriptors to hand a child. The browser is given its two ends
/// of the pipes as handles it inherits, and told their values on its command line.
#[cfg(windows)]
fn spawn_with_pipe(executable: &Path, args: &[String], environment: &[(&str, &str)]) -> Result<(Child, Client)> {
    use std::os::windows::io::FromRawHandle;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, HANDLE_FLAG_INHERIT, SetHandleInformation};
    use windows_sys::Win32::System::Pipes::CreatePipe;

    fn pipe() -> Result<(HANDLE, HANDLE)> {
        let mut read: HANDLE = std::ptr::null_mut();
        let mut write: HANDLE = std::ptr::null_mut();

        // No security attributes: neither end can be inherited until one is marked so.
        if unsafe { CreatePipe(&mut read, &mut write, std::ptr::null(), 1 << 16) } == 0 {
            return Err(std::io::Error::last_os_error()).context("creating a pipe to the browser");
        }

        Ok((read, write))
    }

    // A child inherits every handle that is marked inheritable at the moment it starts.
    // Two launches at once would each hand their browser the other's pipe, and a pipe
    // with a second holder does not close when its browser exits. So: one at a time.
    static LAUNCHING: std::sync::Mutex<()> = std::sync::Mutex::new(());

    let _one_at_a_time = LAUNCHING.lock().unwrap_or_else(|poisoned| poisoned.into_inner());

    let (commands_read, commands_write) = pipe()?;
    let (replies_read, replies_write) = pipe()?;

    // From here on the host's two ends are owned, and close themselves on any way out.
    let to_browser = unsafe { std::fs::File::from_raw_handle(commands_write) };
    let from_browser = unsafe { std::fs::File::from_raw_handle(replies_read) };

    let inheritable = unsafe {
        SetHandleInformation(commands_read, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) != 0
            && SetHandleInformation(replies_write, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) != 0
    };

    let spawned = if inheritable {
        let mut command = tokio::process::Command::new(executable);

        command.args(args).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).kill_on_drop(true);
        command.envs(environment.iter().copied());

        // The browser reads commands from the first handle and writes replies to the second.
        command.arg(format!("--remote-debugging-io-pipes={},{}", commands_read as usize, replies_write as usize));
        command.spawn().with_context(|| format!("starting {}", executable.display()))
    } else {
        Err(std::io::Error::last_os_error()).context("marking the browser's ends of the pipe inheritable")
    };

    // The browser has its own copies now. Ours must go, or its exit would never be seen.
    unsafe {
        CloseHandle(commands_read);
        CloseHandle(replies_write);
    }

    let child = spawned?;

    Ok((child, Client::new(tokio::fs::File::from_std(from_browser), tokio::fs::File::from_std(to_browser))))
}

#[cfg(not(any(unix, windows)))]
fn spawn_with_pipe(_executable: &Path, _args: &[String], _environment: &[(&str, &str)]) -> Result<(Child, Client)> {
    bail!("Launching the browser over the debugging pipe is not implemented on this platform.")
}
