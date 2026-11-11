# Evaluation

Scanline's interface is tuned by giving agents pages with planted rendering bugs and reading what they do (04-AGENT-INTERFACE.md, section 9). This folder holds the bugs' expected diagnoses, the prompt an agent is given, the scorer, and the results of each run.

## The bugs

`fixtures/bugs/` is one small game scene in raw WebGL 2 (`scene.js`) and fifteen pages that run it. `b00.html` is correct. Each of `b01.html` to `b14.html` has exactly one thing wrong.

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
| b14 | performance | A haze of sunlight was added and the frame's GPU time went up many times over. |

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

3. Give an agent each bug, and nothing else. The agent must have Scanline (the MCP tools or the command line) and no access to this repository. The runner does it for any agent that is a command: it gives the command each prompt on standard input (and, wherever the command says `{prompt_file}`, the path of a file holding it), keeps what the command prints as `bNN.txt`, and scores the folder. It serves the fixtures itself, so step 2 is not needed, and runs each agent in an empty folder, one at a time.

```bash
node evals/run.mjs --agent 'claude -p --mcp-config /path/to/mcp.json --allowedTools "mcp__scanline"'
```

`--bugs b03,b13` runs some of them, `--out` names the results folder, `--timeout` is the seconds one agent may take (900), and `--how` is what the prompt calls the tools. A round of fourteen costs whatever fourteen runs of that agent cost: the runner does not know or limit it.

By hand instead: print a prompt, give it to an agent, save its final answer as `bNN.txt` in a folder under `results/`, then score the folder.

```bash
node evals/prompt.mjs b03
```

```bash
node evals/score.mjs --dir evals/results/2026-11-10
```

The scorer checks words, not judgement: the answer's CAUSE has to mention each thing `expect` lists. Treat it as a first filter, and read the answers. What agents say slowed them down is worth more than the score.

Calls are counted from the commands an answer lists, not from the number it gives: agents under-report their own count.

`tests/findings.test.mjs` is the other half. For each bug it checks, with no agent, that the capture's summary or one further command states the fact that is the cause, and that the correct page raises nothing. It runs with `npm test`, so a change that stops Scanline saying something is caught before the next round.

The runner (`run.mjs`) is tested with a stand-in for the agent (`tests/bugs.test.mjs`). It has not been run with a real one: the rounds in `results/` were run by hand, and the `claude` command line was not installed on the machine this was built on.

## What is measured

The PRD's targets for version 1.0 (section 10):

| Measure | Target |
|---|---|
| Share diagnosed correctly, with no hints | 80% or more |
| Median tool calls to a correct diagnosis | 12 or fewer |
| Median tokens of tool results per diagnosis | Under 40,000 |

Each round's answers are in `results/`, and `results/README.md` has the scores, what agents said slowed them down, and what was changed because of it.
