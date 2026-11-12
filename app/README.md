# The Scanline app

The game in Chromium and everything Scanline knows about it in one window: [docs/APP.md](../docs/APP.md) is the design. macOS on Apple silicon for now; Windows is next ([docs/HANDOVER.md](../docs/HANDOVER.md)).

## Using it

Open `Scanline.app`. It asks the host for a new session in the app (starting the host if none is running) and the window opens on its start page. Type an address in the bar (`⌘L`), or open one from File › Open Recent.

| | |
|---|---|
| `⌘L` | the address bar |
| `⌘N` | a new window: a new session |
| `⌘R` | reload |
| `⌘.` | pause or run |
| `⌘'` | step one frame (`⇧⌘'` ten) |
| `⌘[` `⌘]` | slower, faster (`0.125×` to `4×`) |
| `⇧⌘C` | capture the next frame |
| `⇧⌘D` | Debug: answer the agent's request |
| `⌘1`–`⌘5` | Live, Resources, Captures, Console, Agent |
| `⌘\` | a wider panel |
| `⌘W`, `⌘Q` | close the window, which ends its session |

The panels:

- **Live**: frame time, CPU and GPU time, the work each frame does, GPU memory and the objects alive, as the page runs.
- **Resources**: every live object by kind, largest first. A texture opens to its levels (◀ ▶), small ones enlarged texel by texel; a buffer to its bytes, in hex or as float32, a page at a time; a shader or program to its source and logs. Each says the line of code that made it.
- **Captures**: the session's captured frames. One opened shows "Worth a look", the target as it stood after the chosen draw, the draw list (each with the box it changed, or "changed nothing"), and the draw's state. Click the picture for a pixel's value and every event that changed it. Send to agent passes the capture, draw and pixel to the agent.
- **Console**: the page's console by frame, repeats folded, filtered to warnings or errors.
- **Agent**: every command an agent runs on the host, and what you do, newest first; and what the agent has asked of you, with Debug.

A capture file (`.scanline`, written by `export`) opens in the app when double-clicked: it is imported into the host and shown in Captures, in a new window or the one already open.

## Agents

An agent shows its session in the app with `launch(url, display: "app")`, or for every launch with `SCANLINE_DISPLAY=app` in the host's environment. `viewer(show: "capture", capture: "cap_2", draw: 14)` points the app's panels at something; `show` is `live`, `resources` (with `handle`), `capture`, `console` or `activity`.

What you do in the app goes to the host as yours: the activity log says so, the tiers do not apply to it (you can go to any address), and your pause or step works while you have the input. What an agent sends cannot claim to be yours: the command line, MCP and MCP over HTTP drop it.

## How it is put together

One executable, three parts (`src/main.rs`):

- **The launcher** (opened from the Dock or the Finder): asks the host, on its control socket, for a session in the app, starting the host first with the bundled command line if none is running, and quits.
- **The player** (started by the host with `--remote-debugging-pipe`, as it starts Chrome): the window. The host drives the page over the pipe; the window asks the host for everything its panels show, as the "viewer" (not logged), and sends what you do as the "person" (logged). `src/player.rs`, `src/panels/`, `src/host.rs`.
- **Chromium's helpers** (`--type=…`): CEF's renderer, GPU and utility processes, in Chromium's sandbox.

The game is a native view of Chromium's own (CEF in windowed mode), placed over the rectangle GPUI lays out for it; nothing is drawn over it. `src/mac.rs` holds the two places where CEF and GPUI meet in AppKit.

The bundle (`Scanline.app/Contents`):

- `MacOS/Scanline`: the app; `MacOS/scanline-cli`: the `scanline` command line, under another name because file names on a Mac ignore case.
- `Frameworks/Chromium Embedded Framework.framework`, and the five `Scanline Helper` apps, each a hard link to the app's executable.
- `Resources/start.html`, `Resources/AppIcon.icns`.

## Building it

```bash
npm run app
```

That is `app/bundle.sh`: it builds the app and the command line and assembles `app/target/Scanline.app`. `RELEASE=1 sh app/bundle.sh` makes a release build. The first build needs:

- **CEF 156** in `app/target/cef`. `bundle.sh` copies the prototype's if it has one; otherwise the build downloads it there (135 MB, from cef-builds.spotifycdn.com).
- **cmake and ninja**, to compile CEF's C++ wrapper: on the PATH (Homebrew's will do), or in a private Python environment, `python3 -m venv app/target/tools` and the `cmake` and `ninja` wheels installed into it.
- Not Xcode: GPUI is built with `runtime_shaders`, so its Metal shaders are compiled when the app starts.

To use the build with the command line in this repository, point the host at it: `SCANLINE_APP=app/target/Scanline.app`, set where the host is started (a running host keeps its environment: `scanline stop` first). An installed app is found without it, in `/Applications` or `~/Applications`.

`SCANLINE_APP_SNAPSHOTS=<folder>` makes the window save a picture of itself there every two seconds, with where Chromium's view sits beside it: a way to check the window with nobody at the screen. (A picture of one's own window leaves out what Chromium's GPU process draws, so the game area is dark in it.)

The icon is drawn by `resources/icon/draw.swift`; `resources/icon/make.sh` remakes `AppIcon.icns`.

## Tests

`npm run test:app` launches the app as the host's browser, drives and captures a page in it, points its panels, and closes it. It is skipped when the app has not been built. The window itself (typing, clicking, menus) is checked by hand: [docs/BY-HAND.md](../docs/BY-HAND.md), "The Scanline app".
