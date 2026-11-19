# Handover: what to do next

Written on 11 November 2026, first at the end of the work on the Mac and then again the same day at the end of the Windows build on the PC, brought up to date on 12 November 2026 after the Scanline app was built on the Mac, again on 17 November 2026 after the app was built on the PC, and on 18 November 2026 after the smoke-testing work on the Mac (section 0), for whoever carries on: a person, or an agent in a new session on either machine. A new session has none of the earlier conversation, so everything it needs is here or in a file this names.

Read this first, then [DEPARTURES.md](DEPARTURES.md) (what was built and how it differs from the specification) and [BY-HAND.md](BY-HAND.md) (what only a person can check).

## Where things stand

- Everything is on `main` at github.com/photonstorm/scanline.
- It builds and runs on two machines: the Mac (Apple silicon, Chrome 157, Metal) and the PC (Windows 11, x64, an NVIDIA RTX 3080 Ti, Chrome 157, Direct3D).
- On the PC every group of the suite passed on 17 November 2026, on the Mac's later work and the game debugger: the type check, `test:wgsl` 10, `test:probe` 52, `test:bugs` 33, the Rust unit tests 50, `test:e2e` 58, `test:findings` 54, `test:webgpu` 28, `test:journeys` 2, `test:protocol` 27, `test:security` 17, `test:package` 5 and `test:app` 3, and the app's own unit tests (9). One test needed a change (a depth Direct3D reads one step up). Both slow-frame journeys passed with their timing comparison reported and not asserted: see "Things learned the hard way".
- On the Mac the whole suite passed on its last build, 12 and 13 November: `npm test` as one command, eleven groups with `test:app`, none failing (section 1, "What was run last"). The Mac's release archive (`dist/scanline-0.0.1-macos-arm64.tar.gz`) was rebuilt from it.
- **On the Mac the app has not been built since the Windows work of 17 November**, which changed code the Mac shares: section 1.
- Every milestone of the build plan up to 1.0 is worked through, and from the list for after 1.0: the Babylon.js and PlayCanvas adapters, the native-capture profile, assertions for a test run, a recording as a video, and "Send to agent".
- **Nothing has been compiled or run on Linux.**
- **The Scanline app is built on the Mac** ([app/](../app/README.md), designed in [APP.md](APP.md)): one window with the game in an embedded Chromium (CEF 156) and Scanline's panels (GPUI) beside it, the host kept as its own process. The host launches it as a session's browser with `display: "app"`. Stages 0 to 2 of the design and part of stage 3 are done: APP.md, section 12. `npm run test:app` drives it (skipped where it is not built). **It builds and runs on the PC too** since 17 November 2026, and `test:app` passes there; what is left on Windows is in section 2a.
- **Scanline for games** ([GAME.md](GAME.md)) was built on 13 November 2026, all six milestones: tabs, watches, audio, takes, notes, clips and engine watchables, each a command with the app's part. What differs from the plan is in DEPARTURES.md, "Scanline for games"; what needs a person, BY-HAND.md items 12 to 15. Their tests are in `tests/protocol.test.mjs`. Next for it: watches in flight recordings, takes and notes in one exported file, and a stepped frame advancing audio.
- **Smoke testing, replays across loading and films** were built on the Mac on 18 November 2026, at the owner's request, after Scanline was tried on one of his games (plain ES modules on raw WebGL 2, no engine): section 0. In short: a page is known to be ready and can be waited for (`launch --wait ready`, `scanline help loading`); a deterministic session now loads first and counts its frames from ready, so a run recorded on a page that loads assets replays exactly; `scanline smoke <url>` is a smoke test in one command; `step`, `policy` and `smoke` take pictures along the way as one labelled sheet (`shots`); and `scanline film` makes an MP4 by stepping, H.264 with the game's sound. `DEPARTURES.md`, "Smoke testing, replays and recordings for games", says what each is and why; `BY-HAND.md` items 23 to 29 what a person must check.
- **A WebGPU frame's GPU time was fixed on the Mac on 19 November 2026**: it is the time at least one pass was under way, not the passes added up, which read double or worse on Apple's GPU. Section 0a.
- The specification is not in this repository. It is in the `render-debugger/` folder of the `render-debugger-spec` branch of the `v3-gameblocks` repository, which is pushed. Read it there. Do not edit it and do not copy it here.

## How to work in this repository

These are the owner's standing instructions. They were given in conversation on the Mac, and a new session will not have heard them.

- **Commit and push to `main` without asking**, as each piece of work is finished and tested. Only a deployment needs the owner.
- **Carry on without stopping to ask.** Work through the list below. Decide the small things yourself, including overhead budgets.
- **What you cannot check yourself goes in `docs/BY-HAND.md`**, as a step for a person with what should happen. What differs from the specification goes in `docs/DEPARTURES.md`, with why.
- **Documentation is in plain British English.** The licence is the PolyForm Shield License 1.0.0 (`LICENSE.md`), chosen by the owner on 11 November 2026: do not change it, and do not call Scanline "open source", which that licence is not. `packages/scanline-hooks` alone is MIT.
- **Ask before fetching code from outside.** On the Mac, `npm install --save-dev playcanvas` and the Chrome for Testing download were both left for the owner. On a new machine the first `npm install` and `cargo build` download every dependency, which needs the owner's go-ahead there. (On the PC the owner gave it, for what the lock files name.)
- **Keep the owner's name, email and project names out of requests to outside services.**
- **A test run must not take over the machine.** Test only what you changed: see "Testing a change" below. One run at a time, at low priority.

### Testing a change

The owner's instruction, 18 November 2026. After the smoke-testing work a session ran every group of the suite. It took two hours and took over the Mac for most of them. That must not happen again.

- **After a change, run the tests of that feature and of what sits next to it, and nothing more.** A new command is tested by its own tests and those of the commands it is built from, not by the suite.
- **Never run the whole suite unless the owner asks for it.** That means `npm test`, every group in turn, and an evaluation round. The whole suite is for a release to the public, and the owner starts it or says to.
- **A change to something everything rests on** (the hook generator, stepping and the clock, the DevTools client, the store) still gets the nearest tests only. Say in your report that a full run is the owner's to start, and why it may be worth one.
- **Say what you ran and what you did not**, in the commit or the report, so nobody takes a narrow run for a full one.
- **Do not run a test again to chase a pass.** The tests that compare GPU time fail when another session shares the GPU. Say so and move on.

One test by name, which is the usual run:

```bash
node --test --test-concurrency=1 --test-timeout=120000 --test-name-pattern "smoke" tests/protocol.test.mjs
```

One group, when the change is wider than a few tests:

| What changed | Run |
|---|---|
| The WGSL reader | `npm run test:wgsl` (no browser) |
| A Rust crate, with nothing the browser sees | `cargo test -p <crate>` |
| The probe (`probe/src`) | The tests in `probe/test/probe.test.mjs` that name what changed, then the tests of the command that reads it |
| A command: stepping, input, screenshots, pixels, captures, patches, experiments, `emulate`, `trace`, runs | The tests in `tests/e2e.test.mjs` that name it |
| The page protocol, engine adapters, watches, audio, takes, notes, ready, `smoke`, contact sheets, films | The tests in `tests/protocol.test.mjs` that name it |
| What a capture volunteers, `lint`, a planted bug | The tests in `tests/findings.test.mjs` that name it; `npm run test:bugs` if a fixture in `fixtures/bugs` changed |
| The analysis of a WebGPU capture | The tests in `tests/webgpu.test.mjs` that name it |
| A capture as a file, the tiers | `npm run test:security` |
| The skills, help topics, the installer, the plugin files | `npm run test:package` |
| The app | `npm run test:app`, and `cargo test` in `app/` |
| The slow-frame journey | `npm run test:journeys`, on a machine nothing else is using |

Cheap enough to run every time: `npm run typecheck`, `cargo fmt`, and `cargo test -p` for the crate you touched.

Things learned the hard way:

- Build order: `npm run build` (the probe and the replay page), then `cargo build`. The binary holds both scripts, and the skills. If it seems stale after a script or a skill changes, touch `crates/scanline-core/build.rs` and build again.
- After editing `probe/tools/method-table.mjs`, run `npm run gen:hooks`. Never print `probe/src/hooks/generated.ts` with context: its lines are enormous.
- Do not rebuild the binary or the scripts while a test run or an evaluation round is using them.
- Run `cargo fmt` before committing. A tool's description in `crates/scanline-core/src/tools.rs` must stay under 420 characters (a unit test checks). A new help topic is also listed in `crates/scanline/src/cli.rs`.
- Tests give every file its own `SCANLINE_HOME`. By hand, set one yourself so that you do not disturb a host the owner is using.
- A fixture's canvas has `id="game"`, so `window.game` is the canvas until the page's script replaces it. Test for `window.game.frame`, not for `window.game`.
- `tests/host.mjs` is where the tests keep what differs between machines: the binary's name, whether a host is running for a home (`runtime.json`, since Windows has no socket file), `assertPixel` for a pixel that Metal and Direct3D round apart, and `windowsRule` for who a file or a pipe lets in.
- A page's WebGPU set-up is asynchronous and slow through Direct3D. A test that looks at a WebGPU page waits for the page to be ready; it does not sleep and hope.
- GPU time is not steady on the PC: its graphics card slows its clock when it has little to do, and the same frame can read several times higher a few seconds later. A test that compares GPU time before and after a change takes several readings of each, turn about, and compares the middle ones. One of each is a coin-toss there. Even so the slow-frame journey on WebGL cannot be relied on there, and says "GPU time was not steady on this machine, so it was not compared" where it would have asserted: look for that line in a run on the Mac, where it should not appear.

- A test that compares GPU time is at the mercy of whatever else is using the GPU. On 18 November `b14` (in `test:findings`) and both slow-frame journeys failed on the Mac while other sessions were at work on the same machine, and failed the same way with the release binary built before that day's changes: check a timing failure against an older binary before believing it. A fixture opened in a browser preview pane counts as something else using the GPU.
- Port 8765 may be taken by a server of the owner's own. A fixture server started by hand should take another port, and say which.
- The probe keeps 600 frames of frame times, counters and console frames. Anything that reports on a longer stretch of play reads them every 600 frames or fewer, as `smoke` does.
- A page's `onmessage` handler on any `MessagePort` is wrapped by the probe and held while the clock is frozen. A port of the probe's own must be added to `ownPorts` (`probe/src/natives.ts`) before its handler is set, or its messages are held with the page's and its handler counted as a timer's.

On the PC in particular:

- **The owner's npm configuration there has `os=linux`** (in their own `.npmrc`, for their own reasons: leave it). With it, `npm install` fetches the Linux builds of TypeScript and esbuild, and `npm run typecheck` fails. Install with:

```bash
npm ci --os=win32
```

- Low priority in PowerShell: `(Get-Process -Id $PID).PriorityClass = 'BelowNormal'` before `npm test`. A process started from one at that priority keeps it.
- An agent's shell tool there halves doubled backslashes in a here-document, and turns `\t` and `\b` into control characters. Edit any file that holds backslashes (Windows paths, regular expressions) with the editing tool, and look at what was written.
- Every text file is LF on every machine (`.gitattributes`). The install script for Windows is given CRLF when a release is packed, not in the repository.
- File names ignore case on Windows, as on most Macs: `Scanline.exe` and `scanline.exe` in one folder are one file, and so are `dist\Scanline-…zip` and `dist\scanline-…zip`. The app's command line is `scanline-cli.exe` for that reason, and the app's package is `Scanline-app-…`.
- Building the app: section 2a.

## 0. Smoke testing, replays and films: built on 18 November, and what they left

Built and tested on the Mac only. Each has a help topic (`loading`, `smoke`, `film`), a section in `DEPARTURES.md` and tests in `tests/protocol.test.mjs` (26 new ones, on `fixtures/protocol/loading.html`, `smoke.html` and `film.html`).

Left to do:

- **The app has not been compiled with the day's one change to it** (`app/src/channel.rs` and `host.rs`: the app finds the host's socket through `runtime.json` when the home's path is too long for one). The app's build needs cmake, which the shell this was written in did not have. It goes with section 1.
- **None of it has run on Windows.** In particular: `film` needs the platform's H.264 and AAC encoders through WebCodecs (Chrome on Windows has both; look at the first sound packet's time stamp, which decides how much of the start is dropped); a long `SCANLINE_HOME` is not a problem there (a pipe is named by a hash); `ready`, `smoke` and `shots` have nothing of the Mac's in them and should simply pass.
- **A person has not watched or heard a film**, nor posted one: `BY-HAND.md` items 27 to 29. The tests play it back with ffmpeg (pictures to the pixel, each beep within 30 ms of its frame, and 2 to 5 ms on a quiet machine), and ffmpeg takes anything.
- **A film of the page as composited is slow** (0.15 s a frame at a phone's size: about 7 minutes for 45 s), because the browser takes a picture after every frame and it comes through the debugging channel twice. Encoding in the hidden replay page from a screencast, or a capture of the tab as a media stream, might be quicker; neither was tried.
- **CSS animation is not on the virtual clock** (`document.timeline`), which now shows in two places: a film of the page, where CSS moves too fast, and a page whose loading waits on a CSS transition's end, which is real time and so not the same frame every run.
- **Sound from `<audio>` and `<video>` elements** is not stepped and not in a film.
- **What "ready" follows.** The guess does not follow what a worker loads, IndexedDB, or a WebSocket, and a page that goes on loading after it looks quiet does that work on counted frames. A page that calls `__scanline.loading()` and `ready()` is exact; the owner's games' shared shell is to be given those calls (in their repository, not this one).
- **A flight recording's contact sheet is still unlabelled.** The letters are there now (`scanline-image`, `contact_sheet`): it could use them.
- **`navigate` does not wait for ready** by itself; the next `step` does, in a session that holds loading.
- **Watches in flight recordings, takes and notes in one exported file** are still as GAME.md left them. "A stepped frame advancing audio" is built, for a film; outside a film a stepped game is still silent.

## 0a. GPU time of a WebGPU frame: fixed on 19 November, and what it left

Found while the owner's engine was being measured: `stats` read 25 ms of GPU time on a game holding a steady 60 frames a second. The passes of a frame overlap on Apple's GPU, and their times were being added up. `DEPARTURES.md`, "GPU time of a WebGPU frame", has the measurements and what changed (`shared/gpu-time.ts`, `probe/src/timing.ts`, `stats`, and with them `smoke`, `assert` and `experiment`).

Run on it: the new unit tests (`probe/test/gpu-time.test.mjs`, 9), the probe's own tests that name it, the type check and `cargo fmt`. The debug binary was rebuilt. Nothing wider was run, as "Testing a change" says.

Left to do:

- **The app has not been built or run with it**, and the app's Live panel reads the same figure. It goes with section 1.
- **Nothing of it has run on Windows.**
- **GPU time is still time that passed, not work done.** Apple's GPU slows when it has little to do, so the same frame reads 5 to 8 ms at the display's pace and 9 to 13 ms just after loading. Eight builds of one game measured after the fix swung two-fold between runs on a Mac in use. A budget in milliseconds is met or missed by the state the GPU is in. A load that holds the clock up, or a known draw timed beside the page's, would make it comparable; neither is built.
- **`step(fast: true)` measures one or two frames a call**, and they read anything. For GPU time, step without `fast`.
- **The slow-frame journey on WebGPU** still asserts on a pass's start-to-end time. `added` is what it should read where passes overlap. It was not changed.
- **A full run of the tests that compare GPU time** (`test:webgpu`, `test:findings`, the journeys) is the owner's to start, on a quiet machine: the figure they read has changed.

## 1. Back on the Mac: build the app again

**Do this first on the Mac.** The app was built on the PC on 17 November 2026 (section 2a), and that changed code the Mac shares, none of which has been compiled on a Mac since:

- **`app/Cargo.toml`**: GPUI without its default features, then `font-kit`, `wayland`, `x11` and `runtime_shaders` named, so that its Windows manifest is left out. Nothing else of the defaults should matter on a Mac; if text or the window looks different, look here first.
- **`app/build.rs`**, new: it does nothing off Windows.
- **`app/src/mac.rs`**: `from_cef` and `to_cef` (a view as CEF names one: a plain pointer on a Mac), and `desktop` and `local_stamp`, moved there from `to_desktop` in `player.rs` unchanged.
- **`app/src/player.rs`**: the shortcuts are bound to `secondary-…` where they were `cmd-…` (⌘ on a Mac, as before), and the text fields test `modifiers.secondary()`. ⌥⌫ is still a word back on a Mac.
- **`app/src/browser.rs`**: the key handler's system event is a type alias, `*mut u8` on a Mac as before.
- **`app/src/launcher.rs`**: the Mac's `run` is unchanged under `cfg(not(windows))`; the command line it starts is built in two steps.
- **`npm run app`** and **`npm run package:app`** are `node app/build.mjs`, which runs `app/bundle.sh` or `app/package.sh` on a Mac.
- **`crates/scanline-browser/src/lib.rs`**, `find_app`: the host no longer offers itself as the app when it is called `scanline` and "Scanline" beside it is itself.

So, on the Mac:

```bash
git pull
```

```bash
npm run app
```

```bash
npm run test:app
```

(the app's own group, not the whole suite: "Testing a change", above) and `cargo test` in `app/` (7 tests on a Mac; the PC runs two more, for the desktop and the stamp, which are Windows-only). Then open the app and try ⌘L, ⌘. and ⇧⌘C by hand: the bindings' spelling changed.

### What was run last

On the Mac on 18 November 2026, after the smoke-testing work (section 0), every group a group at a time at low priority, on the debug build: the type check, the Rust unit tests (55: `scanline` 9, `scanline-core` 26, `scanline-image` 8, the rest as before), `test:wgsl` (10), `test:probe` (52), `test:bugs` (33), `test:security` (18, and one Windows-only), `test:package` (5), `test:app` (3, on the app as built on 12 November) and `test:protocol` (50, of which 26 are new) all passed. Six tests that compare GPU time failed in that run, and nothing else did: "an experiment measures a change and takes it away again" in `test:e2e` (57 of 58), `b14` and `w14` in `test:findings` (52 of 54), "a WebGL frame is timed pass by pass" in `test:webgpu` (27 of 28) and both slow-frame journeys. Other sessions were using the same machine and its GPU throughout. Each was then run against the release binary built on 13 November, before any of the day's changes: the experiment, `b14` and both journeys failed there the same way, and the other two failed on some runs and passed on others with either binary (the pass-timing test: the old binary failed two runs of three, the new one of three). Earlier the same day, between the work on loading and the rest, `test:e2e` had passed 58 of 58 and `test:webgpu` 28 of 28. **Run those six again on a quiet machine before trusting either result**; the app's own unit tests were not run (the app was not rebuilt).

On the PC on 17 November 2026, on the Mac's later work and the game debugger (`f236671`), then on each commit after it: every group passed, a group at a time and not as one `npm test` (the suite was stopped by its first failure, which was a test's, and the rest run on from there): the type check, `test:wgsl` (10), `test:probe` (52), `test:bugs` (33), the Rust unit tests (50), `test:e2e` (58, one changed: a depth of 0.5 reads 0.5000001 through Direct3D), `test:findings` (54), `test:webgpu` (28), `test:journeys` (2, GPU time not steady, so not compared), `test:protocol` (27), `test:security` (17) and `test:package` (5); then `test:app` (3) on the app's debug and release builds, and the app's own unit tests (9). The Rust unit tests were run again after the host's one change (`find_app`).

On the Mac on 12 November 2026, after the magnifier and the fixes to regions and the canvas target: every group passed, `test:wgsl` to `test:webgpu` (`test:e2e` 57) in one `npm test`, and `test:journeys` to `test:app` run again after the slow-frame journey's timing comparison (held to its size only when the readings are steady, as the e2e one is) failed once while another page shared the GPU; and the app's unit tests (5).

On the Mac on 12 November 2026, after the app's new look, the capture view and `attachments`: every group passed, `test:e2e` (57) and `test:wgsl` to `test:e2e` in one `npm test`, and `test:findings` (54) to `test:app` in a second run once b14 took the clearest of three timing runs (it had failed once while another page shared the GPU); and the app's unit tests (5).

On the Mac on 12 November 2026, after quick captures, `emulate`, pointer lock in the app, sizes, sound and projects: `npm test` as one command passed, every group: the Rust unit tests (41), the type check, `test:wgsl` (10), `test:probe` (52), `test:bugs` (33), `test:e2e` (56), `test:findings` (54), `test:webgpu` (28), `test:journeys` (2), `test:protocol` (16), `test:security` (17, one of them Windows-only) and `test:package` (5), `test:app` (3); and the app's own unit tests (`cargo test` in app/, 5). Runs earlier the same day each failed one GPU timing comparison while another page shared the GPU; those now hold to the direction of a change, not its size, when the tool reports its readings unsteady.

On the Mac on 12 November 2026, after the Scanline app was built (which changed the host: `display`, who asked, `viewer` and `open_strip` in an app session, the app's exit watcher): `npm test` as one command passed on `20a2c45`, every group, `test:app` (3) and `test:security` (17, one of them Windows-only) included. On the last commits a second run passed every group except one timing comparison in `test:e2e` ("an experiment measures a change and takes it away again", on `fixtures/slow/webgpu.html`), whose readings were not steady; it passed twice when run again on its own, and the groups after it were run and passed.

On the Mac on 11 November 2026, on `86a2795`: `npm test` as one command passed. The Rust unit tests (41), the type check, `test:wgsl` (10), `test:probe` (52), `test:bugs` (33), `test:e2e` (52), `test:findings` (54), `test:webgpu` (28), `test:journeys` (2), `test:protocol` (16), `test:security` (15) and `test:package` (5). About seven minutes of tests.

On the PC before that, on 11 November 2026: every group passed, a group at a time, on `0e7a578`.

On the Mac, `npm install` cannot write to the usual npm cache from inside an agent's sandbox, and says the cache has root-owned files. Give it a cache it can write to: `npm install --cache "$TMPDIR/npm-cache"`.

## 2. What the Windows build left

It is described in `DEPARTURES.md` under "Windows". Not done:

- **A person has looked at nothing on the PC.** `BY-HAND.md`, "On Windows": the control strip, the viewer, a real F9 press, the host outliving its terminal, JSON in each shell, a release and its installer, the pinned browser's real download, a native debugger, and a second user of the PC.
- **Signing on Windows.** `tools/package.mjs` packs an unsigned `scanline.exe`. It needs the owner's certificate.
- **The installer for Windows has not been run.** `npm run package` was run on the PC: it writes `dist/scanline-0.0.1-windows-x64.zip` (6.1 MB on 11 November, 6.9 MB on 17 November), which unpacks to the binary, the seven skills, the plugin files and `install.ps1`, and the binary in it answers `--version`. `install.ps1` was checked for syntax and line endings and no further, because running it adds a folder to the owner's own `PATH`: it is in `BY-HAND.md`.
- **A host started inside a job dies with the job.** Some terminals and agent clients run a command in a job that kills everything the command started. The host is started in its own process group with its own hidden console, which survives a closed terminal, but not that. `CREATE_BREAKAWAY_FROM_JOB` would escape a job that allows it; it fails outright in one that does not, so it would need trying and falling back.
- **The journeys' timing is still not asserted on the PC.** `experiment` now measures turn about and says when its readings disagree (`DEPARTURES.md`, "Windows"), which is as much as timing a light frame on that card allows. What would make GPU time comparable there is a load that holds the card's clock up while a reading is taken, or a known draw timed beside the page's to measure the clock by. Neither is built.
- **The security of the Windows side has been tested and not reviewed.** `docs/SECURITY.md` says what it relies on.
- **An evaluation round through Direct3D** has not been run: every round so far was on the Mac.
- **Edge.** `find_browser` lists Edge's usual paths on Windows, and nothing has been run in it.

## 2a. The Scanline app on Windows: built, and what it left

Built and tested on the PC on 17 November 2026: `npm run app` (`app\bundle.ps1`) assembles `app\target\Scanline\`, `npm run test:app` passes on its debug and release builds, and `npm run package:app` (`app\package.ps1`) packs `dist\Scanline-app-0.0.1-windows-x64.zip` (190 MB). The window was checked through pictures of itself (`SCANLINE_APP_SNAPSHOTS`, now built on Windows) and its command file: Live, Captures with a capture's target and attachments, Resources, Experiments, the launcher starting a host, a capture file opened, a window closed ending its session. `DEPARTURES.md`, "The app on Windows", says what differs from the Mac and why; the README says how to build it. Left:

- **A person has looked only at the game area.** The owner's first look, on 17 November, found it black while the game ran: GPUI's DirectComposition layer was above Chromium's window. The app now has GPUI draw into the window instead (`DEPARTURES.md`, "The app on Windows"), and a copy of the screen showed the start page's ring in its place. The owner then saw games from several sites show in it. The rest is in `BY-HAND.md`, "The app on Windows" (items 16 to 22), then 1 to 15 with Ctrl for ⌘: first, that the game is sharp and stays in its place at every display scale.
- **Chromium's sandbox.** The helpers run without it on Windows. CEF 156 sandboxes there an application built as a DLL and started by its `bootstrap.exe`, not one that links `cef_sandbox.lib`, which its Windows distribution no longer has. The app would become `Scanline.dll` with the code in `main.rs` behind CEF's entry point, and `bootstrap.exe` renamed `Scanline.exe` beside it.
- **The pointer is hidden, not held**, for a game that takes it: a mouse-look game turns until the cursor meets the screen's edge. Moving the cursor back to the window's middle after each move, and keeping those moves from the page, would hold it.
- **No menu bar.** GPUI draws none on Windows. The shortcuts, the toolbar and the projects page do what the menus do; a window menu (Alt) could be added with Win32's own menus if it is missed.
- **An installer, signing and a `.scanline` file association.** The zip is unpacked by hand into `%LOCALAPPDATA%\Programs`, where the host finds the app.
- **The Mac has not built what this changed**: section 1.

On the PC, building the app:

- It needs Visual Studio's C++ tools (cmake and ninja come with them); `bundle.ps1` enters the developer shell itself. The PC has only the Windows 10 SDK (10.0.19041), so `bundle.ps1` defines `NTDDI_WIN10_FE` for CEF's wrapper. Installing the Windows 11 SDK would make that unnecessary; nothing else needs it.
- `bundle.ps1` builds the command line before it enters the developer shell, and gives the constant to the app's build only. Otherwise each change between `npm run app` and a plain `cargo build` rebuilt SQLite and zstd.
- Do not run `npm run app` while a test run is using `target\debug\scanline.exe`: it builds the command line too.
- To try the app by hand without disturbing a host the owner uses, give it a home of its own: `$env:SCANLINE_HOME` and `$env:SCANLINE_APP` set before `scanline launch <url> --display app`, and `$env:SCANLINE_APP_SNAPSHOTS` for pictures of the window.
- Those pictures (`PrintWindow`) leave out Chromium's window, so they cannot show whether the game is visible: that is how a black game area got past the tests. To see what a person sees, bring the window above the others for a moment without activating it (`SetWindowPos` with `HWND_TOPMOST` and `SWP_NOACTIVATE`) and copy that part of the screen (`Graphics.CopyFromScreen` in Windows PowerShell, after `SetProcessDPIAware`), then put it back (`HWND_NOTOPMOST`).

Noticed on the way, not about Windows: a live view's patch (`live_view(view: "wireframe")`) is listed by `patches` as having "matched no draws in the last frame" while it draws every one, in Chrome as in the app (`crates/scanline-core/src/patch.rs`).

## 3. The PlayCanvas adapter: built, and what it left

Built on the PC on 11 November 2026, once the owner had installed PlayCanvas (`probe/src/adapters/playcanvas.ts`, `fixtures/engines/playcanvas.html`, tests in `tests/protocol.test.mjs` and `probe/test/probe.test.mjs`). `DEPARTURES.md`, "The PlayCanvas adapter", says how it works and what it found wrong in Scanline's own capture, which is fixed. Left:

- It has been run against one small scene. A real PlayCanvas game, with post effects, particles, text, batching or Gaussian splats, has not been tried: launch one, capture, and read the "Replay check" line and the pass tree.
- Only version 2.24.0 has been tried. An older one is found by a second route and does not say which version it is.
- Integer textures replay on WebGL 2 now. On WebGL 1 they do not exist; on WebGPU they were always copied as they are.


## 4. A Firefox mode, and WebKit

Not started. Everything drives Chromium through its debugging protocol, so this is a second back end, not a switch. What depends on the protocol today: starting the browser and the pipe; putting the probe in before the page's first script, in every frame and worker; the binding the probe reports through; trusted keyboard, mouse and touch input; screenshots of the page; window bounds for the control strip; tracing; and intercepting the network for runs that replay.

- Firefox speaks WebDriver BiDi, which has a preload script, input actions and screenshots. It has no pipe: it needs a WebSocket client in the host.
- The probe is ordinary JavaScript but leans on Chrome in places: the format of error stacks (creation sites are read from them), `scheduler.postTask`, WebCodecs (the video), `WEBGL_debug_shaders`, and WebGPU's timestamp queries.
- Firefox ships WebGPU on Windows, so the PC is the right machine for this.
- Start with a spike, as the build plan did for Chromium: launch, inject, step one frame, read one pixel. Then decide how much of the host can sit behind one interface.

WebKit is further off: Safari's automation is narrower, and it would have to be done on the Mac.

## 5. Linux

Probably the nearest of the unbuilt platforms: the pipe launch is plain Unix, the control channel is the Unix one, and the browser paths, the pinned browser and process memory each have a Linux branch. None of it has been run. The hotkey helper has no Linux form, and the packaging has not been tried. WSL 2 on the PC may be enough to try it, if a GPU is visible there.

## 6. The rest of the list for after 1.0

- **WebXR.** An immersive session draws to the headset's framebuffer on the headset's clock. Needs a device or an emulator.
- **Single-window builds.** Built as the Scanline app, on the Mac and on Windows (section 2a).
- **Signed installers and updates.** Need the owner's signing identity on each platform, and somewhere for releases to live. `tools/package.mjs` has the macOS steps, never run, and nothing for Windows.

## 7. Smaller things not built

Each is described where it bites, in `scanline help limits` and in `DEPARTURES.md`.

- For a draw inside a WebGPU render bundle: the values in its uniform buffers, and a line of its own in `pixel_history`. (`draw` and `geometry` take one with `inside: n`.)
- The wireframe view on a running WebGPU page. A capture has it.
- Reading back, from a running page, a multisampled texture the page did not make with `TEXTURE_BINDING` usage, and stencil on WebGL. A capture reads both.
- More than one WebGPU device in one capture.
- The `half_resolution` experiment.
- External (video) textures in a WebGPU capture.
- The fast binary channel for bulk data. Images travel as compressed base64 over the protocol; spike S2 was never run.
- The engines the specification's content matrix lists and the repository lacks: a Unity WebGL build, an Emscripten build.
- What the GPU keeps alive and the page has let go of. A texture is now kept on record for as long as a view of it is. The same question for other pairs (a buffer or a sampler that only a bind group holds, a bind group the page dropped after its last use) has not been asked: the record of such an object ends when the collector takes the page's handle, though the GPU may hold the object longer.

## 8. The evaluation

- Four rounds have been run, all by hand with one sub-agent per bug, all on the Mac: 14 of 14 WebGL bugs in round 3, 15 of 15 WebGPU bugs in round 4 (`evals/results/README.md`).
- **Read round 4 with its caveat.** The WebGPU bugs and the findings that name their causes were written together, so it shows those causes are found, not how Scanline does on a mistake nobody planted.
- The runner (`evals/run.mjs`) has only been run with a stand-in for the agent. A real round spends the agent's tokens 29 times, so it is the owner's to start.
- Not covered: a bug that is right on one API and wrong on the other, large frames, engines. A round on the PC would be the first through Direct3D.
- The skills have never been in front of an agent: every round gave `scanline help` and nothing else.

## 9. For the owner

In `BY-HAND.md`, and not something an agent can do:

- Look at what nobody has seen on a screen: the control strip, the viewer, "Send to agent", pointer lock by a real click, a real F9 press from another application (made on the Mac, not yet on the PC), Xcode attaching to the native-capture profile, and PIX or RenderDoc doing the same on the PC.
- Decide: who holds the copyright, and whether contributors must sign anything (`BY-HAND.md`, "Yours to decide", which also records what is decided: the name, the licence, the plugin's author, where releases go, the version).
- Run or allow: the pinned Chrome for Testing download on the Mac (done on the PC), the Claude Code plugin's first install, and, once it has been seen to work, signing.
