# Where the build departs from the specification

The specification was written from documents and source code, before anything was run. This file lists where the code now differs from it, and why. Each entry should end up as a change to the specification.

## Changed because a spike showed the design was wrong

| The specification says | The code does | Why |
|---|---|---|
| Inject into a worker by evaluating the probe while the worker is held at start, then releasing it. | Hold the worker, set an instrumentation breakpoint for its first statement, release it, evaluate the probe at that pause, then switch the debugger off. | A worker held at start has no WebGPU interfaces yet, so they could not be hooked, and reading `self.location` in it blocks forever. Spike S1. |
| `Target.setAutoAttach` on the page reaches every worker. | Auto-attach is also set on the browser session, and targets are filtered by URL scheme. | Shared and service workers are not children of the page. Browser-level attach also catches the browser's own UI and extension workers, which must be left alone. Spike S1. |
| While the agent owns input, ignore the person's with `Input.setIgnoreInputEvents`, if injected events pass through it. | Not built yet. The probe-side filter is now the plan. | `Input.setIgnoreInputEvents` drops injected events too. Spike S4. |
| Key events send `key`, `code` and the legacy key code. | They send `key`, `code` and `windowsVirtualKeyCode` only, never `nativeVirtualKeyCode`. | With a native key code set, a key event with no text left the next mouse event unacknowledged on macOS. Spike S4. |
| "Wait for the acknowledgements, then release the frame" makes input frame-exact. | The same, for now. | A wheel event is acknowledged before the page receives it, so acknowledgement is not proof of delivery. The host should confirm through the probe's input recorder. Not done yet. Spike S4. |
| The probe replaces `requestAnimationFrame` with a queue. | Each page callback is registered natively, one for one; the gate decides when the native frame fires whether to run or hold it. | Keeps the browser's own ordering and the microtask checkpoint after each callback, which a probe-side queue flushed in one task cannot. |
| Overhead budgets are percentages of CPU frame time (1%, 5%, 15%). | Budgets are absolute costs per graphics call: see "Overhead budgets" below. | On a frame that is nothing but graphics calls, 6–8 ns per call is 16–29%, so a percentage measures the benchmark, not the tool. Decided 10 November 2026 (the owner left the choice to the build). Spike S9. |

## Overhead budgets

Decided 10 November 2026, replacing the percentages in the PRD (section 9.1). They are averages over the calls of a frame, measured by `spikes/s9-overhead.mjs` on the reference machine (Apple M6, Chrome 157).

| Level | Budget per graphics call | On a 2,000-draw frame (10,000 calls) | As a share of a 60 Hz frame |
|---|---|---|---|
| `off` | 5 ns | 0.05 ms | 0.3% |
| `observe` | 25 ns | 0.25 ms | 1.5% |
| `record` | 100 ns, not counting the copy of data a write carries | 1 ms | 6% |

- The `observe` budget has to hold with the registry and shadow state on, not only the counters measured in spike S9 (6–8 ns).
- Work done once per frame (counters, timing queries) is budgeted separately: 50 µs a frame at `observe`.
- Creating an object may cost more (a call site is recorded): 5 µs per creation. A page that creates thousands of objects a frame pays for it, and that page has a bug Scanline should be reporting.

## Changed for now, to be revisited

| The specification says | The code does | Why |
|---|---|---|
| The MCP server uses the `rmcp` crate and speaks revisions 2025-11-25 and 2026-07-28, over stdio and loopback HTTP. | A small hand-written JSON-RPC server over stdio, speaking revisions up to 2025-11-25. | Quickest route to a working, tested front end. It depends only on tools, text, images and instructions. Moving to `rmcp` gains the stateless 2026 revision and HTTP. |
| Bulk data travels on a loopback binary WebSocket. | Images travel through the protocol as gzip-compressed base64. | The architecture's stated fallback. Fine for canvas-sized images; captures will need the fast channel. Spike S2 has not been run. |
| The protocol client uses types generated from the protocol definition. | Commands and events are `serde_json::Value`. | Few commands are used, each wrapped where it is called. |
| The default browser is a pinned Chrome for Testing, downloaded on first run. | The installed Chrome, Edge or Chromium is found and used. | No download step exists yet. Spike S10 has not been run. |
| Tool names are prefixed `gfx_` everywhere. | `gfx_` in MCP; bare names on the command line and in the control API. | The prefix exists to avoid clashes among an agent's tools. |
| `gfx_step`'s `observe.screenshot` takes `{scale, region}`. | It takes the screenshot command's own arguments (`max_edge`, `region`, `zoom`). | One set of image arguments to learn. |
| Every call names its session. | The session may be left out when exactly one is open. | The specification's own command-line examples leave it out. With two open, the error lists them. |
| The window (`scanline` with no arguments starts the app). | No window. `scanline serve` runs the host; the other modes start it. | Milestone 4. |
| Windows 11 and macOS. | macOS only. The pipe launch for Windows (inherited handles) is not written. | Nothing here has been run on Windows. |
| Capability tiers, an origin allow-list, `file://` access limited to the launched file's directory. | None of these. `eval` is always available. | Milestone 7. Until then, treat a session as able to do anything the page can. |
| The probe records a rolling tail of command names, so a crash can be pinned to its last call. | Not built. A crash is reported as an event with no last call. | Comes with the capture level. |

## Milestone 2 against its exit criteria

"For every page in the matrix, the texture and buffer lists are complete (checked against known scenes), every texture can be previewed, and WebGL shadow state passes its verify check after 1,000 frames."

| Criterion | Standing |
|---|---|
| Lists complete, checked against known scenes | Met for the pages there are: the inventory fixtures have known objects and the tests count them. The matrix still lacks PlayCanvas, a Unity build and an Emscripten build. |
| Every texture can be previewed | **Not met.** Colour textures in 8-bit, float and integer formats are read back on both APIs. Compressed, depth, stencil and multisampled textures are not: they need a sampling pass or a decoder, neither built. WebGL 1 buffers cannot be read at all (the API has no call for it). |
| Shadow state verifies after 1,000 frames | Met: no drift on eight WebGL pages (raw WebGL 1 and 2, a worker, three.js, PixiJS, Phaser, Babylon.js). `node spikes/m2-verify.mjs`. |

Also from the milestone's list, not built: WGSL reflection (the plan's `scanline-shader` crate and `naga`), the real memory of the GPU process, and GPU time per pass on WebGL (queries cannot nest, so it needs one query per framebuffer span). WebGL shader reflection comes from the driver (active attributes and uniforms), which needs no parser.

## Milestone 3 against its exit criteria

Built for WebGL 1, WebGL 2 and WebGPU: the capture, the store (BLAKE3-named, zstd-compressed blobs and one SQLite database per capture), the replay page, and the commands `capture`, `captures`, `draw_list`, `draw`, `draw_diff`, `pixel_source`, `pass_tree`, `query`, with `screenshot` and `pixels` taking a capture and a draw.

"Replay matches the original on every matrix page, or reports why not. An agent diagnoses the 'wrong pixels' class of planted bugs with no hints."

| Criterion | Standing |
|---|---|
| Replay matches on every matrix page | Met for the pages there are: eight on WebGL, and on WebGPU the two raw pages, three.js and PixiJS. Babylon.js on WebGPU, a device in a worker, and the engines the matrix still lacks are untried. |
| Or reports why not | Met: every capture is replayed once when taken and compared with the frame's own image, the verdict is stored with it, and replay answers carry a warning when it failed. |
| An agent diagnoses the planted bugs with no hints | Met for the bugs there are: twelve, in one small WebGL scene (`fixtures/bugs/`), all diagnosed by agents using only the command line, in a median of 8.5 commands. `evals/results/README.md` has both rounds and their limits. There is no runner that starts the agents; the rounds were started by hand. |

Differences from the specification:

| The specification says | The code does | Why |
|---|---|---|
| Start-of-frame contents are recovered from end-of-frame contents and the recorded writes. | End-of-frame contents are used as they are, and the frame's writes are replayed over them. Render targets are also read before the frame. | The same result in the common cases with no reconstruction step. See the spike for where it can fail. |
| "Which draw produced this pixel" comes from a draw-ID pass with rewritten fragment shaders. | The pixel is read after every event on its target. | No shader rewriting, true values, and it gives before and after for each change. Slower: 0.3 ms an event. |
| The pass tree uses debug groups, labels, target changes and adapter knowledge. | Passes are runs of events on one target. | WebGL has no debug groups; the rest needs the page protocol and adapters. |
| The command stream is `stream.bin`. | It is `stream.zst`: the capture as JSON, compressed, with data in the blob store. | Simple, and the replay page takes it as it is. |
| Full-size intermediate targets are not stored; thumbnails of each target at pass ends are. | Only the frame's final image is stored. Intermediate targets come from replay. | Replay is fast enough that thumbnails have not been needed. |
| The replay page is at an internal URL. | It is a hidden page at `https://replay.scanline.invalid/`, a request the host answers itself and nothing fetches. | WebGPU exists only in a secure context, which `about:blank` is not. |
| A WebGPU capture is replayed onto a canvas. | The replay has no canvas: where the page called `getCurrentTexture`, it gets an ordinary texture of the same size and format. | A canvas's texture expires when the task ends, and reading a target back takes several. |
| (Not said.) How a WebGPU target is seen part-way through a frame. | The replay splits the frame at that point: it ends the open pass, finishes and submits every encoder so far, reads, then opens new encoders and a pass that loads what the old one stored and has the same state set. | WebGPU does nothing until commands are submitted, and a pass cannot be read while it is open. |
| WebGPU objects are recreated from recorded creation calls. | From the descriptors the registry already keeps for the inventory, made lossless: object references, views with their textures, layouts taken from pipelines. | One record serves both. |

Also true of what is built:

- A capture carries its own table of method names, so it stays readable when a later version numbers methods differently.
- The `draws` table holds clears and blits as well as draws, since all three change pixels. `kind` tells them apart.
- `draw_list`'s filter is a SQL condition on the `draws` table, not a language of its own. The database is opened read-only.
- Replaying a capture needs a live browser, and any open session's will do. Reading what the capture says needs none.
- Textures in formats that cannot be read back (luminance and alpha formats, compressed, depth, integer) are replayed empty. The capture's replay check then fails and says why. A sampling pass would fix the first two.
- Each replay makes a fresh context and recreates every object. Keeping one context per capture and running forwards from where it stands would make repeated questions cheaper.
- WebGL 1 buffers now have a copy kept of every upload, as the specification asks, so they can be read and captured. This doubles the memory of WebGL 1 buffers while Scanline is attached.

## Milestone 4 so far

"The hand-off journey (J2 in the PRD) works end to end on both platforms with no manual step. A recorded two-minute session of a deterministic fixture replays to the same frame hashes."

| Criterion | Standing |
|---|---|
| The hand-off journey works end to end | Works on macOS, in tests, on the planted flicker (`fixtures/bugs/b13.html`): the agent asks, the page runs, Debug freezes it and captures the frame, the recording names the three frames that flicker, and each can be taken apart. Confirmed with a person at a visible window on 11 November 2026: a real F9 press froze the page, 128 frames were kept, and the recording named the four that flicker. The tests run it headless, with the press sent as a command or as a key event. No Windows. |
| A recorded two-minute session of a deterministic fixture replays to the same frame hashes | Met on `fixtures/matrix/game.html`: 7,200 frames with 160 key presses and 103 clicks replay with all 240 fingerprints matching and every number the game holds identical to the last bit, in about six seconds. Also met for a session played live, not stepped. Tests cover a shorter one. |

Built: `request_human`, `wait` on a request, `debug`, `recording`, `take_control`, the event queue, annotation passed with the press, the Debug key, the flight recorder for WebGL and WebGPU, one owner of the input at a time as far as the agent's commands go, runs (`save_run`, `replay_run`) with divergence detection, and stepping that does not wait for the display.

Not built from the milestone's list: the window and its control strip; the gamepad shim and the pointer-lock route; in-page policy scripts; recorded network for deterministic sessions; capture triggers; audio and worker time control beyond what milestone 1 has.

| The specification says | The code does | Why |
|---|---|---|
| Debug is a global hotkey registered with the operating system. | The probe takes the key (F9 by default) in the page, ahead of the page's own listeners, so the page never sees it. | No window process exists yet to own a hotkey. It works while the page has the keyboard, pointer lock and fullscreen included, and not when another window does. |
| The person sees the instruction and a Debug button in a control strip. | The instruction is in `status` and the event queue; nothing is shown to the person. | Needs the window. Until then the agent has to tell the person what it asked, in its own reply. |
| While the agent owns input, the person's is ignored. | The agent is refused `step`, `resume`, `run_until`, `input` and `navigate` while the person owns input. The person's input is never blocked. | The filter belongs in the probe and has not been written. |
| The flight recorder keeps the last N frames. | It records in runs of 30 frames, each beginning with a snapshot of the state, and drops whole runs, so it holds between N and N + 30. | A recording has to be replayable from its first frame, which needs the state as that frame began. Snapshotting every frame would cost too much; every 30th is cheap. |
| Resources destroyed inside the window are kept alive until they leave it. | Not done. An object the page drops is held, but one it deletes is gone, and is empty in the replay. | WebGL would need the contents read at the moment of deletion, WebGPU the destroy deferred. |
| The recording has thumbnails taken as the frames went by. | None are taken live. `recording` replays the frames once and reads each one's picture then. | Reading the canvas every frame stalls the page. Only the frozen frame has a picture from the page, so only it checks the replay. |
| `record` is an overhead level. | The recorder is started and stopped by `request_human` and Debug at whatever level the session has. | It is on only while a person is hunting something. |

About runs and deterministic sessions:

| The specification says | The code does | Why |
|---|---|---|
| A deterministic session has a seeded random source and a fixed virtual timestep. | Also a fixed origin: page time starts at 0 and the date at 1 January 2026 (UTC). | The clock used to start from whenever the page happened to load, so two runs read times a few milliseconds apart. A game that used the time itself, not only the difference between frames, drew different frames. |
| Divergence is found by comparing per-frame draw counts and thumbnail hashes. | A fingerprint (a hash of the canvas, the draw count, the call count) is taken every 30th frame of a deterministic session, and a replay is compared with them as it goes. | Reading the canvas every frame would stall the page. A replay stops within 30 frames of where it parted. |
| Replay is unpaced. | `step` and `replay_run` have a fast mode that runs each frame as the next task instead of waiting for the display. | Stepped frames otherwise run at the display's rate, so replaying two minutes took two minutes. |
| Network responses are recorded and replayed at the frame they first arrived. | Not built. | A page that loads something while it runs may part from its recording. The replay says so. |

Fast frames are not presented one by one, so a page that depends on the browser clearing its drawing buffer between frames draws over its last frame in fast mode. Its fingerprints then differ from a run recorded at normal speed, and the replay reports that as a divergence.

While adding fast mode a fault was found in frames the probe runs by hand (which it already did for a hidden window): each was stamped with the real time, which the browser coarsens to 100 µs, so two run back to back could be taken for one. They are now numbered.

Measured cost of recording, with `node spikes/s9-overhead.mjs` (Apple M6, Chrome 157), against a budget of 100 ns per graphics call:

| API | Calls per frame | Recording, per call | A 2,000-draw frame costs |
|---|---|---|---|
| WebGL 2 | 10,002 | about 220 ns | 2.2 ms more |
| WebGL 2 | 50,002 | about 205 ns | |
| WebGPU | 4,008 | about 430 ns | 1.7 ms more |
| WebGPU | 20,008 | about 136 ns | |

Over budget on both. Most of it is the row of state built at every draw (WebGL copies the program's uniform values each time). Building those rows when the recording is taken, from the calls, would bring it down; that is not done. The same run measured `observe` at 22 to 55 ns a call, noisier than the 17 measured before, on a machine that was doing other work.

A frame taken from a recording is replayed from the recording's first frame. That is simple and exact, and it makes questions about late frames of a heavy scene slow: a keyframe every so often would fix it.

## WebGPU capture: what it does not do

- Which test rejected a draw that changed nothing. The tests are part of the pipeline, so trying a draw without one means building the pipeline again without it.
- Uniform values by name. That needs WGSL reflection, which is not built. `draw` lists what each bind group holds.
- Render bundles built before the captured frame, and external textures. The calls that use them fail in replay and the summary says so.
- The contents of depth, stencil, multisampled and compressed textures. They are empty in replay; a pass normally clears them.
- Buffers and storage textures the GPU wrote in an earlier frame (a compute simulation) are captured as the frame left them, not as it found them, so such a frame replays one step ahead. Render targets are read before the frame. The replay check shows when this matters.
- More than one device in a capture. Calls on another device's objects are left out.
- A call rejected in replay is found by wrapping every call in an error scope. WebGPU reports most errors when an encoder is finished, so the call named is `finish`, with the browser's message saying which pass call was at fault.

## Added, not in the specification

- **A capture says what is worth a look.** The specification puts lints in milestone 5. A first set came out of the evaluation and is built: draws that changed nothing, rejected calls and feedback loops, a viewport that is not its target's size, a clear clipped by a scissor box left on, a blended draw with opaque ones drawn over it, blending off on a translucent colour, a bound texture that cannot be sampled, and what the frame created and deleted. Each is worded as a fact about the frame, not a verdict.
- **What every event changed is measured when the capture is taken**, by reading its target back around each event in one more replay. `draw_list` shows it. A frame too large for that (more than about 600 million pixels read) goes without, and `draw` measures one event when asked.
- **A draw that changed nothing is replayed with each test off in turn**, so `draw` can say which test rejected it. This stands in for part of pixel history.
- **`draw` says where each uniform and each texture binding came from**: the call that set it, and whether that call was for this draw or an earlier one.
- **`resources` and `memory` flag leaks and churn** from the registry: many live objects created by one line over many frames, or far more objects created than are alive.
- **Call arguments in a capture's `commands` table are stored for reading**: handles for objects, `prg_1.name` for uniform locations, WebGL's names for the enumerated arguments of the common methods.
- **A command waits for the events the browser sent before its reply.** Replies and events are handled by different tasks, so `step` could otherwise report no errors for a frame that raised one.

- **A page that draws from timers alone still steps.** A frame is "the clock moves, the frame callbacks run, then the timers that have come due run", so a loop on `setTimeout` pauses and steps like any other.
- **Errors carry the frame they were thrown in.** The browser reports an uncaught error after the probe's end-of-frame work, by which time the frame number has moved on. The probe notes the throw as it passes.
- **Frames are numbered from 1**, and everything that happens during a frame carries the number of the image it produces.
- **A command with no reply times out with its name** (30 s), after spike S4 met one.
- **`status` reports the browser's and the GPU process's process IDs**, which telemetry will need and the crash tests use.
- **Object handles are the probe's own numbers** (`tex_17`), with a suffix for objects in a worker or another frame (`tex_17_w2`). The host remembers which page load each handle it has shown came from, so a handle from before a reload is refused with a message, as the specification asks.
- **`resource` takes a context handle** and returns the WebGL state a draw would use now, from the mirror. `verify: true` checks the mirror against the context.
- **Texture rows are shown the way they were rendered.** A WebGL render target's first row is its bottom, so it is flipped for display and for `pixels`; `flip: false` gives storage order.
- **The probe's records ride on the page's objects as private class fields**, one generated class per kind of object. A shared lookup saw every type of object and cost about 75 ns a call; one class per kind costs about 17.
- **A page's own timer queries win.** Only one can be active, so when the page begins one, Scanline ends its own and stops timing that context.

## Known gaps in what is built

- Unlabelled WebGPU objects are not given generated labels, which the specification lists as a modification. They are named by handle in results instead.
- "Last used" is tracked for WebGL objects (at bind, and once a frame for what is bound when drawing). WebGPU needs the pass recording of the capture level.
- WebGPU pass timing measures one frame at a time: a frame that ends while the previous readback is in flight goes unmeasured (about one frame in three at 60 Hz here).
- Timer queries and timestamp writes are only added at the `observe` level and above, and never in unmodified mode.
- If a WebGL 2 page has set the default framebuffer's read buffer to `NONE`, the readback raises a GL error the page can see.
- Step broadcasts to every probe at once (frames and workers) but does not keep them in step with each other frame by frame.
- Console lines are tied to frames by wall-clock time against the top frame's record, so a line logged within a millisecond of a frame boundary can be one frame out. Errors are exact.
- `document.timeline` and event time stamps do not read the virtual clock yet.
- Media elements are not paused with the clock; audio contexts are.
