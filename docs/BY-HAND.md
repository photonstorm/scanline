# What has not been tried by hand

Scanline is built and tested with no window on screen. These are the things only a person at the machine can confirm. Each says what to do and what should happen. Tick them off, or note what went wrong, and the list shrinks.

## Where things stand

Every milestone of the build plan up to 1.0 has been worked through on macOS. What is left falls into three kinds, and only the first two need you:

1. **Things to look at.** The sections below. Start with the viewer and the control strip, which nobody has yet seen on a screen with their own eyes.
2. **Things to decide or supply.** "Yours to decide" near the end: a licence, the name, where releases live, and the Apple Developer identity that signing needs. The pinned browser download and the Claude Code plugin are written and waiting on a first run by you.
3. **Things not built, that need no one.** Listed in [DEPARTURES.md](DEPARTURES.md) under each milestone and in `scanline help limits`. The largest: Windows; for WebGPU captures, pixel history, geometry, per-draw profiling and the views that redraw the frame with other shaders; WGSL reflection (uniforms by name); adapters for Babylon.js and PlayCanvas; MCP over loopback HTTP.

Set-up, from the repository:

```bash
export PATH="$PWD/target/debug:$PATH"
```

```bash
node evals/serve.mjs 8765
```

## The control strip (milestone 4)

```bash
scanline launch http://127.0.0.1:8765/fixtures/bugs/b13.html
```

```bash
scanline request_human "Watch the glass panel, then press Debug"
```

- [ ] A small dark window appears directly under the game's window, about as wide as it, with no tabs. It reads "You are driving", the instruction, a red REC light and a frame number that counts up.
- [ ] The game's window still has the keyboard: F9 freezes the picture without clicking on the game first.
- [ ] The strip's Debug button does the same as F9. Pause stops the picture and turns into Resume; Step moves one frame while paused.
- [ ] After a press the strip reads "Nobody is driving" and "Frozen at frame N. The agent has this frame and the M before it."
- [ ] Does it matter that the strip stays where it was when the game's window is moved?

## Keeping your input out (milestone 4)

```bash
scanline launch http://127.0.0.1:8765/fixtures/matrix/game.html --strip
```

- [ ] The arrow keys move the green square and a click throws sparks.

```bash
scanline take_control
```

```bash
scanline resume
```

- [ ] The strip reads "The agent is driving". The arrow keys and clicks now do nothing in the game. F9 still freezes it.

```bash
scanline take_control --release
```

- [ ] The keys and clicks work again.

## Marking the frozen frame (milestone 4)

```bash
scanline launch http://127.0.0.1:8765/fixtures/bugs/b13.html
```

```bash
scanline request_human "Press Debug, then point at the glass"
```

Press F9 with the game focused, then:

- [ ] The strip reads "Frozen at frame N … Click the picture to point at something, drag to mark a box, or type a note", and has a text field with a Send button.
- [ ] A click on the frozen game leaves a small orange ring where you clicked. A drag leaves an orange box.
- [ ] Typing in the strip's field and pressing Enter (or Send) clears the field and the strip says the note was sent.

```bash
scanline events
```

- [ ] The list ends with one `annotation` for each: a point (`x`, `y`), a box (`x`, `y`, `w`, `h`) and the note, with coordinates that match where you pointed (canvas pixels from the top-left of the 480×360 picture).

```bash
scanline resume
```

- [ ] The ring or box disappears and the note field goes.

## A real gamepad (milestone 4)

With a gamepad plugged in (press a button on it once so the browser sees it):

```bash
scanline launch http://127.0.0.1:8765/fixtures/matrix/game.html --deterministic
```

- [ ] The left stick moves the green square.

```bash
scanline save_run
```

- [ ] The summary counts "gamepad changes".

```bash
scanline replay_run run_1
```

- [ ] The square ends where it was, and the fingerprints match.

## Pointer lock without the shim (milestone 4)

```bash
scanline launch http://127.0.0.1:8765/fixtures/matrix/mouselook.html
```

- [ ] Click the picture: the cursor disappears and moving the mouse slides the white bar. Escape gives the cursor back.
- [ ] F9 still freezes the page while the pointer is locked.

## The viewer (milestone 7)

```bash
scanline launch http://127.0.0.1:8765/fixtures/adapters/three.html
```

```bash
scanline capture
```

```bash
scanline viewer
```

- [ ] A second window opens, titled Scanline, with three tabs: Activity, Live and Capture. It does not cover the game.
- [ ] Activity lists `launch`, `capture` and `viewer`, newest at the bottom, each with its arguments and the first line of its answer. Run `scanline pixels 10 10` in the shell: a row appears within a second without touching the viewer.
- [ ] Live shows four graphs (frame time, GPU time, draws, memory) that move while the game runs and go flat when you run `scanline pause`.
- [ ] Capture lists the captures; choosing one shows its events down the left. Clicking an event shows the picture as it stood after that event. Moving the pointer over the picture gives the pixel's position and value; the wheel zooms, and at high zoom the pixels are sharp squares, not blurred.
- [ ] The State and Shaders panes show that event's state and its shader source, readable without scrolling sideways.
- [ ] Is anything hard to read, too small, or in the wrong place? This is the first time anyone has looked at it with their own eyes.

## A capture as a file (milestone 7)

```bash
scanline export cap_1 --path ~/Desktop/test.scanline
```

- [ ] The file appears on the Desktop. Finder shows it as a plain document a few hundred kilobytes in size.

```bash
scanline import ~/Desktop/test.scanline
```

- [ ] A new capture handle is given, and `scanline captures` marks it "(imported)".
- [ ] On another Mac with Scanline (if there is one): the same file imports, and `scanline screenshot --capture <handle>` shows the same picture.

## The pinned browser (milestone 7)

This downloads about 170 MB from Google, which is why it has never been run here.

```bash
scanline browser install --dry-run
```

- [ ] It names Chrome for Testing 157.0.8103.50, a `storage.googleapis.com` address and a directory under `~/Library/Application Support/Scanline/browser`.

```bash
scanline browser install
```

- [ ] It finishes with "Installed Chrome for Testing …". `scanline browser` then says a launch would use the pinned one.
- [ ] `scanline launch http://127.0.0.1:8765/fixtures/matrix/webgl2.html` opens a window titled "Google Chrome for Testing", and macOS does not refuse to open it.
- [ ] `npm test` still passes with the pinned browser in use.

## The Claude Code plugin (milestone 7)

The plugin files were written from the documentation and have not been loaded: the `claude` command was not available where they were written.

```bash
claude plugin validate .
```

- [ ] It reports no errors. (Warnings about a missing licence or author details are expected: see "Yours to decide".)

```bash
claude --plugin-dir .
```

- [ ] With `scanline` on the `PATH`, `/mcp` lists a `scanline` server with the `gfx_` tools, and the seven skills are listed with the `scanline:` prefix.
- [ ] Asked "why is the glass opaque on http://127.0.0.1:8765/fixtures/bugs/b03.html", it uses the tools and names blending.

## A release (milestone 7)

```bash
npm run package
```

- [ ] `dist/scanline-0.0.1-macos-arm64.tar.gz` is written. Unpacked somewhere else, `sh install.sh` puts `scanline` in `~/.local/bin` and `scanline --version` answers from a new terminal.
- [ ] With `SCANLINE_SIGN_IDENTITY` set to your Developer ID Application identity, the script signs the binary, and `codesign --verify --strict dist/scanline-0.0.1-macos-arm64/scanline` passes.
- [ ] With `SCANLINE_NOTARY_PROFILE` set as well (a `notarytool` keychain profile), the submission is accepted. A bare binary cannot be stapled; a `.pkg` or `.dmg` would be needed for that, and neither is built.

## Yours to decide

These are not tests. They are choices that were not mine to make, and each is a small edit.

- **A licence.** The repository has none, so nobody else may use the code yet. `packages/scanline-hooks/package.json` and `.claude-plugin/plugin.json` have no `license` field for the same reason.
- **Who the plugin is by.** `.claude-plugin/plugin.json` and `marketplace.json` say "Scanline" as author and owner. Put your name or organisation there if you want it shown.
- **The name.** "Scanline" is still a working name. It is in the binary, the socket, the file suffix (`.scanline`), the plugin and every skill.
- **Where releases live.** Updates are not built because there is nowhere to check. GitHub Releases on this repository would do.
- **The version.** Everything says 0.0.1. `tools/package.mjs --check` fails if `Cargo.toml`, `package.json` and the plugin disagree.

## Confirmed

- 11 November 2026: a real F9 press froze `b13.html`, 128 frames were kept, and `recording` named the four frames that flicker. (No strip existed then.)

## Not possible on this machine

- Windows: nothing has been run there, and the browser launch for Windows is not written.
- Pointer lock and fullscreen: `node spikes/s4-input.mjs --headed` checks them and has not been run. The pointer-lock shim (`--pointer_lock shim`) is tested; the browser's own lock is not.
- A Debug hotkey that works while another application has the keyboard: nothing registers one with the operating system. F9 works while the game's window or the strip has the keyboard.
- PlayCanvas, a Unity WebGL build and an Emscripten build, which the specification's content matrix lists: none is in the repository, and fetching them needed your say-so. Put a build in `fixtures/engines/`, launch it, run `scanline capture`, and read the "Replay check" line.
- A WebGPU device in a worker: there is no fixture for it.
