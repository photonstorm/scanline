// Stage 0, test 3: the same pages' frame timing in Chrome, for comparison with the app.
//
//   node prototypes/app/checks/timing.mjs [--browser <path to an executable>] [--seconds 6]
//
// Launches Chrome (or, with --browser, any Chromium that takes --remote-debugging-pipe) with
// the same window size as the app's game view, loads each page, lets it settle, and reads the
// gaps between the page's own frames with the same script the app injects.

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Browser, launch, attachToPage } from '../../../spikes/lib/cdp.mjs';
import { sleep } from '../../../spikes/lib/session.mjs';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const seconds = Number(arg('seconds', 6));
const origin = arg('origin', 'http://127.0.0.1:8765');
const pages = ['/prototypes/app/pages/start.html', '/fixtures/engines/three.html', '/fixtures/engines/three.html?renderer=webgpu'];

// The app's own measuring script, taken from its source so the two cannot drift apart.
const source = readFileSync(new URL('../src/ui.rs', import.meta.url), 'utf8');
const script = source.match(/const PAGE_SCRIPT: &str = r#"([\s\S]*?)"#;/)[1];

// Chrome by default. With --browser, the app's own executable, started as the host would start
// Chrome: the protocol on file descriptors 3 and 4, and a cache of its own.
function start ()
{
    const path = arg('browser');

    if (!path)
    {
        return launch({ width: 1100, height: 846 });
    }

    const cache = mkdtempSync(join(tmpdir(), 'scanline-prototype-check-'));
    const child = spawn(path, ['--remote-debugging-pipe'], {
        stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
        env: { ...process.env, SCANLINE_PROTOTYPE_CACHE: cache }
    });

    return new Browser(child, cache, true);
}

const browser = start();
const page = await attachToPage(browser);

await page.send('Page.enable');
await page.send('Page.addScriptToEvaluateOnNewDocument', { source: script });

const version = await browser.send('Browser.getVersion');

console.log(`${version.product}, ${seconds} s a page`);

for (const path of pages)
{
    await page.send('Page.navigate', { url: origin + path });
    await sleep(2000);
    await page.send('Runtime.evaluate', { expression: 'window.__prototype.times.length = 0' });
    await sleep(seconds * 1000);

    const { result } = await page.send('Runtime.evaluate', { expression: 'JSON.stringify(window.__prototype.read())', returnByValue: true });
    const read = JSON.parse(result.value);

    console.log(`${path.padEnd(48)} ${(1000 / read.mean).toFixed(1).padStart(6)} fps  ${read.mean.toFixed(2)} ms ± ${read.spread.toFixed(2)}  worst ${read.worst.toFixed(2)} ms`);
}

await browser.close();
