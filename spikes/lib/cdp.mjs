// A minimal DevTools Protocol client over --remote-debugging-pipe, for the spikes.
// The Rust host (crates/scanline-cdp) replaces this; it exists so the probe and the
// design's open questions can be tested before the host does.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CANDIDATES = {
    darwin: [
        '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
    ],
    win32: [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
    ],
    linux: ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']
};

export function findBrowser ()
{
    if (process.env.SCANLINE_BROWSER)
    {
        return process.env.SCANLINE_BROWSER;
    }

    const found = (CANDIDATES[process.platform] ?? []).find((path) => existsSync(path));

    if (!found)
    {
        throw new Error('No Chromium found. Set SCANLINE_BROWSER to a Chrome, Edge or Chromium binary.');
    }

    return found;
}

// The switches the architecture lists as always on (02-ARCHITECTURE.md, section 2.4).
export const ALWAYS_ON = [
    '--remote-debugging-pipe',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--disable-features=CalculateNativeWinOcclusion',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-search-engine-choice-screen',
    '--disable-sync',
    '--disable-extensions',
    '--disable-component-extensions-with-background-pages',
    '--password-store=basic',
    '--use-mock-keychain'
];

export const PROFILES = {
    stock: [],
    deep: [
        '--enable-unsafe-webgpu',
        '--enable-webgpu-developer-features',
        '--enable-dawn-features=dump_shaders,use_user_defined_labels_in_backend,disable_symbol_renaming'
    ],
    software: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--use-webgpu-adapter=swiftshader']
};

export class Browser
{
    constructor (child, userDataDir, ownsDir)
    {
        this.child = child;
        this.userDataDir = userDataDir;
        this.ownsDir = ownsDir;
        this.nextId = 1;
        this.pending = new Map();
        this.listeners = new Set();
        this.exited = false;
        this.buffer = [];
        this.replyTimeoutMs = 30000;

        this.out = child.stdio[3];
        this.in = child.stdio[4];

        this.in.on('data', (chunk) => this.onData(chunk));

        this.exit = new Promise((resolve) =>
        {
            child.on('exit', (code, signal) =>
            {
                this.exited = true;

                for (const { reject, method } of this.pending.values())
                {
                    reject(new Error(`Browser exited before ${method} returned`));
                }

                this.pending.clear();
                this.emit({ method: 'Scanline.browserExited', params: { code, signal } });
                resolve({ code, signal });
            });
        });
    }

    onData (chunk)
    {
        let start = 0;

        for (let i = 0; i < chunk.length; i++)
        {
            if (chunk[i] !== 0)
            {
                continue;
            }

            this.buffer.push(chunk.subarray(start, i));
            start = i + 1;

            const text = Buffer.concat(this.buffer).toString('utf8');

            this.buffer = [];
            this.onMessage(JSON.parse(text));
        }

        if (start < chunk.length)
        {
            this.buffer.push(chunk.subarray(start));
        }
    }

    onMessage (message)
    {
        if (message.id !== undefined)
        {
            const waiting = this.pending.get(message.id);

            if (!waiting)
            {
                return;
            }

            this.pending.delete(message.id);

            if (message.error)
            {
                waiting.reject(new Error(`${waiting.method}: ${message.error.message}`));
            }
            else
            {
                waiting.resolve(message.result);
            }

            return;
        }

        this.emit(message);
    }

    emit (message)
    {
        for (const listener of this.listeners)
        {
            listener(message);
        }
    }

    send (method, params = {}, sessionId)
    {
        if (this.exited)
        {
            return Promise.reject(new Error(`Browser has exited; cannot send ${method}`));
        }

        const id = this.nextId++;
        const message = { id, method, params };

        if (sessionId)
        {
            message.sessionId = sessionId;
        }

        return new Promise((resolve, reject) =>
        {
            // A command the browser never answers becomes an error that names it.
            const timer = setTimeout(() =>
            {
                this.pending.delete(id);
                reject(new Error(`${method} got no reply in ${this.replyTimeoutMs} ms`));
            }, this.replyTimeoutMs);

            this.pending.set(id, {
                method,
                resolve: (value) => { clearTimeout(timer); resolve(value); },
                reject: (error) => { clearTimeout(timer); reject(error); }
            });

            this.out.write(JSON.stringify(message) + '\0');
        });
    }

    // Listen for events. `filter` is a method name, or a function of the whole message.
    on (filter, handler)
    {
        const listener = (message) =>
        {
            if (typeof filter === 'function' ? filter(message) : message.method === filter)
            {
                handler(message.params, message);
            }
        };

        this.listeners.add(listener);

        return () => this.listeners.delete(listener);
    }

    once (filter, timeoutMs = 10000)
    {
        return new Promise((resolve, reject) =>
        {
            const timer = setTimeout(() =>
            {
                off();
                reject(new Error(`Timed out after ${timeoutMs} ms waiting for ${typeof filter === 'string' ? filter : 'an event'}`));
            }, timeoutMs);

            const off = this.on(filter, (params, message) =>
            {
                clearTimeout(timer);
                off();
                resolve(message);
            });
        });
    }

    session (sessionId)
    {
        return {
            sessionId,
            send: (method, params) => this.send(method, params, sessionId),
            on: (method, handler) => this.on((message) => message.sessionId === sessionId && message.method === method, handler),
            once: (method, timeoutMs) => this.once((message) => message.sessionId === sessionId && message.method === method, timeoutMs)
        };
    }

    async close ()
    {
        if (!this.exited)
        {
            try
            {
                await Promise.race([
                    this.send('Browser.close'),
                    new Promise((resolve) => setTimeout(resolve, 2000))
                ]);
            }
            catch
            {
                // Already going.
            }

            await Promise.race([this.exit, new Promise((resolve) => setTimeout(resolve, 3000))]);

            if (!this.exited)
            {
                this.child.kill('SIGKILL');
                await this.exit;
            }
        }

        if (this.ownsDir)
        {
            rmSync(this.userDataDir, { recursive: true, force: true, maxRetries: 5 });
        }
    }
}

export function launch ({
    url = 'about:blank',
    profile = 'stock',
    headless = false,
    app = true,
    width = 1280,
    height = 720,
    userDataDir,
    args = [],
    quiet = true
} = {})
{
    const ownsDir = !userDataDir;

    userDataDir ??= mkdtempSync(join(tmpdir(), 'scanline-profile-'));

    const flags = [
        ...ALWAYS_ON,
        ...PROFILES[profile],
        `--user-data-dir=${userDataDir}`,
        // Keep crash data inside the disposable profile, not the user's own browser folders.
        '--disable-breakpad',
        `--crash-dumps-dir=${join(userDataDir, 'crashes')}`,
        `--window-size=${width},${height}`,
        ...args
    ];

    if (headless)
    {
        flags.push('--headless=new');
        flags.push(url);
    }
    else if (app)
    {
        flags.push(`--app=${url}`);
    }
    else
    {
        flags.push(url);
    }

    const child = spawn(findBrowser(), flags, {
        stdio: ['ignore', quiet ? 'ignore' : 'inherit', quiet ? 'ignore' : 'inherit', 'pipe', 'pipe']
    });

    return new Browser(child, userDataDir, ownsDir);
}

// Attach to the first page target and return a flattened session for it.
export async function attachToPage (browser)
{
    await browser.send('Target.setDiscoverTargets', { discover: true });

    const { targetInfos } = await browser.send('Target.getTargets');

    let page = targetInfos.find((target) => target.type === 'page');

    if (!page)
    {
        const created = await browser.once((message) => message.method === 'Target.targetCreated' && message.params.targetInfo.type === 'page');

        page = created.params.targetInfo;
    }

    const { sessionId } = await browser.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });

    return { ...browser.session(sessionId), targetId: page.targetId };
}
