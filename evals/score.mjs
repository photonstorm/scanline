// Scores an agent's answer to a planted bug against the expected diagnosis.
//
//   node evals/score.mjs b03 answer.txt
//   node evals/score.mjs --dir evals/results/2026-11-10     every bNN.txt in a folder
//
// Scoring is by words, not by judgement: the answer's CAUSE and EVIDENCE must mention
// each thing the manifest lists. It is a first filter. Read the answers too.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const manifest = JSON.parse(readFileSync(new URL('./bugs.json', import.meta.url), 'utf8'));

export function score (id, answer)
{
    const bug = manifest.bugs.find((entry) => entry.id === id);

    if (!bug)
    {
        throw new Error(`No bug "${id}".`);
    }

    // Only what the agent concluded, not the question repeated back.
    const said = answer.slice(Math.max(0, answer.search(/\bCAUSE\b/)));
    const missing = bug.expect.filter((group) => !group.some((pattern) => new RegExp(pattern, 'i').test(said)));
    const calls = commandsIn(answer) ?? claimed(answer);

    return {
        id,
        class: bug.class,
        correct: missing.length === 0,
        missing: missing.map((group) => group.join(' | ')),
        calls,
        words: said.split(/\s+/).length
    };
}

// Agents miscount their own calls (the first round's answers under-reported by up to
// five), so the commands they list are counted and the number they give is the fallback.
function commandsIn (answer)
{
    const section = /COMMANDS:\**([\s\S]*?)(?:\n\s*\**FRICTION|$)/i.exec(answer);

    if (!section)
    {
        return null;
    }

    // "a (then, in the same shell call) b" is two commands.
    const lines = section[1].split(/\n|\(then[^)]*\)/).map((line) => line.replace(/^[\s\-*\d.`]+/, '').trim()).filter((line) => /^(--)?[a-z_]+\b/.test(line) && !/^[A-Z(]/.test(line));

    return lines.length || null;
}

function claimed (answer)
{
    const calls = /CALLS:\s*\**\s*(\d+)/i.exec(answer);

    return calls ? Number(calls[1]) : null;
}

if (import.meta.url === `file://${process.argv[1]}`)
{
    const rows = process.argv[2] === '--dir'
        ? readdirSync(process.argv[3]).filter((name) => /^b\d+\.txt$/.test(name)).sort().map((name) => score(name.slice(0, -4), readFileSync(join(process.argv[3], name), 'utf8')))
        : [score(process.argv[2], readFileSync(process.argv[3], 'utf8'))];

    console.table(rows.map((row) => ({ bug: row.id, class: row.class, correct: row.correct, calls: row.calls, missing: row.missing.join('; ') })));

    const right = rows.filter((row) => row.correct).length;
    const counted = rows.filter((row) => row.calls !== null).map((row) => row.calls).sort((a, b) => a - b);

    console.log(`${right} of ${rows.length} diagnosed correctly (${Math.round(right * 100 / rows.length)}%).${counted.length ? ` Median tool calls: ${median(counted)}.` : ''}`);
}

function median (sorted)
{
    const middle = sorted.length >> 1;

    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
