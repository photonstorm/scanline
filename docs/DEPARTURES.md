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

## Added, not in the specification

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
