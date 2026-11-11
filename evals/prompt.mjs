// Prints the prompt an agent under evaluation is given for one planted bug.
//
//   node evals/prompt.mjs b03 [origin]
//
// The agent gets the scene, the symptom and the tool. Never the cause.

import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('./bugs.json', import.meta.url), 'utf8'));

export function promptFor (id, origin = 'http://127.0.0.1:8765', how = 'the `gfx_*` tools')
{
    const bug = manifest.bugs.find((entry) => entry.id === id);

    if (!bug)
    {
        throw new Error(`No bug "${id}". Bugs are: ${manifest.bugs.map((entry) => entry.id).join(', ')}.`);
    }

    return [
        `A WebGL page has a rendering bug. Find its cause.`,
        ``,
        `The page: ${origin}/fixtures/bugs/${bug.id}.html`,
        `What it should show: ${manifest.scene}`,
        `What is wrong: ${bug.symptom}`,
        ``,
        `Use only ${how} to investigate. Do not read the page's source code, fetch its URL, or look in the repository: the point is to find the cause from what the page does when it runs.`,
        ``,
        `Finish with:`,
        `CAUSE: one or two sentences saying exactly what the page does wrong.`,
        `EVIDENCE: what you observed that shows it (which draw or object, which values).`,
        `FIX: the change to make.`,
        `CALLS: how many tool calls you made.`
    ].join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`)
{
    console.log(promptFor(process.argv[2], process.argv[3]));
}
