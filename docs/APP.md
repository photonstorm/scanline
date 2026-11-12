# The Scanline app

A design for Scanline as a desktop application: one window holding the game and everything Scanline knows about it, for a person working alone or beside an agent. Written 12 November 2026. Nothing here is built yet, apart from the prototype in stage 0 once it exists.

## 1. What it is for

Today Scanline is a command and an MCP server. An agent drives it, and a person watches through a separate Chrome window, the control strip and the viewer in another tab. That works for agents, and badly for people: three windows, nothing to browse, and no way to see the game and its resources side by side.

The app puts all of it in one window:

- the game, running in a real Chromium, unobstructed;
- controls above it: address, reload, pause, step, time scale, capture, record, Debug;
- panels beside it: live graphs, resources, captures, console, and what the agent is doing;
- a capture opened in place, to be taken apart draw by draw.

It should feel like a native profiler, not a web page: fast to open, instant to scroll, and good to look at. It sits on the Dock (or the Start menu) and opens without an agent.

## 2. Principles

1. **One engine.** The host (the `scanline` binary) stays the only thing that launches pages, captures, analyses and stores. The app is a client of it, like the command line and the MCP server.
2. **Nothing the app can do that an agent cannot.** Every button is a host call. If a panel needs something the host does not offer, the host gains it first, as a tool. The person and the agent always see the same game, handles and captures.
3. **Nothing the page does can take the host down.** This is the specification's rule (02-ARCHITECTURE.md, section 2.5) and the app keeps it: see section 4.
4. **The game's view is Chromium's own.** The game draws into a real native view through Chromium's compositor, so frame pacing, vsync and GPU timing are what Chrome gives. Nothing is drawn over it. Scanline's markings on the game (a highlighted draw, a probed pixel) are drawn by the probe inside the page, as now, or shown in the panels.
5. **Headless stays.** The `scanline` binary on its own, with no app, is unchanged: for agents working alone, test runs and CI.

## 3. Technology

| Part | Choice | Why |
|---|---|---|
| Interface | GPUI (`gpui` 0.2.2, the toolkit Zed is built on), with `gpui-component` 0.9.1 for tables, lists, docks, tabs and inputs | Drawn on the GPU at the display's rate; built for large lists and fast scrolling; native windows and menus on macOS and Windows. Rust, like the host. |
| Browser | CEF (the Chromium Embedded Framework) through the `cef` crate 156.4.0 (Chromium 156.0.8078.88), in windowed mode: the browser is a native child view of the app's window | Real Chromium. Windowed mode keeps Chromium's own compositor and timing (principle 4). The protocol is available in process. |
| Engine | The existing host, unchanged in kind | Section 4. |

Rejected, with reasons, in the research of 11 November 2026: WKWebView (it is Safari's engine, and has no debugging protocol); Tauri 3's CEF runtime (alpha, and its interface is a web view); Qt WebEngine (Chromium 134, no WebGPU listed); off-screen CEF in a GPU-drawn interface, such as Wef (Chromium renders to a texture and CEF does no frame timing of its own, which changes what is being measured); Electron (workable, and the fallback if stage 0 fails: see section 10).

## 4. Processes

```
 ┌──────────────────────────── Scanline.app ─────────────────────────────┐
 │  GPUI interface              CEF browser process                       │
 │  (toolbar, panels)           (the game's native view)                  │
 │        │                            │  renderer, GPU, utility helpers  │
 └────────┼────────────────────────────┼──────────────────────────────────┘
          │ control API                │ DevTools protocol
          ▼                            ▼
 ┌──────────────────────────── scanline host ────────────────────────────┐
 │  sessions, probe injection, capture, replay, analysis, store, MCP      │
 └────────────────────────────────────────────────────────────────────────┘
          ▲
          │ MCP / command line / control API
       agents
```

- **The host is its own process.** In CEF the Chromium browser process is the application, and Chromium deliberately ends it when the GPU process crashes too often (02-ARCHITECTURE.md, section 2.2). So the app can die; the host must not. When the app dies the host records it as a crash of the session's browser, as it does today, keeps every capture and recording, and relaunches the app at the same page if asked.
- **The host drives the app's Chromium exactly as it drives a launched Chrome.** Two ways, and stage 0 decides between them:
  1. The host starts the app with `--remote-debugging-pipe`, as it starts Chrome now. If CEF honours the switch in its browser process, the host's protocol client works unchanged and the app is, to the host, one more browser binary.
  2. Otherwise the app relays: it calls CEF's `SendDevToolsMessage` and passes the `AddDevToolsMessageObserver` stream back to the host over the control channel. The host's protocol client takes any reader and writer (`scanline-cdp`, `Client::new`), so this is a new transport, not new logic.
  Either way the protocol never listens on a port.
- **The interface talks to the host only through the control API**, for everything that changes anything. For speed it may read the capture store directly, read only (captures are immutable once written).
- **The app is started by the host or by the person.** Opened from the Dock it starts or finds the host, then opens a session in itself. An agent's `launch` shows its game in the app when the app is running (or when asked: `launch(display: "app")`), and in a launched Chrome otherwise, as now.

## 5. Browsers

- **Embedded.** The app carries one Chromium, through CEF: 156 at the time of writing, against 157 in Chrome Stable. A debugger running an older Chromium than players use can report different WebGPU limits, features and validation errors, so the version is always shown, and every measurement names it (as the profile is named now).
- **Updating the embedded browser.** CEF's stable API versioning lets an app built against one API version run with newer CEF binaries that support it. The app can download a newer CEF build (from the CEF builds CDN, checked against its published hash) beside the bundled one, and use it for new sessions. Behaviour can still differ between Chromium versions, so a newly downloaded build runs Scanline's self-check (the protocol, probe injection, a WebGL and a WebGPU fixture) before it is offered. The bundled build is never removed.
- **External browsers.** The app keeps today's mode: a launched Chrome, Chrome for Testing, Canary or Edge in its own window, with the app's panels working as normal. This is how to debug on today's Chrome the day it ships, or with a person's own profile and extensions.
- **Profiles** (`stock`, `deep`, `software`) apply to both. In CEF, Chromium switches are fixed when the browser process starts, so changing profile restarts the app's browser process; the host already restarts a launched browser for the same reason.

## 6. The window

```
┌───────────────────────────────────────────────────────────────────────────┐
│ ◀ ▶ ⟳  http://127.0.0.1:8765/game.html          ▮▮  ▶|  1×  ● Capture  ⚑ │
├───────────────────────────────────────────────┬───────────────────────────┤
│                                               │ Live │ Resources │ Captures│
│                                               │ Console │ Agent            │
│                                               ├───────────────────────────┤
│                  the game                     │  frame time   ▁▂▁▃▁▂▁     │
│        (Chromium's own view, unobstructed)    │  GPU time     ▁▁▂▁▁▁▁     │
│                                               │  draws        412         │
│                                               │  GPU memory   183 MB ▲    │
│                                               │  textures     96 (141 MB) │
├───────────────────────────────────────────────┤  …                        │
│ frame 1,204 · paused · WebGPU · Chromium 156 · stock · agent: idle         │
└───────────────────────────────────────────────┴───────────────────────────┘
```

- **Toolbar**: address and history; reload; pause, step one frame, step many; time scale; capture (now, or the next n frames into a recording); save run and replay; Debug (the hand-off key); who owns input, the person or the agent.
- **Live**: frame time, GPU time per pass, draws and calls per frame, GPU memory by category, texture and buffer counts, with a leak or churn warning where `memory()` gives one. History scrolls back over the session; pausing freezes it.
- **Resources**: every texture, buffer, shader, program or pipeline, sampler and framebuffer, filterable and sorted by size, each with the line that created it. A texture opens to its levels, layers and faces, paged with the arrow keys, with exact texel values under the pointer and the views (depth, stencil, a channel, a mip) the host can give. A buffer opens to a hex view and a typed view (float32, vec4, a struct layout taken from the shader that reads it), paged a screen at a time over the whole buffer.
- **Captures**: the session's captures and recordings. Opening one replaces the panels with the capture workspace (below); the game keeps its place on the left.
- **Console**: the page's console and errors by frame, repeats folded.
- **Agent**: the activity log: each call the agent makes, as it makes it, with its result. A request from the agent for the person (`request_human`) appears here and in the status bar.

**The capture workspace**: the draw list (each draw with the box it changed, and "changed nothing" marked), the target as it stood after the selected draw, and for that draw its state, shaders, uniforms or bind groups with values, bound textures and vertices. Pixel history on click. Compare two captures side by side. The "Worth a look" list first, as in the command line. A capture opens in its own window when wanted, and a capture file (`export`) opens the app when double-clicked.

**Look**: dark and light themes from the system, a dense profiler layout with clear type, and graphs that are drawn, not imaged. A visual direction (applications whose interfaces to learn from) will be added here once chosen.

## 7. Agents and the person together

- An agent connects to the host as now. When the app is open, the agent's session is in the app: the person sees the game the agent is playing, and every call the agent makes in the Agent panel.
- Both can act on the same session. The rules for input ownership and the control strip carry over: the toolbar takes the control strip's place.
- What the person does in the app is in the activity log too, so the agent can read it (`activity`) and see, for example, that the person captured frame 1,204 and selected draw 37.

## 8. Platforms and shipping

- **macOS** first, then **Windows** (the PC). Linux once both work; CEF and GPUI support it.
- **Bundle**: the app (with CEF's framework and its helper apps), and the `scanline` binary inside it, so the command line and MCP server come with the app. The plain `scanline` download stays for headless use.
- **Size**: a few hundred MB. Accepted.
- **Signing and notarisation**: CEF's nested helper apps each need signing, with the hardened-runtime entitlements Chromium's JavaScript compiler needs. The owner signs and notarises.
- **Security updates**: an embedded Chromium makes Scanline responsible for shipping Chromium's security fixes. The app loads pages the person chooses for debugging, not general browsing, but releases should still follow CEF's stable branch.

## 9. Risks

| Risk | What would show it | If it happens |
|---|---|---|
| A CEF native child view does not sit properly inside a GPUI window (focus, resizing, high-DPI, keyboard shortcuts) | Stage 0, tests 1 and 7 | Fix in the app's windowing code; GPUI exposes the native window handle. |
| Neither the pipe nor the relayed protocol reaches workers (Scanline needs `Target.setAutoAttach` at browser level for shared and service workers) | Stage 0, test 2 | Relayed protocol for the page and its dedicated workers; shared and service workers documented as a limit of the embedded browser. |
| Frame pacing in CEF differs from Chrome's | Stage 0, test 3 | Investigate CEF's settings; until then, measurements point to an external browser. |
| `gpui` is pre-1.0 and changes under us | Every update | Pin versions; keep the interface code in one crate. |
| `cef` bindings lag a Chromium release | CEF builds page | Use the newest CEF build through API versioning (section 5). |

## 10. Stages

**Stage 0: the prototype.** Throwaway code in `prototypes/app/`, outside the Cargo workspace, so it cannot affect the build or the tests. It does not use the host. It answers one question: can a GPUI window hold a real Chromium running a game, and drive it over the DevTools protocol from native controls, well enough to build on?

It has: a GPUI window with an address field and buttons (Go, Reload, Pause, Resume, Screenshot); the game in a CEF view on the left; a panel on the right showing the frame rate (from the page, through the protocol), the WebGL or WebGPU adapter, the page's console messages, the last screenshot, and a list of 10,000 rows.

It passes when:

1. **The view.** The game runs in a CEF windowed view inside the GPUI window and stays correct through resizing, moving between displays and high-DPI; keyboard input goes to the game when it has focus and to the native controls when they do.
2. **The protocol.** Native buttons drive the page over the protocol in process: `Runtime.evaluate`, `Page.captureScreenshot`, `Page.addScriptToEvaluateOnNewDocument` (pausing by holding `requestAnimationFrame`), console events. Recorded: whether CEF honours `--remote-debugging-pipe`; whether `Target.setAutoAttach` reaches a dedicated worker and a shared worker.
3. **Timing.** On the same machine and display, a WebGL fixture and a WebGPU fixture run at the same frame rate, with the same frame-time spread, as in Chrome.
4. **Crashing.** What happens to the app when the GPU process is crashed repeatedly (`chrome://gpucrash`): recorded, not fixed.
5. **Scrolling.** The 10,000-row list scrolls at the display's rate while the game runs.
6. **Cost.** Start-up time to first frame, memory, and the size of the built app: recorded.
7. **Windows.** Tests 1 to 5 on the PC.

The results go in `docs/spikes/RESULTS.md`. If test 1 or 2 fails beyond repair, the fallback is Electron, with the interface in web technology; the rest of this document still applies.

**Stage 1: the shell.** The app proper (`crates/scanline-app`): window, toolbar, game view, the host started and supervised, the protocol path chosen in stage 0, sessions opened from the app and from agents, the status bar, the Console and Agent panels.

**Stage 2: inspection.** Live, Resources (texture browser, buffer explorer) and Captures, with the capture workspace. Anything the panels need that the host lacks is added to the host as a tool first.

**Stage 3: finish.** Themes and the visual direction, menus and shortcuts, several windows, recent pages, capture files opening the app, embedded-browser updates, signing and notarisation, Windows parity, then Linux.

## 11. Open questions

- Should an agent's `launch` use the app whenever it is running, or only when asked?
- One session per window, or tabs?
- Where the visual direction comes from: the owner has offered examples of applications with interfaces worth learning from.
