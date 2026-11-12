# The desktop app prototype

Stage 0 of [docs/APP.md](../../docs/APP.md): a GPUI window holding a real Chromium (CEF 156) running a game, driven over the DevTools protocol from native buttons. Throwaway code. It does not use Scanline's host, and it is outside the Cargo workspace, so it cannot affect the main build or the tests. What it found is in [docs/spikes/RESULTS.md](../../docs/spikes/RESULTS.md), "The desktop app prototype".

macOS on Apple silicon only, for now.

## Running it

It is built already if `target/Scanline Prototype.app` exists. Serve the pages, from the repository:

```bash
node evals/serve.mjs 8765
```

Then open the app:

```bash
open "prototypes/app/target/Scanline Prototype.app"
```

It starts on `pages/start.html`. Type an address in the bar (click it first), or use the shortcuts in the panel. Pause holds the page's `requestAnimationFrame` callbacks; Step runs one frame's worth of them. Screenshot asks the protocol for one.

To open a page straight away, run the executable with the address:

```bash
"prototypes/app/target/Scanline Prototype.app/Contents/MacOS/scanline-prototype" https://example.com/
```

## Building it

```bash
prototypes/app/bundle.sh
```

The first build needs three things in `prototypes/app/target/`, none of them in Git:

- **CEF** in `target/cef`. The build downloads it there (135 MB, from cef-builds.spotifycdn.com) when `CEF_PATH` points at it, which `bundle.sh` sets.
- **cmake and ninja** in `target/tools`, to compile CEF's C++ wrapper. Without Homebrew's, a private Python environment does: `python3 -m venv target/tools`, then install the `cmake` and `ninja` wheels into it.
- Nothing for Metal: GPUI is built with `runtime_shaders`, so it compiles its shaders when it starts and full Xcode is not needed.

`BUNDLE_DIR=target/test prototypes/app/bundle.sh` builds a second copy; give a running second copy its own cache with `SCANLINE_PROTOTYPE_CACHE`, or Chromium hands the start to the first.

## The checks

With the fixtures served:

```bash
node prototypes/app/checks/timing.mjs
```

```bash
node prototypes/app/checks/timing.mjs --browser "$PWD/prototypes/app/target/test/Scanline Prototype.app/Contents/MacOS/scanline-prototype"
```

```bash
node prototypes/app/checks/robustness.mjs "$PWD/prototypes/app/target/test/Scanline Prototype.app/Contents/MacOS/scanline-prototype"
```

The first times three pages in Chrome; the second times them in the app, which it drives over `--remote-debugging-pipe` exactly as it drove Chrome; the third checks workers and crashes the app's GPU process until Chromium gives up. Set `SCANLINE_PROTOTYPE_REPORT` to a file path and the app writes its panels' state there once a second.

## How it fits together

- `src/main.rs`: one executable for every process. Started with `--type=…` it is a Chromium helper.
- `src/browser.rs`: CEF's application, client and handlers, and the protocol observer. Everything arrives on the main thread (`external_message_pump`), into a thread-local inbox.
- `src/mac.rs`: Chromium's `CrAppControlProtocol` added to GPUI's application class; the browser's view placed over the game's rectangle.
- `src/ui.rs`: the window, a 4 ms message pump, the protocol calls and the panels.
