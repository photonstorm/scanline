// Launches a browser with the probe injected into every frame and worker, and gives the
// caller a way to call the probe. The spikes and the probe's tests share it.

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { attachToPage, launch } from './cdp.mjs';
import { repoRoot } from './serve.mjs';

export function wrapProbe (config)
{
    const body = readFileSync(join(repoRoot, 'probe', 'dist', 'probe.js'), 'utf8');

    return `(() => { const __SCANLINE_CONFIG__ = ${JSON.stringify(config)};\n${body}\n})();`;
}

export async function open ({
    url,
    headless = true,
    profile = 'stock',
    width = 800,
    height = 600,
    args = [],
    level = 'observe',
    startPaused = false,
    unmodified = false,
    deterministic = null,
    inject = true,
    quiet = true
} = {})
{
    const browser = launch({ headless, profile, width, height, args, quiet });
    const page = await attachToPage(browser);
    const token = randomBytes(8).toString('hex');

    const config = {
        key: `scanline.${token}`,
        binding: `__scanline_${token}`,
        level,
        startPaused,
        unmodified,
        deterministic,
        probeVersion: 'dev'
    };

    const source = wrapProbe(config);

    // Every probe instance that has said hello: one per frame and per worker.
    const instances = [];
    const events = [];
    const consoleLines = [];
    const exceptions = [];
    const workers = [];
    const eventWaiters = new Set();

    browser.on('Runtime.bindingCalled', (params, message) =>
    {
        if (params.name !== config.binding)
        {
            return;
        }

        const event = { ...JSON.parse(params.payload), sessionId: message.sessionId, contextId: params.executionContextId };

        events.push(event);

        if (event.t === 'hello')
        {
            instances.push(event);
        }

        for (const waiter of eventWaiters)
        {
            waiter(event);
        }
    });

    browser.on('Runtime.consoleAPICalled', (params, message) =>
    {
        consoleLines.push({
            type: params.type,
            text: params.args.map((arg) => arg.value ?? arg.description ?? '').join(' '),
            timestamp: params.timestamp,
            sessionId: message.sessionId
        });
    });

    browser.on('Runtime.exceptionThrown', (params) =>
    {
        exceptions.push(params.exceptionDetails.exception?.description ?? params.exceptionDetails.text);
    });

    // Workers: auto-attach is not recursive, so it is set again on every new session.
    //
    // What spike S1 found about a worker held at start (waitForDebuggerOnStart):
    //   - WebGPU interfaces do not exist in it yet, so the probe cannot hook them there.
    //   - Reading self.location in it blocks forever.
    // So the probe is not evaluated at attach. An instrumentation breakpoint stops the worker
    // just before its first statement, when the global is complete; the probe is evaluated
    // there and the debugger is switched off again, which resumes the worker.
    const injectable = (targetUrl) => /^(https?|file|blob|data|about):/.test(targetUrl) || targetUrl === '';

    browser.on('Target.attachedToTarget', (params) =>
    {
        const session = browser.session(params.sessionId);
        const type = params.targetInfo.type;
        const isWorker = type === 'worker' || type === 'shared_worker' || type === 'service_worker';
        const ours = injectable(params.targetInfo.url);
        const sent = [];
        const send = (method, commandParams) => sent.push(session.send(method, commandParams).catch((error) =>
        {
            if (process.env.SCANLINE_DEBUG)
            {
                console.error(`[attach] ${type} ${method}: ${error.message}`);
            }
        }));

        workers.push({ type, url: params.targetInfo.url, sessionId: params.sessionId, waiting: params.waitingForDebugger });

        if (process.env.SCANLINE_DEBUG)
        {
            console.error(`[attached] ${type} ${params.targetInfo.url.slice(0, 90)} waiting=${params.waitingForDebugger}`);
        }

        if (ours && (isWorker || type === 'iframe'))
        {
            if (type === 'iframe')
            {
                send('Page.enable');
                send('Page.setBypassCSP', { enabled: true });

                if (inject)
                {
                    send('Page.addScriptToEvaluateOnNewDocument', { source });
                }
            }

            send('Runtime.enable');
            send('Runtime.addBinding', { name: config.binding });

            if (isWorker && inject)
            {
                const off = session.on('Debugger.paused', (paused) =>
                {
                    if (paused.reason !== 'instrumentation')
                    {
                        return;
                    }

                    off();
                    send('Runtime.evaluate', { expression: source });
                    send('Debugger.disable');
                });

                send('Debugger.enable');
                send('Debugger.setInstrumentationBreakpoint', { instrumentation: 'beforeScriptExecution' });
            }

            send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
        }

        send('Runtime.runIfWaitingForDebugger');
    });

    await page.send('Page.enable');
    await page.send('Page.setBypassCSP', { enabled: true });

    if (inject)
    {
        await page.send('Page.addScriptToEvaluateOnNewDocument', { source });
    }

    await page.send('Runtime.enable');
    await page.send('Runtime.addBinding', { name: config.binding });
    await page.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });

    const expression = (method, callArgs) =>
        `globalThis[Symbol.for(${JSON.stringify(config.key)})](${JSON.stringify(method)}, ${JSON.stringify(JSON.stringify(callArgs ?? {}))})`;

    // Call a probe method. `where` is an instance from `instances` (default: the top frame).
    const probe = async (method, callArgs, where) =>
    {
        const target = where ? browser.session(where.sessionId) : page;
        const params = { expression: expression(method, callArgs), awaitPromise: true, returnByValue: true };

        if (where && where.kind === 'window' && where.contextId !== undefined)
        {
            params.contextId = where.contextId;
        }

        const reply = await target.send('Runtime.evaluate', params);

        if (reply.exceptionDetails)
        {
            throw new Error(`probe.${method} threw: ${reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text}`);
        }

        const parsed = JSON.parse(reply.result.value);

        if (parsed.error)
        {
            throw new Error(`probe.${method}: ${parsed.error}`);
        }

        return parsed.ok;
    };

    const evaluate = async (code, { awaitPromise = true } = {}) =>
    {
        const reply = await page.send('Runtime.evaluate', { expression: code, awaitPromise, returnByValue: true });

        if (reply.exceptionDetails)
        {
            throw new Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text);
        }

        return reply.result.value;
    };

    const waitForEvent = (test, timeoutMs = 10000) =>
    {
        const already = events.find(test);

        if (already)
        {
            return Promise.resolve(already);
        }

        return new Promise((resolve, reject) =>
        {
            const timer = setTimeout(() =>
            {
                eventWaiters.delete(waiter);
                reject(new Error(`Timed out after ${timeoutMs} ms waiting for a probe event`));
            }, timeoutMs);

            const waiter = (event) =>
            {
                if (test(event))
                {
                    clearTimeout(timer);
                    eventWaiters.delete(waiter);
                    resolve(event);
                }
            };

            eventWaiters.add(waiter);
        });
    };

    const navigate = async (to) =>
    {
        const loaded = page.once('Page.loadEventFired', 20000);

        await page.send('Page.navigate', { url: to });
        await loaded;
    };

    if (url)
    {
        await navigate(url);
    }

    return {
        browser, page, config, source, instances, events, consoleLines, exceptions, workers,
        probe, evaluate, waitForEvent, navigate,
        close: () => browser.close()
    };
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
