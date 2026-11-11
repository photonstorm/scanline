# Handover: what to do next

Written on 11 November 2026, at the end of the work on the Mac, for whoever carries on: a person, or an agent in a new session on another machine. A new session has none of the earlier conversation, so everything it needs is here or in a file this names.

Read this first, then [DEPARTURES.md](DEPARTURES.md) (what was built and how it differs from the specification) and [BY-HAND.md](BY-HAND.md) (what only a person can check).

## Where things stand

- Everything is on `main` at github.com/photonstorm/scanline.
- The full suite passed on the last build: 259 tests in ten groups, none failing (`npm test`, about 13 minutes on the Mac).
- Every milestone of the build plan up to 1.0 is worked through, and from the list for after 1.0: the Babylon.js adapter, the native-capture profile, assertions for a test run, a recording as a video, and "Send to agent".
- It has only ever been built and run on macOS (Apple silicon, Chrome 157, Metal). **Nothing has been compiled or run on Windows or Linux.**
- The specification is not in this repository. It is in the `render-debugger/` folder of the `render-debugger-spec` branch of the `v3-gameblocks` repository, which is pushed. Read it there. Do not edit it and do not copy it here.

## How to work in this repository

These are the owner's standing instructions. They were given in conversation on the Mac, and a new session will not have heard them.

- **Commit and push to `main` without asking**, as each piece of work is finished and tested. Only a deployment needs the owner.
- **Carry on without stopping to ask.** Work through the list below. Decide the small things yourself, including overhead budgets.
- **What you cannot check yourself goes in `docs/BY-HAND.md`**, as a step for a person with what should happen. What differs from the specification goes in `docs/DEPARTURES.md`, with why.
- **Documentation is in plain British English.** No licence has been chosen: do not add one.
- **Ask before fetching code from outside.** On the Mac, `npm install --save-dev playcanvas` and the Chrome for Testing download were both left for the owner. On a new machine the first `npm install` and `cargo build` download every dependency, which needs the owner's go-ahead there.
- **Keep the owner's name, email and project names out of requests to outside services.**
- **A test run must not take over the machine.** Run the suite at low priority, one run at a time.

Things learned the hard way:

- Build order: `npm run build` (the probe and the replay page), then `cargo build`. The binary holds both scripts. If it seems stale after a script change, touch `crates/scanline-core/build.rs` and build again.
- After editing `probe/tools/method-table.mjs`, run `npm run gen:hooks`. Never print `probe/src/hooks/generated.ts` with context: its lines are enormous.
- Do not rebuild the binary or the scripts while a test run or an evaluation round is using them.
- Run `cargo fmt` before committing. A tool's description in `crates/scanline-core/src/tools.rs` must stay under 420 characters (a unit test checks). A new help topic is also listed in `crates/scanline/src/cli.rs`.
- Tests give every file its own `SCANLINE_HOME`. By hand, set one yourself so that you do not disturb a host the owner is using.
- A fixture's canvas has `id="game"`, so `window.game` is the canvas until the page's script replaces it. Test for `window.game.frame`, not for `window.game`.

## 1. The Windows build

This is the next piece of work, and the reason for the move to the PC. The specification asks for Windows 11 and macOS. The code was written with Windows in mind in places (paths, the default home, where Chrome lives) but the parts that touch the operating system are Unix-only, and each has a stub that says so.

### Setting the PC up

1. Git for Windows. This repository has a `.gitattributes` that keeps every text file at LF: the tests compare text line by line and the binary holds the skills and scripts as text.
2. Rust, stable, 1.90 or later (the Mac used 1.99.1), with the MSVC toolchain. The Visual Studio Build Tools with "Desktop development with C++" are needed: SQLite, zstd and BLAKE3 are compiled from C.
3. Node 24 or later (the Mac used 26.13).
4. Google Chrome, installed in the usual place, or `SCANLINE_BROWSER` set to a Chromium binary.
5. Clone this repository, and `v3-gameblocks` at `render-debugger-spec` beside it for the specification.
6. Then, in this repository:

```bash
npm install
```

```bash
npm run build
```

```bash
cargo build
```

Expect the first `cargo build` to fail or warn: this has never been compiled for Windows. Fix what it says before anything else.

### What is Unix-only, file by file

**`crates/scanline-browser/src/lib.rs`: starting the browser.** `spawn_with_pipe` has a Unix body and a stub for everything else. Chrome is driven over `--remote-debugging-pipe`. On Unix it reads commands on file descriptor 3 and writes replies on 4, which the Unix code arranges with `dup2` between fork and exec. On Windows there are no numbered descriptors to hand over from Rust, so:

- Make two anonymous pipes (`CreatePipe`). Mark the browser's two ends inheritable (`SetHandleInformation` with `HANDLE_FLAG_INHERIT`) and leave the host's two ends not inheritable.
- Pass the browser its ends by value: `--remote-debugging-io-pipes=<read handle>,<write handle>`, the two handles as unsigned integers, alongside `--remote-debugging-pipe`. This is from memory of Chromium's source (`content/browser/devtools/devtools_pipe_handler.cc`): check it against the Chrome on the PC before building on it.
- Rust's `Command` starts a child with handle inheritance on, so the two inheritable handles reach it. Close the host's copies of them after the spawn.
- Wrap the host's ends as files (`from_raw_handle`) and give them to `scanline_cdp::Client::new`, as the Unix code does. Anonymous pipes cannot do overlapped I/O; `tokio::fs::File` reads on a blocking thread, which is fine.
- Two browsers launched at the same moment could each inherit the other's handles. Hold a lock around the launch, or pass an explicit handle list.
- The messages are the same as on Unix: JSON, each ended by a zero byte.

`spikes/lib/cdp.mjs` is a second, independent client in Node that the lower-level tests use (`probe/test`, `tests/bugs.test.mjs`). It opens the pipe as `stdio[3]` and `stdio[4]`. Node passes extra descriptors to a child in the way Chrome on Windows understands, so it may work as it is. Run `npm run test:probe` early: if it passes, the browser side of the pipe is proven before any Rust is written.

`process_memory` in the same file returns nothing on Windows. `K32GetProcessMemoryInfo` gives a process's private bytes; say in the text what the figure is, as the macOS and Linux branches do.

`find_browser` already lists the usual Windows paths. Add the per-user install (`%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe`).

**`crates/scanline/src/control.rs`: the host and its clients.** The host listens on a Unix socket in its home directory, private to the user, and every other mode (`scanline <command>`, `scanline mcp`, the hotkey helper) connects to it. All of it is `#[cfg(unix)]`, with stubs that say "macOS only for now". For Windows:

- Use a named pipe (`tokio::net::windows::named_pipe`). Derive its name from the home directory (a hash of the path), so that each `SCANLINE_HOME` has its own: the tests run many homes.
- The Unix socket is private because of its file mode. A named pipe's default security lets other users of the machine read it, so create it with a security descriptor that names only the current user, and refuse remote clients. `docs/SECURITY.md` describes the boundary this has to keep.
- `first_pipe_instance(true)` tells a second host that one is already running, which is what the connect-first check does on Unix.
- `Link` holds the two halves of a `UnixStream`. Make it hold any reader and writer (`tokio::io::split`) so that one body serves both platforms.
- `running_host` asks whether a process is alive with `kill(pid, 0)`. On Windows: `OpenProcess` and `GetExitCodeProcess`.
- `start_host` detaches the host with `setsid` so that closing the terminal does not take it down. On Windows: `creation_flags` with `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP`.
- The host stops on SIGINT and SIGTERM. On Windows: `tokio::signal::ctrl_c` and `tokio::signal::windows` (`ctrl_break`, `ctrl_close`).
- The home directory is set to mode 700 and the socket to 600. Neither means anything on Windows. `%LOCALAPPDATA%\Scanline` (the default home there, already in `scanline_core::default_home`) is private to the user by inheritance; a `SCANLINE_HOME` somewhere else may not be, and the host should say so.
- `runtime.json` records the socket's path. Record the pipe's name there instead.

**`crates/scanline/src/http.rs`: MCP over loopback HTTP.** Only `bind` is Unix-only: it creates the token file with mode 600. Write the file without the mode on Windows. The rest is plain TCP.

**`crates/scanline/src/hotkey.rs`: the system-wide Debug key.** macOS only, through Carbon. On Windows: `RegisterHotKey` (with `MOD_NOREPEAT`) and a `GetMessageW` loop waiting for `WM_HOTKEY`; F1 to F24 are virtual keys `0x70` to `0x87`. Its `press` connects to the host with a Unix socket: on Windows open the named pipe as a file. Then remove the macOS-only condition in `hold_debug_key` (`crates/scanline-core/src/handoff.rs`) and in the test that is skipped off macOS (`tests/e2e.test.mjs`, "a Debug key held system-wide").

**`crates/scanline-browser/src/pinned.rs`: the pinned Chrome for Testing.** The platform table has `win64`. It unpacks with `ditto` on macOS and `unzip` elsewhere; Windows has no `unzip`, but has `tar`, which reads zip archives (`tar -xf`). `curl` is there on Windows 10 and later.

**`tools/package.mjs`: the release.** It names the archive for the platform and knows the binary is `scanline.exe`, but:

- It runs `npm` with `execFileSync`, which on Windows cannot start `npm.cmd` without a shell.
- It writes `install.sh`. Windows needs its own (a PowerShell script that copies `scanline.exe` somewhere under `%LOCALAPPDATA%` and adds that to the user's `PATH`), and a `.zip` is what a Windows user expects.
- Signing is written for macOS only. Signing on Windows needs the owner's certificate, as on the Mac.

**The native-capture profile** sets Metal's capture variables and its text names Xcode. On Windows the same switches apply and the debugger is RenderDoc or PIX. Lower priority: make the text say the right thing for the platform.

### What the tests will need

The suite was written against one machine. On the PC expect:

- **The binary's name.** Every test file runs `target/debug/scanline`. Windows usually finds `scanline.exe` from that, but check.
- **File modes.** `tests/security.test.mjs` checks that the token file is mode 600 and looks for `control.sock`. Those checks need a Windows form, not removal: the thing they protect still has to be true.
- **Exact pixel values.** Many tests compare pixels exactly, and were measured through Metal on an Apple GPU. Flat colours will match. Values that come from filtering, mipmaps or blending may differ by one through Direct3D on another GPU. Where one does, measure what the PC gives and allow for both; do not loosen a test that is checking a flat colour.
- **Timing thresholds.** The profile and experiment tests ask for a share of GPU time (the haze takes 80% or more; a flat colour takes the frame below 60%). They should hold on any GPU, but the margins were set on one.
- **Text that is about the Mac.** `profile` explains that a tile-based GPU shades only the last of several opaque draws, and `stats` quotes the step the browser rounds WebGPU timestamps to. Both are true of the Mac's GPU and browser; check what is true on the PC and make the text depend on what was measured.
- **Shader translations.** `resource` on a shader gives the browser's translation: Metal's language on the Mac, HLSL on Windows. One test already allows for both.
- **Extensions.** The live wireframe view on WebGL uses `WEBGL_polygon_mode`; the WebGL 1 depth replay uses `EXT_frag_depth`; the compressed-texture fixture uses S3TC and says so when it is missing. Check each is there through Direct3D.
- **Paths in output** use backslashes on Windows. A test that matches a path with `/` will need both.
- **Quoting on the command line.** Help shows JSON arguments in single quotes (`--events '[{"pointer": "down"}]'`), which `cmd` and PowerShell do not treat as the Mac's shell does. The tests are not affected (they pass arguments as a list), but the help text and the skills should show a form that works on Windows.
- **Output encoding.** Results contain characters outside ASCII (`«»`, `×`, `→`, `µ`). They are UTF-8. Check that they survive a Windows console and a pipe.

### A good order

1. Compile. Fix what the first build says.
2. `npm run test:wgsl` and `npm run test:probe`: no Rust involved, and they prove Node, the scripts and the browser on the PC.
3. The pipe launch in `scanline-browser`.
4. The control channel in `control.rs`. After this, `scanline launch` works and most of the suite can run.
5. `npm test`, group by group, fixing what is about the platform and noting what is about the GPU.
6. The hotkey, the pinned browser, the packaging.
7. Update what says "macOS only": the stubs' messages, `help limits` (`LIMITS` in `tools.rs`), `README.md`, the "Windows 11 and macOS" row and the milestone 8 table in `DEPARTURES.md`, "Not possible on this machine" in `BY-HAND.md`, and `docs/SECURITY.md` for the named pipe.
8. Back on the Mac, run the whole suite again: the shared code will have changed.

A person will need to check on the PC what a person checked on the Mac: the control strip, the viewer, a real F9 press. Add those to `BY-HAND.md` under Windows.

## 2. The PlayCanvas adapter

Blocked only on an install the owner has to run or allow:

```bash
npm install --save-dev playcanvas
```

Then:

- Write `probe/src/adapters/playcanvas.ts` on the pattern of `babylon.ts`, with the helpers in `wrap.ts`, and register it in `index.ts`. Read the installed version to find what to wrap: the frame, each render pass or layer, and each mesh instance's draw, with its material.
- PlayCanvas has a WebGL 2 device and a WebGPU one. Cover both, as the Babylon adapter does.
- Fixtures in `fixtures/engines/`, tests in `tests/protocol.test.mjs` beside Babylon's.
- Then take PlayCanvas out of the "not built" lists: `README.md`, `DEPARTURES.md` (the milestone 8 table), `BY-HAND.md`, `LIMITS` in `tools.rs`, and the skills.

## 3. A Firefox mode, and WebKit

Not started. Everything drives Chromium through its debugging protocol, so this is a second back end, not a switch. What depends on the protocol today: starting the browser and the pipe; putting the probe in before the page's first script, in every frame and worker; the binding the probe reports through; trusted keyboard, mouse and touch input; screenshots of the page; window bounds for the control strip; tracing; and intercepting the network for runs that replay.

- Firefox speaks WebDriver BiDi, which has a preload script, input actions and screenshots. It has no pipe: it needs a WebSocket client in the host.
- The probe is ordinary JavaScript but leans on Chrome in places: the format of error stacks (creation sites are read from them), `scheduler.postTask`, WebCodecs (the video), `WEBGL_debug_shaders`, and WebGPU's timestamp queries.
- Firefox ships WebGPU on Windows, so the PC is the right machine for this.
- Start with a spike, as the build plan did for Chromium: launch, inject, step one frame, read one pixel. Then decide how much of the host can sit behind one interface.

WebKit is further off: Safari's automation is narrower, and it would have to be done on the Mac.

## 4. Linux

Probably the nearest of the unbuilt platforms: the pipe launch is plain Unix, and the browser paths, the pinned browser and process memory each have a Linux branch. None of it has been run. The hotkey helper has no Linux form, and the packaging has not been tried. WSL 2 on the PC may be enough to try it, if a GPU is visible there.

## 5. The rest of the list for after 1.0

- **WebXR.** An immersive session draws to the headset's framebuffer on the headset's clock. Needs a device or an emulator.
- **Single-window builds.** The game runs in the browser's own window and the control strip in a second that follows it. One window holding both means a native shell around an embedded browser: a different application.
- **Signed installers and updates.** Need the owner's signing identity on each platform, and somewhere for releases to live. `tools/package.mjs` has the macOS steps, never run.

## 6. Smaller things not built

Each is described where it bites, in `scanline help limits` and in `DEPARTURES.md`.

- For draws inside a WebGPU render bundle: `geometry`, and which test turned one away. The bundle is one event.
- The wireframe view on a running WebGPU page. A capture has it.
- Reading back multisampled textures, and the stencil of a depth and stencil texture.
- More than one WebGPU device in one capture.
- The `half_resolution` experiment.
- A `writeBuffer` call's data in a capture's call list (it shows as `<Uint8Array data>`). An agent in round 4 wanted it.
- External (video) textures in a WebGPU capture.
- The fast binary channel for bulk data. Images travel as compressed base64 over the protocol; spike S2 was never run.
- The engines the specification's content matrix lists and the repository lacks: PlayCanvas, a Unity WebGL build, an Emscripten build.

## 7. The evaluation

- Four rounds have been run, all by hand with one sub-agent per bug: 14 of 14 WebGL bugs in round 3, 15 of 15 WebGPU bugs in round 4 (`evals/results/README.md`).
- **Read round 4 with its caveat.** The WebGPU bugs and the findings that name their causes were written together, so it shows those causes are found, not how Scanline does on a mistake nobody planted.
- The runner (`evals/run.mjs`) has only been run with a stand-in for the agent. A real round spends the agent's tokens 29 times, so it is the owner's to start.
- Not covered: a bug that is right on one API and wrong on the other, large frames, engines. A round on Windows would be the first through Direct3D.
- The skills have never been in front of an agent: every round gave `scanline help` and nothing else.

## 8. For the owner

In `BY-HAND.md`, and not something an agent can do:

- Look at what nobody has seen on a screen: the control strip, the viewer, "Send to agent", pointer lock by a real click, a real F9 press from another application, Xcode attaching to the native-capture profile.
- Decide: a licence, the name, who the plugin is by, where releases live, the version.
- Run or allow: the PlayCanvas install, the pinned Chrome for Testing download, the Claude Code plugin's first install, signing.
