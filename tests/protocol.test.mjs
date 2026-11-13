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

import { binary, hostRunning } from './host.mjs';
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
    if (!hostRunning(home))
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
        assert.match((await scanline('live_view', 'stencil')).out, /The stencil view reads a finished frame and is not drawn on the running page.*and the page's own views: «bounds» \(off\)/);
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
        assert.match((await scanline('live_view')).out, /The page registered no debug views of its own/);
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

    for (const [name, query, renderer] of [['its WebGL engine', '', /Engine: Babylon\.js 9\.35\.0 \(Engine, WebGL 2\) detected/], ['its WebGPU engine', '?engine=webgpu', /Engine: Babylon\.js 9\.35\.0 \(WebGPUEngine, WebGPU\) detected/]])
    {
        test(`Babylon.js, ${name}: meshes, materials and the shadow map`, async () =>
        {
            const { capture, tree } = await adapted(`fixtures/engines/babylon-shadows.html${query}`, renderer);

            assert.match(tree, /«Scene \(camera camera\) → canvas» {2}events 0–9 {2}8 draws/);
            assert.match(tree, /«sun_shadowMap 512×512» {2}events 1–4 {2}3 draws/);
            assert.match(tree, /of GroundMesh «ground»/);
            assert.match(tree, /of Mesh «box 2»/);

            // A mesh drawn into the shadow map says so, and names the material it is lit with.
            const details = await scanline('query', capture, "SELECT draw, entity, entity_detail FROM draws WHERE kind = 'draw' ORDER BY draw", '--json');
            const entities = details.json.data.rows.map((row) => JSON.parse(row[2]));

            assert.deepEqual(entities.map((entity) => entity.name), ['box 0', 'box 1', 'ball', 'ground', 'box 0', 'box 1', 'ball', 'box 2']);
            assert.deepEqual(entities.map((entity) => entity.shadowPass === true), [true, true, true, false, false, false, false, false]);
            assert.equal(entities[3].material.type, 'StandardMaterial');

            // The engine's own settings are controls: with shadows off there is no shadow pass.
            const set = await scanline('page', 'set_control', '--id', 'babylon.shadows', '--value', 'false');

            assert.match(set.out, /«babylon\.shadows» was true and is now false/);
            await scanline('step', 2);

            const after = await captured();

            assert.doesNotMatch((await scanline('pass_tree', after.capture)).out, /sun_shadowMap/);
        });
    }

    for (const [name, query, renderer] of [
        ['its WebGL 2 device', '', /Engine: PlayCanvas 2\.24\.0 \(WebglGraphicsDevice, WebGL 2\) detected/],
        ['its WebGPU device', '?device=webgpu', /Engine: PlayCanvas 2\.24\.0 \(WebgpuGraphicsDevice, WebGPU\) detected/]
    ])
    {
        test(`PlayCanvas, ${name}: mesh instances, materials and the shadow map`, async () =>
        {
            const { capture, tree } = await adapted(`fixtures/engines/playcanvas.html${query}`, renderer);

            // The frame, and inside it the engine's passes: the sun's shadow map, then the
            // camera's pass over its layers.
            assert.match(tree, /«Application» {2}events 0–9 {2}8 draws/);
            assert.match(tree, /«shadow map of sun → ShadowMap2D_DEPTH 512×512» {2}events 0–3 {2}3 draws/);
            assert.match(tree, /«World, Skybox, Immediate, UI \(camera camera\) → canvas» {2}events 4–9 {2}5 draws/);
            assert.match(tree, /of MeshInstance «ground»/);

            // A mesh instance drawn into the shadow map says so, and names its material.
            const details = await scanline('query', capture, "SELECT draw, entity, entity_detail FROM draws WHERE kind = 'draw' ORDER BY draw", '--json');
            const entities = details.json.data.rows.map((row) => JSON.parse(row[2]));
            const names = entities.map((entity) => entity.name);

            // The engine sorts what it draws, so within a pass only the membership is held
            // to; the see-through box is drawn last, after everything opaque.
            assert.deepEqual(names.slice(0, 3).sort(), ['ball', 'box 0', 'box 1'], 'the three that cast shadows');
            assert.deepEqual(names.slice(3).sort(), ['ball', 'box 0', 'box 1', 'box 2', 'ground']);
            assert.equal(names[7], 'box 2');
            assert.deepEqual(entities.map((entity) => entity.shadowPass === true), [true, true, true, false, false, false, false, false]);
            assert.deepEqual(entities.find((entity) => entity.name === 'ground').material, { type: 'StandardMaterial', name: 'grass' });
            assert.ok(entities.every((entity) => entity.type === 'MeshInstance' && typeof entity.id === 'number'));

            // What the engine says of itself comes with the page's state.
            const said = await scanline('page');

            assert.match(said.out, /What PlayCanvas says of itself: «\{"applications":\[\{"layers":\[\{"name":"World","enabled":true,"meshInstances":5\}/);

            // With no light casting shadows there is no shadow pass, and switching it back restores it.
            const set = await scanline('page', 'set_control', '--id', 'playcanvas.shadows', '--value', 'false');

            assert.match(set.out, /«playcanvas\.shadows» was true and is now false/);
            await scanline('step', 2);

            assert.doesNotMatch((await scanline('pass_tree', (await captured()).capture)).out, /shadow map of sun/);

            await scanline('page', 'set_control', '--id', 'playcanvas.shadows', '--value', 'true');
            await scanline('step', 2);

            assert.match((await scanline('pass_tree', (await captured()).capture)).out, /shadow map of sun/);
        });
    }

    test('an engine the adapter does not map says so: Phaser on its Canvas renderer', async () =>
    {
        await opened('fixtures/engines/phaser.html?renderer=canvas', 3);

        const said = await scanline('page');

        assert.match(said.out, /Engine: Phaser 4\.2\.1 \(Canvas\) detected; the adapter was tested with 4\.2 and is off\./);
        assert.match(said.out, /This game uses the Canvas renderer, which issues no WebGL or WebGPU draws/);
    });
});

describe('watches (docs/GAME.md, section 3)', () =>
{
    for (const gpu of ['webgl', 'webgpu'])
    {
        test(`a velocity that turns NaN stops the game on its frame, in ${gpu}`, async () =>
        {
            const launched = await scanline('launch', server.url(`fixtures/protocol/watch.html?gpu=${gpu}`), '--headless', '--paused');

            assert.match(launched.out, /Launched ses_\d+/, launched.out);

            const watched = await scanline('watch', 'game.player.body.velocity', '--break', 'true');

            assert.match(watched.out, /Watching 2 properties: «game\.player\.body\.velocity» \(expression\): «x» = 2, «y» = 0\./, watched.out);
            assert.match(watched.out, /Rules: finite \(breaks\)\./);

            const ran = await scanline('run_until', '--until', '{"frames": 100}');

            assert.match(ran.out, /Stopped at frame 40: watch «game\.player\.body\.velocity\.x» broke its rule finite: 2 became NaN/, ran.out);

            const read = await scanline('watches', '--history', 5);

            assert.match(read.out, /«player» \(the page's sprite\): «x» = NaN ✗, «y» = 90/, read.out);
            assert.match(read.out, /«player»\.«body\.velocity\.x» broke finite at frame 40: 2 became NaN/);
            assert.match(read.out, /«x»: 92, 94, 96, 98, NaN/);
            assert.match(read.out, /«frame\.name»: «"run-0"», «"run-1"», «"run-2"», «"run-3"», «"run-0"»/);

            // The page's own watch has no break rule: it is told, and the game ran on to the agent's.
            const events = await scanline('events', '--kinds', '["watch-broken"]', '--json');

            assert.ok(events.json.data.events.some((event) => event.data.name === 'player' && event.data.prop === 'body.velocity.x' && event.data.frame === 40 && event.data.breaks === false));

            // Set from the debugger, the sprite comes back where it was put.
            const sprite = async () => (await scanline('pixels', 112, 100, '--json')).json.data;
            const gone = await sprite();

            assert.match((await scanline('watch_set', 'player', 'x', 100)).out, /«player»\.«x» was NaN and is now 100\./);
            assert.match((await scanline('watch_set', 'player', 'body.velocity.x', 1)).out, /was NaN and is now 1\./);
            await scanline('step', 2);
            assert.notDeepEqual(await sprite(), gone, 'the sprite is drawn again');
            assert.match((await scanline('watches', 'player')).out, /«x» = 102, «y» = 90/);

            // A capture carries the watches' values at its frame.
            const taken = await scanline('capture');

            assert.match(taken.out, /Watches at this frame \(its data has their last 60 frames\):\n {2}«player» \(the page's sprite\): «x» = 10\d/, taken.out);
        });
    }

    test('what cannot be watched or set is refused plainly', async () =>
    {
        await opened('fixtures/protocol/watch.html?nan=0', 2);

        assert.match((await scanline('watch', 'game.player.(')).out, /Not watched: the expression does not compile/);
        assert.match((await scanline('watch_set', 'player', 'frame.name', 3)).out, /«player»\.«frame\.name» was not set: frame\.name is a string, so it takes a string\./);
        assert.match((await scanline('watch_set', 'nobody', 'x', 3)).out, /There is no watch «nobody»\. Watched: «player»\./);

        // An object's own primitive properties, two levels down.
        const deep = await scanline('watch', 'game', '--depth', 2, '--name', 'game');

        assert.match(deep.out, /«player\.x» = 2\d, «player\.y» = 90/, deep.out);
        assert.match((await scanline('unwatch', '--all', 'true')).out, /Removed 2 watches\./);
        assert.match((await scanline('watches')).out, /Nothing is watched\./);
    });
});
