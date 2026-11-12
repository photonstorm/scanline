// Stage 0, tests 2 and 4 over the pipe: does browser-level auto-attach reach a dedicated and a
// shared worker, and what happens to the app when its GPU process is crashed again and again (killed)?
//
//   node prototypes/app/checks/robustness.mjs <path to the app's executable>

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Browser, attachToPage } from '../../../spikes/lib/cdp.mjs';
import { sleep } from '../../../spikes/lib/session.mjs';

const origin = 'http://127.0.0.1:8765';
const cache = mkdtempSync(join(tmpdir(), 'scanline-prototype-check-'));
const child = spawn(process.argv[2], ['--remote-debugging-pipe'], {
    stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
    env: { ...process.env, SCANLINE_PROTOTYPE_CACHE: cache }
});
const browser = new Browser(child, cache, true);
const attached = [];

browser.listeners.add((message) =>
{
    if (message.method === 'Target.attachedToTarget')
    {
        attached.push(message.params.targetInfo.type);
    }
});

// Browser level, as Scanline's host does it (docs/DEPARTURES.md, spike S1).
await browser.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });

const page = await attachToPage(browser);

await page.send('Page.enable');
await page.send('Page.navigate', { url: `${origin}/prototypes/app/pages/workers.html` });
await sleep(3000);

console.log(`Workers: auto-attach at browser level reached ${[...new Set(attached)].join(', ') || 'nothing'}`);

const gpu = async () =>
{
    const { processInfo } = await browser.send('SystemInfo.getProcessInfo');

    return processInfo.filter((p) => p.type.toLowerCase().includes('gpu')).map((p) => p.id);
};

console.log(`GPU process before: ${await gpu()}`);

for (let crash = 1; crash <= 6; crash++)
{
    if (browser.exited)
    {
        break;
    }

    // chrome://gpucrash does nothing when navigated to over the protocol, so the GPU process
    // is killed instead: to Chromium that is the same as a crash.
    for (const id of await gpu().catch(() => []))
    {
        try { process.kill(id, 'SIGKILL'); } catch {}
    }

    await sleep(2500);

    const alive = !browser.exited;
    const ids = alive ? await gpu().catch(() => 'no reply') : 'the app has exited';

    console.log(`after GPU crash ${crash}: app ${alive ? 'running' : 'GONE'}, GPU process ${ids}`);
}

if (!browser.exited)
{
    await page.send('Page.navigate', { url: `${origin}/prototypes/app/pages/start.html` }).catch(() => undefined);
    await sleep(2000);

    const { result } = await page.send('Runtime.evaluate', { expression: 'String(!!document.createElement("canvas").getContext("webgl"))', returnByValue: true }).catch(() => ({ result: { value: 'no reply' } }));

    console.log(`WebGL after the crashes: ${result.value}`);
    await browser.close();
}
else
{
    console.log(`exit: ${JSON.stringify(await browser.exit)}`);
}
