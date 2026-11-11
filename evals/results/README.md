# Evaluation results

Each folder holds the agents' final answers to one round, one file per bug. Score a folder with `node evals/score.mjs --dir <folder>`.

## How these rounds were run

- The agent was a Claude Sonnet sub-agent, one per bug, given the prompt in `evals/prompt.mjs` and nothing else.
- It used the command line (`scanline <command>`), not the MCP server, against a host shared by every agent in the round. It was told to start with `scanline help`.
- It was forbidden to read the repository, fetch the page or read the page's source.
- Calls are counted from the commands each answer lists, help and `close` included. Agents under-report their own count by up to five, so the number they give is not used.

Read the limits before the numbers:

- The bugs are one small scene (25 events a frame) with one mistake each. This says nothing yet about a frame of 2,000 draws, an engine's renderer, or a bug that needs two findings put together.
- Every agent spends about five commands on overhead: two help topics, `launch`, `capture`, `close`.
- The scorer checks words. All 18 answers were also read; each names the right cause. A few add a guess beyond it (b12's answer suggests a second bug that is not one).

## Round 1: 10 November 2026, build `ee30344` plus GL errors by call

`2026-11-10/`. All twelve bugs.

| Measure | Result | Target for 1.0 |
|---|---|---|
| Diagnosed correctly, no hints | 12 of 12 | 80% or more |
| Median commands to a correct diagnosis | 8.5 (range 7 to 12) | 12 or fewer |
| Tool results read per diagnosis | 7,000 to 18,000 characters, roughly 2,000 to 4,500 tokens | under 40,000 tokens |

| Bug | Commands | How it was found |
|---|---|---|
| b01 crates culled | 9 | `draw` said the crates changed no pixels; the agent compared them with a draw that worked and saw the negative width |
| b02 missing mipmaps | 8 | `resource tex_1` already said the texture samples as black |
| b03 no blending | 8 | `draw_list` showed no blend on the glass |
| b04 tint never set | 12 | read the call stream by SQL to see that no `uniform4f` came before the ground |
| b05 depth cleared to 0 | 11 | opened the clear event to find the depth value |
| b06 glass before crates | 7 | order in `draw_list` |
| b07 scissor left on | 8 | scissor box on every row of `draw_list`; compared with another agent's first-frame capture by mistake |
| b08 wrong texture | 10 | `resources` showed the crate texture last used in frame 0 |
| b09 viewport not restored | 8 | SQL over `draws.viewport` |
| b10 texture every frame | 11 | `memory` snapshots and a diff |
| b11 program every frame | 12 | inferred from a program handle numbered 146 |
| b12 feedback loop | 7 | the capture summary listed the rejected draws |

### What the agents said slowed them down

| Said by | Friction | What was done |
|---|---|---|
| 8 of 12 | Help shows calls as `draw(capture, draw: n)`; the command-line form had to be guessed | `scanline <command> --help` and `scanline help <command>` print the usage, every argument and an example. `scanline help` ends with how a call is typed |
| b01, b05 | "Changed no pixels" does not say which test rejected the draw | `draw` replays it with each test off in turn and says which one lets it draw: culling, depth, scissor, stencil, colour mask, blend, viewport. For depth it adds what the buffer was last cleared to |
| b03, b05, b08, b09 | `draw_list` does not say which draw is which thing, or what it did | Every row carries the pixels the event changed and the box they fall in, measured when the capture is taken |
| b09 | The viewport is not in `draw_list` | Shown when it is not the whole target. A pass that draws through a viewport smaller than its target is listed in the summary |
| b07 | Nothing says the scissor was on when the frame began | The summary lists clears clipped by a scissor box, says when an earlier frame left it on, and names the call that leaves it on |
| b04 | A uniform's value does not say where it came from | `draw` marks each uniform as set for this draw, last set for an earlier event, or not set in this frame |
| b04, b10, b11 | SQL table and column names were guessed wrongly | A failed query lists every table with its columns. `commands.for_draw` names the event a call leads up to |
| b10, b11 | Nothing says the frame creates objects | The summary says what the frame created and deleted. `resources` and `memory` flag a likely leak (many alive from one line) and churn (made and destroyed) |
| b10 | `resources` with no kind is an error | It lists the count of every kind |
| b11 | A destroyed program is reported as "LINK FAILED" | It says the program was linked and has since been destroyed |
| b02, b07 | Another session's capture was read by mistake, with no warning | Every answer about a capture names its page and frame, and warns when the session passed has a different page open |
| b12 | A rejected draw does not say why | A draw rejected for drawing to a texture it has bound is called a feedback loop, with the texture and unit |
| b03 | Blending off with a translucent colour is not flagged | Listed in the summary when a uniform named like a colour or an alpha is below 1 and blending is off |
| b06 | A blended draw before opaque ones is not flagged | Listed in the summary when opaque, depth-written draws land on the same pixels after it |

Also found while fixing: `step` could report "No errors" for a frame that had raised one, because the reply and the error event were handled by different tasks. A command now waits for every event the browser sent before its reply.

## Round 2: 10 November 2026, with the changes above

`2026-11-10-round2/`. Six bugs: the five that took the most commands in round 1, and b07, whose first answer leaned on another agent's capture.

| Bug | Round 1 | Round 2 | What the agent used |
|---|---|---|---|
| b04 | 12 | 11 | `draw`: "tint … last set at call 23, for event 3; not set again for this draw" |
| b05 | 11 | 9 | the summary's "17 draws changed no pixels", then `draw`'s "the depth buffer was last cleared to 0 by event 4" |
| b07 | 8 | 9 | the summary's two lines; then SQL to find the call that left the scissor on |
| b08 | 10 | 11 | `draw`'s texture description, `resources`, then SQL for the bind calls |
| b10 | 11 | 7 | `memory`: "LIKELY LEAK: 30 textures … makeMapTarget" |
| b11 | 12 | 8 | the summary's "created 1 program, 2 shaders", then `resources`' churn line |

Six of six correct. Tool results per diagnosis: 8,700 to 14,200 characters.

This round used the bugs the changes were written against, so it shows the changes work on these bugs, not that they carry over to others. The leak and the stutter became much cheaper. The two that did not were asked for more:

| Said by | Friction | What was done |
|---|---|---|
| b08 | No history of texture binds: which call bound the wrong texture? | `draw` marks each unit as bound for this draw, last bound for an earlier event, or left bound by an earlier frame |
| b08, b07 | SQL on `method = 'bindTexture'` finds nothing; arguments are raw numbers | A query that names a method without its owner is told the names are `gl.…`. Arguments are stored with handles and WebGL's names: `["TEXTURE_2D","tex_2"]`, `["SCISSOR_TEST"]` |
| b07 | "An earlier frame left it on" does not name the call | The summary names the call in this frame that switches the scissor on with nothing after it switching it off |
| b11 | Which draws use the newly made program? | The summary names the events that use a program the frame created |

These last four are covered by `tests/findings.test.mjs` but have not been in front of an agent.

## Round 3: 11 November 2026, build `9b4fde5`, all fourteen bugs

`2026-11-11-round3/`. The first round on the finished build, and the first to include b13 (the flicker) and b14 (the slow haze). Run as rounds 1 and 2 were: one Claude Sonnet sub-agent per bug, the command line, a shared host, `scanline help` as the only instruction. Each answer also lists what slowed the agent down.

| Measure | Result | Target for 1.0 |
|---|---|---|
| Diagnosed correctly, no hints | 14 of 14 | 80% or more |
| Median commands to a correct diagnosis | 9 (range 6 to 11, and b13) | 12 or fewer |
| b13, the intermittent bug | Correct, by brute force: about 190 commands run in shell loops | |

| Bug | Commands | How it was found |
|---|---|---|
| b01 crates culled | 9 | the summary's "3 draws changed no pixels", then `draw`: "every triangle is culled … a negative scale or size flipping them" |
| b02 missing mipmaps | 8 | the summary: "tex_1 … is incomplete … reads black" |
| b03 no blending | 10 | the summary: "drawn with blending off, but its uniform tint has an alpha of 0.4" |
| b04 tint never set | 9 | `pixel_source`, then `draw`: "last set at call 23, for event 3; not set again for this draw" |
| b05 depth cleared to 0 | 8 | `draw`: "every fragment fails the depth test … last cleared to 0 by event 4" |
| b06 glass before crates | 8 | the summary: "Event 6 blends, but opaque depth-written events 8–9 are drawn after it" |
| b07 scissor left on | 11 | the summary named the call that leaves the scissor on; SQL confirmed nothing switches it off |
| b08 wrong texture | 11 | `draw`: "last bound at call 2, for event 0; not bound again"; `resources`: the crate texture last used in frame 0 |
| b09 viewport not restored | 9 | the summary: "Every event on canvas … uses viewport 0, 0, 64, 64" |
| b10 texture every frame | 6 | `memory`: "LIKELY LEAK: 369 textures … makeMapTarget" |
| b11 program every frame | 9 | `resources` and `memory`: churn, 205 programs created and 203 destroyed |
| b12 feedback loop | 9 | the summary and `draw`: the target is also bound on unit 0 |
| b13 flicker, one frame in 40 | about 190 | captured 40 consecutive frames one at a time and read each one's draws until one had the glass before the crates |
| b14 a 64-sample haze | 10 | `draw_list` showed one full-screen draw; `resource` gave the shader, with `SAMPLES = 64` in a loop. It did not use `profile`, `shader_analysis` or `experiment` |

All fourteen answers were read, not only scored. Each names the right cause. b12's adds a second suspicion (the dots' coordinates) that is not a bug, as in round 1.

Read the limits before the numbers, as before: one small scene, one mistake each. Two things are new:

- **b13 was solved the hard way.** The agent never found the flight recorder, because `help` presented it only as something a person's Debug press produces. Scanline can do the same job alone in four commands: `capture(when: {frames: 100}, flight_frames: 100)` kept 99 frames of b13, `recording` answered "2 of the 99 frames differ from the rest … frames 40, 80. Frame 40 first differs from frame 39 at its event 6", and two more captures and a `compare` finish it. The workflow help and two skills now say so. That route has been checked by hand on b13, and has not been in front of an agent.
- **b14 was solved without the tools built for it.** Reading the shader was enough on a frame with one suspicious draw. `profile` and `experiment` earn their place on a frame where the costly draw is not obvious, and this scene does not test that. The agent asked for per-draw GPU time and an estimate of shader cost, both of which exist (`profile`, `shader_analysis`); nothing pointed it at them.

### What the agents said slowed them down

| Said by | Friction | What was done |
|---|---|---|
| b13 | No way to find the frame whose draws differ, short of capturing every frame | The route exists and was not signposted. `help` now gives it under "A fault that comes and goes", and the `scanline` and `scanline-wrong-pixels` skills have it as a recipe |
| b03, b07, b08, b09 | Tried a `calls` command to list a frame's calls; `help calls` printed the workflow again | `scanline calls` and `scanline help calls` now answer with the `query` to run. Help for anything that is neither a topic nor a command says so and lists the topics. The workflow help says the calls are a table |
| b14 | `resource` on a shader the page deleted after linking said "COMPILE FAILED" | It says the shader has been deleted, that this is ordinary after linking, and that the program still works |
| b03 | `patch_state --help` says its filter is "as for patch_draws" and does not name the keys | Each command that takes a filter now names the keys |
| b05 | A clear's mask is shown as 0x4100 | `draw` on a clear says which buffers it clears, in words |
| 9 of 14 | Put `SCANLINE_HOME=…` in a shell variable and the first command failed | Not Scanline's: an artefact of how the round passes the host's directory. A runner that sets the environment for the agent would remove it |
| b01, b04, b06, b07, b10 | `launch` leaves the page running, so the first frame had passed before they looked | Nothing changed. `launch` says "Running at frame 0" and help's first line of the workflow is `launch(url, start: "paused")`; on the command line that is `--paused`, which `scanline launch --help` shows |
| b01 | A uniform's components are not labelled (which of `rect`'s four is the height?) | Nothing: the page's shader gives them no names to show |
| b02 | `draw` does not repeat that a bound texture is incomplete; the summary does | Not done |
| b11 | `stats` does not mention churn; `resources` and `memory` both do | Not done |
| b12 | `console` showed the last 25 of 256 repeated warnings | Not done. Repeated lines should be folded |
| b13 | Capture handles are shared across sessions, and the first one read was another agent's | Already warned about in every answer (it was, and the agent noticed) |
| b14 | Nothing flags a draw as costly | `profile` does; see above |

## Still open

- The line of page code that made a call. Only object creation records a call site; a `clearDepth(0)` or a missing `bindTexture` is located by call number, not by file and line.
- "Which texture should this draw have used?" A capture holds only what the frame used, so a texture the page created and never bound is invisible to it. `resources` shows it, with the frame it was last used in.
- Pixel-level history: which fragments of a draw a test rejected, pixel by pixel.
- WebGL's names are given for the arguments of a fixed list of methods, not for every enumerated argument.
- Bugs not covered: back-end differences, anything on WebGPU, large frames, engines. The one intermittent bug (b13) is covered, the hard way.
- The skills have not been in front of an agent. Every round has given agents `scanline help` and nothing else.
- A runner that starts the agents, so that a round is one command and can be repeated with the MCP server instead of the command line.
