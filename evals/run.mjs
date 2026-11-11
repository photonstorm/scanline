// Runs an evaluation round: gives an agent each planted bug, saves its answers, scores them.
//
//   node evals/run.mjs --agent '<command>' [--bugs b01,b03] [--out evals/results/<name>]
//                      [--how 'the `scanline` command line'] [--timeout 900] [--origin <url>]
//
// The agent is any command that reads a prompt and prints its answer: the prompt is given
// on standard input, and wherever the command says {prompt_file}, the path of a file that
// holds it. Its standard output is the answer. For example, with Claude Code and the MCP
// server:
//
//   node evals/run.mjs --agent 'claude -p --mcp-config /path/to/mcp.json --allowedTools "mcp__scanline"'
//
// Each agent runs in an empty folder of its own, one at a time, so it has no view of this
// repository and no other agent's browser to trip over. The fixtures are served for the
// length of the run unless --origin says they are already served somewhere.
//
// Nothing here knows what agent it is running, or pays for it: check what a round of
// fourteen will cost before starting one.

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { promptFor } from './prompt.mjs';
import { score } from './score.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const manifest = JSON.parse(readFileSync(join(here, 'bugs.json'), 'utf8'));

function options (argv)
{
    const out = {};

    for (let i = 0; i < argv.length; i++)
    {
        if (!argv[i].startsWith('--') || argv[i + 1] === undefined)
        {
            throw new Error(`Expected --name value pairs, not "${argv[i]}".`);
        }

        out[argv[i].slice(2)] = argv[++i];
    }

    return out;
}

// One agent on one prompt. Resolves with what it printed, however it ended.
function ask (command, prompt, seconds)
{
    return new Promise((done) =>
    {
        const folder = mkdtempSync(join(tmpdir(), 'scanline-eval-'));
        const file = join(folder, 'prompt.txt');

        writeFileSync(file, prompt);

        const started = Date.now();
        const child = spawn(command.replaceAll('{prompt_file}', file), { shell: true, cwd: folder, stdio: ['pipe', 'pipe', 'pipe'] });

        let answer = '';
        let errors = '';
        let ended = null;

        const timer = setTimeout(() =>
        {
            ended = `stopped after ${seconds} s`;
            child.kill('SIGKILL');
        }, seconds * 1000);

        child.stdout.on('data', (chunk) => { answer += chunk; });
        child.stderr.on('data', (chunk) => { errors += chunk; });
        child.stdin.on('error', () => undefined);
        child.stdin.end(prompt);

        child.on('error', (error) => { ended = String(error.message); });
        child.on('close', (code) =>
        {
            clearTimeout(timer);
            rmSync(folder, { recursive: true, force: true });
            done({ answer, errors, seconds: (Date.now() - started) / 1000, ended: ended ?? (code === 0 ? null : `exit status ${code}`) });
        });
    });
}

export async function run (given)
{
    if (!given.agent)
    {
        throw new Error('Say which agent to run: --agent \'<command>\'. It is given the prompt on standard input and prints its answer.');
    }

    const wanted = given.bugs ? given.bugs.split(',') : manifest.bugs.map((bug) => bug.id);
    const out = resolve(given.out ?? join(here, 'results', new Date().toISOString().slice(0, 10)));
    const seconds = Number(given.timeout ?? 900);

    mkdirSync(out, { recursive: true });

    let server = null;
    let origin = given.origin;

    if (!origin)
    {
        const { serve } = await import('../spikes/lib/serve.mjs');

        server = await serve({ port: Number(given.port ?? 0) });
        origin = server.origin;
    }

    const rows = [];

    try
    {
        for (const id of wanted)
        {
            const prompt = promptFor(id, origin, given.how);
            const result = await ask(given.agent, prompt, seconds);

            writeFileSync(join(out, `${id}.txt`), result.answer);

            if (result.ended)
            {
                writeFileSync(join(out, `${id}.log`), `${result.ended}\n${result.errors}`);
            }

            rows.push({ ...score(id, result.answer), seconds: Math.round(result.seconds), ended: result.ended });
            console.log(`${id}  ${rows.at(-1).correct ? 'correct' : 'WRONG  '}  ${String(rows.at(-1).calls ?? '?').padStart(3)} calls  ${String(rows.at(-1).seconds).padStart(4)} s${result.ended ? `  (${result.ended})` : ''}`);
        }
    }
    finally
    {
        await server?.close();
    }

    const correct = rows.filter((row) => row.correct);
    const calls = correct.map((row) => row.calls).filter((count) => typeof count === 'number').sort((a, b) => a - b);
    const summary = {
        agent: given.agent,
        bugs: rows.length,
        correct: correct.length,
        medianCalls: calls.length ? calls[Math.floor((calls.length - 1) / 2)] : null,
        rows
    };

    writeFileSync(join(out, 'scores.json'), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(`\n${correct.length} of ${rows.length} diagnosed correctly${summary.medianCalls === null ? '' : `, in a median of ${summary.medianCalls} calls`}. Answers and scores.json are in ${out}.`);

    return summary;
}

if (import.meta.url === `file://${process.argv[1]}`)
{
    try
    {
        await run(options(process.argv.slice(2)));
    }
    catch (error)
    {
        console.error(error.message);
        process.exit(1);
    }
}
