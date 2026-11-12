# What has not been tried by hand

Scanline is built and tested with no window on screen. These are the things only a person at the machine can confirm. Each says what to do and what should happen. Tick them off, or note what went wrong, and the list shrinks.

## Where things stand

Every milestone of the build plan up to 1.0 has been worked through on macOS, and the result was built and tested on Windows 11 on 11 November 2026 ("On Windows", below, is what a person has yet to look at there). What comes next, for a person or an agent picking this up on another machine, is in [HANDOVER.md](HANDOVER.md). What is left falls into three kinds, and only the first two need you:

1. **Things to look at.** The sections below. Start with the viewer and the control strip, which nobody has yet seen on a screen with their own eyes.
2. **Things to decide or supply.** "Yours to decide" near the end: a licence, the name, where releases live, and the Apple Developer identity that signing needs. The pinned browser download and the Claude Code plugin are written and waiting on a first run by you.
3. **Things not built, that need no one.** Listed in [DEPARTURES.md](DEPARTURES.md) under each milestone and in `scanline help limits`. The largest: Linux. Of the build plan's list for after 1.0, the Babylon.js adapter, the native-capture profile, assertions for a test run, a recording as a video and "Send to agent" are built; the PlayCanvas adapter is built too; single-window builds, a WebKit or Firefox mode, Linux and WebXR are not built ([DEPARTURES.md](DEPARTURES.md), "Milestone 8").

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
- [ ] F9 from another application: start the request again, click on some other application's window (a text editor), and press F9 there. The game freezes all the same, and the editor does not see the key. After the press F9 belongs to the editor again. (The key is held system-wide only while the request is open; the test suite proves the path with a made-up press, not a real one.)
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
- [ ] Send to agent: click a pixel of the picture (the line under the capture bar says it is pinned), type a few words in "For the agent" and press Send to agent. In the shell, `scanline events` shows a `selection` event with the capture, the event number, the pixel and your words.
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

## The native-capture profile

```bash
scanline stop
```

```bash
SCANLINE_ALLOW=native-capture scanline launch http://127.0.0.1:8765/fixtures/matrix/webgpu.html --profile native-capture
```

- [ ] The answer names the GPU process ("process 12345"). In Xcode, Debug > Attach to Process by PID or Name takes that number and attaches.
- [ ] With Xcode attached, the Metal capture button in the debug bar captures a frame, and the draw calls it lists carry the page's labels.
- [ ] If Xcode refuses to attach, or shows no Metal capture button: say what it said. Starting the browser this way is all that has been checked.

## An evaluation round with the runner

The runner (`evals/run.mjs`) is tested with a stand-in for the agent. A real round spends the agent's tokens, once for each of the twenty-nine bugs, so it was left for you. With Claude Code installed and an MCP configuration that starts `scanline mcp`:

```bash
node evals/run.mjs --agent 'claude -p --mcp-config /path/to/mcp.json --allowedTools "mcp__scanline"' --bugs b03
```

- [ ] One answer is written to `evals/results/<today>/b03.txt`, and the line printed says whether it was correct and in how many calls.
- [ ] Without `--bugs`, all twenty-nine run, one after another, and `scores.json` holds the round.

## The Scanline app

[app/](../app/README.md), built on 12 November 2026 and checked through the host and pictures of its own window, never by a person's hands. Build it with `npm run app` (it is then `app/target/Scanline.app`), or use the one installed in `~/Applications`. Serve the fixtures (`node evals/serve.mjs 8765`) for the pages below.

1. **Open it from the Finder or the Dock.** A window opens on the start page, whose ring of bars turns. The Live panel's numbers move (about 60 fps), the status bar says `ses_…`, `running at 1×`, `WebGL 2`, and the agent panel lists `you launch`.
2. **The game's view.** The ring is drawn in the black area to the left of the panels, filling it, sharp. Resize the window: the game follows its area and nothing is drawn over the toolbar or the panels. Drag the window by the toolbar; double-click the toolbar to zoom it. Move it to another display.
3. **The address bar.** Click it (or `⌘L`), type `127.0.0.1:8765/fixtures/engines/three.html`, press Return: three cubes, the address shown in the bar, the page in File › Open Recent. `⌘V` pastes; `⌥⌫` deletes a word; Escape gives the keyboard back to the game. Try an address on the internet: the person's navigation goes anywhere.
4. **Keyboard to the game.** Open `fixtures/matrix/game.html`, click the game and use the arrow keys: the game gets them, and the panels' shortcuts (`⌘1`–`⌘5`) still work while it has the keyboard.
5. **Time.** `⌘.` pauses (the button says Run, the status bar `paused`, the frame number stops); `⌘'` steps one frame; the `1×` button goes round 2×, 0.25×, 0.5×, 1×; `⌘[` and `⌘]` halve and double it.
6. **Capture.** `⇧⌘C`: the Captures panel opens on the new capture, with the last draw chosen and its picture. Click other draws in the list; click "Open prg_… in Resources". Click a point of the picture: a "Pixel" card lists the events that changed it; click one to choose that draw. `⌘\` widens the panel. Send to agent, then `scanline wait --kinds selection` in a terminal shows what was sent.
6a. **The divider.** Drag the bar between the game and the panels both ways: the game's view follows, and the panels lay themselves out again (Live goes to two columns when wide). Double-click the bar: half and half again. Quit and reopen: the width you left is kept.
6b. **A capture's progress.** On a heavy page (https://spider.sixfingerpunch.com or https://adventure.sixfingerpunch.com), Capture: the capture opens in a second or two, with its draw list, and the game carries on. A cyan card says the textures are being fetched (so many of so many MB), then that the frame is being replayed and checked. Click draws meanwhile: each one's state, textures and uniforms show at once, its picture when the textures are in. When the card goes, the header says "replay identical" (or what differs), the draw list shows each draw's box, and Worth a look its findings.
6c. **The capture view.** On https://adventure.sixfingerpunch.com, Wide (`⌘\`), then Capture. The navigator lists its passes, each with a small picture; open the one with hundreds of draws and click a few. Each shows its target large, its bound resources (textures with their pictures; click one to open it in Resources) and its attachments side by side, colour ones edged green. A shadow pass's draw shows its depth large. Measure GPU time: after a few seconds the timeline's bars take the width of their GPU time; click the widest. Back to All: the captures as a gallery of their pictures.
6c2. **The magnifier.** In a capture, drag a box across part of the picture: a cyan box stays over it, and a Magnifier card shows the region enlarged with a pixel grid. Point at pixels: x, y and the value before and after the draw appear under it. Before it and What it changed: the region before the draw, and a heat map of what changed, with a line saying how many pixels. On a draw that changed nothing there, What it changed says so. A short click (no drag) still gives the pixel's history.
6d. **The look.** Every toolbar button is an icon in a segment (hover to light it); the rail's icons light in their panel's colour with a bar at the edge; panels have a header bar; nothing looks like a plain rounded web button. The start page credits Streamline for the icons.
7. **Resources.** Textures are a gallery of pictures, filled in a few at a time. Open one; Checker puts a checkerboard in its place in the game, Checker again takes it away. Shaders: the source is coloured, and "As the GPU gets it" shows Chromium's translation. A program: Hide, Flat and Only change the game at once; Edit opens a shader in your text editor (TextEdit unless you have set another), and saving it changes the game (try changing a colour); "Stop and put the shader back" in Experiments undoes it. Click a texture's picture: the texel's exact value appears under it. A texture's ◀ ▶ step through its levels; a buffer's page through it, and "as float32" reads it as numbers; a program's shader buttons open its shaders.
8. **Console and Agent.** A page error turns the Console button's dot red until the panel is opened. In a terminal, run `scanline request_human --instruction "Press Debug"`: the Agent panel shows the request, the toolbar shows Debug and "You have the input"; press Debug (`⇧⌘D`) and `scanline wait --request req_1` returns the capture.
7a. **Experiments.** Wireframe, Overdraw, Depth and Draw ID each change the game at once; Normal puts it back. Every-draw switches (Culling off and the rest) and each program's Hide, Flat and Only light when on, and appear under In force; Undo and Undo all put the game back. The three measurements each take a few seconds and show two bars.
7b. **Screenshot and Video.** Screenshot: a picture appears on the desktop, named by the date and time. Video: the button turns red and counts; Stop: after a while (the frames are replayed and encoded) a WebM of up to the last ten seconds appears on the desktop, and plays in QuickTime or a browser.
7c. **Sizes.** On spider, `⤢ Fit` ▸ 1080p: the game is drawn smaller to fit the game area, and the button and status bar say "1080p 1920×1080 @1x · 45%" or so; nothing of the game spills over the toolbar, the panels or the status bar. Retina @2x: sharper, the same size. iPhone 15: a tall narrow picture at the left of the game area; Landscape turns it. Drag the divider: the picture stays fitted. Its view's own: as before. Open another game and come back: the size you gave spider is given it again.
7d. **Sound.** On a game with sound, `♪ Sound`: silent at once, the button says Muted. Open another game: its sound plays. Back to the first (from the projects page): still muted.
7e. **Fullscreen and the pointer.** Open `fixtures/app/lock.html` (type its path in the address bar). Click in it: the cursor disappears and stays put, the background turns green and the page says "locked"; move the mouse, and `scanline eval --expression "window.state.moved"` (the page's count of mouse moves) climbs. Esc: the cursor is back and the page says "free". Click again, then `⌘Tab` to another app: the cursor is back there. Press F: the page says "fullscreen", and fills the game area only; Esc leaves it. Then a real first-person game in a browser (one that steers by mouse-look): it turns with the mouse, and Esc lets go.
7f. **Projects.** `⌂`: a card for each game opened, with a picture of it from a few seconds after it opened, its title and how long ago; muted or sized games say so. Click one: it opens. Quit, then open Scanline from the Dock with no address: the same page.
8a. **Recordings.** In Captures, Record 2 s: the page runs two seconds and freezes, and a capture of the last frame opens. Back in the list, the recording is there; open it for its contact sheet, and click a frame number to make that frame a capture.
9. **More windows.** `⌘N` opens a second window with a session of its own. Closing a window (`⌘W`, or its red button) ends its session: `scanline sessions` no longer lists it. `⌘Q` likewise.
10. **A capture file.** `scanline export --capture cap_1 --path ~/Desktop/frame.scanline`, then double-click the file in the Finder: a window opens on its Captures panel with that capture. With a window already open, double-click it again: that window imports it and shows it.
11. **An agent's session.** `scanline launch <url> --display app` from a terminal opens a window too, and `scanline viewer --show capture --capture cap_1 --draw 2` turns its panel to that draw.

## The desktop app prototype

[prototypes/app](../prototypes/app/README.md). On the Mac, already done by hand on 12 November 2026: it runs games and is fast. Still to look at:

- Drag the window to another display, and between a Retina and a non-Retina one if there is one: the game stays in its rectangle and sharp.
- Scroll the 10,000-row list hard while a game runs: the game's frame rate in the panel does not drop.
- Full screen (the green button): the game's view follows.

## On Windows

Everything above applies on a PC as well, and none of it has been looked at there: the tests run with no window on screen. Set-up, in PowerShell, from the repository:

```powershell
$env:PATH = "$PWD\target\debug;$env:PATH"
```

```powershell
node evals/serve.mjs 8765
```

Work through "The control strip", "The viewer" and "Send to agent" above as written. Then these, which are about Windows itself:

- [ ] **A real F9 press.** `scanline launch http://127.0.0.1:8765/fixtures/bugs/b13.html`, then `scanline request_human "Watch the glass panel, then press Debug"`. Click on some other application's window and press F9 there. The game freezes, and the other application does not see the key. After the press, F9 belongs to the other application again. (The test presses it with a message the helper posts to itself; nobody has pressed the key.)
- [ ] **No window flashes up.** While a request is open the host runs `scanline hotkey` as a helper. No console window should appear for it, or for the host itself, at any point.
- [ ] **The host outlives its terminal.** Run `scanline launch about:blank` in a terminal and close that terminal. The browser window stays, and `scanline sessions` from a new terminal lists the session. If the host died with the terminal, say which terminal it was: one that runs its commands in a job kills what they start.
- [ ] **JSON in each shell.** `scanline patch_draws --filter "{'draws': [6, 8]}"` is accepted (it answers with a patch, or says the session has no such draws) in `cmd`, in Windows PowerShell and in PowerShell 7. It must not say the filter is not an object.
- [ ] **Characters in a console.** `scanline help limits` in a console window shows "65.5 µs", not "65.5 Âµs". Piped in PowerShell (`scanline help limits | Select-String 65.5`) it shows the wrong characters until `[Console]::OutputEncoding = [Text.Encoding]::UTF8` has been run: that is PowerShell decoding with the console's code page, and is described in the README.
- [ ] **ASCII where the shell garbles.** In Windows PowerShell, without setting `[Console]::OutputEncoding`: `scanline help limits --ascii | Select-String 65.5` shows "65.5 us", and `$env:SCANLINE_ASCII = "1"` makes every command write ASCII the same way. This was built and tested on the Mac only, where no shell garbles anything.
- [ ] **A release.** `npm run package` writes `dist\scanline-0.0.1-windows-x64.zip`. Unpacked somewhere else, `powershell -ExecutionPolicy Bypass -File install.ps1` puts `scanline.exe` in `%LOCALAPPDATA%\Programs\Scanline`, adds that folder to your own PATH, and `scanline --version` answers from a new terminal. Windows may warn that the program is unsigned: signing needs your certificate, and is not written.
- [ ] **A native debugger.** `$env:SCANLINE_ALLOW = "native-capture"`, then `scanline launch http://127.0.0.1:8765/fixtures/matrix/webgpu.html --profile native-capture`. The answer names the GPU process. Try attaching PIX or RenderDoc to it and say what happened: neither has been tried, and each may need the process to have been started its own way.
- [ ] **Another user of the PC.** Signed in as a second, non-administrator user, `Get-Content C:\Users\<you>\AppData\Local\Scanline\host.log` is refused. The tests check the rule on the files and on the pipe; nobody has tried to get past it.

## Yours to decide

These are not tests. They are choices that were not mine to make, and each is a small edit. Two are still open.

- **A licence.** Decided on 11 November 2026: the PolyForm Shield License 1.0.0 (`LICENSE.md`, the official text unchanged under a notice of copyright). Anyone may use Scanline for anything, change it and pass it on, but may not provide a product that competes with it, paid or free; someone who wants to must come to the owner. It is named in `Cargo.toml`, the two `package.json` files and the plugin manifest, and a release carries it. Scanline is "source-available", not "open source". The one exception, also the owner's choice that day, is `packages/scanline-hooks`, the package a page imports: it is under MIT (`packages/scanline-hooks/LICENSE`), because it goes inside other people's games.
- **Who holds the copyright.** Open. `LICENSE.md` says "Copyright (c) 2026 Richard Davey", from the name on the commits. If a company should hold it, that one line is the edit.
- **Contributions.** Open. To sell someone a licence that allows what Shield forbids, the owner needs the right to license other people's contributions that way. Until there is a contributor agreement saying so, a pull request from outside is best not merged.
- **The product's name.** Decided on 11 November 2026: Scanline, for the way a raster screen draws a picture. It is no longer a working name.
- **Who the plugin is by.** Decided on 11 November 2026: the owner. `.claude-plugin/plugin.json` and `marketplace.json` name him as author and owner. (An organisation's name there instead is a one-word edit in each.)
- **Where releases live.** Decided: GitHub Releases on this repository, for now. Nothing publishes there yet, and updates are still not built: `npm run package` makes the archive, and putting it up is by hand.
- **The version.** Decided: 1.0 when it is released, and not before. Everything says 0.0.1 until the owner has seen it work and look as it should. `tools/package.mjs --check` fails if `Cargo.toml`, `package.json` and the plugin disagree.
- **Signing.** Decided: not until then either.
- **The app's identity and signing.** Open. The app's bundle identifier is `org.scanline.app` (its helpers `org.scanline.app.helper…`, its capture file type `org.scanline.capture`), set in `app/bundle.sh`; change it to one of your own before signing. `npm run package:app` makes an unsigned disk image. Signing it means signing the framework, the five helper apps and the app, inside out, with the hardened runtime and the entitlements Chromium's JavaScript compiler needs (`com.apple.security.cs.allow-jit`, `com.apple.security.cs.allow-unsigned-executable-memory`), then notarising the image.

## Confirmed

- 11 November 2026, on the PC: `scanline browser install` downloaded Chrome for Testing 157.0.8103.50 and unpacked it, and `scanline browser` says a launch would use it. Run by the owner. (Not yet run on the Mac. Nobody has yet launched a page in it and looked.)
- 11 November 2026: a real F9 press froze `b13.html`, 128 frames were kept, and `recording` named the four frames that flicker. (No strip existed then.)

## Not possible on this machine

- Linux: nothing has been built or run there.
- Pointer lock and fullscreen, from your own click: see "Pointer lock without the shim" above. From an injected click both were checked on 11 November 2026 in a headed window: the browser grants them when its window is in front (after `Page.bringToFront`) and refuses when it is not (`WrongDocumentError`, "not granted"). Scanline does not bring its window to the front for an agent, so a refusal is reported as a warning event that points at the shim.
- A Unity WebGL build and an Emscripten build, which the specification's content matrix lists: neither is in the repository, and fetching them needed your say-so. Put a build in `fixtures/engines/`, launch it, run `scanline capture`, and read the "Replay check" line.
