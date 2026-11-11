// Spike S9: what do the hooks cost? (06-BUILD-PLAN.md, section 3.)
//
// CPU time of the frame's JavaScript at: no probe, level `off`, level `observe`, and
// `observe` with the flight recorder running. The budgets are per graphics call
// (docs/DEPARTURES.md): 5 ns at `off`, 25 ns at `observe`, 100 ns while recording.

import { open, sleep } from './lib/session.mjs';
import { serve } from './lib/serve.mjs';

setTimeout(() => { console.error('S9 timed out'); process.exit(3); }, 580000).unref();

const headless = !process.argv.includes('--headed');
const rounds = Number(process.argv.find((arg) => arg.startsWith('--rounds='))?.slice(9) ?? 3);
// Cross-origin isolation raises performance.now() from 100 µs steps to 5 µs, which these
// sub-millisecond frames need.
const server = await serve({ headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' } });

const median = (values) =>
{
    const sorted = [...values].sort((a, b) => a - b);

    return sorted[Math.floor(sorted.length / 2)];
};

// Mean of the middle 80%: steadier than the median at this timer resolution, and not
// thrown by the odd frame that hit a garbage collection.
const trimmedMean = (values) =>
{
    const sorted = [...values].sort((a, b) => a - b);
    const cut = Math.floor(sorted.length * 0.1);
    const middle = sorted.slice(cut, sorted.length - cut);

    return middle.reduce((a, b) => a + b, 0) / middle.length;
};

async function measure (api, draws, mode)
{
    const session = await open({
        url: server.url(`fixtures/spikes/s9.html?api=${api}&draws=${draws}`),
        headless,
        inject: mode !== 'none',
        level: mode === 'none' ? 'off' : (mode === 'record' ? 'observe' : mode)
    });

    try
    {
        if (mode === 'record')
        {
            // Wait for the page to have its context, then keep the last 120 frames.
            await sleep(500);
            await session.probe('record.start', { frames: 120 });
        }

        // Let the JIT settle, then take the most recent 300 frames.
        await sleep(3500);

        const result = JSON.parse(await session.evaluate('JSON.stringify({ samples: window.s9.samples.slice(-300), calls: window.s9.callsPerFrame, isolated: crossOriginIsolated })'));

        return { ms: trimmedMean(result.samples), calls: result.calls, frames: result.samples.length, isolated: result.isolated };
    }
    finally
    {
        await session.close();
    }
}

const rows = [];

const only = process.argv.find((arg) => arg.startsWith('--api='))?.slice(6);
const sizes = (process.argv.find((arg) => arg.startsWith('--draws='))?.slice(8) ?? '2000,10000').split(',').map(Number);
// --modes=none,off,observe leaves the flight recorder out, for probes built before it existed.
const modes = (process.argv.find((arg) => arg.startsWith('--modes='))?.slice(8) ?? 'none,off,observe,record').split(',');

for (const api of ['webgl2', 'webgpu'].filter((name) => !only || name === only))
{
    for (const draws of sizes)
    {
        // Interleave the modes across rounds so drift in the machine's load hits all three alike.
        const times = { none: [], off: [], observe: [], record: [] };

        let calls = 0;

        for (let round = 0; round < rounds; round++)
        {
            for (const mode of modes)
            {
                const result = await measure(api, draws, mode);

                times[mode].push(result.ms);
                calls = result.calls;

                if (!result.isolated)
                {
                    console.error('warning: page is not cross-origin isolated; timer resolution is 100 µs');
                }
            }
        }

        const base = median(times.none);
        const off = median(times.off);
        const observe = median(times.observe);
        const record = times.record.length ? median(times.record) : NaN;

        rows.push({
            api,
            draws,
            'calls/frame': calls,
            'no probe ms': base.toFixed(3),
            'spread ms': (Math.max(...times.none) - Math.min(...times.none)).toFixed(3),
            'off ms': off.toFixed(3),
            'off %': (((off - base) / base) * 100).toFixed(1),
            'observe ms': observe.toFixed(3),
            'observe %': (((observe - base) / base) * 100).toFixed(1),
            'ns/call off': (((off - base) * 1e6) / calls).toFixed(0),
            'ns/call observe': (((observe - base) * 1e6) / calls).toFixed(0),
            'record ms': record.toFixed(3),
            'ns/call record': (((record - base) * 1e6) / calls).toFixed(0)
        });
    }
}

console.table(rows);
await server.close();
