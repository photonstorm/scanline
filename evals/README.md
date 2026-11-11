# Evaluation

Scanline's interface is tuned by giving agents pages with planted rendering bugs and reading what they do (04-AGENT-INTERFACE.md, section 9). This folder holds the bugs' expected diagnoses, the prompt an agent is given, the scorer, and the results of each run.

## The bugs

`fixtures/bugs/` is one small game scene in raw WebGL 2 (`scene.js`) and fourteen pages that run it. `b00.html` is correct. Each of `b01.html` to `b13.html` has exactly one thing wrong.

`bugs.json` says, for each bug:

| Field | What it is |
|---|---|
| `class` | The kind of bug, from the list in the agent interface document. |
| `symptom` | What a person would say is wrong. This is all the agent is told. |
| `diagnosis`, `fix` | The cause, and the change that fixes it. Never shown to the agent. |
| `expect` | What a correct answer has to mention: a list of groups, at least one pattern from each. |
| `check` | How `tests/bugs.test.mjs` proves the bug is really there: a pixel that differs from the reference scene, textures that grow, or shaders compiled every frame. |

| Bug | Class | Symptom |
|---|---|---|
| b01 | nothing drawn | The three crates are missing. |
| b02 | sampling | The crates are drawn black. |
| b03 | wrong pixels | The glass panel is opaque. |
| b04 | wrong pixels | The ground is the wrong colour. |
| b05 | nothing drawn | Only the sky and the HUD are drawn. |
| b06 | wrong order | The glass panel does not tint the crates. |
| b07 | wrong pixels | After the first frame almost the whole canvas is black. |
| b08 | wrong pixels | The crates have the wrong picture on them. |
| b09 | targets | The whole scene is squashed into a corner. |
| b10 | memory | Memory keeps growing. |
| b11 | performance | The page stutters. |
| b12 | targets | The minimap is empty. |
| b13 | intermittent | The glass panel flickers for one frame now and then. |

b12 was not planted. It was a real mistake in the first version of the scene, found by using Scanline on the "correct" page, and kept.

b13 is the one a single capture is unlikely to catch: it needs the flight recorder, which keeps the frames before Debug is pressed.

Not covered yet: back-end differences (right on WebGPU, wrong on WebGL), and anything on WebGPU. WebGPU frames can be captured now, so a WebGPU version of the scene is the next set of bugs to plant.

## Running an evaluation

1. Build, and check the bugs reproduce:

```bash
npm run build && cargo build && npm run test:bugs
```

2. Serve the fixtures:

```bash
node evals/serve.mjs 8765
```

3. For each bug, give an agent the prompt and nothing else. The agent must have Scanline (the MCP tools or the command line) and no access to this repository:

```bash
node evals/prompt.mjs b03
```

4. Save each agent's final answer as `bNN.txt` in a folder under `results/`, then score the folder:

```bash
node evals/score.mjs --dir evals/results/2026-11-10
```

The scorer checks words, not judgement: the answer's CAUSE has to mention each thing `expect` lists. Treat it as a first filter, and read the answers. What agents say slowed them down is worth more than the score.

Calls are counted from the commands an answer lists, not from the number it gives: agents under-report their own count.

`tests/findings.test.mjs` is the other half. For each bug it checks, with no agent, that the capture's summary or one further command states the fact that is the cause, and that the correct page raises nothing. It runs with `npm test`, so a change that stops Scanline saying something is caught before the next round.

There is no runner that starts the agents. One that drives the `claude` command line with the MCP server attached is the obvious next piece; it was not written because that command was not installed on the machine this was built on, so it could not have been tested.

## What is measured

The PRD's targets for version 1.0 (section 10):

| Measure | Target |
|---|---|
| Share diagnosed correctly, with no hints | 80% or more |
| Median tool calls to a correct diagnosis | 12 or fewer |
| Median tokens of tool results per diagnosis | Under 40,000 |

Each round's answers are in `results/`, and `results/README.md` has the scores, what agents said slowed them down, and what was changed because of it.
