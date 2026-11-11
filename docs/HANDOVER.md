# Handover: what to do next

Written on 11 November 2026, first at the end of the work on the Mac and then again the same day at the end of the Windows build on the PC, for whoever carries on: a person, or an agent in a new session on either machine. A new session has none of the earlier conversation, so everything it needs is here or in a file this names.

Read this first, then [DEPARTURES.md](DEPARTURES.md) (what was built and how it differs from the specification) and [BY-HAND.md](BY-HAND.md) (what only a person can check).

## Where things stand

- Everything is on `main` at github.com/photonstorm/scanline.
- It builds and runs on two machines: the Mac (Apple silicon, Chrome 157, Metal) and the PC (Windows 11, x64, an NVIDIA RTX 3080 Ti, Chrome 157, Direct3D).
- On the PC every group of the suite passed on the last build: 265 tests in ten groups and 40 Rust unit tests, none failing. They were run a group at a time, some before the last push and the rest straight after it, and not as one `npm test`. Both slow-frame journeys passed with their timing comparison reported and not asserted: see "Things learned the hard way".
- **On the Mac the suite has not been run since the Windows build**, and the shared code changed: see section 1.
- Every milestone of the build plan up to 1.0 is worked through, and from the list for after 1.0: the Babylon.js and PlayCanvas adapters, the native-capture profile, assertions for a test run, a recording as a video, and "Send to agent".
- **Nothing has been compiled or run on Linux.**
- The specification is not in this repository. It is in the `render-debugger/` folder of the `render-debugger-spec` branch of the `v3-gameblocks` repository, which is pushed. Read it there. Do not edit it and do not copy it here.

## How to work in this repository

These are the owner's standing instructions. They were given in conversation on the Mac, and a new session will not have heard them.

- **Commit and push to `main` without asking**, as each piece of work is finished and tested. Only a deployment needs the owner.
- **Carry on without stopping to ask.** Work through the list below. Decide the small things yourself, including overhead budgets.
- **What you cannot check yourself goes in `docs/BY-HAND.md`**, as a step for a person with what should happen. What differs from the specification goes in `docs/DEPARTURES.md`, with why.
- **Documentation is in plain British English.** No licence has been chosen: do not add one.
- **Ask before fetching code from outside.** On the Mac, `npm install --save-dev playcanvas` and the Chrome for Testing download were both left for the owner. On a new machine the first `npm install` and `cargo build` download every dependency, which needs the owner's go-ahead there. (On the PC the owner gave it, for what the lock files name.)
- **Keep the owner's name, email and project names out of requests to outside services.**
- **A test run must not take over the machine.** Run the suite at low priority, one run at a time.

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

On the PC in particular:

- **The owner's npm configuration there has `os=linux`** (in their own `.npmrc`, for their own reasons: leave it). With it, `npm install` fetches the Linux builds of TypeScript and esbuild, and `npm run typecheck` fails. Install with:

```bash
npm ci --os=win32
```

- Low priority in PowerShell: `(Get-Process -Id $PID).PriorityClass = 'BelowNormal'` before `npm test`. A process started from one at that priority keeps it.
- An agent's shell tool there halves doubled backslashes in a here-document, and turns `\t` and `\b` into control characters. Edit any file that holds backslashes (Windows paths, regular expressions) with the editing tool, and look at what was written.
- Every text file is LF on every machine (`.gitattributes`). The install script for Windows is given CRLF when a release is packed, not in the repository.

## 1. Back on the Mac: run the whole suite

**Do this first.** Two things make it due.

The last two pieces of work on the PC (`experiment` measuring turn about, and the PlayCanvas adapter with the three fixes to capture it turned up: mapped buffers on WebGPU, the texture unit a texture is read through on WebGL, integer textures in the WebGL 2 replay) have been run on the PC only. Those fixes are in the probe and the replay page, which every group uses. On the Mac, PlayCanvas arrives with `npm install` (it is in `package.json` now).

And the Windows build changed code both platforms share, none of which has been run on the Mac at all:

- `crates/scanline/src/control.rs` was rewritten round a `channel` module with a Unix form and a Windows form. The Unix form is the old code moved, but it has only been read, not run.
- `crates/scanline/src/http.rs` (`bind` and `new_token`), `crates/scanline/src/hotkey.rs` (its usage text became a constant) and `crates/scanline-browser/src/lib.rs` (`process_memory_measure`) have small changes on the Unix side.
- The probe changed in four places that are not about Windows: a WebGPU pass whose two timestamps are equal now counts as zero and not as missing (`probe/src/timing.ts`); `status` says how far the page has got towards WebGPU (`webgpuStarting` in `probe/src/contexts.ts`); a texture view's record keeps its texture's handle (`probe/src/gpu/tracker.ts`); and `step` and `run_until` wait for the WebGPU queue before they answer (`gpuWorkDone` in `probe/src/timing.ts`), which adds a little to every step of a WebGPU page.
- `launch` waits differently (`crates/scanline-core/src/commands.rs`): only a WebGL or WebGPU context ends the wait early, where any context did, and a page that has asked for a WebGPU adapter is waited on for up to 4 s. On the Mac this should cost nothing for a page that draws, and a page with only a 2D canvas now takes the full 1.2 s to launch.
- `experiment` measures three times each way, turn about (`crates/scanline-core/src/patch.rs`), so it steps more frames for small counts: 20 asked for is 30 each way.
- The command line reads `"{'draws': [6, 8]}"` as JSON (`value` in `crates/scanline/src/cli.rs`).
- The tests take either of two values where Metal and Direct3D round apart. The values for Metal are the ones the tests had; check none was mistyped.
- The slow-frame journeys take seven GPU readings where they took three (`turnAbout` in `tests/journeys.test.mjs`), so they run longer.

So, on the Mac:

```bash
git pull
```

```bash
npm install
```

```bash
npm test
```

Expect it to pass. If `stats` on a WebGPU page now reports a lower GPU time than before, that is the timing change, and it is the truer figure: `DEPARTURES.md`, "Windows", says why.

If a group fails on the Mac, the likeliest places are the ones nobody has run there: the Unix half of `control.rs`, the PlayCanvas tests (the adapter's tests name passes and count events as the PC drew them), and the tests that now take either of two pixel values.

### What was run last

On the PC on 11 November 2026, on the build that was pushed last, every group passed: the Rust unit tests (40), the type check, `test:wgsl` (10), `test:probe` (52, PlayCanvas among the engines), `test:bugs` (33), `test:e2e` (51), `test:findings` (54), `test:webgpu` (27), `test:journeys` (2), `test:protocol` (16, PlayCanvas on both devices), `test:security` (15) and `test:package` (5). The probe, protocol and package groups were run before the push and the rest after it, each on its own; `npm test` as one command has not been run since the PlayCanvas adapter.

On the Mac nothing has been run since before the Windows build.

## 2. What the Windows build left

It is described in `DEPARTURES.md` under "Windows". Not done:

- **A person has looked at nothing on the PC.** `BY-HAND.md`, "On Windows": the control strip, the viewer, a real F9 press, the host outliving its terminal, JSON in each shell, a release and its installer, the pinned browser's real download, a native debugger, and a second user of the PC.
- **Signing on Windows.** `tools/package.mjs` packs an unsigned `scanline.exe`. It needs the owner's certificate.
- **The installer for Windows has not been run.** `npm run package` was run on the PC: it writes `dist/scanline-0.0.1-windows-x64.zip` (6.1 MB), which unpacks to the binary, the seven skills, the plugin files and `install.ps1`, and the binary in it answers `--version`. `install.ps1` was checked for syntax and line endings and no further, because running it adds a folder to the owner's own `PATH`: it is in `BY-HAND.md`.
- **A host started inside a job dies with the job.** Some terminals and agent clients run a command in a job that kills everything the command started. The host is started in its own process group with its own hidden console, which survives a closed terminal, but not that. `CREATE_BREAKAWAY_FROM_JOB` would escape a job that allows it; it fails outright in one that does not, so it would need trying and falling back.
- **PowerShell garbles `« » µ →` in output it captures or pipes**, on a PC whose console code page is not UTF-8. The README says what to type. An option to print ASCII only (`<<` and `>>`, `x`, `us`, `->`) would spare an agent that drives the command line through PowerShell; MCP is not affected.
- **The journeys' timing is still not asserted on the PC.** `experiment` now measures turn about and says when its readings disagree (`DEPARTURES.md`, "Windows"), which is as much as timing a light frame on that card allows. What would make GPU time comparable there is a load that holds the card's clock up while a reading is taken, or a known draw timed beside the page's to measure the clock by. Neither is built.
- **The security of the Windows side has been tested and not reviewed.** `docs/SECURITY.md` says what it relies on.
- **An evaluation round through Direct3D** has not been run: every round so far was on the Mac.
- **Edge.** `find_browser` lists Edge's usual paths on Windows, and nothing has been run in it.

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
- **Single-window builds.** The game runs in the browser's own window and the control strip in a second that follows it. One window holding both means a native shell around an embedded browser: a different application.
- **Signed installers and updates.** Need the owner's signing identity on each platform, and somewhere for releases to live. `tools/package.mjs` has the macOS steps, never run, and nothing for Windows.

## 7. Smaller things not built

Each is described where it bites, in `scanline help limits` and in `DEPARTURES.md`.

- For draws inside a WebGPU render bundle: `geometry`, and which test turned one away. The bundle is one event.
- The wireframe view on a running WebGPU page. A capture has it.
- Reading back multisampled textures, and the stencil of a depth and stencil texture.
- More than one WebGPU device in one capture.
- The `half_resolution` experiment.
- A `writeBuffer` call's data in a capture's call list (it shows as `<Uint8Array data>`). An agent in round 4 wanted it.
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
- Decide: a licence. (The name is Scanline, the plugin is by the owner, releases go on GitHub Releases, and the version is 1.0 at release: `BY-HAND.md`, "Yours to decide".)
- Run or allow: the pinned Chrome for Testing download on the Mac (done on the PC), the Claude Code plugin's first install, and, once it has been seen to work, signing.
