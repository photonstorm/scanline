// A capture as one file, and the tiers that limit what a client may do. Each group of tests
// runs a host of its own, in its own temporary SCANLINE_HOME, because tiers are fixed when
// a host starts.
//
//   npm run build && cargo build && npm run test:security

import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { repoRoot, serve } from '../spikes/lib/serve.mjs';

const binary = join(repoRoot, 'target', 'debug', 'scanline');
const scratch = mkdtempSync(join(tmpdir(), 'scanline-files-'));

let server;

// A host with its own home and its own environment.
function host (extra = {})
{
    const home = mkdtempSync(join(tmpdir(), 'scanline-sec-'));
    const env = { ...process.env, SCANLINE_HOME: home, ...extra };

    delete env.SCANLINE_ALLOW;
    delete env.SCANLINE_DENY;
    Object.assign(env, extra);

    function scanline (...args)
    {
        return new Promise((resolve) =>
        {
            execFile(binary, args, { env, timeout: 60000 }, (error, stdout, stderr) =>
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

    async function end ()
    {
        if (existsSync(join(home, 'control.sock')))
        {
            await scanline('stop');
        }

        rmSync(home, { recursive: true, force: true });
    }

    return { home, scanline, end };
}

before(async () =>
{
    assert.ok(existsSync(binary), `${binary} is missing. Run cargo build first.`);
    server = await serve();
});

after(async () =>
{
    await server.close();
    rmSync(scratch, { recursive: true, force: true });
});

const DRAWS = 'select draw, kind, pass, target, mode, count, program, blend, pixels_changed from draws order by draw';

describe('a capture as one file', () =>
{
    const first = host();
    const second = host();

    after(async () =>
    {
        await first.end();
        await second.end();
    });

    for (const api of ['webgl2', 'webgpu'])
    {
        test(`${api}: exported from one host, imported on another, it answers the same`, async () =>
        {
            const launched = await first.scanline('launch', server.url(`fixtures/matrix/${api}.html`), '--paused', '--headless', '--json');

            assert.equal(launched.code, 0, launched.out);

            await first.scanline('step', '5');

            const taken = await first.scanline('capture', '--json');

            assert.equal(taken.code, 0, taken.out);

            const cap = taken.json.data.capture;
            const before = await first.scanline('query', cap, DRAWS, '--json');
            const last = before.json.data.rows.at(-1)[0];
            const picture = await first.scanline('screenshot', '--capture', cap, '--at_draw', String(last), '--json');

            assert.equal(picture.code, 0, picture.out);

            // With no path, the file goes to the exports directory, named for the capture.
            const exported = await first.scanline('export', cap, '--json');

            assert.equal(exported.code, 0, exported.out);
            assert.equal(exported.json.data.path, join(first.home, 'artefacts', 'exports', `${cap}.scanline`));
            assert.equal(statSync(exported.json.data.path).size, exported.json.data.bytes);
            assert.equal(readFileSync(exported.json.data.path).subarray(0, 19).toString(), 'SCANLINE CAPTURE 1\n');
            assert.match(exported.json.summary, /Exported cap_\d+ \(frame \d+ of /);

            await first.scanline('close');

            // Another host, with nothing on disk but the file.
            const file = join(scratch, `${api}.scanline`);

            copyFileSync(exported.json.data.path, file);

            const imported = await second.scanline('import', file, '--json');

            assert.equal(imported.code, 0, imported.out);
            assert.equal(imported.json.data.imported_as, cap);
            assert.equal(imported.json.data.meta.api, taken.json.data.api);

            const copy = imported.json.data.capture;
            const after = await second.scanline('query', copy, DRAWS, '--json');

            assert.deepEqual(after.json.data.rows, before.json.data.rows);

            const listed = await second.scanline('captures');

            assert.match(listed.out, new RegExp(`${copy} .*\\(imported\\)`));

            // It replays there too: the same picture after the same event.
            await second.scanline('launch', 'about:blank', '--headless');

            const again = await second.scanline('screenshot', '--capture', copy, '--at_draw', String(last), '--json');

            assert.equal(again.code, 0, again.out);

            const same = await second.scanline('diff', picture.json.images[0].original, again.json.images[0].original, '--json');

            assert.equal(same.code, 0, same.out);
            assert.equal(same.json.data.changed, 0, same.json.summary);

            const state = await second.scanline('draw', copy, String(last), '--json');

            assert.equal(state.code, 0, state.out);

            await second.scanline('close');

            // Imported twice, it is two captures: a handle is this host's, not the file's.
            const twice = await second.scanline('import', file, '--json');

            assert.notEqual(twice.json.data.capture, copy);
        });
    }

    test('an export is always a .scanline file, and replaces nothing but another export', async () =>
    {
        const cap = (await second.scanline('captures', '--json')).json.data.captures[0].capture;
        const wrongName = await second.scanline('export', cap, '--path', join(scratch, 'notes.txt'));

        assert.notEqual(wrongName.code, 0);
        assert.match(wrongName.out, /whose name ends in \.scanline/);
        assert.equal(existsSync(join(scratch, 'notes.txt')), false);

        // A file of another kind that happens to have the name.
        const taken = join(scratch, 'taken.scanline');

        writeFileSync(taken, 'export PATH=/somewhere\n');

        const refused = await second.scanline('export', cap, '--path', taken);

        assert.notEqual(refused.code, 0);
        assert.match(refused.out, /exists and is not a Scanline capture file, so it has not been replaced/);
        assert.equal(readFileSync(taken, 'utf8'), 'export PATH=/somewhere\n');

        // Its own earlier export may be written again.
        const mine = join(scratch, 'mine.scanline');

        assert.equal((await second.scanline('export', cap, '--path', mine)).code, 0);
        assert.equal((await second.scanline('export', cap, '--path', mine)).code, 0);

        const unknown = await second.scanline('export', 'cap_999');

        assert.match(unknown.out, /No capture "cap_999"\./);
    });

    test('a file that is not a capture, or is damaged, is refused and leaves nothing behind', async () =>
    {
        const count = async () => (await second.scanline('captures', '--json')).json.data.total;
        const had = await count();
        const good = readFileSync(join(scratch, 'webgl2.scanline'));

        writeFileSync(join(scratch, 'other.scanline'), 'not one of ours\n');

        const other = await second.scanline('import', join(scratch, 'other.scanline'));

        assert.notEqual(other.code, 0);
        assert.match(other.out, /is not a Scanline capture file/);

        writeFileSync(join(scratch, 'short.scanline'), good.subarray(0, good.length - 100));

        const short = await second.scanline('import', join(scratch, 'short.scanline'));

        assert.notEqual(short.code, 0);
        assert.match(short.out, /is cut short/);

        // One byte changed inside the last blob.
        const bent = Buffer.from(good);

        bent[bent.length - 20] ^= 0xff;
        writeFileSync(join(scratch, 'bent.scanline'), bent);

        const damaged = await second.scanline('import', join(scratch, 'bent.scanline'));

        assert.notEqual(damaged.code, 0);
        assert.match(damaged.out, /blob [0-9a-f]{64}/);

        const missing = await second.scanline('import', join(scratch, 'nowhere.scanline'));

        assert.notEqual(missing.code, 0);
        assert.match(missing.out, /nowhere\.scanline/);

        assert.equal(await count(), had);
    });
});

describe('tiers: the defaults', () =>
{
    const usual = host();

    after(() => usual.end());

    test('a local page may be driven, patched and evaluated in; navigate keeps to its origin', async () =>
    {
        const page = server.url('fixtures/matrix/webgl2.html');
        const launched = await usual.scanline('launch', page, '--paused', '--headless', '--json');

        assert.equal(launched.code, 0, launched.out);
        assert.equal((await usual.scanline('step', '2')).code, 0);

        const value = await usual.scanline('eval', '1 + 1', '--json');

        assert.equal(value.code, 0, value.out);

        // The same server by another name is another origin.
        const elsewhere = page.replace('127.0.0.1', 'localhost');
        const refused = await usual.scanline('navigate', elsewhere);

        assert.notEqual(refused.code, 0);
        assert.match(refused.out, /navigate keeps to the origin the session was launched on \(http:\/\/127\.0\.0\.1:\d+\), and http:\/\/localhost:\d+ is another/);
        assert.match(refused.out, /SCANLINE_ALLOW=navigate/);

        const status = await usual.scanline('status', '--json');

        assert.equal(status.json.data.url, page);

        // Another page of the same origin, and a reload, are fine.
        const near = await usual.scanline('navigate', server.url('fixtures/matrix/webgl1.html'));

        assert.equal(near.code, 0, near.out);
        assert.equal((await usual.scanline('navigate', '--reload')).code, 0);

        await usual.scanline('close');
    });

    test('help security says what is in force', async () =>
    {
        const help = await usual.scanline('help', 'security');

        assert.match(help.out, /In force on this host:/);
        assert.match(help.out, /control \(time, input, hand-off, replaying a run\): on/);
        assert.match(help.out, /on for pages served from this machine, off for others/);
        assert.match(help.out, /navigate keeps to the origin the session was launched on/);
    });
});

describe('tiers: switched off', () =>
{
    const bare = host({ SCANLINE_DENY: 'control,patch,files' });

    after(() => bare.end());

    test('looking and capturing work; time, input, patching, eval and files elsewhere do not', async () =>
    {
        const launched = await bare.scanline('launch', server.url('fixtures/matrix/webgl2.html'), '--headless', '--json');

        assert.equal(launched.code, 0, launched.out);

        const shot = await bare.scanline('screenshot', '--json');

        assert.equal(shot.code, 0, shot.out);

        const taken = await bare.scanline('capture', '--json');

        assert.equal(taken.code, 0, taken.out);
        assert.equal((await bare.scanline('draw_list', taken.json.data.capture)).code, 0);
        assert.equal((await bare.scanline('resources', 'texture')).code, 0);

        for (const [args, tier] of [
            [['step', '1'], /control tier/],
            [['pause'], /control tier/],
            [['input', '--events', '[{"type":"key","key":"a"}]'], /control tier/],
            [['request_human', 'play'], /control tier/],
            [['page', 'set_control', '--id', 'x', '--value', '1'], /control tier/],
            [['eval', '1 + 1'], /patch-and-evaluate tier/],
            [['patch_draws', '--filter', '{"draws":[0]}'], /patch-and-evaluate tier/],
            [['experiment', 'scissor_1px'], /patch-and-evaluate tier/],
            [['policy', '() => {}'], /patch-and-evaluate tier/]
        ])
        {
            const refused = await bare.scanline(...args);

            assert.notEqual(refused.code, 0, args.join(' '));
            assert.match(refused.out, tier, args.join(' '));
            assert.match(refused.out, /Only the person running Scanline can do that/, args.join(' '));
        }

        // Files: inside the artefact directory, yes; anywhere else, no.
        const cap = taken.json.data.capture;
        const outside = await bare.scanline('export', cap, '--path', join(scratch, 'out.scanline'));

        assert.notEqual(outside.code, 0);
        assert.match(outside.out, /outside Scanline's artefact directory .* started without the files tier/);
        assert.equal(existsSync(join(scratch, 'out.scanline')), false);

        const dotted = await bare.scanline('export', cap, '--path', join(bare.home, 'artefacts', 'exports', '..', '..', '..', 'out.scanline'));

        assert.notEqual(dotted.code, 0);
        assert.match(dotted.out, /started without the files tier/);

        const inside = await bare.scanline('export', cap, '--json');

        assert.equal(inside.code, 0, inside.out);

        const brought = await bare.scanline('import', join(scratch, 'mine.scanline'));

        assert.notEqual(brought.code, 0);
        assert.match(brought.out, /started without the files tier/);
        assert.equal((await bare.scanline('import', inside.json.data.path)).code, 0);

        const image = await bare.scanline('diff', '/etc/hosts.png', 'canvas');

        assert.match(image.out, /started without the files tier/);

        const help = await bare.scanline('help', 'security');

        assert.match(help.out, /control \(time, input, hand-off, replaying a run\): off/);
        assert.match(help.out, /patch and evaluate \(patch_\*, experiment, eval, policy\): off/);
        assert.match(help.out, /outside the artefact directory off/);

        await bare.scanline('close');
    });
});

describe('tiers: widened, and misspelt', () =>
{
    const wide = host({ SCANLINE_ALLOW: 'navigate' });
    const wrong = host({ SCANLINE_DENY: 'pach' });

    after(async () =>
    {
        await wide.end();
        await wrong.end();
    });

    test('with navigate allowed, a session may go to another origin', async () =>
    {
        const page = server.url('fixtures/matrix/webgl2.html');

        await wide.scanline('launch', page, '--headless');

        const moved = await wide.scanline('navigate', page.replace('127.0.0.1', 'localhost'), '--json');

        assert.equal(moved.code, 0, moved.out);
        assert.match(moved.json.data.url, /^http:\/\/localhost:/);

        await wide.scanline('close');
    });

    test('a tier name that is not one stops the host from starting', async () =>
    {
        const launched = await wrong.scanline('launch', 'about:blank', '--headless');

        assert.notEqual(launched.code, 0);
        assert.match(launched.out, /SCANLINE_DENY holds "pach", which is not a tier\. It takes control, patch and files/);
        assert.equal(existsSync(join(wrong.home, 'control.sock')), false, 'no host was started');
    });
});

describe('MCP over loopback HTTP', () =>
{
    const home = mkdtempSync(join(tmpdir(), 'scanline-http-'));
    const env = { ...process.env, SCANLINE_HOME: home };

    let child;
    let port;
    let token;

    // One request, with whatever headers: node's own client, so that Host can be anything.
    const post = (headers, body, method = 'POST', path = '/mcp') => new Promise((resolve, reject) =>
    {
        const request = httpRequest({ host: '127.0.0.1', port, path, method, headers: { 'Content-Type': 'application/json', ...headers } }, (response) =>
        {
            let text = '';

            response.on('data', (chunk) => { text += chunk; });
            response.on('end', () =>
            {
                let json = null;

                try { json = JSON.parse(text); } catch { /* words, not JSON */ }

                resolve({ status: response.statusCode, text, json, headers: response.headers });
            });
        });

        request.on('error', reject);
        request.end(body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)));
    });

    before(async () =>
    {
        child = spawn(binary, ['serve', '--http'], { env, stdio: 'ignore' });

        for (let i = 0; i < 100 && !existsSync(join(home, 'runtime.json')); i++)
        {
            await new Promise((resolve) => setTimeout(resolve, 50));
        }

        port = JSON.parse(readFileSync(join(home, 'runtime.json'), 'utf8')).http.port;
        token = readFileSync(join(home, 'http-token'), 'utf8');
    });

    after(async () =>
    {
        await new Promise((resolve) => execFile(binary, ['stop'], { env }, resolve));
        child.kill();
        rmSync(home, { recursive: true, force: true });
    });

    test('the token is a file only its owner can read, and the port is on this machine alone', () =>
    {
        assert.equal(statSync(join(home, 'http-token')).mode & 0o777, 0o600);
        assert.match(token, /^[0-9a-f]{64}$/);
        assert.equal(JSON.parse(readFileSync(join(home, 'runtime.json'), 'utf8')).http.url, `http://127.0.0.1:${port}/mcp`);
    });

    test('a client with the token speaks MCP: initialize, tools, a call', async () =>
    {
        const auth = { Authorization: `Bearer ${token}` };
        const hello = await post(auth, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });

        assert.equal(hello.status, 200);
        assert.equal(hello.headers['content-type'], 'application/json');
        assert.equal(hello.json.result.serverInfo.name, 'scanline');
        assert.equal(hello.json.result.protocolVersion, '2025-11-25');

        // A notification has no answer.
        assert.equal((await post(auth, { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);

        const tools = await post(auth, { jsonrpc: '2.0', id: 2, method: 'tools/list' });

        assert.ok(tools.json.result.tools.some((tool) => tool.name === 'gfx_launch'));

        const called = await post(auth, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'gfx_sessions', arguments: {} } });

        assert.equal(called.json.result.isError, false);
        assert.match(called.json.result.content[0].text, /No sessions are open/);

        // The same host answers the CLI: there is one host, with two doors.
        const launched = await post(auth, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'gfx_launch', arguments: { url: server.url('fixtures/bugs/b00.html'), headless: true, paused: true } } });

        assert.match(launched.json.result.content[0].text, /Launched ses_1/);

        const listed = await new Promise((resolve) => execFile(binary, ['sessions'], { env }, (_error, stdout) => resolve(stdout)));

        assert.match(listed, /ses_1/);
        assert.match((await post({ ...auth, Host: `localhost:${port}` }, { jsonrpc: '2.0', id: 5, method: 'ping' })).text, /"result":\{\}/);
    });

    test('no token, a web page, or another name for this machine: refused', async () =>
    {
        const auth = { Authorization: `Bearer ${token}` };
        const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };

        const bare = await post({}, ping);

        assert.equal(bare.status, 401);
        assert.equal(bare.headers['www-authenticate'], 'Bearer');
        assert.equal((await post({ Authorization: `Bearer ${token.slice(0, -1)}0` }, ping)).status, 401);

        // A page in a browser says where it is from. Even with the token, even from this machine.
        const page = await post({ ...auth, Origin: 'http://localhost:5173' }, ping);

        assert.equal(page.status, 403);
        assert.match(page.text, /Requests from web pages are refused/);
        assert.equal(page.headers['access-control-allow-origin'], undefined, 'nothing tells a browser the answer may be read');

        // DNS rebinding: a name the attacker controls, resolving to 127.0.0.1.
        assert.equal((await post({ ...auth, Host: `evil.example:${port}` }, ping)).status, 403);
        assert.equal((await post({ ...auth, Host: '127.0.0.1' }, ping)).status, 403);

        assert.equal((await post(auth, undefined, 'GET')).status, 405);
        assert.equal((await post(auth, undefined, 'OPTIONS')).status, 405);
        assert.equal((await post(auth, ping, 'POST', '/')).status, 404);
        // What is not JSON is answered as JSON-RPC says to.
        const garbled = await post(auth, 'not json at all {');

        assert.equal(garbled.status, 200);
        assert.equal(garbled.json.error.code, -32700);
    });

    test('a host started without --http opens no port', async () =>
    {
        const quiet = host();

        await quiet.scanline('sessions');

        assert.equal(JSON.parse(readFileSync(join(quiet.home, 'runtime.json'), 'utf8')).http, null);
        assert.equal(existsSync(join(quiet.home, 'http-token')), false);
        await quiet.end();
    });
});
