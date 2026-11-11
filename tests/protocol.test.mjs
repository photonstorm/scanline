// The page protocol and the engine adapters, through the CLI (05-PAGE-PROTOCOL.md).
//
//   npm run build && cargo build && npm run test:protocol
//
// The protocol: a page that names its draws, offers its state and registers controls and
// views is read and driven through `page` and `live_view`, and its names reach a capture.
// The adapters: on three.js, PixiJS and Phaser, with no change to the page, every draw of a
// frame resolves to an engine object.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';
import { repoRoot, serve } from '../spikes/lib/serve.mjs';

const binary = join(repoRoot, 'target', 'debug', 'scanline');
const home = mkdtempSync(join(tmpdir(), 'scanline-protocol-'));
const env = { ...process.env, SCANLINE_HOME: home };

let server;

function scanline (...args)
{
    return new Promise((resolve) =>
    {
        execFile(binary, args.map(String), { env, timeout: 60000 }, (error, stdout, stderr) =>
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

async function opened (page, frames = 5)
{
    const launched = await scanline('launch', server.url(page), '--headless', '--paused');

    assert.match(launched.out, /Launched ses_\d+/, launched.out);

    return scanline('step', frames);
}

async function captured ()
{
    const taken = await scanline('capture');
    const capture = /^(cap_\d+):/m.exec(taken.out)?.[1];

    assert.ok(capture, taken.out);
    assert.match(taken.out, /Replay check: replaying the capture gives an image identical/, 'wrapping the engine changes nothing it draws');

    return { capture, summary: taken.out };
}

before(async () =>
{
    assert.ok(existsSync(binary), `${binary} is missing. Run cargo build first.`);
    server = await serve();
});

after(async () =>
{
    await scanline('stop');
    await server.close();
    rmSync(home, { recursive: true, force: true });
});

afterEach(async () =>
{
    if (!existsSync(join(home, 'control.sock')))
    {
        return;
    }

    for (const [, session] of (await scanline('sessions')).out.matchAll(/\b(ses_\d+)\b/g))
    {
        await scanline('close', '--session', session);
    }
});

describe('a page that uses the protocol', () =>
{
    test('its state comes with every step, and page lists what it offers', async () =>
    {
        const stepped = await opened('fixtures/protocol/webgl2.html', 3);

        assert.match(stepped.out, /Page state \(its own words\): «\{"scene":"orchard"/);

        const quiet = await scanline('step', '--observe', '{"state": false}');

        assert.doesNotMatch(quiet.out, /Page state/);

        const page = await scanline('page', '--json');

        assert.equal(page.code, 0, page.out);
        assert.match(page.json.summary, /The page uses the page protocol \(version 1\)/);
        assert.match(page.json.summary, /«sun\.height» = 0\.8 {2}\(number 0 to 1\) {2}«Height of the sun»/);
        assert.match(page.json.summary, /«season» = "summer" {2}\(one of \["spring","summer","autumn"\]\)/);
        assert.match(page.json.summary, /«bounds» off {2}«Tree bounds»/);
        assert.match(page.json.summary, /«trees» {2}10 draws\n {4}«tree-1» {2}2 draws {2}of Tree «tree-1»/);
        assert.match(page.json.summary, /prg_1: «\{"light":\{"max":2,"min":0\}\}»/);
        assert.match(page.json.summary, /frame +1 {2}«first frame»/);
        assert.equal(page.json.data.controls.length, 3);

        // One part at a time.
        assert.match((await scanline('page', 'state')).out, /^State: «\{"scene":"orchard"/);
        assert.match((await scanline('page', 'nonsense')).out, /page has no call "nonsense"/);
    });

    test('a control is set, checked against what it takes, and changes the picture', async () =>
    {
        await opened('fixtures/protocol/webgl2.html', 3);

        const crown = async () => (await scanline('pixels', 50, 150, '--json')).json.data;
        const summer = await crown();
        const set = await scanline('page', 'set_control', '--id', 'season', '--value', 'autumn');

        assert.match(set.out, /«season» was "summer" and is now "autumn"/);

        await scanline('step');

        assert.notDeepEqual(await crown(), summer, 'the crowns changed colour');

        const refused = await scanline('page', 'set_control', '--id', 'sun.height', '--value', 3);

        assert.notEqual(refused.code, 0);
        assert.match(refused.out, /«sun\.height» was not set: its maximum is 1/);
        assert.match((await scanline('page', 'set_control', '--id', 'moon', '--value', 1)).out, /The page has no control «moon»\. It has: «sun\.height», «wind», «season»/);
    });

    test('a registered view is switched on live, and off', async () =>
    {
        await opened('fixtures/protocol/webgl2.html', 3);

        assert.match((await scanline('live_view')).out, /Views the page can draw: «bounds» \(off\)/);

        const on = await scanline('live_view', 'bounds');

        assert.match(on.out, /«bounds» is on: «A red box round each tree/);

        await scanline('step');

        const groups = await scanline('page', 'groups');

        assert.match(groups.out, /«debug» {2}20 draws/);
        assert.match((await scanline('live_view', 'off')).out, /Switched off: «bounds»/);

        await scanline('step');

        assert.doesNotMatch((await scanline('page', 'groups')).out, /«debug»/);
        assert.match((await scanline('live_view', 'overdraw')).out, /"overdraw" on the running page is not built\. view\(capture, kind: "overdraw"\)/);
        assert.match((await scanline('live_view', 'nope')).out, /The page has no view «nope»\. It has: «bounds» \(off\)/);
    });

    test('the page is run to a mark, saved and restored', async () =>
    {
        await opened('fixtures/protocol/webgl2.html', 2);

        const ran = await scanline('run_until', '--until', '{"mark": "second passed"}');

        assert.match(ran.out, /Stopped at frame 6[23]: the page raised "second passed"/);

        const saved = await scanline('page', 'checkpoint');

        assert.match(saved.out, /^chk_1: the page's state at frame 6[23]/);

        await scanline('page', 'set_control', '--id', 'season', '--value', 'spring');
        assert.match((await scanline('page', 'state')).out, /"season":"spring"/);

        const back = await scanline('page', 'restore', '--checkpoint', 'chk_1');

        assert.match(back.out, /The page's restore\(\) was given chk_1/);
        assert.match((await scanline('page', 'state')).out, /"season":"summer"/);
        assert.match((await scanline('page', 'restore', '--checkpoint', 'chk_9')).out, /There is no checkpoint chk_9/);

        // The engine's own time control is called when asked for, by name.
        assert.match((await scanline('page', 'time', '--action', 'pause')).out, /Called the engine's own pause\(\)/);
        assert.match((await scanline('page', 'time', '--action', 'rewind')).out, /The engine provides no "rewind"\. It provides: pause, resume, step, setScale/);
    });

    test('a capture carries the names: groups, objects, labels', async () =>
    {
        await opened('fixtures/protocol/webgl2.html', 3);

        const { capture, summary } = await captured();

        assert.match(summary, /All 11 draws are in a named group, and every one belongs to an object the page or its engine declared/);

        const tree = await scanline('pass_tree', capture, '--json');

        assert.deepEqual(tree.json.data.groups.map((group) => [group.depth, group.name, group.draws]).slice(0, 4), [[0, 'sky', 0], [0, 'ground', 1], [0, 'trees', 10], [1, 'tree-1', 2]]);
        assert.match(tree.json.summary, /«tree-3» {2}events 6–7 {2}2 draws {2}of Tree «tree-3»/);

        const listed = await scanline('draw_list', capture, '--filter', "path LIKE 'trees / tree-2%'", '--json');

        assert.equal(listed.json.data.total, 2);
        assert.match(listed.json.summary, /of Tree «tree-2» {2}in «trees \/ tree-2»/);

        const one = await scanline('draw', capture, 4);

        assert.match(one.out, /In group «trees \/ tree-2»\./);
        assert.match(one.out, /Object: Tree «tree-2»\. As the page or its engine declared it: «\{"height":\d+,"id":2,"name":"tree-2","path":"orchard\/tree-2","type":"Tree"\}»/);

        // Names given with label() are the objects' labels.
        const labels = await scanline('query', capture, "SELECT kind, label FROM objects WHERE label IS NOT NULL ORDER BY kind, label");

        assert.match(labels.out, /buffer \| unit quad/);
        assert.match(labels.out, /program \| flat/);
        assert.match(labels.out, /shader \| flat\.fragment/);
    });

    test('a page that says nothing is told so, and unmodified mode has no protocol', async () =>
    {
        await opened('fixtures/matrix/webgl2.html', 2);

        const page = await scanline('page');

        assert.match(page.out, /The page has made no page-protocol calls/);
        assert.match((await scanline('page', 'controls')).out, /The page registered no controls/);
        assert.match((await scanline('live_view')).out, /The page registered no debug views/);
        assert.match((await scanline('page', 'checkpoint')).out, /The page offers no checkpoints/);
    });
});

// One engine, one renderer: what the adapter says, and that no draw is left unnamed.
async function adapted (page, engine)
{
    await opened(page, 5);

    const said = await scanline('page');

    assert.match(said.out, engine, said.out);
    assert.match(said.out, /is active: draws are grouped by the engine object they belong to/);

    const { capture, summary } = await captured();

    assert.match(summary, /draws? (is|are) in a named group, and (every one )?belongs? to an object the page or its engine declared/, summary);

    const loose = await scanline('query', capture, "SELECT count(*) AS loose FROM draws WHERE kind = 'draw' AND entity IS NULL", '--json');

    assert.deepEqual(loose.json.data.rows, [[0]], 'every draw resolves to an engine object');

    const tree = await scanline('pass_tree', capture, '--json');

    return { capture, tree: tree.json.summary, groups: tree.json.data.groups };
}

describe('engine adapters: every draw resolves to an engine object', () =>
{
    test('three.js, WebGLRenderer: objects, instancing, materials and the shadow pass', async () =>
    {
        const { capture, tree } = await adapted('fixtures/adapters/three.html', /Engine: three\.js r187 \(WebGLRenderer\) detected/);

        assert.match(tree, /«Courtyard → canvas» {2}events 0–14 {2}13 draws/);
        assert.match(tree, /«shadow maps» {2}events 0–4 {2}4 draws\n {6}«Pillars» {2}event 1 {2}1 draw {2}of InstancedMesh «Pillars»/);
        assert.match(tree, /«Crate» {2}events 8–10 {2}3 draws {2}of Mesh «Crate»/);
        assert.match(tree, /«GlassBall» {2}events 13–14 {2}2 draws/);

        // One object, two materials: each draw says which.
        const crate = await scanline('query', capture, "SELECT entity_detail FROM draws WHERE draw BETWEEN 8 AND 10", '--json');
        const materials = crate.json.data.rows.map((row) => JSON.parse(row[0])).map((entity) => `${entity.material.name} ${entity.materialIndex}`).sort();

        assert.deepEqual(materials, ['Lid 1', 'Wood 0', 'Wood 0']);

        const shadow = await scanline('draw', capture, 1);

        assert.match(shadow.out, /"instances":5/);
        assert.match(shadow.out, /"shadowPass":true/);

        // The engine's own settings are controls.
        const set = await scanline('page', 'set_control', '--id', 'three.shadows', '--value', 'false');

        assert.match(set.out, /«three\.shadows» was true and is now false/);
    });

    test('three.js, WebGPURenderer', async () =>
    {
        const { tree } = await adapted('fixtures/adapters/three.html?renderer=webgpu', /Engine: three\.js r187 \(WebGPURenderer, WebGPU\) detected/);

        assert.match(tree, /«Shadow Map \[ Sun \] → ShadowMap 256×256» {2}events \d+–\d+ {2}4 draws/);
        assert.match(tree, /«Pillars» {2}event \d+ {2}1 draw {2}of InstancedMesh «Pillars»/);
        assert.match(tree, /«Output Color Transform» {2}event \d+ {2}1 draw {2}of QuadMesh «Output Color Transform»/);
    });

    for (const [name, query, renderer] of [['WebGL', '', 'webgl'], ['WebGPU', '?renderer=webgpu', 'webgpu']])
    {
        test(`PixiJS, ${name}: what is in each batch, and why it ended`, async () =>
        {
            const { capture, tree } = await adapted(`fixtures/adapters/pixi.html${query}`, new RegExp(`Engine: PixiJS 8\\.22\\.0 \\(${renderer}\\) detected`));

            assert.match(tree, /«batch 1 \(3 objects\)» {2}event 1 {2}1 draw {2}of Batch «3 objects»/);
            assert.match(tree, /«batch 2 \(Gem-3\)»/);
            assert.match(tree, /«filter pass 1» {2}events? [\d–]+ {2}1 draw {2}of FilterPass «filter on BlurredPanel»/);
            assert.match(tree, /«BigStar» {2}event \d+ {2}1 draw {2}of graphics «BigStar»/);

            const reasons = await scanline('query', capture, "SELECT draw, entity_detail FROM draws WHERE entity = 'Batch «3 objects»' ORDER BY draw", '--json');
            const [first, second] = reasons.json.data.rows.map((row) => JSON.parse(row[1]));

            assert.deepEqual(first.first, ['Coin-0', 'Gem-1', 'Coin-2']);
            assert.equal(first.ended, 'the blend mode changed (normal to add)');
            assert.deepEqual(first.textures, ['coin', 'gem']);
            assert.equal(second.ended, 'a filter (pushFilter) came next, which cannot be batched');

            // The engine's own account: how many batches, and why each ended.
            const said = await scanline('page', '--json');
            const engine = JSON.parse(said.json.data.engine[0].text);

            assert.equal(engine.lastFrame.batches, 8);
            assert.equal(engine.lastFrame.batchEndedBecause['the blend mode changed'], 2);
            assert.equal(engine.stages[0].name, 'Stage');
        });
    }

    test('Phaser 4: the game objects in each batch, per camera, and why it was flushed', async () =>
    {
        const { capture, tree, groups } = await adapted('fixtures/adapters/phaser.html', /Engine: Phaser 4\.2\.1 \(WebGL\) detected/);

        assert.deepEqual(groups.filter((group) => group.depth === 0).map((group) => [group.name, group.draws]), [['scene Yard, camera Main', 5], ['scene Yard, camera Minimap', 6]]);
        assert.match(tree, /«batch 2 \(Gem-3\)» {2}event 2 {2}1 draw {2}of Batch «Gem-3»/);
        assert.match(tree, /«batch 6 \(camera Minimap\)» {2}event 6 {2}1 draw {2}of Camera «Minimap»/);

        const details = await scanline('query', capture, "SELECT draw, entity_detail FROM draws WHERE kind = 'draw' ORDER BY draw LIMIT 5", '--json');
        const batches = details.json.data.rows.map((row) => JSON.parse(row[1]));

        assert.deepEqual(batches[0].first, ['Coin-0', 'Gem-1', 'Coin-2']);
        assert.match(batches[0].ended, /^the drawing context changed/);
        assert.deepEqual(batches[3].kinds, { Arc: 1, Rectangle: 1 });
        assert.equal(batches[3].ended, 'a different kind of batch began (BatchHandlerQuad)');
        assert.deepEqual(batches[4].first, ['CrateBody', 'CrateLid', 'ScoreText', 'Player']);
        assert.equal(batches[4].ended, 'the camera had drawn everything it sees');
    });

    test('an engine the adapter does not map says so: Phaser on its Canvas renderer', async () =>
    {
        await opened('fixtures/engines/phaser.html?renderer=canvas', 3);

        const said = await scanline('page');

        assert.match(said.out, /Engine: Phaser 4\.2\.1 \(Canvas\) detected; the adapter was tested with 4\.2 and is off\./);
        assert.match(said.out, /This game uses the Canvas renderer, which issues no WebGL or WebGPU draws/);
    });
});
