// The Scanline app as the host's browser (docs/APP.md): a session shown in the app is driven
// as one in Chrome is, and the app's panels can be pointed at things by the agent.
//
//   app/bundle.sh && cargo build && npm run test:app
//
// Skipped when the app has not been built (it needs CEF; see app/README.md), or on a
// machine the app does not build for yet.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { repoRoot, serve } from '../spikes/lib/serve.mjs';

import { binary, hostRunning } from './host.mjs';

// The bundle on a Mac; on Windows the folder app/bundle.ps1 makes, and its executable.
const app = process.platform === 'win32' ? join(repoRoot, 'app', 'target', 'Scanline', 'Scanline.exe') : join(repoRoot, 'app', 'target', 'Scanline.app');
const executable = process.platform === 'win32' ? app : join(app, 'Contents', 'MacOS', 'Scanline');
const skip = !['darwin', 'win32'].includes(process.platform) || !existsSync(executable) ? 'the app is not built (app/bundle.sh, or app/bundle.ps1 on Windows)' : false;

const home = mkdtempSync(join(tmpdir(), 'scanline-app-'));
const env = { ...process.env, SCANLINE_HOME: home, SCANLINE_APP: app };

delete env.SCANLINE_DISPLAY;

function scanline (...args)
{
    return new Promise((resolve) =>
    {
        execFile(binary, args, { env, timeout: 90000 }, (error, stdout, stderr) =>
        {
            let json = null;

            if (args.includes('--json'))
            {
                try { json = JSON.parse(stdout); } catch { /* an error message, not JSON */ }
            }

            resolve({ code: error ? error.code ?? 1 : 0, out: (stdout + stderr).trim(), json });
        });
    });
}

let server;

before(async () =>
{
    server = await serve();
});

after(async () =>
{
    if (hostRunning(home))
    {
        await scanline('stop');
    }

    await server.close();
    rmSync(home, { recursive: true, force: true });
});

describe('a session in the app', { skip }, () =>
{
    test('launches the app as its browser, and is driven and captured as a window would be', async () =>
    {
        const launched = await scanline('launch', server.url('fixtures/engines/three.html'), '--display', 'app', '--paused', '--json');

        assert.equal(launched.code, 0, launched.out);

        const status = await scanline('status', '--json');

        assert.equal(status.json.data.display, 'app');
        assert.match(status.json.data.browser, /^Chrome\/\d+/);
        assert.equal(status.json.data.contexts[0].api, 'webgl2');

        // Time is the probe's, whatever the window.
        const stepped = await scanline('step', '3', '--json');

        assert.equal(stepped.code, 0, stepped.out);

        const captured = await scanline('capture', '--json');

        assert.equal(captured.code, 0, captured.out);
        assert.equal(captured.json.data.counts.draws, 3);
        assert.equal(captured.json.data.replay_matches, true);
    });

    test('viewer points the app\'s panels, and status carries the request for the app to read', async () =>
    {
        const shown = await scanline('viewer', '--show', 'capture', '--capture', 'cap_1', '--draw', '2');

        assert.equal(shown.code, 0, shown.out);
        assert.match(shown.out, /is shown in the Scanline app, whose panels are the viewer/);

        const status = await scanline('status', '--json');

        assert.deepEqual(status.json.data.app_show, { seq: 1, show: 'capture', capture: 'cap_1', draw: 2, handle: null, recording: null });

        const unknown = await scanline('viewer', '--show', 'pixels');

        assert.notEqual(unknown.code, 0);
        assert.match(unknown.out, /The app's panels are activity, live, capture, console and resources/);
    });

    test('the app is the strip: request_human opens no other window, and closing the session closes the app', async () =>
    {
        const asked = await scanline('request_human', '--instruction', 'Press Debug when the cube is green');

        assert.equal(asked.code, 0, asked.out);

        const status = await scanline('status', '--json');

        assert.equal(status.json.data.owner, 'human');
        assert.equal(status.json.data.request.instruction, 'Press Debug when the cube is green');

        const pid = status.json.data.browser_pid;

        assert.equal((await scanline('close')).code, 0);

        let gone = false;

        for (let i = 0; i < 40 && !gone; i++)
        {
            try { process.kill(pid, 0); } catch { gone = true; }

            await new Promise((resolve) => setTimeout(resolve, 100));
        }

        assert.ok(gone, 'the app\'s process is gone once its session is closed');
        assert.match((await scanline('sessions')).out, /No sessions are open/);
    });
});
