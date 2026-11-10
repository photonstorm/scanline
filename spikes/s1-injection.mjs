// Spike S1: can the probe reach every frame and every kind of worker before page code runs,
// over the pipe? (06-BUILD-PLAN.md, section 3.)

import { open, sleep } from './lib/session.mjs';

setTimeout(() => { console.error('S1 timed out after 40 s'); process.exit(3); }, 40000).unref();
import { serve } from './lib/serve.mjs';

const headless = !process.argv.includes('--headed');
const first = await serve();
const second = await serve();

const session = await open({ headless });
const url = `${first.url('fixtures/spikes/s1.html')}?key=${encodeURIComponent(session.config.key)}&other=${encodeURIComponent(second.origin)}`;

// Shared and service workers are not children of the page target: attach from the browser too.
await session.browser.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });

await session.navigate(url);
await sleep(2500);

const reports = JSON.parse(await session.evaluate('JSON.stringify(window.s1)'));
const expected = [
    'main', 'classic', 'module', 'blob', 'offscreen', 'nested-parent', 'nested-child', 'shared', 'service',
    'iframe-same-origin', 'iframe-cross-origin', 'iframe-sandboxed', 'iframe-srcdoc'
];

const rows = expected.map((who) =>
{
    const report = reports[who];

    if (!report)
    {
        return { who, result: 'NO REPORT' };
    }

    if (report.error)
    {
        return { who, result: `ERROR ${report.error}` };
    }

    return {
        who,
        result: report.present ? 'probe first' : 'PAGE FIRST',
        bindingLeftOnGlobal: (report.leaked ?? []).length > 0
    };
});

console.table(rows);
console.log('main-frame details:', reports.main);
console.log('probe instances that said hello:', session.instances.map((instance) => `${instance.kind}${instance.top ? ' (top)' : ''} ${instance.url.replace(/\?.*/, '')}`));
console.log('targets auto-attached:', session.workers.map((worker) => `${worker.type} ${worker.url.replace(/\?.*/, '').slice(0, 80)}`));

// Did the worker that made a WebGL 2 context get it discovered by its own probe?
for (const instance of session.instances.filter((other) => other.kind === 'worker'))
{
    try
    {
        const status = await session.probe('status', {}, instance);

        const who = new URL(status.url).searchParams.get('who') ?? status.url.replace(/\?.*/, '').slice(-24);

        console.log(`worker ${who}: hooked ${status.hooks.interfaces.length} interfaces${status.hooks.interfaces.includes('GPUDevice') ? ', WebGPU among them' : ', WebGPU NOT among them'}`);

        if (status.contexts.length)
        {
            console.log(`worker ${status.url.replace(/\?.*/, '')}: contexts`, status.contexts.map((context) => `${context.api} ${context.width}x${context.height} offscreen=${context.offscreen}`));
        }
    }
    catch (error)
    {
        console.log('worker status failed:', error.message);
    }
}

console.log('page exceptions:', session.exceptions);

await session.close();
await first.close();
await second.close();
