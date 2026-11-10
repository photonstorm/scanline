# Scanline

A browser for debugging WebGL and WebGPU rendering, driven by an AI agent and shared with the person working beside it.

Scanline runs any page in a Chromium it launches and supervises, with instrumentation in place before the page's first line of script. An agent can then pause the page at a frame boundary, step it frame by frame, send it input, and read back exactly what the GPU drew. Every capability is a command; the command line and the MCP server are two front ends over the same commands.

"Scanline" is a working name.

## Status

Early. The first milestone of the build plan ("eyes and hands") works on macOS:

| Works | Not built yet |
|---|---|
| Launch a URL or local file in a supervised Chromium with a disposable profile | Live inventory of textures, buffers, shaders, pipelines; memory |
| Probe injected before page script in every frame and every kind of worker | Frame capture and replay; the draw list; state at each draw |
| Pause, step N frames, resume, time scale, run until a condition | Pixel history, overdraw and other views, per-draw GPU time, lints |
| One virtual clock behind frame timestamps, `performance.now`, `Date` and timers | Live patching of shaders, uniforms and state |
| Deterministic sessions: seeded random numbers and a fixed time step | The window: control strip, Debug button and hotkey, capture viewer |
| Keyboard, mouse, wheel and touch input as trusted events; held keys; frame-exact events | Hand-off to a person; the flight recorder; input replay |
| Canvas readback for WebGL 1, WebGL 2 and WebGPU: screenshots, zoom with a pixel grid, exact pixel values | The fast binary channel for bulk data |
| Console, uncaught errors and browser GPU warnings, each with its frame | Windows. Installers. A pinned browser download. |
| Frame pacing and per-frame draw, instance, triangle and call counts | |
| The host survives the GPU process or the whole browser being killed, and says what happened | |

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
npm run build:probe
```

```bash
cargo build --release
```

The probe is built first because the binary embeds it: a host and its probe are always the same version.

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
scanline run_until --until '{"expr": "game.scene === \"level2\""}'
```

```bash
scanline stop
```

`scanline --help` lists every command. `scanline help` explains the workflow, `scanline help input` the input events, and `scanline help limits` what is not built. Add `--json` to any command for the whole result.

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
| `crates/scanline-image` | Crop, nearest-neighbour zoom with a grid, downscale, PNG |
| `crates/scanline-mcp` | The MCP front end |
| `crates/scanline` | The binary: host, command line, MCP relay |
| `probe/` | The script injected into every page and worker (TypeScript, built to one file) |
| `probe/tools/` | The generator that writes the WebGL and WebGPU hook wrappers from the published interface definitions |
| `fixtures/` | Test pages: a known scene on each API and engine, and the spike pages |
| `spikes/` | The experiments the build plan asked for before milestone 1, and the Node launcher they share |
| `docs/` | Spike results, and where the build departs from the specification |
| `skills/` | Skills that teach an agent to use Scanline |
| `tests/` | End-to-end tests of the built binary |

## Tests

```bash
npm test
```

That builds the probe, checks its types, runs the probe's browser tests (about 25 s), the Rust unit tests, and the end-to-end tests of the binary (about 5 s). The browser tests launch headless Chromium with throwaway profiles. The parts can be run alone: `npm run test:probe`, `cargo test`, `npm run test:e2e`.

After changing `probe/tools/method-table.mjs`, run `npm run gen:hooks`.

## The specification

Scanline is built from a specification and build plan written before any code: a product requirements document, an architecture, the inspection techniques for each API, the agent interface, a page protocol, and a milestone plan with ten experiments to run first. Four of the ten have been run; [docs/spikes/RESULTS.md](docs/spikes/RESULTS.md) has what they found, and [docs/DEPARTURES.md](docs/DEPARTURES.md) lists where the code differs from the specification and why.
