# Spike results

The build plan lists ten experiments to run before milestone 1, each answering a question the design could not settle from documents. This file records what was run, on what, and what it found.

Run on 10 November 2026 on macOS 27.2, Apple M6, installed Google Chrome 157.0.8103.39 with a disposable profile, launched over `--remote-debugging-pipe`. **Every run so far was headless.** Windows has not been tested. Where a result needs a visible window it is marked as not yet run.

| Spike | Question | Status | Result |
|---|---|---|---|
| S1 | Can the probe reach every frame and worker before page code? | Run (macOS, headless) | **Pass in all 13 cases**, after two changes to the injection recipe. |
| S2 | How fast can capture data leave the page? | Not run | |
| S3 | Do the frame gate and virtual clock hold on real engines? | Run (macOS, headless) | **Pass on 12 pages.** Unity and Emscripten builds not tried. |
| S4 | Does protocol input behave like real input? | Partly run (headless) | Trusted and activating: **pass**. Two findings change the design. Pointer lock, fullscreen, and "window covered" need a headed run. |
| S5 | Can replay give GPU-true answers at acceptable cost? | Run for WebGL (macOS, headless) | **Pass on 10 pages:** the replayed frame is identical to the original, pixel for pixel. 2,000 draws replay in 10 ms. WebGPU, pixel history, depth and compressed readback are not done. |
| S6 | Are GPU timings usable? | Not run as specified | Learned in passing: timer queries exist for WebGL 1 and 2 and `timestamp-query` for WebGPU on this machine, in the stock profile. WebGPU timestamps there move in steps of 65,536 ns. Repeatability, amplified per-draw timing and the shader dump are untested. |
| S7 | Is the two-window model good enough? | Not run | Needs the host's window. |
| S8 | Can real GPU memory be attributed to the page? | Not run | |
| S9 | What do the hooks cost? | Run (macOS, headless) | 4–8 ns per WebGL call at `observe`; within noise for WebGPU. Over the PRD's 5% on a frame that is nothing but calls, so the budgets were restated as costs per call. See below. |
| S10 | Can a pinned browser be shipped? | Not run | The spikes use the installed Chrome, which works with its own profile directory. |

Run them again with:

```bash
npm run build:probe
```

```bash
node spikes/s1-injection.mjs
```

```bash
node spikes/s3-time.mjs
```

```bash
node spikes/s4-input.mjs
```

```bash
node spikes/s5-replay.mjs
```

```bash
node spikes/s9-overhead.mjs
```

Add `--headed` to any of them for a visible window. `s4-input.mjs --headed` takes pointer lock and fullscreen for a moment.

## S1. Injection

**Method.** `fixtures/spikes/s1.html` starts every kind of context. The first line of each asks whether the probe's entry point already exists, and reports back to the page. The launcher is `spikes/lib/session.mjs`.

**Result.** The probe ran first in: the main frame; a classic, a module, a blob and a nested dedicated worker; a worker that makes an OffscreenCanvas context; a shared worker; a service worker; a same-origin, a cross-origin, a sandboxed and a `srcdoc` iframe.

**What the design had wrong, and the recipe that works.**

1. **Workers must not get the probe at attach.** A worker held by `waitForDebuggerOnStart` has an incomplete global: the WebGPU interfaces (`GPUDevice` and the rest) are not there yet, so the probe cannot hook them, and reading `self.location` blocks forever (the evaluate never returns and the worker never starts). The architecture's recipe, "`Runtime.evaluate` of the probe in the worker, then `Runtime.runIfWaitingForDebugger`", therefore leaves WebGPU unhooked in every worker.
2. **Instead, stop the worker at its first statement.** On attach: `Runtime.enable`, `Runtime.addBinding`, `Debugger.enable`, `Debugger.setInstrumentationBreakpoint { instrumentation: "beforeScriptExecution" }`, `Target.setAutoAttach` (it is not recursive), `Runtime.runIfWaitingForDebugger`. On `Debugger.paused` with reason `instrumentation`: `Runtime.evaluate` the probe, then `Debugger.disable`, which resumes the worker. At that point the global is complete. Verified for classic and module workers: all 13 interfaces are hooked, WebGPU among them.
3. **Shared and service workers are not children of the page target.** They only appear with `Target.setAutoAttach` on the browser session as well. That also attaches things Scanline must leave alone (the browser's own UI targets, and extension service workers), so the host filters by URL scheme and still calls `runIfWaitingForDebugger` on everything.
4. **Launch with `--disable-extensions --disable-component-extensions-with-background-pages`.** Branded Chrome otherwise starts three extension service workers of its own.

**Confirmed as designed.**

- `Page.addScriptToEvaluateOnNewDocument` runs before the first page script in the main frame and in every iframe, including out-of-process ones (each is its own target and needs the script added on its own session).
- The `Runtime.addBinding` function exists before the probe runs and can be deleted from the global, after which the probe's saved reference still works. Nothing named `scanline` is enumerable on the page's global. The probe's entry point is one non-enumerable symbol-keyed property.
- Wrapped functions report native source, name and length (`performance.now.toString()` is `function now() { [native code] }`).

**Not tested.** Windows. Worklets (audio, paint). A worker created inside an out-of-process iframe.

## S3. Frame gate and virtual clock

**Method.** `spikes/s3-time.mjs`. For each page: pause and check nothing moves for 400 ms; step 1 frame; step 100 frames; wait 600 ms; resume and check the engine's own clock saw no jump. Each page publishes its frame count and the engine's own elapsed time and last delta.

**Result.** All four checks pass on all twelve pages:

| Page | Contexts found | Step of 100 frames |
|---|---|---|
| Raw WebGL 1, WebGL 2, WebGPU | one each | exactly 100 frames, 16.667 ms each |
| Timer loop, no `requestAnimationFrame` | WebGL 1 | 100 frames, 16.667 ms each, in 4 ms of real time |
| Render loop in a worker (OffscreenCanvas) | WebGL 2, in the worker's probe | exactly 100 |
| three.js 0.187, WebGL and WebGPU renderers | as expected | exactly 100 |
| PixiJS 8.22, WebGL and WebGPU renderers | as expected, plus the 2D and probing contexts PixiJS makes | exactly 100 |
| Phaser 4.2.1, WebGL and Canvas renderers | as expected | exactly 100 |
| Babylon.js 9.35, WebGL 2 | one | exactly 100 |

- Pause lands within one frame. Resume shows no jump: the first delta after a 600 ms pause is one frame (16–17 ms).
- A step is paced by the display (100 frames take about 1.66 s) because each stepped frame is a real browser frame. Pages with no frame callbacks step as fast as their timers can run.
- The frame gate is not a queue of the probe's own. Each page callback is registered natively, one for one, and the gate decides when a native frame fires whether the page's callbacks run or are held. This keeps the browser's own ordering and its microtask checkpoint after each callback. The architecture describes "a queue"; the code is the better design and the document should follow it.
- A page that draws from timers, with no frame callbacks at all, still pauses and steps: a frame there is "the clock moves, then the timers that have come due run".

**Not tested.** A Unity WebGL build and an Emscripten build (none to hand). Audio (the probe suspends and resumes audio contexts; no check listens for stuck audio). A headed window, and a covered or minimised one. `Emulation.setVirtualTimePolicy`, which the plan asked to be recorded for reference.

**Known limits, as the architecture predicts.** Loops on `MessageChannel` or `scheduler.postTask` are not gated. Code that busy-waits on `performance.now()` inside one frame will spin forever while the clock is frozen, since time does not move within a stepped frame.

## S4. Input

**Method.** `spikes/s4-input.mjs` injects keyboard, mouse, wheel and touch events through the `Input` domain into `fixtures/spikes/s4.html`, which logs what arrives and what each event was allowed to do. Chrome is started with autoplay locked, so user activation has to be earned.

**Result (headless).**

| Question | Answer |
|---|---|
| Are injected events trusted? | Yes: key, mouse, wheel and touch all have `isTrusted` true. |
| Do they count as user activation? | Yes. A suspended `AudioContext` resumed from an injected click. |
| Movement deltas without pointer lock | `movementX` and `movementY` are derived from successive positions, as hoped. |
| Does `Input.setIgnoreInputEvents(true)` let injected events through? | **No.** It drops them too: nothing reached the page while it was on. |
| Multi-touch | Works with no touch emulation switched on. Two points gave two `pointerdown` and `touchstart` events. |
| Does the probe's recorder see injected input? | Yes, by frame. |
| Are events delivered while the frame gate is paused? | Yes. Keys, moves and wheels are all acknowledged and delivered with the page paused. |

**What this changes.**

1. **Locking the person out needs the probe.** `Input.setIgnoreInputEvents` cannot separate the person from the agent, so the architecture's fallback becomes the plan: a filter in the probe that admits only events the host has announced.
2. **Never send `nativeVirtualKeyCode`.** With it set (to the Windows key code), any key event that carried no text left the *next* mouse event unacknowledged, every time, on macOS. Without it everything is acknowledged in under 40 ms. `windowsVirtualKeyCode`, `key` and `code` are enough.
3. **Give every protocol command a reply timeout.** The stall above looked like a hang in the page until the client named the command that got no reply.
4. A wheel event is acknowledged before the page receives it. "Wait for the acknowledgement, then release the frame" is not enough for wheels; the host should confirm delivery through the probe's recorder.

**Not run: needs a visible window.** Pointer lock (`WrongDocumentError` headless), fullscreen (`not granted` headless), relative motion under pointer lock, whether frames flow when the window is covered or minimised. An explicit `movementX` on `Input.dispatchMouseEvent` is ignored, so if position-derived deltas do not work under lock, the probe shim is the route.

## S5. Replay

The plan asked for a hand-built capture. Instead the real capture path was built for WebGL and tested, since the question (does a replayed frame match?) is the same and the code is kept.

**Method.** `spikes/s5-replay.mjs`. For each page: capture one frame through the probe; open a hidden page in the same browser (`Target.createTarget` with `hidden: true`); give it the capture; run it; compare the replay's final image with the frame's own, byte for byte. Then ask for the picture after the middle event, and for every event that changed the centre pixel.

**Result.**

| Page | Calls | Draws | Capture | Replay | Final image | Trace of one pixel |
|---|---|---|---|---|---|---|
| Raw WebGL 1 | 16 | 5 | 50 ms | 6 ms | identical | 3 ms |
| Raw WebGL 2 | 6 | 1 | 39 ms | 4 ms | identical | 1 ms |
| WebGL 1 on a timer | 16 | 5 | 12 ms | 6 ms | identical | 8 ms |
| Inventory (render target, float texture) | 19 | 1 | 42 ms | 5 ms | identical | 2 ms |
| three.js | 13 | 3 | 68 ms | 6 ms | identical | 4 ms |
| PixiJS | 8 | 1 | 49 ms | 9 ms | identical | 4 ms |
| Phaser | 4 | 1 | 40 ms | 6 ms | identical | 3 ms |
| Babylon.js | 18 | 3 | 43 ms | 6 ms | identical | 4 ms |
| 2,000 unbatched draws | 10,002 | 2,000 | 68 ms | 10 ms | identical | 641 ms |
| 10,000 unbatched draws | 50,002 | 10,000 | 126 ms | 15 ms | identical | 3,089 ms |

- **Replay matches.** On the same GPU, driver and ANGLE, running the recorded calls against the recorded contents gives the same image, bit for bit, including multisampled default framebuffers.
- **Cost is well inside the budgets.** Capture of a 2,000-draw frame takes 68 ms against a budget of 2 s. A replay is a fresh context each time and still takes 10 ms.
- **"Which draw produced this pixel" needs no shader rewriting.** Reading the pixel after every event on its target finds each event that changed it, with the value before and after, and the last is the answer. It costs about 0.3 ms an event: 0.64 s for 2,000 draws, against a target of 0.5 s. The draw-ID pass the specification describes would be one read instead of 2,000, but has to rewrite fragment shaders; it is worth building only if this proves too slow.
- **A hidden target works as the replay page.** It has no window and renders with the real GPU.

**What the capture relies on, and where that can fail.**

- Contents are read when the frame ends, not when it starts. An object's contents at the end are its contents at the start plus the frame's own writes, and replay repeats those writes. This is wrong only where a frame reads data left by an earlier frame and overwrites it later in the same frame.
- Render targets are the common case of that (a frame that samples the last frame's result), so their contents are also read before the frame.
- A page whose drawing happens in timers is recorded through to the end of the timers that came due with the frame. The first version stopped at the frame boundary and recorded nothing.
- An image, canvas or video the frame uploads is copied through a 2D canvas, which can change translucent pixels by one step.

**Not tested, from the spike's list.** WebGPU. Pixel history with rejected fragments and `discard`. Readback of depth formats, multisampled samples and compressed textures. Vertex stage output. A frame that samples a texture in a format that cannot be read back (it is replayed empty and the capture's replay check reports the difference).

## S9. Hook overhead

**Method.** `fixtures/spikes/s9.html` issues N unbatched draws per frame (WebGL 2: five calls per draw; WebGPU: two) and times its own JavaScript with the native clock. The page is cross-origin isolated so the timer resolves 5 µs. `spikes/s9-overhead.mjs` compares no probe, level `off` and level `observe`, three interleaved rounds each, taking the mean of the middle 80% of 300 frames.

**Result.**

| API | Draws | Calls per frame | No probe | `off` | `observe` | Cost per call at `observe` |
|---|---|---|---|---|---|---|
| WebGL 2 | 2,000 | 10,002 | 0.284 ms | 0.329 ms | 0.366 ms | about 8 ns |
| WebGL 2 | 10,000 | 50,002 | 1.829 ms | 1.886 ms | 2.115 ms | about 6 ns |
| WebGPU | 2,000 | 4,008 | 0.273 ms | 0.344 ms | 0.278 ms | within noise |
| WebGPU | 10,000 | 20,008 | 0.513 ms | 0.483 ms | 0.512 ms | within noise |

Run-to-run spread of the baseline was 0.02–0.08 ms (1.2 ms for the 10,000-draw WebGL case), so differences under about 0.06 ms are noise. The `off` figures in particular are not distinguishable from zero.

**Reading it.**

- In absolute terms the hooks are cheap: at `observe`, a 2,000-draw WebGL frame pays about 0.08 ms, which is 0.5% of a 60 Hz frame.
- Against the PRD's wording they fail: "under 5% of CPU frame time" on a frame whose CPU time is *only* graphics calls gives 16–29% for WebGL, because a native WebGL call costs under 30 ns on this machine and the wrapper adds 6–8.
- **Decision (10 November 2026):** the budgets are now absolute costs per call: 5 ns at `off`, 25 ns at `observe`, 100 ns at `record`. A percentage of a frame with no game logic in it measures the benchmark, not the tool. The table is in [../DEPARTURES.md](../DEPARTURES.md).
- That was `observe` as counters only. **With milestone 2's registry and state mirror on, the same 2,000-draw WebGL frame costs about 17 ns a call** (0.450 ms against 0.282 ms with no probe), inside the 25 ns budget. The first version cost 75 ns: every lookup of a probe record went through one shared piece of code that saw textures, buffers, programs and contexts alike, and capabilities lived in a `Map`. One generated class per kind of object and an array for capabilities fixed it.
- The generated wrappers pass `arguments` straight to the native function, so argument counts are exactly what the page gave.

**Not tested.** `record` level (not built yet). An integrated GPU, Windows.

## The desktop app prototype (APP.md, stage 0)

Run on 12 November 2026 on macOS 27.2, Apple M6, a 60 Hz display. The prototype is in [prototypes/app](../../prototypes/app/README.md): GPUI 0.2.2 and CEF 156.0.26 (Chromium 156.0.8078.88) through the `cef` crate 156.4.0, with the browser as a native child view (Alloy style) of the GPUI window, and the protocol in process through `SendDevToolsMessage`. Chrome 157.0.8103.50 for comparison.

**It works.** The owner used it by hand for some time, on the fixtures and on a WebGL game on the web, and found it fast.

| Test | Result |
|---|---|
| 1. The view | **Pass by hand on the Mac.** The game sits in the rectangle GPUI lays out for it, at Retina resolution; typing goes to the address bar when it is clicked and to the game when it is. Moving between displays not tried. |
| 2. The protocol | **Pass, both ways.** In process: `Runtime`, `Page` (including `addScriptToEvaluateOnNewDocument`), `Target.setAutoAttach`, `Emulation`, `Browser.getVersion` and `Page.captureScreenshot` all work, round trips of 4–5 ms with the 4 ms pump. `SystemInfo` is refused ("only supported on the browser target"). **Over a pipe: the app's executable started with `--remote-debugging-pipe` gives the full browser-level protocol on file descriptors 3 and 4, exactly as Chrome does**: Scanline's spike library drove it unchanged, `SystemInfo.getProcessInfo` included, and browser-level auto-attach reached the page and a shared worker. |
| 3. Timing | **Pass: the same as Chrome.** Mean frame gap and spread over 6 s, window the same size: start page 16.67 ms ± 0.48 (Chrome ± 0.55), three.js WebGL ± 0.50 (± 0.49), three.js WebGPU ± 0.50 (± 0.51); worst gaps 17.8–17.9 ms in both. |
| 4. Crashing | **As the specification predicted.** Each killed GPU process was replaced and WebGL kept working; at the **sixth** kill Chromium ended the browser process, which is the app, with SIGTRAP. `chrome://gpucrash` does nothing when navigated to over the protocol. |
| 5. Scrolling | Not measured. The 10,000-row list scrolled smoothly by hand; the window tool could not reach a second copy to measure the frame rate while scrolling. |
| 6. Cost | First game frame 0.39 s after start. Seven processes, 787 MB resident with a heavy WebGL game loaded (GPU 143 MB, renderer 238 MB, utility 197 MB, the app about 210 MB). The bundle is 582 MB in a debug build: CEF's framework is 327 MB, and each of the six copies of the executable 43 MB (one executable would do, with the helpers linked to it). |
| 7. Windows | Not run. |

What it decides for the design:

- **The host drives the app over `--remote-debugging-pipe`**, option 1 in APP.md section 4. No relay and no change to the host's protocol client: to the host the app is one more browser binary.
- **The host stays its own process.** Test 4 shows the app can be taken down by the page's GPU trouble, as Chromium intends.
- The in-process protocol is still there for the app's own panels if they ever need it, but the panels should go through the host (principle 2).

What it learned on the way:

- GPUI's application class has to be taught Chromium's `CrAppControlProtocol` (`isHandlingSendEvent`, `setHandlingSendEvent:`, and a `sendEvent:` that sets it) before either toolkit starts. Done at run time with the Objective-C runtime; about 60 lines.
- With `external_message_pump`, every CEF callback arrives on GPUI's main thread. The prototype pumps on a 4 ms timer instead of honouring `OnScheduleMessagePumpWork`; the app proper should honour it.
- The browser's view is a sibling of GPUI's view in the window's content view, placed by hand each turn of the pump; CEF does not follow GPUI's layout by itself.
- Two copies sharing a cache directory do not both start: Chromium hands the second to the first.
- Building needs cmake and ninja (CEF's C++ wrapper) and, unless GPUI compiles its shaders at run time, full Xcode for the Metal compiler.
