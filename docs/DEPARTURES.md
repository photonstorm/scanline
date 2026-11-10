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
| Overhead budgets are percentages of CPU frame time (1%, 5%, 15%). | Unchanged, but see the recommendation. | On a frame that is nothing but graphics calls, 6–8 ns per call is 16–29%. The budgets should be absolute. Owner's decision. Spike S9. |

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

## Added, not in the specification

- **A page that draws from timers alone still steps.** A frame is "the clock moves, the frame callbacks run, then the timers that have come due run", so a loop on `setTimeout` pauses and steps like any other.
- **Errors carry the frame they were thrown in.** The browser reports an uncaught error after the probe's end-of-frame work, by which time the frame number has moved on. The probe notes the throw as it passes.
- **Frames are numbered from 1**, and everything that happens during a frame carries the number of the image it produces.
- **A command with no reply times out with its name** (30 s), after spike S4 met one.
- **`status` reports the browser's and the GPU process's process IDs**, which telemetry will need and the crash tests use.

## Known gaps in what is built

- A WebGL readback restores the state it disturbs by asking the context for it (`getParameter`). The shadow state of milestone 2 replaces those calls.
- If a WebGL 2 page has set the default framebuffer's read buffer to `NONE`, the readback raises a GL error the page can see.
- Step broadcasts to every probe at once (frames and workers) but does not keep them in step with each other frame by frame.
- Console lines are tied to frames by wall-clock time against the top frame's record, so a line logged within a millisecond of a frame boundary can be one frame out. Errors are exact.
- `document.timeline` and event time stamps do not read the virtual clock yet.
- Media elements are not paused with the clock; audio contexts are.
