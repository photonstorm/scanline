# Scanline

A browser for debugging WebGL and WebGPU rendering, driven by an AI agent and shared with the person working beside it.

Scanline runs any page in a Chromium it launches and supervises, with instrumentation in place before the page's first line of script. An agent can then pause the page at a frame boundary, step it frame by frame, send it input, and read back exactly what the GPU drew. Every capability is a command; the command line and the MCP server are two front ends over the same commands.

"Scanline" is a working name.

## Status

Early. The first three milestones of the build plan ("eyes and hands", "inventory" and "capture") work on macOS.

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
- Timing: frame pacing, CPU time in frame callbacks, GPU time per frame (WebGL) and per pass (WebGPU), per-frame draw, instance, triangle and call counts.
- Frame capture, for WebGL 1, WebGL 2 and WebGPU: every call of a frame, the state and uniforms at each draw, and the contents of what the frame used, kept on disk after the page closes. Each capture is replayed at once on the same GPU and compared with the frame, pixel for pixel.
- Questions of a capture: the draw list (with a SQL filter), one draw in full and how many pixels it changed, what differs between two draws, the target as it stood after any draw, which draws changed a pixel and what was there before, and SQL over the whole capture.
- What a capture volunteers: draws that changed nothing, calls the browser rejected, a viewport that is not its target's size, a clear clipped by a scissor box left on, translucent draws in the wrong order or with blending off, a bound texture that cannot be sampled, and what the frame created and deleted. For a draw that changed nothing, which test rejected it, found by replaying it with each test off in turn. For each uniform at a draw, the call that set it.
- Leaks and churn: many live objects from one line of code, or objects made and destroyed every frame, are flagged by `resources` and `memory`.
- Planted bugs: one scene with twelve known bugs (`fixtures/bugs/`), tests that pin down what Scanline says about each, and an evaluation in which agents diagnose them with nothing but Scanline (`evals/`).
- Console, uncaught errors and browser GPU warnings, each with its frame.
- The host survives the GPU process or the whole browser being killed, and says what happened.

**Not built yet**

- For WebGPU captures: which test rejected a draw, uniform values by name (WGSL reflection), render bundles built before the frame, external textures.
- A runner that starts the evaluation's agents by itself (the bugs, prompts and scorer exist: see `evals/`).
- Full pixel history (rejected fragments, pixel by pixel), overdraw and other views, per-draw GPU time.
- Live patching of shaders, uniforms and state.
- The window: control strip, Debug button and hotkey, capture viewer. Hand-off to a person, the flight recorder, input replay.
- The browser's real GPU memory. WGSL reflection. Readback of compressed, depth and multisampled textures.
- The fast binary channel for bulk data. Windows. Installers. A pinned browser download.

It has been run only on macOS (Apple silicon) with the installed Google Chrome 157. Most runs were headless; a session with a visible window has been checked by hand once. Pointer lock and fullscreen are unverified.

## Requirements

- macOS on Apple silicon
- Google Chrome, Microsoft Edge or Chromium (set `SCANLINE_BROWSER` to pick a binary)
- Rust 1.90 or later
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

```bash
scanline stop
```

`scanline --help` lists every command and `scanline <command> --help` one command's arguments. `scanline help` explains the workflow, `scanline help capture` taking a frame apart, `scanline help input` the input events, and `scanline help limits` what is not built. Add `--json` to any command for the whole result.

The first command starts a background host that holds the browsers; `scanline stop` ends it and closes them. Images and the host's log are kept under `~/Library/Application Support/Scanline` (set `SCANLINE_HOME` to move them).

## Use it from an agent

Register the MCP server with an agent client. For Claude Code, in `.mcp.json`:

```json
{
  "mcpServers": {
    "scanline": {
      "command": "/absolute/path/to/scanline/target/release/scanline",
      "args": ["mcp"]
    }
  }
}
```

The tools are the same commands with a `gfx_` prefix: `gfx_launch`, `gfx_step`, `gfx_pixels` and so on. `gfx_help` returns the workflow, and matches the binary exactly. A skill for agents is in [skills/scanline](skills/scanline/SKILL.md).

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
| `fixtures/` | Test pages: a known scene on each API and engine, a scene with twelve planted bugs, and the spike pages |
| `evals/` | The agent evaluation: each planted bug's expected diagnosis, the prompt, the scorer and each round's results |
| `spikes/` | The experiments the build plan asked for before milestone 1, and the Node launcher they share |
| `docs/` | Spike results, and where the build departs from the specification |
| `skills/` | Skills that teach an agent to use Scanline |
| `tests/` | End-to-end tests of the built binary |

## Tests

```bash
npm test
```

That builds the probe and the replay page, checks their types, runs the probe's browser tests (about a minute), the planted-bug checks, the Rust unit tests, the end-to-end tests of the binary and the tests of what Scanline says about each planted bug (about 15 s each). The browser tests launch headless Chromium with throwaway profiles. The parts can be run alone: `npm run test:probe`, `npm run test:bugs`, `cargo test`, `npm run test:e2e`, `npm run test:findings`.

After changing `probe/tools/method-table.mjs`, run `npm run gen:hooks`. `node spikes/s5-replay.mjs` checks that captured frames replay to identical images, `node spikes/s9-overhead.mjs` measures what the hooks cost per call, and `node spikes/m2-verify.mjs` checks the WebGL state mirror against the context after 1,000 frames on every WebGL page.

## The specification

Scanline is built from a specification and build plan written before any code: a product requirements document, an architecture, the inspection techniques for each API, the agent interface, a page protocol, and a milestone plan with ten experiments to run first. Four of the ten have been run; [docs/spikes/RESULTS.md](docs/spikes/RESULTS.md) has what they found, and [docs/DEPARTURES.md](docs/DEPARTURES.md) lists where the code differs from the specification and why.
