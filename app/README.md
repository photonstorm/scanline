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
| `⇧⌘S` | a screenshot of the canvas, to the desktop |
| `⇧⌘V` | start a video; again to stop and save it to the desktop |
| `⇧⌘M` | mute the game, or turn its sound on again: remembered for each game |
| `⇧⌘E` | the sizes the game can be given |
| `⇧⌘H` | the projects page: every game opened, with a picture of each |
| `Esc` | the pointer and the screen back from a game that took them |
| `⇧⌘D` | Debug: answer the agent's request |
| `⌘1`–`⌘6` | Live, Resources, Captures, Experiments, Console, Agent |
| `⌘\` | the panels as wide as the window allows, and back |
| `⌘W`, `⌘Q` | close the window, which ends its session |

Drag the bar between the game and the panels to share the window between them; double-click it to go back to half and half. The width is remembered.

Opened with no address, the window shows the projects page: a card for each game opened before (newest first), with its title, a picture taken while it ran, and whether it was muted or given a size. A click goes back to it. `⌂` in the toolbar, or `⇧⌘H`, comes back to the page.

The toolbar's size button (`Fit`) gives the game the size and pixel ratio of a desktop window (720p to 4K, with Retina), a phone or a tablet (turned on its side with Landscape), as DevTools' device mode does: the page is told the size, and what it draws is scaled to fit the game area, which keeps its size in the window. `Sound` mutes the game (the whole page, as a muted Chrome tab is). Both are remembered for each game, and put back when it is opened again.

A game that goes fullscreen fills the game area, not the screen; one that takes the pointer (pointer lock, as a first-person game does) has it: the cursor is held still and hidden while the mouse's moves reach the game. Esc gives both back, as in Chrome, and so does Game ▸ Release Pointer; the pointer is given back whenever the window is not in front. The status bar says while a game has either.

The panels:

- **Live**: frame time, CPU and GPU time, the work each frame does, GPU memory and the objects alive, as the page runs.
- **Resources**: every live object by kind. Textures are a gallery of their pictures; one opens to its levels (◀ ▶), small ones enlarged texel by texel, a click reads a texel exactly, and Checker, White, Black or Mips stands in for it in the game. A shader shows its source coloured, with line numbers, or as the GPU gets it (the browser's translation). A program shows its uniforms with the values last set, its attributes, Hide, Flat and Only for its draws, and Edit for each shader: the shader opens in your own text editor, and each time you save it the game draws with it (Experiments says so, and puts it back). A buffer shows its bytes, in hex or as float32, a page at a time. Each says the line of code that made it.
- **Experiments**: change how the running game draws. The frame as wireframe (a game's full-screen passes stay filled, so it shows through post-processing), overdraw, depth or a colour per draw; culling, the depth test, depth writes or blending off for every draw; each program hidden, drawn flat or drawn alone; a stand-in for each texture; where the GPU time goes (fill, shading, texture fetching, each measured with and without); and what is in force, each with Undo. Every control is a host command an agent can run too (`help(topic: "patch")`).
- **Captures**: the session's captured frames, as a gallery of their final pictures. One opened is laid out as Metal's debugger and Nsight lay a frame out: a **navigator** of its passes, each with a picture of its target, opening onto its events (an icon for each kind; a warning where a draw changed nothing); the chosen draw's **target**, large (click a pixel for its history; a target with no colour, a shadow map's, shows its depth); its **bound resources**, as a table: the program, the vertex inputs and their buffers, each texture unit with its picture, the uniforms, and the attachments; and every **attachment** of its target side by side, as it stood after the draw: a G-buffer's albedo, normals, roughness and depth at once (a click shows one large). Drag a box on the picture for the **magnifier**: the region enlarged with no smoothing (a pixel grid from 8×), as the draw left it, as it was before it, and what it changed (a heat map, with how many pixels and by how much); point at a pixel for its exact value before and after. It asks the host for exactly what an agent would: screenshot with a region and zoom, and diff. Above them, the **frame timeline**: the passes and, beneath, their draws, coloured by program; Measure times every draw and makes each as wide as it took, as Nsight's trace does. A click on any of them chooses that draw.
- **Captures, while one is made**: a capture opens in a second or two, even on a heavy scene: its draws, their state, shaders and uniforms can be read at once, while a card at the top says the textures are being fetched and then the frame replayed and checked. Each draw's picture, a pixel's story and the replay check follow when they are in (`capture(quick: true)`). "Findings" lists what is often the bug. Send passes the capture, draw, pixel and a note of yours to the agent. Record 2s keeps every frame of two seconds of play (the flight recorder): a recording shows its contact sheet and frames, any of which becomes a capture with a click.
- **Console**: the page's console by frame, repeats folded, filtered to warnings or errors.
- **Agent**: every command an agent runs on the host, and what you do, newest first; and what the agent has asked of you, with Debug.

A capture file (`.scanline`, written by `export`) opens in the app when double-clicked: it is imported into the host and shown in Captures, in a new window or the one already open.

## Agents

An agent shows its session in the app with `launch(url, display: "app")`, or for every launch with `SCANLINE_DISPLAY=app` in the host's environment. `viewer(show: "capture", capture: "cap_2", draw: 14)` points the app's panels at something; `show` is `live`, `resources` (with `handle`), `capture` (with `capture` and `draw`, or `recording`), `console` or `activity`.

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

## Its look

Words are kept to what a control or a number needs: a button is one or two words, a heading names its contents, and nothing explains what the screen already shows. Messages from the host meant for agents (the next command to call) are trimmed before they are shown.

Flat panels edged with hairlines, colour kept for meaning (what is chosen, what is on, which kind of thing), the toolbar in grouped segments with Capture as its one main action, and icons from Streamline's Core Line – Free set: 45 of them, compiled in, under CC BY 4.0 (resources/icons/LICENSE.md lists them; the bundle carries the notice). Streamline's free licence allows 50 of its free icons in a project: add one only in place of another, or past 50 not at all. `chevron.svg` is Scanline's own.

## Building it

```bash
npm run app
```

That is `app/bundle.sh`: it builds the app and the command line and assembles `app/target/Scanline.app`. `RELEASE=1 sh app/bundle.sh` makes a release build. The first build needs:

- **CEF 156** in `app/target/cef`. `bundle.sh` copies the prototype's if it has one; otherwise the build downloads it there (135 MB, from cef-builds.spotifycdn.com).
- **cmake and ninja**, to compile CEF's C++ wrapper: on the PATH (Homebrew's will do), or in a private Python environment, `python3 -m venv app/target/tools` and the `cmake` and `ninja` wheels installed into it.
- Not Xcode: GPUI is built with `runtime_shaders`, so its Metal shaders are compiled when the app starts.

To use the build with the command line in this repository, point the host at it: `SCANLINE_APP=app/target/Scanline.app`, set where the host is started (a running host keeps its environment: `scanline stop` first). An installed app is found without it, in `/Applications` or `~/Applications`.

`SCANLINE_APP_SNAPSHOTS=<folder>` makes the window save a picture of itself there every two seconds, with where Chromium's view sits beside it: a way to check the window with nobody at the screen. (A picture of one's own window leaves out what Chromium's GPU process draws, so the game area is dark in it.) In that mode the window also does what a `<session>.do` file in the folder says, one line each, then removes it: `capture`, `screenshot`, `video`, `show experiments`, `select tex_4`, `kind shader`, `back`, `view wireframe`, `patch <key> patch_draws {json}`, `measure flat_fragment`, `width 900`, `draw 12`, `pixel 10 20`, `address <url>`, `mute`, `projects`, `release`, `sizes`, `size 1080p @2x` (or `size iPhone 15 landscape`, `size fit`), `timeline` (measure the open capture's GPU time), `magnify x y w h` (a region of the chosen draw's target), `showing before|after|changed`.

`npm run package:app` (`app/package.sh`) makes a release build and packs it into `dist/Scanline-<version>-macos-arm64.dmg`, with a link to `/Applications`. It is unsigned: signing and notarising are the owner's, and come before packing.

The icon is drawn by `resources/icon/draw.swift`; `resources/icon/make.sh` remakes `AppIcon.icns`.

## Tests

`npm run test:app` launches the app as the host's browser, drives and captures a page in it, points its panels, and closes it. It is skipped when the app has not been built. The window itself (typing, clicking, menus) is checked by hand: [docs/BY-HAND.md](../docs/BY-HAND.md), "The Scanline app".
