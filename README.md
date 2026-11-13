# Scanline

A browser for debugging WebGL and WebGPU rendering, driven by an AI agent and shared with the person working beside it.

Scanline runs any page in a Chromium it launches and supervises, with instrumentation in place before the page's first line of script. An agent can then pause the page at a frame boundary, step it frame by frame, send it input, and read back exactly what the GPU drew. Every capability is a command; the command line and the MCP server are two front ends over the same commands.

## Status

Every milestone of the build plan up to 1.0 has been worked through on macOS (Apple silicon), and the result builds and passes its tests on Windows 11 (x64) as well. What each one's exit criteria asked for, and where this build falls short of them, is in [docs/DEPARTURES.md](docs/DEPARTURES.md). What only a person at the machine can confirm, and what needs the maintainer's own accounts (signing, a licence, a release host), is in [docs/BY-HAND.md](docs/BY-HAND.md). What to do next is in [docs/HANDOVER.md](docs/HANDOVER.md).

**Works**

- Launch a URL or local file in a supervised Chromium with a disposable profile.
- The probe is injected before page script in every frame and every kind of worker.
- Time: pause, step N frames, resume, time scale, run until a condition. One virtual clock behind frame timestamps, `performance.now`, `Date` and timers. Deterministic sessions with seeded random numbers and a fixed time step.
- Input: keyboard, mouse, wheel and touch as trusted events; held keys; events on exact frames.
- Looking: canvas readback for WebGL 1, WebGL 2 and WebGPU (screenshots, zoom with a pixel grid, exact pixel values); texture contents the same way, including float and integer formats; region statistics; image diff with a heat map.
- Inventory: every texture, buffer, shader, program, pipeline, framebuffer and bind group the page creates, with its size, the frame it was created in and the line of code that created it.
- One object in full: shader source, compile log and the browser's translation; program link log, attributes and every uniform's current value; buffer bytes; WebGPU descriptors.
- WebGL state: a mirror of the context's whole state, kept by watching every call, checked against the context on request.
- Memory: estimates by category; named snapshots and diffs grouped by creating line, which is how a leak is found.
- Timing: frame pacing, CPU time in frame callbacks, GPU time per frame and per pass, per-frame draw, instance, triangle and call counts.
- Frame capture, for WebGL 1, WebGL 2 and WebGPU: every call of a frame, the state and uniforms at each draw, and the contents of what the frame used, kept on disk after the page closes. Each capture is replayed at once on the same GPU and compared with the frame, pixel for pixel.
- Questions of a capture: the draw list (with a SQL filter), one draw in full and how many pixels it changed, what differs between two draws, the target as it stood after any draw, which draws changed a pixel and what was there before, and SQL over the whole capture.
- What a capture volunteers: draws that changed nothing, calls the browser rejected, a viewport that is not its target's size, a clear clipped by a scissor box left on, translucent draws in the wrong order or with blending off, a bound texture that cannot be sampled, and what the frame created and deleted. On WebGPU also: a texture sampled whose mip levels were never written, a pass that throws away (`storeOp: "discard"`) what a later draw samples, and translucent colours written unblended to an opaque canvas. For a draw that changed nothing, which test rejected it, found by replaying it with each test off in turn. For each uniform at a draw, the call that set it.
- Leaks and churn: many live objects from one line of code, or objects made and destroyed every frame, are flagged by `resources` and `memory`.
- Planted bugs: one scene, in WebGL 2 with fourteen known bugs and in WebGPU with fifteen (`fixtures/bugs/`), tests that pin down what Scanline says about each, and an evaluation in which agents diagnose them with nothing but Scanline (`evals/`).
- Analysis of a capture, for WebGL and WebGPU: the history of a pixel (every draw that covered it, and for one that changed nothing, what turned it away: a test, or its own shader discarding it); a draw's geometry (its vertex attributes, where its vertex shader puts the vertices, and how many triangles would be rasterised at all); two captures compared (events moved, added or removed, state that differs, the pictures' difference); a lint; what a shader could cost, read from its source; views by replay (overdraw, wireframe, which draw owns each pixel, the depth and stencil buffers, which mip level was sampled, NaN in a float target); and GPU time per draw, shader or pass. For a WebGPU draw, what each bind group holds by the names its shaders give them, with the values in its buffers.
- A browser trace for a window of frames: how long the GPU process was busy decoding and validating the page's commands, on which threads, doing what, with the whole trace kept for Perfetto.
- Memory that is measured: what the GPU process holds as the operating system counts it (its footprint on macOS, its private bytes on Windows), set beside the estimates, so a leak found by counting is confirmed by the process growing.
- Live patches, for WebGL and WebGPU: override state, edit a shader, leave draws out or draw only some, stand a checkerboard in for a texture, and (WebGL) hold a uniform, all in the running page and all undone at will. On WebGPU the pipeline is built again with the change and swapped in round each draw. Each patch says in words the change to make in source. An experiment measures the frame with and without a change and puts it back. A patch made with `keep` is made again after a reload and before a run is replayed, so a fix can be tried from the first frame.
- The slow-frame journey end to end, on WebGL 2 and on WebGPU: find the pass and the shader that cost the frame its time, confirm the cost is in filling pixels, read the shader, patch it live, compare the picture and the timing, and get the change to make in source (`tests/journeys.test.mjs`).
- The page protocol: a page can name its GPU objects and group its draws, declare the game objects they belong to, mark points on its timeline, offer its state (returned with every step), and register controls and debug views, through a global that exists only inside Scanline. `packages/scanline-hooks` wraps it; the `scanline-debuggable-rendering` skill says how to write a page this way.
- Engine adapters: with no change to the page, every draw on three.js (both renderers), PixiJS 8 (both renderers) and Phaser 4 resolves to the engine's own objects. On three.js that is the `Object3D`, with shadow passes and render targets as groups. PixiJS and Phaser batch, so a draw's object is its batch: which sprites went into it, and why it ended there.
- Working with a person: the agent asks them to play and press Debug (F9, which is held system-wide while they are asked, so it works whichever window has the keyboard) when the bug shows. The press freezes the page and captures the frame there and then, and the flight recorder has kept the frames before it (120 by default). A recording says which of its frames draw something different from the rest, gives a contact sheet of every frame, and any frame can be made a capture.
- Marking the frozen frame: after a Debug press the person can click the picture to point at something, drag a box, or type a note in the strip, and each reaches the agent as an event in canvas pixels.
- Capture when something happens: `capture(when)` runs the page until it raises an error, a frame runs long, the page marks an event or an expression becomes true, and captures that frame with the frames before it.
- A virtual gamepad, relative mouse moves under a pointer-lock shim, and policies: a function the agent writes that runs in the page once a frame and answers with the input to give.
- The control strip: a small window under the game's, in the same browser, that shows the person who is driving, what the agent asked of them, the frame number and whether frames are being recorded, with Debug, Pause and Step buttons.
- The viewer: a window for the person, in the same browser, with a log of every command the agent runs and what it answered, live graphs of frame time, GPU time, draws and memory, and a capture viewer (the draw list, each event's state and shaders, the target as it stood after any event, zoom and pixel values). It is a client of the same commands the agent has, and nothing in it is a capability the agent lacks. From it the person can send what they have chosen (an event, a pinned pixel, a note) to the agent, as an event with handles.
- A capture as one file: `export` writes a capture and everything it uses to one `.scanline` file, and `import` reads it into any host, where it answers the same questions and replays.
- Watches on the game's own objects: `watch` names a value or an object by expression (or the page registers one with `__scanline.watch`), and Scanline reads its numbers, booleans and strings as each frame ends, keeps 600 frames of them, and checks rules (finite, defined, range, type, changes, steady). A rule with `break` stops the game on the frame it broke. `watch_set` changes a value; captures carry the watches' values. The app shows them in Live → Objects, with each value editable in place. See [docs/GAME.md](docs/GAME.md).
- Audio: `audio` shows each Web Audio context with its output level in dBFS, the graph of nodes as the game built it (parameters, automation, connections), what is playing, every buffer with its decoded size and the file it came from, the audio and video elements, and findings (a suspended context, a node connected to nothing, a gain above 1 on the way out, clipping, a file decoded twice, a buffer of tens of megabytes). `audio_node` has one node and its level; `audio_patch` mutes, solos or bypasses a node or holds a parameter, to hear the difference. The app's Game panel shows it all, with meters and M, S and B switches on each node.
- Takes: named recordings of input. `take(action: "start")` records from that frame (the person's input or the agent's), `stop` keeps it in `<home>/takes`, and `play` loads the page again and plays it to the same frame, then pauses, captures or screenshots there. It can stop early at a frame, at a mark, or where a watch's breaking rule breaks. Where the page offers checkpoints, a take begun part way plays from the checkpoint it saved. A person can record one in the app (Game → Takes) and hand its name to the agent.
- Notes: in the app, Note (⇧⌘N) freezes the game and opens its frame to mark with a pen, arrows, boxes, rings and numbered pins in five colours, with a line of words. The agent receives a `note` event; `note(id)` gives the frame with and without the marks (the host draws them), the marks in canvas pixels, a capture, a take that reaches the frame again, and the watches and audio then. `notes` lists them.
- Tiers: the person decides what a client may do when the host starts. By default patching and `eval` work only on pages served from this machine, and `navigate` keeps to the origin a session was launched on. See [docs/SECURITY.md](docs/SECURITY.md).
- Skills: seven recipes (the core loop, wrong pixels, a slow frame, memory, working with a person, playing, and writing rendering code that can be debugged by name), held in the binary so they always match it: `scanline skill`, or `help(skill)` over MCP. A test checks that every command a skill names exists.
- A recording as a video: `recording(video: true)` writes the frames kept before a Debug press as a WebM file, for the person to watch or attach to a report.
- Assertions for a test run: `assert` holds the canvas to a baseline picture, a pixel to a colour, the console to "no errors" and a frame to budgets (draws, triangles, calls, GPU and CPU time), and exits 2 from a shell when anything fails. `scanline help testing` has the recipe.
- MCP over loopback HTTP (`scanline serve --http`), for a client that cannot spawn a process: bound to 127.0.0.1, with a token and `Host` and `Origin` checks.
- Engine adapters also cover Babylon.js (both engines) and PlayCanvas (both devices).
- A Claude Code plugin (`.claude-plugin/`): the MCP server and the skills, installed from this repository as a marketplace of one.
- A release archive: `npm run package` builds the one binary (the probe, the replay page and the skills are inside it) and packs it with an install script. `scanline browser install` fetches the pinned Chrome for Testing; `--dry-run` says what it would do.
- One owner of the input: when the agent takes control, the person's keys and mouse are kept out of the page; when the person has it, the agent may look but not act.
- Runs: in a deterministic session (seeded random numbers, a fixed time step, a clock that starts from zero) the input a page has received can be saved and played again from a reload, on the same frames. What the page fetched while it ran is kept too, and given again on the frames it first arrived on. A fingerprint of the frame every 30 frames is checked against the original, and the replay stops where they first differ. Stepping and replay can run without waiting for the display: two minutes of play replays in about six seconds.
- Console, uncaught errors and browser GPU warnings, each with its frame.
- The host survives the GPU process or the whole browser being killed, and says what happened.

**Not built**

- For WebGPU captures: external (video) textures; uniform values and a pixel-history line of its own for a draw inside a render bundle; more than one device in a capture.
- The wireframe view on a running WebGPU page (a capture has it). Readback from a running page of a multisampled texture the page cannot itself sample, and of stencil on WebGL (a capture has both).
- The fast binary channel for bulk data.
- Linux. A WebKit or Firefox mode. WebXR. A single window that holds both the game and the strip.
- Signed and notarised installers, and updates: these need the maintainer's Apple Developer identity, a code-signing certificate for Windows, and somewhere to publish releases. The packaging script has the steps and they have not been run.

It has been run on two machines, each with the installed Google Chrome 157: a Mac (Apple silicon, where the browser draws through Metal) and a PC (Windows 11, x64, an NVIDIA GPU, where it draws through Direct3D). Most runs were headless; sessions with a visible window have been checked by hand for the Debug key and the flight recorder, and the rest of what needs eyes is listed in [docs/BY-HAND.md](docs/BY-HAND.md).

## Requirements

- macOS on Apple silicon, or Windows 11 on x64
- Google Chrome, Microsoft Edge or Chromium (set `SCANLINE_BROWSER` to pick a binary)
- Rust 1.90 or later. On Windows, the MSVC toolchain and the Visual Studio Build Tools with "Desktop development with C++": SQLite, zstd and BLAKE3 are compiled from C
- Node.js 24 or later

## Build

```bash
npm install
```

```bash
npm run build
```

```bash
cargo build --release
```

The probe and the replay page are built first because the binary embeds them: a host and the scripts it injects are always the same version.

To make a release archive for this machine (the binary, the skills, the plugin files and an install script, in `dist/`: a `.tar.gz` with `install.sh`, or on Windows a `.zip` with `install.ps1`):

```bash
npm run package
```

To see which browser a launch would use, and what installing the pinned Chrome for Testing would do:

```bash
scanline browser
```

```bash
scanline browser install --dry-run
```

## Use it from a shell

```bash
scanline launch http://localhost:5173 --paused
```

```bash
scanline step 30 --screenshot 512
```

```bash
scanline pixels 640 600
```

```bash
scanline resources texture
```

```bash
scanline resource prg_1
```

```bash
scanline memory --snapshot before
```

```bash
scanline capture
```

```bash
scanline pixel_source cap_1 640 600
```

```bash
scanline draw cap_1 37
```

```bash
scanline query cap_1 "select program, count(*) from draws group by program"
```

```bash
scanline run_until --until '{"expr": "game.scene === \"level2\""}'
```

(In a Windows shell: `scanline run_until --until "{'expr': 'game.level === 2'}"`. See "On Windows" below.)

```bash
scanline watch game.player.body.velocity --break true
```

```bash
scanline watches --history 30
```

```bash
scanline audio playing
```

```bash
scanline take play door-glitch --then capture
```

```bash
scanline audio_patch anode_12 bypass
```

```bash
scanline request_human "Play until the water flickers, then press Debug"
```

```bash
scanline wait --request req_1
```

```bash
scanline recording rec_1
```

```bash
scanline viewer
```

```bash
scanline export cap_1 --path water-flicker.scanline
```

```bash
scanline import water-flicker.scanline
```

```bash
scanline stop
```

`scanline --help` lists every command and `scanline <command> --help` one command's arguments. `scanline help` explains the workflow, `scanline help capture` taking a frame apart, `scanline help input` the input events, and `scanline help security` what a client may do, and `scanline help limits` what is not built. `scanline skill` lists the skills and `scanline skill wrong-pixels` prints one. Add `--json` to any command for the whole result.

The first command starts a background host that holds the browsers; `scanline stop` ends it and closes them. Images and the host's log are kept under `~/Library/Application Support/Scanline`, or `%LOCALAPPDATA%\Scanline` on Windows (set `SCANLINE_HOME` to move them).

### On Windows

The commands are the same. Three things differ in a Windows shell:

- **JSON arguments.** `cmd` does not treat single quotes as quotes, and Windows PowerShell drops the double quotes inside them. Write JSON with single quotes inside double quotes, which every shell passes on whole and Scanline reads as JSON: `scanline patch_draws --filter "{'draws': [6, 8]}"`. `scanline <command> --help` shows its example this way on Windows.
- **Characters outside ASCII.** Scanline writes UTF-8 (`« »` round text from the page, `×`, `µ`, `→`). A console shows it rightly, and so does a pipe to a program that reads bytes. PowerShell decodes what it captures or pipes with the console's code page, so either run `[Console]::OutputEncoding = [Text.Encoding]::UTF8` once in a session before piping Scanline's output into another command, or ask Scanline for ASCII: `--ascii` on a command, or `SCANLINE_ASCII=1` in the environment for all of them. It then writes `<<` and `>>` round text from the page, `x`, `us` and `->`, and with `--json` it writes every other character as a `\u` escape, which loses nothing.
- **The host's lifetime.** The first command starts the host in the background, and it outlives the terminal. A terminal or agent client that kills everything it started when a command ends takes the host with it; run `scanline serve` in a window of its own to keep one.

## Use it in a test run

```bash
scanline launch http://localhost:5173 --headless --paused --deterministic
```

```bash
scanline step 120
```

```bash
scanline assert --baseline tests/baselines/title.png --no_errors --max_draws 200
```

```bash
scanline stop
```

The first run, with `--update` added to `assert`, saves the baseline. After that `assert` exits 0 when everything holds and 2 when anything fails, with a picture of where the canvas differs. `scanline help testing` says more.

## Use it from an agent

The binary is also an MCP server: `scanline mcp`, on stdio. The tools are the same commands with a `gfx_` prefix: `gfx_launch`, `gfx_step`, `gfx_pixels` and so on. `gfx_help` returns the workflow and the skills, and matches the binary exactly.

`scanline mcp --lean` (or `SCANLINE_MCP=lean`, which `serve --http` honours too) offers two tools in their place: `gfx(command, args)` runs any command, and `gfx_help(command)` gives a command's parameters when they are wanted, from the same schemas. An agent then pays about 430 tokens for the tools where the full set costs some 20,100, and one more call the first time it needs a command's parameters. A misspelt command is answered with the nearest one.

**Claude Code.** This repository is a plugin and a marketplace of one. With `scanline` on your `PATH`:

```bash
claude plugin marketplace add photonstorm/scanline
```

```bash
claude plugin install scanline@scanline
```

That registers the MCP server and installs the seven skills. To try the plugin from a checkout without installing it:

```bash
claude --plugin-dir .
```

**What each way costs an agent.** Measured on 13 November 2026: over MCP the 77 tools' definitions are about 20,100 tokens (72,200 characters), sent with every request unless the client defers them (Claude Code's tool search does, listing names alone until a tool is wanted). The command line costs nothing until it is used: `scanline help` is about 1,400 tokens, `scanline help <command>` far less, and a skill (`scanline skill <name>`) is read only when its kind of job comes up. `scanline mcp --lean` brings MCP down to about 640 tokens with its instructions. For an agent that can run a shell, the command line and the skills are the cheapest way in; for one that cannot, lean MCP, unless its client defers tools as Claude Code does.

**Any other agent.** Register a stdio MCP server whose command is `scanline` with the argument `mcp`, and write the skills where the agent loads them from:

```bash
scanline skill --to ~/.claude/skills
```

To limit what the agent may do, set `SCANLINE_DENY` or `SCANLINE_ALLOW` in the server's environment, with no host already running: see [docs/SECURITY.md](docs/SECURITY.md).

## Layout

| Path | What |
|---|---|
| `crates/scanline-cdp` | DevTools Protocol client over `--remote-debugging-pipe` |
| `crates/scanline-browser` | Finds, launches and supervises the browser |
| `crates/scanline-core` | Sessions, probe injection, the commands (the control API) |
| `crates/scanline-image` | Crop, nearest-neighbour zoom with a grid, downscale, statistics, diff, PNG |
| `crates/scanline-store` | Captures on disk: content-addressed blobs and a SQLite database per capture |
| `crates/scanline-mcp` | The MCP front end |
| `crates/scanline` | The binary: host, command line, MCP relay |
| `probe/` | The script injected into every page and worker (TypeScript, built to one file) |
| `probe/tools/` | The generator that writes the WebGL and WebGPU hook wrappers from the published interface definitions |
| `replay/` | The replay page: runs a capture again in a hidden page of the same browser |
| `fixtures/` | Test pages: a known scene on each API and engine, a scene with planted bugs on each API, a slow frame, a page that uses the page protocol, awkward scenes for each engine adapter, and the spike pages |
| `packages/scanline-hooks` | The page protocol as a package a page can import: it does nothing outside Scanline |
| `evals/` | The agent evaluation: each planted bug's expected diagnosis, the prompt, the scorer and each round's results |
| `spikes/` | The experiments the build plan asked for before milestone 1, and the Node launcher they share |
| `docs/` | Spike results, where the build departs from the specification, the security review, and what is left to try by hand |
| `skills/` | Skills that teach an agent to use Scanline. The binary holds a copy of each |
| `.claude-plugin/` | The Claude Code plugin and its marketplace entry |
| `tools/` | The script that builds and packs a release |
| `tests/` | End-to-end tests of the built binary |

## Tests

```bash
npm test
```

That builds the probe and the replay page, checks their types, runs the WGSL reader's tests and the probe's browser tests (about a minute), the planted-bug checks, the Rust unit tests, the end-to-end tests of the binary, the tests of what Scanline says about each planted bug, the analysis of a WebGPU capture, the slow-frame journey, the page protocol and engine adapters, captures as files and the tiers, and the skills, browser installer and plugin files (about 10 to 60 s each). The browser tests launch headless Chromium with throwaway profiles. The parts can be run alone: `npm run test:wgsl`, `npm run test:probe`, `npm run test:bugs`, `cargo test`, `npm run test:e2e`, `npm run test:findings`, `npm run test:webgpu`, `npm run test:journeys`, `npm run test:protocol`, `npm run test:security`, `npm run test:package`.

After changing `probe/tools/method-table.mjs`, run `npm run gen:hooks`. `node spikes/s5-replay.mjs` checks that captured frames replay to identical images, `node spikes/s9-overhead.mjs` measures what the hooks cost per call, and `node spikes/m2-verify.mjs` checks the WebGL state mirror against the context after 1,000 frames on every WebGL page.

## Licence

Scanline is source-available under the [PolyForm Shield License 1.0.0](LICENSE.md). In short, and the licence's own words are what count:

- You may use it for anything, at work included: debugging a game you sell is fine.
- You may read it, change it, and pass it and your changes on, with the licence and its notice.
- You may not provide a product that competes with Scanline, whether you charge for it or not. That covers packaging Scanline, or something made from it, into a product of your own.

The Scanline app's icons are 45 from Streamline's Core Line – Free set (https://streamlinehq.com), under the Creative Commons Attribution 4.0 licence; [app/resources/icons/LICENSE.md](app/resources/icons/LICENSE.md) lists them, and the app carries the notice.

One part is under the MIT licence instead: `packages/scanline-hooks`, the small package a page imports to describe its own drawing, so that it asks nothing of the game it goes into.

If you want to do what the licence does not allow, ask the author for a licence that does. It is not an open-source licence as the Open Source Initiative defines one, because it restricts that one use.

## The specification

Scanline is built from a specification and build plan written before any code: a product requirements document, an architecture, the inspection techniques for each API, the agent interface, a page protocol, and a milestone plan with ten experiments to run first. Four of the ten have been run; [docs/spikes/RESULTS.md](docs/spikes/RESULTS.md) has what they found, and [docs/DEPARTURES.md](docs/DEPARTURES.md) lists where the code differs from the specification and why.
