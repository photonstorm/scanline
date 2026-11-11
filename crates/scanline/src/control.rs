//! The control API on a local channel, and the client side of it.
//!
//! JSON-RPC, one message per line, over a channel only the user can open: a Unix socket in
//! the home directory on macOS and Linux, a named pipe named for the home directory on
//! Windows. No network port is opened (02-ARCHITECTURE.md, sections 9.2 and 10). The
//! running host writes a runtime file in the home directory; the other modes find the host
//! through it.
//!
//! What differs between the platforms is in `channel`, below. Everything else is shared.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use scanline_core::Host;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};

/// The two halves of a connection, whatever it is made of.
type Reader = Box<dyn AsyncRead + Send + Unpin>;
type Writer = Box<dyn AsyncWrite + Send + Unpin>;

fn home() -> PathBuf {
    scanline_core::default_home()
}

fn runtime_path() -> PathBuf {
    home().join("runtime.json")
}

/// The connection to the host was lost mid-call.
#[derive(Debug)]
pub struct Dropped;

impl std::fmt::Display for Dropped {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "The Scanline host stopped while the command was running. Its sessions are gone; launch again.")
    }
}

impl std::error::Error for Dropped {}

/// The process ID the runtime file names, if there is one.
fn recorded_pid() -> Option<u32> {
    let text = std::fs::read_to_string(runtime_path()).ok()?;

    serde_json::from_str::<Value>(&text).ok()?["pid"].as_u64().map(|pid| pid as u32)
}

/// The process ID of a host that is running, going by the runtime file.
fn running_host() -> Option<u32> {
    let pid = recorded_pid()?;

    (pid != std::process::id() && channel::alive(pid)).then_some(pid)
}

fn blocked(error: &std::io::Error) -> String {
    format!(
        "This process is not allowed to reach the Scanline host's {} at {} ({error}). A sandbox around this command is the usual cause: run scanline outside it. The host itself has not been touched.",
        channel::KIND,
        channel::place()
    )
}

pub async fn serve(http: Option<u16>) -> Result<()> {
    let home = home();

    // The directory and the channel are the person's alone. This is the boundary that
    // keeps other users of the machine out, so failing to set it is failing to start.
    std::fs::create_dir_all(&home).with_context(|| format!("creating {}", home.display()))?;
    channel::make_private(&home)?;

    // Never disturb a host that is running. One that cannot be reached is not the same as
    // one that is gone: a sandbox may be blocking this process and not the host.
    match channel::dial().await {
        Ok(_) => bail!("A Scanline host is already running ({} {}). Use `scanline stop` to stop it.", channel::KIND, channel::place()),
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => bail!("{}", blocked(&error)),
        Err(error) => {
            if let Some(pid) = running_host() {
                bail!(
                    "A Scanline host is running (process {pid}) but its {} at {} cannot be reached: {error}. Stop that process, then start again.",
                    channel::KIND,
                    channel::place()
                );
            }
        }
    }

    // Before anything is put on disk: a host that cannot start (a misspelt tier) leaves nothing.
    let host = Host::new(home.clone())?;

    channel::before_serving();

    let mut listener = channel::Listener::bind()?;

    // MCP over loopback HTTP, only when asked for: the one network port Scanline opens.
    let mut web = None;

    if let Some(port) = http {
        let (listener, port, token) = crate::http::bind(&home, port).await?;

        eprintln!("MCP over HTTP at http://127.0.0.1:{port}/mcp. The token is in {}.", crate::http::token_path(&home).display());
        tokio::spawn(crate::http::serve(listener, port, token, host.clone()));
        web = Some(port);
    }

    // Where the channel is goes under its kind: "socket" with a path, or "pipe" with a name.
    let kind = channel::KIND;

    std::fs::write(
        runtime_path(),
        json!({ kind: channel::place(), "pid": std::process::id(), "version": env!("CARGO_PKG_VERSION"), "http": web.map(|port| json!({ "port": port, "url": format!("http://127.0.0.1:{port}/mcp") })) })
            .to_string(),
    )
    .with_context(|| format!("writing {}", runtime_path().display()))?;

    let stop = Arc::new(tokio::sync::Notify::new());

    eprintln!("scanline {} serving on {}", env!("CARGO_PKG_VERSION"), channel::place());

    let mut signals = channel::Signals::new()?;

    loop {
        tokio::select! {
            accepted = listener.accept() => {
                match accepted {
                    Ok((read, write)) => {
                        tokio::spawn(connection(read, write, host.clone(), stop.clone()));
                    }
                    // Nothing to be done about one client that could not be taken; the next can.
                    Err(_) => tokio::time::sleep(Duration::from_millis(10)).await,
                }
            }
            _ = stop.notified() => break,
            _ = signals.recv() => break,
        }
    }

    // Close every browser before going, so none is left running with nobody driving it.
    host.shutdown().await;

    // Only this host's own files: another may have taken the place since.
    if recorded_pid() == Some(std::process::id()) {
        channel::remove();

        let _ = std::fs::remove_file(runtime_path());
        let _ = std::fs::remove_file(crate::http::token_path(&home));
    }

    Ok(())
}

async fn connection(read: Reader, mut write: Writer, host: Arc<Host>, stop: Arc<tokio::sync::Notify>) {
    let (replies, mut outbox) = tokio::sync::mpsc::unbounded_channel::<String>();

    tokio::spawn(async move {
        while let Some(reply) = outbox.recv().await {
            if write.write_all(reply.as_bytes()).await.is_err() || write.write_all(b"\n").await.is_err() || write.flush().await.is_err() {
                break;
            }
        }
    });

    let mut lines = BufReader::new(read).lines();

    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(request) = serde_json::from_str::<Value>(&line) else { continue };
        let host = host.clone();
        let replies = replies.clone();
        let stop = stop.clone();

        // Each request runs on its own task: a long wait must not hold up a pause.
        tokio::spawn(async move {
            let id = request["id"].clone();
            let method = request["method"].as_str().unwrap_or("").to_string();

            let reply = if method == "host.stop" {
                stop.notify_one();
                json!({ "id": id, "result": { "summary": "Scanline host stopping; its browsers are being closed.", "data": {}, "images": [] } })
            } else {
                match host.call(&method, request["params"].clone()).await {
                    Ok(result) => json!({ "id": id, "result": result }),
                    Err(error) => json!({ "id": id, "error": { "message": format!("{error:#}") } }),
                }
            };

            let _ = replies.send(reply.to_string());
        });
    }
}

/// A client connection to the running host.
pub struct Link {
    lines: tokio::io::Lines<BufReader<Reader>>,
    write: Writer,
    next_id: u64,
}

impl Link {
    /// Connects to the host, starting it first if it is not running.
    pub async fn connect() -> Result<Self> {
        match channel::dial().await {
            Ok((read, write)) => return Ok(Self::over(read, write)),
            // Not allowed to reach it. Starting another host would not help, and would get in its way.
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => bail!("{}", blocked(&error)),
            Err(error) => {
                if let Some(pid) = running_host() {
                    bail!("A Scanline host is running (process {pid}) but its {} at {} cannot be reached: {error}.", channel::KIND, channel::place());
                }
            }
        }

        start_host()?;

        for _ in 0..100 {
            tokio::time::sleep(Duration::from_millis(50)).await;

            if let Some(link) = Self::try_connect().await {
                return Ok(link);
            }
        }

        bail!("Started the Scanline host but could not reach it at {} within 5 s. Run `scanline serve` in a terminal to see why.", channel::place())
    }

    pub async fn try_connect() -> Option<Self> {
        let (read, write) = channel::dial().await.ok()?;

        Some(Self::over(read, write))
    }

    fn over(read: Reader, write: Writer) -> Self {
        Link { lines: BufReader::new(read).lines(), write, next_id: 1 }
    }

    pub async fn call(&mut self, method: &str, params: Value) -> Result<Value> {
        let id = self.next_id;

        self.next_id += 1;

        let request = json!({ "id": id, "method": method, "params": params }).to_string();

        if self.write.write_all(request.as_bytes()).await.is_err() || self.write.write_all(b"\n").await.is_err() || self.write.flush().await.is_err() {
            return Err(Dropped.into());
        }

        loop {
            let line = match self.lines.next_line().await {
                Ok(Some(line)) => line,
                _ => return Err(Dropped.into()),
            };

            let Ok(mut reply) = serde_json::from_str::<Value>(&line) else { continue };

            if reply["id"].as_u64() != Some(id) {
                continue;
            }

            return match reply.get("error") {
                Some(error) => Err(anyhow!("{}", error["message"].as_str().unwrap_or("The host reported an error it did not describe."))),
                None => Ok(reply["result"].take()),
            };
        }
    }
}

/// Starts the host as a process of its own that outlives this one.
fn start_host() -> Result<()> {
    // Said here, where the person will see it, and not only in the host's log.
    scanline_core::tiers::Tiers::from_env()?;

    let executable = std::env::current_exe().context("finding the scanline binary to start the host")?;
    let home = home();

    std::fs::create_dir_all(&home).with_context(|| format!("creating {}", home.display()))?;

    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(home.join("host.log"))
        .with_context(|| format!("opening {}", home.join("host.log").display()))?;

    let mut command = std::process::Command::new(executable);

    command.arg("serve").stdin(std::process::Stdio::null()).stdout(log.try_clone()?).stderr(log);

    // On its own, so closing the terminal or the agent client does not take the host (and
    // the browsers a person may be playing in) down with it.
    channel::detach(&mut command);

    command.spawn().context("starting the Scanline host")?;

    Ok(())
}

pub async fn stop() -> Result<String> {
    match Link::try_connect().await {
        None => match running_host() {
            Some(pid) => bail!(
                "A Scanline host is running (process {pid}) but its {} at {} cannot be reached from here, so it was not stopped.",
                channel::KIND,
                channel::place()
            ),
            None => Ok("No Scanline host is running.".to_string()),
        },
        Some(mut link) => {
            let host = recorded_pid();
            let reply = link.call("host.stop", json!({})).await?;

            // Wait for it to finish closing browsers, so a following command starts a fresh host.
            for _ in 0..100 {
                if channel::gone(host) {
                    break;
                }

                tokio::time::sleep(Duration::from_millis(50)).await;
            }

            Ok(reply["summary"].as_str().unwrap_or("Stopped.").replace("stopping; its browsers are being closed.", "stopped; its browsers are closed."))
        }
    }
}

/// The channel as macOS and Linux have it: a socket file in the home directory, which only
/// the user can enter (mode 700), that only the user can open (mode 600).
#[cfg(unix)]
mod channel {
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};

    use anyhow::{Context, Result};

    use super::{Reader, Writer};

    pub const KIND: &str = "socket";

    fn socket_path() -> PathBuf {
        super::home().join("control.sock")
    }

    /// Where the channel is, as a person would look for it.
    pub fn place() -> String {
        socket_path().display().to_string()
    }

    pub fn make_private(home: &Path) -> Result<()> {
        std::fs::set_permissions(home, std::fs::Permissions::from_mode(0o700)).with_context(|| {
            format!("making {} private to you. Scanline keeps its control socket there; set SCANLINE_HOME to a directory you own.", home.display())
        })
    }

    pub async fn dial() -> std::io::Result<(Reader, Writer)> {
        let (read, write) = tokio::net::UnixStream::connect(socket_path()).await?.into_split();

        Ok((Box::new(read), Box::new(write)))
    }

    pub struct Listener(tokio::net::UnixListener);

    impl Listener {
        pub fn bind() -> Result<Self> {
            let socket = socket_path();

            // A socket file left by a host that did not exit cleanly.
            let _ = std::fs::remove_file(&socket);

            // Made private from the instant it exists, not a moment after.
            let mask = unsafe { libc::umask(0o177) };
            let bound = tokio::net::UnixListener::bind(&socket);

            unsafe { libc::umask(mask) };

            let listener = bound.with_context(|| {
                format!("binding the control socket at {}. If the path is too long for a socket, set SCANLINE_HOME to a shorter directory.", socket.display())
            })?;

            std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600)).with_context(|| format!("making {} private to you", socket.display()))?;

            Ok(Listener(listener))
        }

        pub async fn accept(&mut self) -> std::io::Result<(Reader, Writer)> {
            let (read, write) = self.0.accept().await?.0.into_split();

            Ok((Box::new(read), Box::new(write)))
        }
    }

    /// What tells the host to stop from outside: an interrupt, or being asked to terminate.
    pub struct Signals {
        interrupt: tokio::signal::unix::Signal,
        terminate: tokio::signal::unix::Signal,
    }

    impl Signals {
        pub fn new() -> std::io::Result<Self> {
            use tokio::signal::unix::{SignalKind, signal};

            Ok(Signals { interrupt: signal(SignalKind::interrupt())?, terminate: signal(SignalKind::terminate())? })
        }

        pub async fn recv(&mut self) {
            tokio::select! {
                _ = self.interrupt.recv() => {}
                _ = self.terminate.recv() => {}
            }
        }
    }

    /// Whether a process exists. Signal 0 tests for it without touching it, and "not
    /// permitted" still means it is there.
    pub fn alive(pid: u32) -> bool {
        unsafe { libc::kill(pid as i32, 0) == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM) }
    }

    /// Its own session, so the terminal closing does not reach it.
    pub fn detach(command: &mut std::process::Command) {
        use std::os::unix::process::CommandExt;

        unsafe {
            command.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
    }

    pub fn before_serving() {}

    /// Whether a host that was asked to stop has finished: it removes its socket last.
    pub fn gone(_host: Option<u32>) -> bool {
        !socket_path().exists()
    }

    pub fn remove() {
        let _ = std::fs::remove_file(socket_path());
    }
}

/// The channel as Windows has it: a named pipe. A pipe is not a file in the home directory,
/// so its name is made from the home directory's path, and each home has its own. Who may
/// open it is set by a security descriptor that names the user and nobody else, and it is
/// made refusing clients on other machines. The home directory is given the same owner-only
/// rule, which the files in it inherit.
#[cfg(windows)]
mod channel {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::process::CommandExt;
    use std::path::Path;
    use std::time::Duration;

    use anyhow::{Context, Result, bail};
    use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeServer, ServerOptions};
    use windows_sys::Win32::Foundation::{
        CloseHandle, ERROR_ACCESS_DENIED, ERROR_PIPE_BUSY, GetLastError, HANDLE, HANDLE_FLAG_INHERIT, LocalFree, STILL_ACTIVE, SetHandleInformation,
    };
    use windows_sys::Win32::Security::Authorization::{
        ConvertSecurityDescriptorToStringSecurityDescriptorW, ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
        GetNamedSecurityInfoW, SDDL_REVISION_1, SE_FILE_OBJECT, SetNamedSecurityInfoW,
    };
    use windows_sys::Win32::Security::{
        ACL, DACL_SECURITY_INFORMATION, GetSecurityDescriptorDacl, GetTokenInformation, PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR,
        SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER, TokenUser,
    };
    use windows_sys::Win32::System::Console::{GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE};
    use windows_sys::Win32::System::Threading::{
        CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW, GetCurrentProcess, GetExitCodeProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    use super::{Reader, Writer};

    pub const KIND: &str = "pipe";

    /// The pipe's name: the same for every process that names the same home directory,
    /// however it spells the path.
    pub fn place() -> String {
        let home = super::home();
        let path = std::path::absolute(&home).unwrap_or(home).to_string_lossy().replace('/', "\\").to_lowercase();

        // FNV-1a, written out: the name must not change with the version of the compiler.
        let hash =
            path.trim_end_matches('\\').bytes().fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| (hash ^ u64::from(byte)).wrapping_mul(0x0000_0100_0000_01b3));

        format!(r"\\.\pipe\scanline-{hash:016x}")
    }

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// Text the system allocated, copied out and given back.
    unsafe fn take_text(text: *mut u16) -> String {
        let mut length = 0;

        unsafe {
            while *text.add(length) != 0 {
                length += 1;
            }

            let copied = String::from_utf16_lossy(std::slice::from_raw_parts(text, length));

            LocalFree(text.cast());

            copied
        }
    }

    /// The user this process runs as, as the text of their security identifier.
    fn user() -> std::io::Result<String> {
        unsafe {
            let mut token: HANDLE = std::ptr::null_mut();

            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
                return Err(std::io::Error::last_os_error());
            }

            // Asked twice: once for the size, once for the answer. In u64s, so that the
            // structure at its start is aligned.
            let mut size = 0;

            GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut size);

            let mut buffer = vec![0u64; (size as usize).div_ceil(8).max(1)];
            let read = GetTokenInformation(token, TokenUser, buffer.as_mut_ptr().cast(), size, &mut size);
            let failed = std::io::Error::last_os_error();

            CloseHandle(token);

            if read == 0 {
                return Err(failed);
            }

            let mut text = std::ptr::null_mut();

            if ConvertSidToStringSidW((*buffer.as_ptr().cast::<TOKEN_USER>()).User.Sid, &mut text) == 0 {
                return Err(std::io::Error::last_os_error());
            }

            Ok(take_text(text))
        }
    }

    /// A security descriptor made from its text, freed when dropped.
    struct Descriptor(PSECURITY_DESCRIPTOR);

    // It is memory this process owns and never changes after it is made.
    unsafe impl Send for Descriptor {}

    impl Descriptor {
        fn parse(text: &str) -> std::io::Result<Self> {
            let mut descriptor = std::ptr::null_mut();

            if unsafe { ConvertStringSecurityDescriptorToSecurityDescriptorW(wide(text).as_ptr(), SDDL_REVISION_1, &mut descriptor, std::ptr::null_mut()) } == 0
            {
                return Err(std::io::Error::last_os_error());
            }

            Ok(Descriptor(descriptor))
        }
    }

    impl Drop for Descriptor {
        fn drop(&mut self) {
            unsafe { LocalFree(self.0) };
        }
    }

    /// The rule the home directory is given: the user, and the system and its
    /// administrators (who could take it anyway, and whose backup and scanning would
    /// otherwise fail), each with full control, inherited by everything inside. "P" is what
    /// stops the directory above adding anyone else.
    fn home_rule(user: &str) -> String {
        format!("D:PAI(A;OICI;FA;;;{user})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)")
    }

    /// The rule a directory has now, as text. None if it cannot be read.
    fn rule_of(path: &[u16]) -> Option<String> {
        unsafe {
            let mut descriptor = std::ptr::null_mut();
            let mut acl: *mut ACL = std::ptr::null_mut();

            if GetNamedSecurityInfoW(
                path.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut acl,
                std::ptr::null_mut(),
                &mut descriptor,
            ) != 0
            {
                return None;
            }

            let mut text = std::ptr::null_mut();
            let converted =
                ConvertSecurityDescriptorToStringSecurityDescriptorW(descriptor, SDDL_REVISION_1, DACL_SECURITY_INFORMATION, &mut text, std::ptr::null_mut());

            LocalFree(descriptor);

            (converted != 0).then(|| take_text(text))
        }
    }

    /// Makes the home directory, and so every file in it, the user's alone. A directory
    /// under the user's own profile already is; one named by SCANLINE_HOME may not be.
    pub fn make_private(home: &Path) -> Result<()> {
        let explain = || {
            format!(
                "making {} private to you. Scanline keeps its token and its captures there; set SCANLINE_HOME to a directory you own, on a disk that keeps permissions (NTFS).",
                home.display()
            )
        };
        let path: Vec<u16> = home.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
        let user = user().with_context(explain)?;
        let wanted = home_rule(&user);

        // Setting it walks everything inside, so it is set once and then left alone. The
        // system gives a rule's entries back in an order of its own: the same entries in
        // any order are the same rule.
        let entries = |rule: &str| {
            let mut parts: Vec<String> = rule.split('(').map(str::to_string).collect();

            parts.sort();
            parts
        };

        if rule_of(&path).is_some_and(|now| entries(&now) == entries(&wanted)) {
            return Ok(());
        }

        let descriptor = Descriptor::parse(&wanted).with_context(explain)?;

        unsafe {
            let mut present = 0;
            let mut defaulted = 0;
            let mut acl: *mut ACL = std::ptr::null_mut();

            if GetSecurityDescriptorDacl(descriptor.0, &mut present, &mut acl, &mut defaulted) == 0 || present == 0 {
                return Err(std::io::Error::last_os_error()).with_context(explain);
            }

            let set = SetNamedSecurityInfoW(
                path.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                acl,
                std::ptr::null(),
            );

            if set != 0 {
                return Err(std::io::Error::from_raw_os_error(set as i32)).with_context(explain);
            }
        }

        Ok(())
    }

    pub async fn dial() -> std::io::Result<(Reader, Writer)> {
        let name = place();

        // Between the host taking one client and offering the pipe to the next there is a
        // moment when every instance is in use. That is "busy", not "nobody there".
        for _ in 0..40 {
            match ClientOptions::new().open(&name) {
                Ok(client) => {
                    let (read, write) = tokio::io::split(client);

                    return Ok((Box::new(read), Box::new(write)));
                }
                Err(error) if error.raw_os_error() == Some(ERROR_PIPE_BUSY as i32) => tokio::time::sleep(Duration::from_millis(25)).await,
                Err(error) => return Err(error),
            }
        }

        Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "the pipe stayed busy for a second"))
    }

    pub struct Listener {
        name: String,
        rule: Descriptor,
        /// The instance of the pipe that the next client will connect to.
        waiting: NamedPipeServer,
    }

    /// One instance of the pipe. `first` fails if the pipe already exists: a host is running.
    fn instance(name: &str, rule: &Descriptor, first: bool) -> std::io::Result<NamedPipeServer> {
        let mut attributes =
            SECURITY_ATTRIBUTES { nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: rule.0, bInheritHandle: 0 };

        unsafe {
            ServerOptions::new()
                .first_pipe_instance(first)
                .reject_remote_clients(true)
                .create_with_security_attributes_raw(name, (&raw mut attributes).cast::<c_void>())
        }
    }

    impl Listener {
        pub fn bind() -> Result<Self> {
            let name = place();

            // The user and nobody else may open it. Left to its default, a pipe can be read
            // by every user of the machine.
            let rule =
                user().and_then(|user| Descriptor::parse(&format!("D:P(A;;GA;;;{user})"))).context("making the rule for who may open the control pipe")?;

            let waiting = match instance(&name, &rule, true) {
                Ok(waiting) => waiting,
                Err(error) if error.raw_os_error() == Some(ERROR_ACCESS_DENIED as i32) => {
                    bail!("A Scanline host is already running (pipe {name}). Use `scanline stop` to stop it.")
                }
                Err(error) => return Err(error).with_context(|| format!("creating the control pipe {name}")),
            };

            Ok(Listener { name, rule, waiting })
        }

        pub async fn accept(&mut self) -> std::io::Result<(Reader, Writer)> {
            self.waiting.connect().await?;

            // The next instance is made before this one is handed over, so the pipe is
            // never without one. Nothing below waits, so a client taken is never dropped.
            let next = instance(&self.name, &self.rule, false)?;
            let (read, write) = tokio::io::split(std::mem::replace(&mut self.waiting, next));

            Ok((Box::new(read), Box::new(write)))
        }
    }

    /// What tells the host to stop from outside: Ctrl+C or Ctrl+Break in its console, the
    /// console closing, the person logging off, the machine shutting down.
    pub struct Signals {
        interrupt: tokio::signal::windows::CtrlC,
        pause: tokio::signal::windows::CtrlBreak,
        close: tokio::signal::windows::CtrlClose,
        logoff: tokio::signal::windows::CtrlLogoff,
        shutdown: tokio::signal::windows::CtrlShutdown,
    }

    impl Signals {
        pub fn new() -> std::io::Result<Self> {
            use tokio::signal::windows::{ctrl_break, ctrl_c, ctrl_close, ctrl_logoff, ctrl_shutdown};

            Ok(Signals { interrupt: ctrl_c()?, pause: ctrl_break()?, close: ctrl_close()?, logoff: ctrl_logoff()?, shutdown: ctrl_shutdown()? })
        }

        pub async fn recv(&mut self) {
            tokio::select! {
                _ = self.interrupt.recv() => {}
                _ = self.pause.recv() => {}
                _ = self.close.recv() => {}
                _ = self.logoff.recv() => {}
                _ = self.shutdown.recv() => {}
            }
        }
    }

    /// Whether a process exists and has not exited.
    pub fn alive(pid: u32) -> bool {
        unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);

            if process.is_null() {
                // There, but not ours to look at.
                return GetLastError() == ERROR_ACCESS_DENIED;
            }

            let mut code = 0;
            let read = GetExitCodeProcess(process, &mut code);

            CloseHandle(process);

            read != 0 && code == STILL_ACTIVE as u32
        }
    }

    /// Stops this process's input and output from being inherited by a process it starts.
    /// A child on Windows inherits every handle marked inheritable, whatever it is given as
    /// its own input and output; a host that held the pipe a command writes its answer to
    /// would keep that pipe open, and whoever ran the command would wait for the host.
    fn keep_own_handles() {
        for which in [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE] {
            unsafe {
                let handle = GetStdHandle(which);

                if !handle.is_null() {
                    SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0);
                }
            }
        }
    }

    /// The host's own input and output are not for the browsers it starts: a browser that
    /// held the log, or a pipe to whoever started the host, would keep it open after the
    /// host had gone.
    pub fn before_serving() {
        keep_own_handles();
    }

    /// A console of its own that nobody sees, and a process group of its own: closing the
    /// terminal, or Ctrl+C in it, does not reach the host.
    pub fn detach(command: &mut std::process::Command) {
        keep_own_handles();
        command.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
    }

    /// Whether a host that was asked to stop has finished: its process has gone, and the
    /// pipe with it.
    pub fn gone(host: Option<u32>) -> bool {
        host.is_none_or(|pid| !alive(pid))
    }

    /// The pipe goes when the last handle to it does. There is nothing to remove.
    pub fn remove() {}
}

/// The pipe a helper process opens as a file to speak to the host (hotkey.rs).
#[cfg(windows)]
pub fn pipe_name() -> String {
    channel::place()
}

#[cfg(not(any(unix, windows)))]
compile_error!("The control channel is written for Unix sockets and for Windows named pipes.");
