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

## Still open

- The line of page code that made a call. Only object creation records a call site; a `clearDepth(0)` or a missing `bindTexture` is located by call number, not by file and line.
- "Which texture should this draw have used?" A capture holds only what the frame used, so a texture the page created and never bound is invisible to it. `resources` shows it, with the frame it was last used in.
- Pixel-level history: which fragments of a draw a test rejected, pixel by pixel.
- WebGL's names are given for the arguments of a fixed list of methods, not for every enumerated argument.
- Bugs not covered: intermittent ones, back-end differences, anything on WebGPU, large frames, engines.
- A runner that starts the agents, so that a round is one command and can be repeated with the MCP server instead of the command line.
