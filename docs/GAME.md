# Scanline for games: requirements and build plan

13 November 2026. The owner's brief: make Scanline a debugger for web games, not only for their rendering. An agent building a game should be able to see its objects, its audio and its input as easily as its draw calls, and the person playing it should be able to point at a problem and hand the agent everything it needs to act.

This document says what to build, in what order, and how each part is known to work. It sits beside the rendering specification (in the `render-debugger/` folder of the v3-gameblocks repository), which it does not change.

## 1. What changes, in one paragraph

Scanline already holds a game's frame clock, its input and its pixels. It adds four things: **watches** on the game's own objects (positions, velocities, any value), checked every frame for values that go wrong; **audio** inspection of the Web Audio graph and the media elements, with levels, buffers and parameters, and the means to mute, solo and bypass; **takes**, named recordings of input that play back to the same frame; and **notes**, a paused frame the person marks up and sends to the agent with the audio, the watches and the take that led there. Each is a host command first, so an agent can do everything the person can, and the app shows it.

## 2. Principles

These hold for every part below.

1. **A command first.** Every capability is a control-API command with a tool definition. The app calls the same commands. Nothing exists only in the app.
2. **Nothing to set up for the basics.** Audio inspection, takes and notes work on any page. Watches work on any value the agent can name by expression. The `scanline-hooks` package adds names and structure; it is never required.
3. **The page notices nothing it did not ask for.** Instrumentation is as for rendering: native functions kept, wrappers disguised, every change to what the page can observe declared in the launch summary and switched off by `unmodified: true`.
4. **Bounded.** Every history, list and recording has a limit, stated in its command's description, and says when it was reached.
5. **Page text is data.** Names, labels and values that come from the page appear between « », as everywhere in Scanline.
6. **Numbers before pictures.** A watch reports values; a level meter reports decibels; a take reports frames. Pictures accompany numbers, never replace them.

## 3. Watches: the game's own objects

### 3.1 What it is for

A player's velocity becomes `NaN` and the sprite disappears. Today the agent finds out by looking at screenshots. With a watch it names the value once and Scanline checks it every frame, stops the game on the frame it goes wrong, and shows the values on the frames before.

### 3.2 Requirements

- **W1. Watch anything nameable.** `watch(expression)` watches the value of a JavaScript expression evaluated in the page after each frame, such as `game.player.body.velocity.x`. An object expression watches its own enumerable number, boolean and string properties (one level by default, `depth` up to 3).
- **W2. Watch what the page exposes.** `dbg.watch(name, object, { props, rules })` in `scanline-hooks` registers an object under a name, with the properties to read (or all own primitive properties) and rules. The page can register many objects of one kind with a prefix (`enemy/3`). `dbg.unwatch(name)` removes one.
- **W3. Common kinds.** `dbg.watch.sprite(name, sprite)` reads `x, y, rotation, scale, alpha, visible, frame` and velocity when present; `dbg.watch.object3d(name, object)` reads `position, rotation, scale, visible`. The engine adapters (Phaser, three.js, PixiJS, Babylon.js, PlayCanvas) offer the scene's objects for watching without page changes: `watchable()` lists them, `watch(object: "…")` picks one.
- **W4. Rules.** Each watch can carry rules checked every frame: `finite` (default for numbers: not `NaN`, not ±∞), `defined` (not `undefined` or `null`), `range [min, max]`, `type`, `changes` (expected to change each frame), `steady` (expected not to). A broken rule is an event (`watch-broken`) naming the watch, the property, the frame and the value before and after.
- **W5. Break.** A rule may `break`: the game pauses on the frame the rule broke, before the next frame runs, as `run_until` does. The agent then captures the frame, reads the watches' history, or steps back with a take.
- **W6. History.** Each watch keeps its values for the last 600 frames (the flight recorder's length). `watches(history: n)` returns them; the app draws them.
- **W7. Set.** A watched number, boolean or string can be set from the debugger (`watch_set(name, prop, value)`), as `controls` already allow for registered values. The person edits it in place in the app.
- **W8. Everywhere it matters.** A capture, a flight recording, a take's end and a note each carry the watches' values at that frame.
- **W9. Cost.** Reading watches costs at most 0.5 ms a frame at the default limit of 200 watched properties; past that, Scanline reads them every other frame and says so.

### 3.3 Commands

| Command | Does |
|---|---|
| `watch(expression \| object, props?, depth?, rules?, name?)` | Adds a watch. Returns its name and first values. |
| `unwatch(name \| all)` | Removes watches. |
| `watches(history?, name?)` | Current values, broken rules, and history when asked. |
| `watch_set(name, prop, value)` | Sets a watched value in the page. |
| `watchable(filter?)` | What the page and its engine offer for watching. |

## 4. Audio

### 4.1 What it is for

The sound effect is too quiet, the echo too long, a sound plays twice, music keeps running when the game is paused, a buffer is 40 MB. Today none of this is visible. With audio inspection the agent sees the graph as the game built it, the levels, the parameters and the memory, and can mute or bypass a node to hear the difference.

### 4.2 Requirements

- **A1. The graph.** Every `AudioContext` and `OfflineAudioContext`, its state and sample rate, and every node it made: its type, its parameters (current value and automation), and its connections, kept as the page builds and changes them. Nodes are named by handle (`anode_12`) and by the page's own label when `dbg.label(node, name)` gives one.
- **A2. What is playing.** Each source node that has started and not ended, with its buffer, start time, loop and playback rate; each `<audio>` and `<video>` element with its source, time, duration, volume, muted and paused state.
- **A3. Buffers.** Every `AudioBuffer`: duration, channels, sample rate, bytes, and where it was made (decoded from which URL, or created). Totals by context.
- **A4. Levels.** Peak and RMS level in dBFS, per context at its destination and per node on request, sampled each frame through an analyser the debugger adds, with a meter in the app. Silence and clipping (samples at or above 0 dBFS) are events.
- **A5. Change it live.** Mute a node (its output goes nowhere), solo a node (every other source muted), bypass a node (its input goes straight to its outputs), set a parameter. Each is a patch, listed with the rendering patches and undone the same way.
- **A6. Clips.** The last 10 seconds of a context's output, kept while recording is on, written as a WAV file on request: what the person heard when they pressed Debug.
- **A7. Pause.** A paused game is silent and its audio clock stops with it (built). A stepped frame advances audio by one frame's time.
- **A8. Findings.** Sources started and never stopped, nodes connected to nothing, contexts left suspended, buffers decoded twice from one URL, gain above 1 on the destination path, clipping.

### 4.3 Commands

| Command | Does |
|---|---|
| `audio(view: summary \| graph \| playing \| buffers \| elements)` | The audio state, by view. |
| `audio_node(handle)` | One node: parameters with automation, connections, level. |
| `audio_patch(handle, mode: mute \| solo \| bypass \| param, param?, value?)` | Changes how the game sounds; undone by `patches`. |
| `audio_clip(seconds?)` | The last seconds of output as a WAV file. |

## 5. Takes: input to play again

### 5.1 What it is for

The agent clicks through a menu, picks a level and walks to the broken door, taking screenshots to find each button. With takes it does that once, names it, and plays it back on every later attempt in a second. The person can record a take too and give its name to the agent: "play `door-glitch` and look at the last frame".

### 5.2 Requirements

- **T1. Record.** `take(action: "start", name?)` records the input the page receives from that frame on: keyboard, pointer, wheel, touch and gamepad, from the person or the agent, each with its frame. `take(action: "stop")` keeps it. The app has a record button.
- **T2. Where it starts.** A take starts from the page's load (it reloads and plays from frame 0, exact in a deterministic session) or from a checkpoint the page provides (`checkpoint.provide`), which the take saves when it starts. The take says which.
- **T3. Play.** `take(action: "play", name, then?)` plays a take on the same frames, as fast as the page allows or in real time, then pauses, or does what `then` asks: `capture`, `screenshot`, `note`. Frames whose fingerprint differs from the recording are reported, as `replay_run` does.
- **T4. Stop early.** `to_frame` stops partway; `until` stops when a watch rule breaks or a mark is reached.
- **T5. Kept and shared.** Takes are files in the home directory, listed by `takes()`, renamed and removed, and exported with a capture or a note.
- **T6. Build on runs.** A take is a run with a name, a start point and an end; `save_run` and `replay_run` stay as they are.

### 5.3 Commands

| Command | Does |
|---|---|
| `take(action: start \| stop \| play, name?, from?, then?, to_frame?, until?, speed?)` | Records or plays a take. |
| `takes()` | The takes on disk. |

## 6. Notes: the person points, the agent acts

### 6.1 What it is for

The person sees something wrong and presses Note. The game freezes. They draw a circle round the problem, write "this shadow flickers" or "the echo here is too long", and send it. The agent receives the picture with the marks, the words, the frame, the watches' values, the last seconds of audio and the take that led there.

### 6.2 Requirements

- **N1. Freeze and mark.** Note (a toolbar button, ⇧⌘N, and the Debug key's long press) pauses the game and shows its frame in the app at full size. Tools: pen, arrow, rectangle, ellipse, text, in five colours; undo and clear.
- **N2. Words.** A note has text. Short, as the person types it.
- **N3. What goes with it.** The marked picture, the unmarked picture, the frame number, a capture of the frame (quick, so it is ready at once), the watches' values and their recent history, the audio state and the last 10 seconds of audio when audio recording is on, and a take from the page's load (or from the last checkpoint) to this frame.
- **N4. To the agent.** A note is an event (`note`), answered by `wait(kinds: ["note"])`, listed by `notes()`, read by `note(id)`. An agent that asked for help (`request_human`) gets the note as its answer.
- **N5. Kept.** Notes are files, exported as one `.scanline` with everything in them.

### 6.3 Commands

| Command | Does |
|---|---|
| `notes()` | The notes taken, newest first. |
| `note(id)` | One note: its text, marked picture, frame, and what came with it. |

## 7. The interface

The panels become fewer and each has tabs, so no part of Scanline needs a long scroll.

| Panel | Tabs |
|---|---|
| Live | Performance, Memory, Objects (the watches) |
| Game | Audio, Takes, Notes |
| Resources | by kind, as now |
| Captures | Frame (picture and attachments), Bindings, State, Timeline |
| Experiments | Views, Programs, Textures, Cost |
| Console | Console, Agent |

Rules for every panel: one tab strip at the top; content fits the panel's height, and only a list that can grow (draws, objects, nodes) scrolls, inside a fixed area; tables over cards wherever there are rows of values; nothing explained that the screen shows.

## 8. Build plan

Each milestone ends with its commands, the app's part, tests and the docs. The order puts first what the person asked for most and what the rest builds on.

| Milestone | Builds | Done when |
|---|---|---|
| **G1. Tabs** | Tab strips; Live split into Performance and Memory; Captures into Frame, Bindings, State; Experiments into Views, Programs, Textures, Cost. | No panel on spider needs scrolling except its lists, at 900 px tall. |
| **G2. Watches** | W1–W9: the probe's watch table read after each frame, rules, break, history; `watch`, `unwatch`, `watches`, `watch_set`; `dbg.watch` in scanline-hooks; the Objects tab. | A fixture whose sprite's velocity turns `NaN` at frame 40 pauses at frame 40 with the rule named, in WebGL and WebGPU pages; values set from the app change the game. |
| **G3. Audio** | A1–A5, A7–A8: the probe's audio graph; `audio`, `audio_node`, `audio_patch`; level meters; the Audio tab. | A fixture with a gain, a delay and a filter shows its graph, levels within 1 dB of what the fixture computes, and goes silent when the source is muted. |
| **G4. Takes** | T1–T6: named takes on runs; play with `then`; the Takes tab. | A take recorded through a fixture's menu plays back to the same frame fingerprint ten times running. |
| **G5. Notes** | N1–N5: the marking surface, the note event, `notes`, `note`; Debug's long press. | A note sent from the app reaches `wait(kinds: ["note"])` with the marked picture, the watches and a take that reaches the same frame. |
| **G6. Clips and watchable scenes** | A6 audio clips; W3 engine adapters' watchable objects. | Phaser and three.js fixtures list their objects; a clip of a fixture's tone is the tone. |

Each milestone is committed when its tests pass, and the app is rebuilt and installed for the owner.

## 9. Not in this plan

- Stepping through JavaScript: the browser's own debugger does this; Scanline does not replace it.
- Network inspection beyond what a deterministic session records.
- Watching more than 200 properties every frame without the cost limit above.
- Audio worklets' internal state (their parameters and connections are covered).
