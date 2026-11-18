// The page protocol and the engine adapters, through the CLI (05-PAGE-PROTOCOL.md).
//
//   npm run build && cargo build && npm run test:protocol
//
// The protocol: a page that names its draws, offers its state and registers controls and
// views is read and driven through `page` and `live_view`, and its names reach a capture.
// The adapters: on three.js, PixiJS and Phaser, with no change to the page, every draw of a
// frame resolves to an engine object.

import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

describe('audio (docs/GAME.md, section 4)', () =>
{
    test('the graph, its levels, its buffers and changes to how it sounds', async () =>
    {
        const launched = await scanline('launch', server.url('fixtures/protocol/audio.html'), '--headless');

        assert.match(launched.out, /Launched ses_\d+/, launched.out);
        await scanline('eval', 'new Promise((done) => { const check = () => (window.sound.ready && sound.context.currentTime > 0.5 ? done(true) : setTimeout(check, 50)); check(); })');

        const heard = await scanline('audio', '--json');
        const summary = heard.json.summary;

        assert.match(summary, /1 context, 7 nodes, 2 playing, 2 buffers/, summary);
        assert.match(summary, /anode_2 Oscillator \(detune 0, frequency 440\) \[playing, sine\] → anode_3/);
        assert.match(summary, /anode_3 Gain «master» \(gain 0\.5\) → anode_4/);
        assert.match(summary, /anode_4 BiquadFilter .*\[lowpass\] → anode_5/);
        assert.match(summary, /anode_5 Delay \(delayTime 0\.1\) → anode_1/);
        assert.match(summary, /anode_7 AudioBufferSource .*\[playing, looped, abuf_\d\] → anode_6/);
        assert.match(summary, /tone\.wav was decoded 2 times/);

        // Within 1 dB of what the fixture computes for a sine at half amplitude.
        const level = heard.json.data.contexts[0].level;

        assert.ok(Math.abs(level.peak - 20 * Math.log10(0.5)) < 1, `peak ${level.peak}`);
        assert.ok(Math.abs(level.rms - 20 * Math.log10(0.5 / Math.SQRT2)) < 1, `rms ${level.rms}`);

        const node = await scanline('audio_node', 'anode_3');

        assert.match(node.out, /anode_3 GainNode «master» in actx_1/);
        assert.match(node.out, /gain = 0\.5 \(default 1, .*\); latest automation: setValueAtTime\(0\.5, 0\)/);
        assert.match(node.out, /From: anode_2\. To: anode_4\./);
        assert.match(node.out, /Level now: peak -6\.\d dBFS/);

        // Muted, the game goes silent; undone, it is heard again.
        assert.match((await scanline('audio_patch', 'anode_2', 'mute')).out, /apatch_1: anode_2 is muted/);
        await scanline('eval', 'new Promise((done) => setTimeout(done, 300))');
        assert.equal((await scanline('audio', '--json')).json.data.contexts[0].level.peak, null, 'silent');
        assert.match((await scanline('audio_patch', '--all', 'true')).out, /Undid 1 audio patch/);
        await scanline('eval', 'new Promise((done) => setTimeout(done, 300))');
        assert.ok((await scanline('audio', '--json')).json.data.contexts[0].level.peak > -7, 'heard again');

        // Bypassing the gain doubles the level: about +6 dB.
        assert.match((await scanline('audio_patch', 'anode_3', 'bypass')).out, /anode_3 is bypassed/);
        await scanline('eval', 'new Promise((done) => setTimeout(done, 300))');
        assert.ok(Math.abs((await scanline('audio', '--json')).json.data.contexts[0].level.peak) < 1, 'full scale');
        await scanline('audio_patch', '--all', 'true');

        const held = await scanline('audio_patch', 'anode_4', 'param', '--param', 'frequency', '--value', 300);

        assert.match(held.out, /anode_4's frequency was 8000 and is now 300/);
        assert.match((await scanline('audio_patch', 'anode_4', 'param', '--param', 'nothing', '--value', 1)).out, /BiquadFilterNode has no parameter nothing; it has frequency, detune, Q, gain|has no parameter nothing/);

        const buffers = await scanline('audio', 'buffers');

        assert.match(buffers.out, /abuf_1 0\.5 s, 1 ch, \d+ Hz, \d+ KB in memory, decoded from «http:\/\/127\.0\.0\.1:\d+\/fixtures\/protocol\/tone\.wav» \(8 KB file\)/, buffers.out);
    });
});

describe('takes (docs/GAME.md, section 5)', () =>
{
    // Click Start, choose a level, then walk right for `walk` frames.
    async function playThrough (level, walk)
    {
        await scanline('input', '--events', '[{"pointer": "down", "x": 160, "y": 100}, {"pointer": "up", "x": 160, "y": 100}]');
        await scanline('step', 3);

        for (let index = 1; index < level; index++)
        {
            await scanline('input', '--events', '[{"key": "ArrowDown", "press": true}]');
            await scanline('step', 2);
        }

        await scanline('input', '--events', '[{"key": "Enter", "press": true}]');
        await scanline('step', 3);
        await scanline('input', '--events', '[{"key": "ArrowRight", "down": true}]');
        await scanline('step', walk);
        await scanline('input', '--events', '[{"key": "ArrowRight", "down": false}]');
        await scanline('step', 5);
    }

    const state = async () => (await scanline('eval', 'JSON.stringify([game.scene, game.level, game.player.x])', '--json')).json.data.value;

    test('a take through a menu plays back to the same frame, ten times running', async () =>
    {
        await scanline('launch', server.url('fixtures/protocol/menu.html'), '--headless', '--paused', '--deterministic', 'true');
        await scanline('step', 5);

        const started = await scanline('take', 'start', 'door-walk');

        assert.match(started.out, /Recording take «door-walk» from frame 5\. It plays from the page's load, with the input before frame 5 too/, started.out);
        await playThrough(1, 100);

        const kept = await scanline('take', 'stop');

        assert.match(kept.out, /Take «door-walk»: frames 5–\d+ \(\d+ frames\) with .*key presses?, .*playing from the page's load\./, kept.out);

        const end = await state();

        assert.match(end, /\["play",1,2\d\d\]/, end);

        for (let time = 0; time < 10; time++)
        {
            const played = await scanline('take', 'play', 'door-walk');

            assert.match(played.out, /Played take «door-walk» to frame \d+\. Paused\./, played.out);
            assert.match(played.out, /All \d+ fingerprints along the way match the original/);
            assert.equal(await state(), end, `play ${time + 1} reached the same place`);
        }

        // Stopped early: at the page's mark, and with a capture where it ends.
        const marked = await scanline('take', 'play', 'door-walk', '--until_mark', 'door', '--then', 'capture');

        assert.match(marked.out, /Stopped the replay of take «door-walk» at frame \d+ of \d+: the page marked «door» at frame \d+\. Paused\./, marked.out);
        assert.match(marked.out, /cap_\d+: frame \d+/);

        assert.match((await scanline('takes')).out, /door-walk {2}frames 5–\d+, .*from load, deterministic/);
        assert.match((await scanline('take', 'rename', 'door-walk', '--to', 'walk')).out, /Take «door-walk» is now «walk»\./);
        assert.match((await scanline('take', 'play', 'nothing')).out, /There is no take "nothing"\. Takes: walk\./);
        assert.match((await scanline('take', 'start', '../x')).out, /cannot be a take's name/);
        assert.match((await scanline('take', 'remove', 'walk')).out, /Removed take «walk»\./);
    });

    test('a take stops where a watch breaks, with the watch added again after the reload', async () =>
    {
        await scanline('launch', server.url('fixtures/protocol/menu.html'), '--headless', '--paused', '--deterministic', 'true');
        await scanline('take', 'start', 'level-two');
        await playThrough(2, 100);
        await scanline('take', 'stop');
        await scanline('watch', 'game.player', '--name', 'hero', '--break', 'true');

        const played = await scanline('take', 'play', 'level-two');

        assert.match(played.out, /Stopped the replay of take «level-two» at frame \d+ of \d+: watch «hero» broke its rule finite on «v?x» at frame \d+\. Paused\./, played.out);
        assert.match(played.out, /1 of 1 watch was added again after the reload/);
        assert.match((await scanline('watches', 'hero')).out, /«vx» = NaN ✗/);
        await scanline('take', 'remove', 'level-two');
    });

    test('a take that begins part way plays from the checkpoint the page saved', async () =>
    {
        await scanline('launch', server.url('fixtures/protocol/menu.html?checkpoint=1'), '--headless', '--paused');
        await playThrough(1, 20);

        const started = await scanline('take', 'start', 'from-here');

        assert.match(started.out, /The page saved a checkpoint at frame \d+; the take plays from there\./, started.out);
        await scanline('input', '--events', '[{"key": "ArrowRight", "down": true}]');
        await scanline('step', 30);
        await scanline('input', '--events', '[{"key": "ArrowRight", "down": false}]');
        await scanline('step', 5);
        assert.match((await scanline('take', 'stop')).out, /playing from the checkpoint saved at frame \d+\./);

        const end = await state();

        // Somewhere else entirely, then back.
        await scanline('input', '--events', '[{"key": "ArrowRight", "down": true}]');
        await scanline('step', 40);
        await scanline('input', '--events', '[{"key": "ArrowRight", "down": false}]');
        assert.notEqual(await state(), end);

        const played = await scanline('take', 'play', 'from-here');

        assert.match(played.out, /Played take «from-here» from its checkpoint \(saved at frame \d+\) for 35 frames\./, played.out);
        assert.equal(await state(), end);
        await scanline('take', 'remove', 'from-here');
    });
});

describe('notes (docs/GAME.md, section 6)', () =>
{
    test('a note reaches the agent with the marked frame, a capture, a take, the watches and the audio', async () =>
    {
        await scanline('launch', server.url('fixtures/protocol/watch.html?nan=0'), '--headless', '--paused');
        await scanline('step', 30);

        const cursor = (await scanline('events', '--json')).json.data.next;
        const marks = [
            { tool: 'ellipse', x: 70, y: 80, w: 40, h: 40, colour: 'yellow' },
            { tool: 'arrow', from: [200, 60], to: [120, 95] },
            { tool: 'text', x: 250, y: 100, text: 'it should be here' }
        ];
        const made = await scanline('note', '--text', 'the sprite stops short', '--marks', JSON.stringify(marks), '--json');

        assert.equal(made.code, 0, made.out);

        const id = made.json.data.note;

        assert.match(made.json.summary, /note_\d+, from the person at frame 30 of «.*watch\.html\?nan=0»: «the sprite stops short»/);
        assert.match(made.json.summary, /a yellow ring round 90,100, 40×40; a red arrow from 200,60 pointing at 120,95/);
        assert.match(made.json.summary, /Pin 1 at 250,100: «it should be here»/);
        assert.match(made.json.summary, /Capture: cap_\d+, of frame 31/);
        assert.match(made.json.summary, /Watch: «player» \(the page's sprite\): «x» = 80/);

        assert.equal(made.json.images.length, 2, 'the frame with the marks and without');

        // The agent hears of it, and can read it again.
        const heard = await scanline('wait', '--kinds', '["note"]', '--cursor', cursor, '--json');

        assert.equal(heard.json.data.events[0].data.note, id);
        assert.match((await scanline('note', id)).out, /«the sprite stops short»/);
        assert.match((await scanline('notes')).out, new RegExp(`${id} {2}frame 30 {2}«the sprite stops short» {2}cap_\\d+`));

        // Its take reaches the same frame again.
        await scanline('step', 20);
        assert.match((await scanline('take', 'play', id)).out, new RegExp(`Played take «${id}» to frame 30\\. Paused\\.`));
        assert.match((await scanline('watches', 'player')).out, /«x» = 80/);

        assert.match((await scanline('note')).out, /A note needs text or marks/);
        assert.match((await scanline('note', 'note_999')).out, /There is no note "note_999"/);
    });
});

describe('audio clips (docs/GAME.md, A6)', () =>
{
    test('a clip of the fixture\'s tone is the tone', async () =>
    {
        await scanline('launch', server.url('fixtures/protocol/audio.html'), '--headless');
        assert.match((await scanline('audio_clip')).out, /Audio is not being kept/);
        assert.match((await scanline('audio_clip', '--record', 'true')).out, /Keeping the last 10 s of what 1 context plays/);
        await scanline('eval', 'new Promise((done) => setTimeout(done, 2500))');

        const clip = await scanline('audio_clip', '--seconds', 2, '--json');
        const file = readFileSync(clip.json.data.path);
        const rate = file.readUInt32LE(24);
        const left = [];

        for (let at = 44; at + 4 <= file.length; at += 4)
        {
            left.push(file.readInt16LE(at) / 32768);
        }

        const peak = Math.max(...left.map(Math.abs));
        let crossings = 0;

        for (let index = 1; index < left.length; index++)
        {
            crossings += left[index - 1] < 0 && left[index] >= 0 ? 1 : 0;
        }

        assert.equal(file.toString('ascii', 0, 4), 'RIFF');
        assert.ok(Math.abs(left.length / rate - 2) < 0.1, `${left.length / rate} s`);
        assert.ok(Math.abs(20 * Math.log10(peak) - 20 * Math.log10(0.5)) < 1, `peak ${peak}`);
        assert.ok(Math.abs(crossings / (left.length / rate) - 440) < 5, `${crossings / (left.length / rate)} Hz`);
    });
});

describe('watchable engine objects (docs/GAME.md, W3)', () =>
{
    for (const [page, path, line] of [
        ['three', 'scene0/GreenCube', /«scene0\/GreenCube» \(the three\.js Mesh\): «position\.x» = 0, «position\.y» = [\d.]+/],
        ['phaser', 'default/Mover', /«default\/Mover» \(the Phaser Rectangle\): «x» = [\d.]+, «y» = [\d.]+/]
    ])
    {
        test(`${page}: the engine's objects are listed and watched with no change to the page`, async () =>
        {
            await opened(`fixtures/engines/${page}.html`, 10);

            const listed = await scanline('watchable');

            assert.match(listed.out, new RegExp(`«${path.replace('/', '\\/')}»`), listed.out);

            const watched = await scanline('watch', '--object', path);

            assert.match(watched.out, line, watched.out);
            await scanline('step', 5);
            assert.match((await scanline('watches', path)).out, line);
            assert.match((await scanline('watch', '--object', 'nowhere/Nothing')).out, /Not watched: no object at nowhere\/Nothing/);
        });
    }
});

// A page that loads the way a small game does (fixtures/protocol/loading.html): assets that
// arrive when they arrive, shaders built in the background, a second stage of loading, and
// a visitor's id kept in storage. `?slow=150` has the test server answer each asset after a
// random wait, so that no two loads go the same way.
describe('waiting until a page is ready', () =>
{
    const page = (query = 'slow=150') => server.url(`fixtures/protocol/loading.html?${query}`);
    const state = async () => JSON.parse((await scanline('page', '--json')).json.data.state.text);

    test('a deterministic launch answers once the page has loaded, says how long it took, and counts frames from there', async () =>
    {
        const launched = await scanline('launch', page(), '--headless', '--paused', '--deterministic', 'true', '--json');

        assert.equal(launched.code, 0, launched.out);
        assert.match(launched.json.summary, /Paused at frame 0\./);
        assert.match(launched.json.summary, /Ready \d+\.\d\d s after the page began to load \(its loading went quiet\); frames count from there, and the \d+ it ran while loading are not counted\./);
        assert.equal(launched.json.data.ready.state, 'ready');
        assert.equal(launched.json.data.ready.reason, 'quiet');
        assert.equal(launched.json.data.ready.held, false, 'the start line is drawn');
        assert.ok(launched.json.data.ready.loadingFrames > 0, 'its shaders were asked after once a frame, which took frames');
        assert.equal(launched.json.data.frame, 0);

        // Everything it loads is in, though no frame has been counted, and page time has not moved.
        assert.equal((await state()).loaded, true);
        assert.equal(launched.json.data.time_ms, 0);

        // The first step is the game's first frame after loading: no polling for it.
        const stepped = await scanline('step', '--json');

        assert.equal(stepped.json.data.frame, 1);
        assert.equal(stepped.json.data.reason, 'step');
        assert.doesNotMatch(stepped.json.summary, /Nothing to step/);
        assert.match((await scanline('events')).out, /ready: \{"frame":0,"loadingFrames":\d+,"ms":[\d.]+,"reason":"quiet"\}/);
    });

    test('a page that says when it is ready is taken at its word', async () =>
    {
        const launched = await scanline('launch', page('slow=150&say'), '--headless', '--paused', '--deterministic', 'true', '--json');

        assert.match(launched.json.summary, /Ready \d+\.\d\d s after the page began to load \(the page said so\); frames count from there/);
        assert.equal(launched.json.data.ready.reason, 'page');
        assert.equal((await state()).loaded, true);
    });

    test('a running page can be waited for, at launch or later; a page held from its first instant says it is still loading', async () =>
    {
        // Asked for at launch, in a session that holds nothing.
        const waited = await scanline('launch', page(), '--headless', '--wait', 'ready', '--json');

        assert.match(waited.json.summary, /Running at frame \d+\./);
        assert.match(waited.json.summary, /Ready \d+\.\d\d s after the page began to load \(its loading went quiet\)\./);
        assert.equal(waited.json.data.ready.loadingFrames, 0, 'its frames were counted as they ran');
        assert.equal((await state()).loaded, true);
        await scanline('close');

        // Not asked for: the launch answers at once, and run_until waits.
        const quick = await scanline('launch', page('slow=400'), '--headless', '--json');

        assert.match(quick.json.summary, /Still loading after \d+\.\d s: waiting on /);

        const until = await scanline('run_until', '--until', '{"ready": true}', '--json');

        assert.equal(until.json.data.met, true, until.out);
        assert.match(until.json.summary, /Ready \d+\.\d\d s after the page began to load \(its loading went quiet\), after a wait of \d+\.\d\d s\. Paused at frame \d+\./);
        assert.equal((await state()).loaded, true);
        assert.match((await scanline('run_until', '--until', '{"ready": true}')).out, /Already ready:/);
        await scanline('close');

        // Paused, and not asked to wait: time is held from the first instant, as it always was,
        // and the page's loading stops where it needs a frame. Step says so.
        const held = await scanline('launch', page(), '--headless', '--paused', '--json');

        assert.equal(held.json.data.ready.state, 'loading');
        assert.match(held.json.summary, /Still loading after \d+\.\d s: waiting on /);
        assert.equal((await scanline('step', '--json')).json.data.frame, 1, 'the first frame is the page\'s first, loading or not');
        await scanline('close');

        // Paused and asked to wait: it loads first, then holds.
        const patient = await scanline('launch', page(), '--headless', '--paused', '--wait', 'ready', '--json');

        assert.match(patient.json.summary, /Paused at frame 0\./);
        assert.match(patient.json.summary, /frames count from there/);
        assert.equal((await state()).loaded, true);

        assert.match((await scanline('launch', page(), '--headless', '--wait', 'soon')).out, /wait is "ready" \(answer once the page has finished loading\) or "none", not "soon"\./);
    });

    test('wait: none keeps time held from the page\'s first instant in a deterministic session', async () =>
    {
        const launched = await scanline('launch', page(), '--headless', '--paused', '--deterministic', 'true', '--wait', 'none', '--json');

        assert.equal(launched.json.data.ready.held, false);
        assert.doesNotMatch(launched.json.summary, /frames count from there/);

        await scanline('step', 3);
        assert.equal((await scanline('status', '--json')).json.data.frame, 3);
        assert.equal((await state()).loaded, false, 'three frames in, it is still loading: they were counted');
    });

    test('a page with nothing to load is held from its first instant, and is ready at once', async () =>
    {
        const launched = await scanline('launch', server.url('fixtures/matrix/game.html'), '--headless', '--paused', '--deterministic', 'true', '--json');

        assert.match(launched.json.summary, /Ready \d+\.\d\d s after the page began to load \(its loading went quiet\); frames count from there\./);
        assert.equal(launched.json.data.ready.loadingFrames, 0, 'none of its frames ran before the line');
        assert.equal(launched.json.data.frame, 0);
    });
});

describe('replays that hold across loading', () =>
{
    const page = (query = 'slow=150') => server.url(`fixtures/protocol/loading.html?${query}`);
    const state = async () =>
    {
        const { frame, events, ...rest } = JSON.parse((await scanline('page', '--json')).json.data.state.text);

        return JSON.stringify({ ...rest, events });
    };

    // A pointer between whole pixels (the page is at a pixel ratio of 2), a drag, and keys.
    const play = [
        { at: 10, pointer: 'move', x: 201, y: 121 },
        { at: 30, pointer: 'down', x: 201, y: 121 },
        { at: 40, pointer: 'move', x: 401, y: 301 },
        { at: 60, pointer: 'up', x: 401, y: 301 },
        { at: 70, key: 'ArrowLeft', down: true },
        { at: 100, key: 'ArrowLeft', down: false },
        { at: 110, pointer: 'move', x: 99, y: 77 }
    ];

    test('a run recorded on a page whose assets arrive at different moments replays with every fingerprint matching', async () =>
    {
        const launched = await scanline('launch', page(), '--headless', '--paused', '--deterministic', 'true', '--dpr', 2);

        assert.match(launched.out, /frames count from there/, launched.out);

        const stepped = await scanline('step', 150, '--fast', '--events', JSON.stringify(play));

        assert.match(stepped.out, /Frame 150 \(stepped 150\)/, stepped.out);

        const recorded = await state();
        const first = JSON.parse(recorded);

        assert.equal(first.loaded, true);
        assert.match(first.id, /^[0-9a-f]{12}$/, 'a first visit: the id was made, from the seeded sequence');
        assert.deepEqual(first.pointer, [49.75, 38.75], 'the pointer is between whole pixels');
        assert.equal(first.moves, 2, 'the first move of all goes no distance and is not counted; the two after it are');

        const saved = await scanline('save_run', '--json');

        assert.equal(saved.json.data.prints, 5);

        for (let time = 0; time < 3; time++)
        {
            const replayed = await scanline('replay_run', saved.json.data.run, '--json');

            assert.equal(replayed.json.data.diverged, null, replayed.json.summary);
            assert.equal(replayed.json.data.matched, 5, replayed.json.summary);
            assert.match(replayed.json.summary, /All 5 fingerprints along the way match the original/);

            // And the page itself is where it was: the same id made again (not found, as a
            // returning visitor's would be), the same pointer to the quarter pixel, the same events.
            assert.equal(await state(), recorded, `replay ${time + 1}`);
        }
    });

    test('a second launch of the same page, given the same input, draws the same frames', async () =>
    {
        const prints = [];

        for (let time = 0; time < 2; time++)
        {
            await scanline('launch', page('slow=250'), '--headless', '--paused', '--deterministic', 'true', '--dpr', 2);
            await scanline('step', 90, '--fast', '--events', JSON.stringify(play.slice(0, 5)));

            const saved = await scanline('save_run', '--json');
            const run = JSON.parse(readFileSync(saved.json.data.path, 'utf8'));

            prints.push(run.prints.map((print) => `${print.frame}:${print.draws}:${print.hash}`).join(' '));
            assert.deepEqual(run.storage, { cookies: [], fresh: true, local: [], session: [], truncated: false }, 'the run keeps what the page found in its storage: nothing');
            await scanline('close');
        }

        assert.equal(prints[0].split(' ').length, 3);
        assert.equal(prints[1], prints[0]);
    });

    test('a run recorded by a returning visitor is replayed as one', async () =>
    {
        await scanline('launch', page('slow=60'), '--headless', '--paused', '--deterministic', 'true');
        await scanline('step', 5, '--fast');

        const id = JSON.parse(await state()).id;

        // The second load finds the id the first one made.
        await scanline('navigate', '--reload', 'true');
        await scanline('step', 40, '--fast');
        assert.equal(JSON.parse(await state()).id, id);

        const saved = await scanline('save_run', '--json');
        const run = JSON.parse(readFileSync(saved.json.data.path, 'utf8'));

        assert.deepEqual(run.storage.local, [['loading-id', id]]);
        assert.equal(run.storage.cookies[0].name, 'loading-id');
        assert.equal(run.storage.fresh, false);

        // Even after the page's storage has been emptied behind its back.
        await scanline('eval', 'localStorage.clear(); document.cookie = "loading-id=; max-age=0; path=/"; 1');

        const replayed = await scanline('replay_run', saved.json.data.run, '--json');

        assert.equal(replayed.json.data.diverged, null, replayed.json.summary);
        assert.equal(replayed.json.data.matched, 1);
        assert.equal(JSON.parse(await state()).id, id);
    });
});

// One command that opens a page, plays it by seeded random input and says what went wrong
// (fixtures/protocol/smoke.html: a small game that counts its input and can be told to fail).
describe('a smoke test', () =>
{
    const page = (query = '') => server.url(`fixtures/protocol/smoke.html${query}`);

    test('a healthy page passes: loaded, played by keys and mouse, measured, pictured and kept', async () =>
    {
        const smoked = await scanline('smoke', page(), '--seconds', 3, '--keep', '--json');

        assert.equal(smoked.code, 0, smoked.out);
        assert.equal(smoked.json.data.met, true);
        assert.match(smoked.json.summary, /^Smoke test PASSED: http:\/\/127\.0\.0\.1:\d+\/fixtures\/protocol\/smoke\.html\n/);
        assert.match(smoked.json.summary, /Loaded: ready \d+\.\d\d s after the page began to load \(its loading went quiet\)\./);
        assert.match(smoked.json.summary, /Played: 180 frames \(3\.0 s of game time\) in \d+\.\d s, by a seeded random rule \(seed 1\): \d+ holds? of keys, \d+ taps? and \d+ drags? by mouse\. \d+ events sent\./);
        assert.match(smoked.json.summary, /Errors: none\.\n {2}Warnings: none\.\n {2}Failed requests: none\./);
        assert.match(smoked.json.summary, /A frame: 5 draws \(worst 5, frame \d+\), 10 triangles \(worst 10, frame \d+\), \d+ API calls \(worst \d+, frame \d+\)\./);
        assert.match(smoked.json.summary, /Time: CPU in frame callbacks mean \d+\.\d\d ms, worst \d+\.\d\d ms, frame \d+\./);
        assert.match(smoked.json.summary, /Pictures at frames 0, 60, 120, 180: one sheet, \d across in reading order, each under its frame number \(below\)\./);

        const data = smoked.json.data;

        assert.equal(data.frames, 180);
        assert.equal(data.figures.frames, 180, 'every frame of the play was measured');
        assert.equal(data.figures.draws.worst.value, 5);
        assert.deepEqual(data.shots.map((shot) => shot.frame), [0, 60, 120, 180]);

        for (const shot of data.shots)
        {
            assert.ok(existsSync(shot.original), shot.original);
        }

        // What comes back to look at is one picture: the sheet.
        assert.equal(smoked.json.images.length, 1);
        assert.equal(smoked.json.images[0].space, 'contact_sheet');
        assert.deepEqual(smoked.json.images[0].frames, [0, 60, 120, 180]);
        assert.ok(existsSync(data.sheet.path));

        // The input reached the game as real input, of every kind the rule gives.
        const state = JSON.parse((await scanline('page', '--json')).json.data.state.text);

        assert.equal(state.frame, 180);
        assert.ok(state.keys >= 1 && state.mouse === data.input.taps + data.input.drags && state.moves > 0, JSON.stringify(state));
        assert.equal(state.touches, 0);

        // Kept: the session (asked for), paused where the play ended, and the play as a run.
        assert.match(smoked.json.summary, /ses_\d+ is still open, paused where the play ended/);
        assert.match((await scanline('status')).out, /Paused at frame 180\./);

        const replayed = await scanline('replay_run', data.run, '--json');

        assert.equal(replayed.json.data.diverged, null, replayed.json.summary);
        assert.equal(replayed.json.data.matched, 6);
        assert.equal(JSON.parse((await scanline('page', '--json')).json.data.state.text).keys, state.keys);
    });

    test('the same seed plays the same game, another seed another, and the session is closed', async () =>
    {
        const plays = [];

        for (const seed of [5, 5, 6])
        {
            const smoked = await scanline('smoke', page(), '--seconds', 2, '--seed', seed, '--shots', 0, '--json');

            assert.equal(smoked.code, 0, smoked.out);
            assert.match(smoked.json.summary, /The session is closed\. The same address and seed play the same game again: smoke\(url, seed: \d, seconds: 2\)/);
            assert.equal(smoked.json.images.length, 0);

            const run = JSON.parse(readFileSync(join(home, 'artefacts', 'runs', `${smoked.json.data.run}.json`), 'utf8'));

            plays.push(JSON.stringify([smoked.json.data.input, run.prints.map((print) => print.hash), run.events.map((row) => [row[0], ...row.slice(2)])]));
        }

        assert.equal(plays[1], plays[0], 'seed 5 twice: the same input on the same frames, and the same pictures');
        assert.notEqual(plays[2], plays[0], 'seed 6 is another game');
        assert.match((await scanline('sessions')).out, /No sessions are open/);
    });

    test('a page that goes wrong fails, with the frame of each error and the address of each failed request', async () =>
    {
        const smoked = await scanline('smoke', page('?broken'), '--seconds', 2, '--shots', 1, '--keep', '--json');

        assert.equal(smoked.code, 2, 'a failed smoke test exits 2');
        assert.equal(smoked.json.data.met, false);
        assert.match(smoked.json.summary, /^Smoke test FAILED: .*smoke\.html\?broken: 2 errors; 1 failed request\./);
        assert.match(smoked.json.summary, /\[frame 40\] exception: «Error: the player fell through the floor/);
        // (The request is made on frame 40 and answered when it is answered: a frame or a few later.)
        assert.match(smoked.json.summary, /\[frame 4\d\] error: «Failed to load resource: the server responded with a status of 404 \(Not Found\): http:\/\/127\.0\.0\.1:\d+\/fixtures\/protocol\/no-such-sprite\.png»/);
        assert.match(smoked.json.summary, /Warnings: 1 .*\n {4}\[frame 40\] warning: «the larder is nearly empty»/);
        assert.match(smoked.json.summary, /Failed requests: 1\.\n {4}404 Not Found {2}GET «http:\/\/127\.0\.0\.1:\d+\/fixtures\/protocol\/no-such-sprite\.png» {2}\(frame 4\d\)/);
        assert.equal(smoked.json.data.frames, 120, 'it is played to the end all the same');
        assert.equal(smoked.json.data.failed_requests[0].status, 404);
        assert.deepEqual(smoked.json.data.faults, ['2 errors', '1 failed request']);

        // The same list, in any session: console(requests: true).
        const listed = await scanline('console', '--requests', '--json');

        assert.match(listed.json.summary, /1 request failed or was answered with an error status/);
        assert.match(listed.json.summary, /404 Not Found {2}GET «.*no-such-sprite\.png»/);
        assert.equal(listed.json.data.failed_requests[0].url, page('no-such-sprite.png').replace('smoke.htmlno', 'no'));
        await scanline('close');

        // And one that fails while the page loads.
        const missing = await scanline('smoke', page('?missing'), '--seconds', 1, '--shots', 0);

        assert.equal(missing.code, 2);
        assert.match(missing.out, /404 Not Found {2}GET «.*not-there\.json» {2}\(while loading\)/);
        assert.match(missing.out, /\[while loading\] error: «Failed to load resource: .*not-there\.json»/);
    });

    test('budgets are held to the worst frame, and a page that stops drawing fails', async () =>
    {
        const heavy = await scanline('smoke', page('?heavy'), '--seconds', 1, '--shots', 0, '--max_draws', 100, '--max_triangles', 5000, '--max_cpu_ms', 500, '--json');

        assert.equal(heavy.code, 2);
        assert.match(heavy.json.summary, /^Smoke test FAILED: .*: over budget \(max_draws\)\./);
        assert.match(heavy.json.summary, /FAIL max_draws: 300 draws in its worst frame, and the budget is 100\./);
        assert.match(heavy.json.summary, /PASS max_triangles: 600 triangles in its worst frame, and the budget is 5000\./);
        assert.match(heavy.json.summary, /PASS max_cpu_ms: \d+\.\d\d ms of CPU time a frame in frame callbacks \(mean\), and the budget is 500\./);

        const stalled = await scanline('smoke', page('?stall'), '--seconds', 2, '--shots', 0, '--json');

        assert.equal(stalled.code, 2);
        assert.match(stalled.json.summary, /^Smoke test FAILED: .*: the page stopped at frame 3\d: it has no frame callbacks and no timers pending, so nothing more will be drawn\./);
        assert.ok(stalled.json.data.frames < 40);
    });

    test('as a phone it is played by touch, at a phone\'s size', async () =>
    {
        const smoked = await scanline('smoke', page(), '--seconds', 2, '--phone', '--shots', 2, '--keep', '--json');

        assert.equal(smoked.code, 0, smoked.out);
        assert.match(smoked.json.summary, /\d+ taps? and \d+ drags? by touch\./);

        const state = JSON.parse((await scanline('page', '--json')).json.data.state.text);

        assert.equal(state.width, 390, 'the page is a phone\'s width');
        assert.equal(state.points, 5, 'and says it can be touched');
        assert.equal(state.touches, smoked.json.data.input.taps + smoked.json.data.input.drags);
        assert.equal(state.mouse, 0);
        assert.ok(state.touches > 0, JSON.stringify(state));

        // The pictures are the page as composited, at the phone's pixels (390×844 at 3).
        assert.deepEqual(smoked.json.data.shots.map((shot) => [shot.frame, shot.width, shot.height]), [[0, 1170, 2532], [120, 1170, 2532]]);
    });

    test('what is asked wrongly is refused before a browser is opened', async () =>
    {
        assert.match((await scanline('smoke')).out, /smoke needs a url/);
        assert.match((await scanline('smoke', page(), '--seconds', 0)).out, /seconds is how long to play, in seconds of game time, from 1 to 600/);
        assert.match((await scanline('smoke', page(), '--keys', '["Sideways"]')).out, /Unknown key "Sideways" in keys/);
        assert.match((await scanline('help', 'smoke')).out, /A smoke test: does the page load, play and stay healthy\?/);
        assert.match((await scanline('sessions')).out, /No sessions are open/);
    });
});

// Pictures at chosen frames, or every so many, while a step or a policy runs: back as one
// sheet with the frame written over each, and as files.
describe('pictures along the way', () =>
{
    test('a step takes them at the frames asked for and returns one labelled sheet', async () =>
    {
        await scanline('launch', server.url('fixtures/protocol/loading.html'), '--headless', '--paused', '--deterministic', 'true');

        const stepped = await scanline('step', 120, '--fast', '--shots', '{"every": 20, "at": [0, 5]}', '--events', '[{"at": 10, "pointer": "move", "x": 100, "y": 100}]', '--json');

        assert.equal(stepped.code, 0, stepped.out);
        assert.match(stepped.json.summary, /8 pictures taken along the way, at frames 0, 5, 20, 40, 60, 80, 100, 120: one sheet, 3 across in reading order, each under its frame number\./);
        assert.equal(stepped.json.data.frame, 120);
        assert.deepEqual(stepped.json.data.shots.map((shot) => shot.frame), [0, 5, 20, 40, 60, 80, 100, 120]);

        // One picture to look at: eight cells of 160×120 under a strip of words, three across.
        assert.equal(stepped.json.images.length, 1);

        const sheet = stepped.json.images[0];

        assert.equal(sheet.space, 'contact_sheet');
        assert.equal(sheet.columns, 3);
        assert.deepEqual([sheet.width, sheet.height], [3 * 166 + 6, 3 * 146 + 6]);
        assert.ok(existsSync(sheet.view));

        // The files are the frames themselves: the last is what the canvas shows now, and
        // the one at frame 5 is not.
        const now = await scanline('screenshot', '--json');
        const last = readFileSync(stepped.json.data.shots[7].original);

        assert.ok(last.equals(readFileSync(now.json.images[0].original)), 'the picture at frame 120 is frame 120');
        assert.ok(!last.equals(readFileSync(stepped.json.data.shots[1].original)), 'and frame 5 is another picture');

        // The events still fell on their frames: stopping for a picture moves nothing.
        assert.deepEqual(JSON.parse((await scanline('page', '--json')).json.data.state.text).events, [['pointermove', 100, 100, 0, 0]]);

        // With a screenshot asked for as well, both come back.
        const both = await scanline('step', 10, '--shots', '{"at": [10], "max_edge": 64}', '--observe', '{"screenshot": true}', '--json');

        assert.deepEqual(both.json.images.map((image) => image.space), ['canvas_px', 'contact_sheet']);
    });

    test('a policy takes them too, of the page as composited', async () =>
    {
        await scanline('launch', server.url('fixtures/protocol/smoke.html'), '--headless', '--paused', '--deterministic', 'true');

        const played = await scanline('policy', '(s, i) => ({keys_down: i.frame % 40 < 20 ? ["ArrowLeft"] : ["ArrowRight"]})', '--frames', 90, '--shots', '{"every": 30, "source": "page", "max_edge": 200}', '--json');

        assert.equal(played.code, 0, played.out);
        assert.match(played.json.summary, /3 pictures taken along the way, at frames 30, 60, 90: one sheet/);
        assert.deepEqual(played.json.data.shots.map((shot) => [shot.frame, shot.width]), [[30, 1280], [60, 1280], [90, 1280]], 'the page is 1280 wide, where the canvas is 320');
        assert.equal(played.json.images.at(-1).space, 'contact_sheet');
        assert.equal(played.json.data.frames, 90);
    });

    test('what cannot be taken is said plainly', async () =>
    {
        // Time held from the first instant: nothing has been drawn at frame 0.
        await scanline('launch', server.url('fixtures/protocol/smoke.html'), '--headless', '--paused');

        const early = await scanline('step', 4, '--shots', '{"at": [0, 4]}', '--json');

        assert.match(early.json.summary, /No picture could be taken at one of the frames asked for \(none at frame 0: the canvas had not been drawn to yet\)\./);
        assert.deepEqual(early.json.data.shots.map((shot) => shot.frame), [4]);

        assert.match((await scanline('step', 100, '--shots', '{"every": 1}')).out, /That is 100 pictures in one call, and the most is 64/);
        assert.match((await scanline('step', 10, '--shots', '{"at": [12]}')).out, /A picture is asked for after 12 frames, but this call runs only 10/);
        assert.match((await scanline('step', 10, '--shots', '{"every": 5, "source": "screen"}')).out, /shots\.source is "canvas" .* or "page"/);
        assert.match((await scanline('step', 10, '--shots', '{}')).out, /shots names no frames/);
        assert.equal((await scanline('status', '--json')).json.data.frame, 4, 'a refused step runs no frames');
    });

    test('a smoke test spreads them over the play, or takes them where asked', async () =>
    {
        const smoked = await scanline('smoke', server.url('fixtures/protocol/smoke.html'), '--seconds', 2, '--shots', '{"every": 40, "at": [0], "source": "canvas", "max_edge": 96}', '--json');

        assert.equal(smoked.code, 0, smoked.out);
        // This page loads nothing, so none of its frames ran before the play: at frame 0 its
        // canvas has not been drawn to, and the report says so.
        assert.deepEqual(smoked.json.data.shots.map((shot) => shot.frame), [40, 80, 120]);
        assert.match(smoked.json.summary, /No picture could be taken at one of the frames asked for \(none at frame 0: the canvas had not been drawn to yet\)\./);
        assert.deepEqual([smoked.json.data.shots[1].width, smoked.json.data.shots[1].height], [320, 240], 'the canvas, not the page');
        assert.equal(smoked.json.images.length, 1);
        assert.match((await scanline('smoke', server.url('fixtures/protocol/smoke.html'), '--shots', 40)).out, /shots is at most 24 pictures spread over the play/);
    });
});

// A recording made by stepping, as an MP4 (fixtures/protocol/film.html: every frame's picture
// says which frame it is, and a beep is begun on frames 30, 90, 150…).
describe('a film', () =>
{
    const page = (query = '') => server.url(`fixtures/protocol/film.html${query}`);
    const scratch = mkdtempSync(join(tmpdir(), 'scanline-film-'));

    after(() => rmSync(scratch, { recursive: true, force: true }));

    // The boxes of an MP4, by path, with where each one's body is.
    function boxes (file, from = 0, to = file.length, path = '', out = [])
    {
        let at = from;

        while (at + 8 <= to)
        {
            const size = file.readUInt32BE(at);
            const kind = file.toString('latin1', at + 4, at + 8);
            const here = `${path}/${kind}`;

            assert.ok(size >= 8 && at + size <= to, `${here} does not fit in its parent`);
            out.push({ path: here, at: at + 8, size: size - 8 });

            if (['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts'].includes(kind))
            {
                boxes(file, at + 8, at + size, here, out);
            }

            at += size;
        }

        return out;
    }

    const stbl = '/moov/trak/mdia/minf/stbl';

    // What a film's file says of itself: its tracks, their clocks and how many samples each has.
    function described (path)
    {
        const file = readFileSync(path);
        const found = boxes(file);
        const all = (name) => found.filter((box) => box.path === name);

        return {
            order: found.filter((box) => box.path.split('/').length === 2).map((box) => box.path),
            tracks: all('/moov/trak').length,
            movie: { scale: file.readUInt32BE(all('/moov/mvhd')[0].at + 12), duration: file.readUInt32BE(all('/moov/mvhd')[0].at + 16) },
            media: all('/moov/trak/mdia/mdhd').map((box) => ({ scale: file.readUInt32BE(box.at + 12), duration: file.readUInt32BE(box.at + 16) })),
            samples: all(`${stbl}/stsz`).map((box) => file.readUInt32BE(box.at + 8)),
            size: [file.readUInt32BE(all('/moov/trak/tkhd')[0].at + 76) >>> 16, file.readUInt32BE(all('/moov/trak/tkhd')[0].at + 80) >>> 16],
            keys: file.readUInt32BE(all(`${stbl}/stss`)[0].at + 4),
            entries: all(`${stbl}/stsd`).map((box) => file.toString('latin1', box.at + 12, box.at + 16)),
            skip: all('/moov/trak/edts/elst').map((box) => file.readUInt32BE(box.at + 12))
        };
    }

    // ffmpeg, where the machine has it, to play the file back: the pictures and the sound.
    const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

    test('the next frames in one call: every frame is in the file, a sixtieth of a second each, with the page\'s sound', async (t) =>
    {
        await scanline('launch', page(), '--headless', '--paused', '--deterministic', 'true');

        const filmed = await scanline('film', '--frames', 150, '--json');

        assert.equal(filmed.code, 0, filmed.out);
        assert.match(filmed.json.summary, /^The film is .*film-001\.mp4: 150 frames at 60 a second \(2\.5 s\), 320×240 H\.264 with AAC sound \(48 kHz stereo\), \d+\.\d MB\. Every frame stepped is in it, each lasting exactly 1\/60 s; it took \d+ s to make\.\nThe page is paused at frame 150\.$/);

        const data = filmed.json.data;

        assert.equal(data.frames, 150);
        assert.deepEqual(data.notes, []);
        assert.equal(data.audio.samples, 120000, 'two and a half seconds of sound at 48 kHz: as long as the pictures, to the sample');
        assert.ok(existsSync(data.film));

        // The page ran exactly the frames filmed, and its sound exactly as long.
        const state = JSON.parse((await scanline('page', '--json')).json.data.state.text);

        assert.equal(state.frame, 150);
        assert.deepEqual(state.beeps, [30, 90, 150]);
        // (A context renders 128 sample frames at a time and is stopped from the page's own
        // thread, so it stands a few milliseconds past the mark: more if that thread was kept waiting.)
        assert.ok(Math.abs(state.time - 2.5) < 0.03, `the page's audio clock stands at ${state.time} s`);

        // The file: the index first, two tracks, 150 pictures at 1/60 s each and the sound beside them.
        const file = described(data.film);

        assert.deepEqual(file.order, ['/ftyp', '/moov', '/mdat']);
        assert.equal(file.tracks, 2);
        assert.deepEqual(file.entries, ['avc1', 'mp4a']);
        assert.deepEqual(file.movie, { scale: 1000, duration: 2500 });
        assert.deepEqual(file.media[0], { scale: 60000, duration: 150000 });
        assert.equal(file.media[1].scale, 48000);
        assert.equal(file.samples[0], 150);
        assert.equal(file.keys, 3, 'a frame to start from each second');
        assert.deepEqual(file.size, [320, 240]);
        assert.deepEqual(file.skip, [data.audio.skip], 'the sound starts past what its decoder drops');

        if (!ffmpeg)
        {
            t.diagnostic('ffmpeg is not installed, so the film was not played back');

            return;
        }

        // Played back: frame n of the film is frame n of the page, to the pixel.
        const raw = join(scratch, 'frames.rgb');

        assert.equal(spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', data.film, '-vf', 'select=eq(n\\,0)+eq(n\\,99)+eq(n\\,149)', '-fps_mode', 'passthrough', '-pix_fmt', 'rgb24', '-f', 'rawvideo', raw]).status, 0);

        const pictures = readFileSync(raw);

        assert.equal(pictures.length, 3 * 320 * 240 * 3);

        for (const [index, frame] of [1, 100, 150].entries())
        {
            const row = pictures.subarray(index * 320 * 240 * 3 + 120 * 320 * 3).subarray(0, 320 * 3);
            const bar = [...Array(320).keys()].filter((x) => row[x * 3] > 200 && row[x * 3 + 1] > 200);
            const beside = (bar[0] + 100) % 320;

            assert.deepEqual([bar[0], bar.length], [(frame * 4) % 320, 8], `the bar of frame ${frame}`);
            assert.ok((frame - 1) % 60 < 30 ? row[beside * 3] > 100 && row[beside * 3 + 2] < 30 : row[beside * 3] < 30 && row[beside * 3 + 2] > 100, `the background of frame ${frame}`);
        }

        // And its sound: as long as the pictures, with each beep where the frame that made it is.
        const sound = join(scratch, 'sound.raw');

        assert.equal(spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', data.film, '-f', 'f32le', '-ac', '1', '-ar', '48000', sound]).status, 0);

        const heard = new Float32Array(new Uint8Array(readFileSync(sound)).buffer);

        assert.equal(heard.length, 120000, 'decoded, the sound is 2.5 s to the sample');

        const onsets = [];
        let quiet = true;

        for (let at = 0; at + 240 < heard.length; at += 48)
        {
            let energy = 0;

            for (let i = at; i < at + 240; i++) { energy += heard[i] * heard[i]; }

            const loud = Math.sqrt(energy / 240);

            if (loud > 0.15 && quiet)
            {
                let first = at;

                while (Math.abs(heard[first]) < 0.1) { first++; }

                onsets.push(first / 48000);
                quiet = false;
            }
            else if (loud < 0.08)
            {
                quiet = true;
            }
        }

        // Frame 30 is shown from 29/60 s. The audio context renders 128 sample frames at a
        // time, so the beep begins a few milliseconds after that (2 to 5 on a quiet machine),
        // never before; on a busy one, by as long as the page's thread was kept from stopping it.
        assert.equal(onsets.length, 3, `beeps heard at ${onsets}`);

        for (const [index, onset] of onsets.entries())
        {
            const late = (onset - (29 + index * 60) / 60) * 1000;

            assert.ok(late > -1 && late < 30, `beep ${index + 1} is ${late.toFixed(1)} ms after its frame`);
        }
    });

    test('started and stopped round any stepping, at a size asked for, to a file named', async () =>
    {
        await scanline('launch', page(), '--headless', '--paused', '--deterministic', 'true');
        await scanline('step', 10, '--fast');

        const started = await scanline('film', 'start', '--width', 160, '--bitrate', 2000000);

        assert.match(started.out, /^Filming ctx_1 at 160×120 \(the canvas is 320×240\), 60 frames a second, H\.264 at 2\.0 Mbit\/s, with the page's sound\. Every frame the page is stepped through from now is in the film/);
        assert.match((await scanline('status')).out, /A film is being made: every frame stepped is in it/);
        assert.match((await scanline('film', 'start')).out, /A film is already being made/);

        await scanline('step', 60, '--fast');
        await scanline('policy', '() => ({})', '--frames', 30);
        await scanline('step', 1);

        const path = join(scratch, 'small.mp4');
        const stopped = await scanline('film', 'stop', '--path', path, '--json');

        assert.equal(stopped.code, 0, stopped.out);
        assert.equal(stopped.json.data.frames, 91, 'the frames of the fast step, the policy and the slow step, and none from before');
        assert.equal(stopped.json.data.film, path);
        assert.deepEqual(described(path).size, [160, 120]);
        assert.equal(described(path).samples[0], 91);
        assert.equal((await scanline('status', '--json')).json.data.frame, 101);
        assert.equal((await scanline('status', '--json')).json.data.filming, false);

        assert.match((await scanline('film', 'stop')).out, /No film is being made/);
        assert.match((await scanline('film', 'start', '--max_edge', 8)).out, /max_edge is a size in pixels from 16 to 4096/);
        assert.match((await scanline('film')).out, /film needs one of: action: "start"/);

        // A path that will not do loses nothing: the film is still there to be stopped properly.
        await scanline('film', 'start');
        await scanline('step', 5, '--fast');
        assert.match((await scanline('film', 'stop', '--path', join(scratch, 'film.txt'))).out, /must end in \.mp4/);
        assert.equal((await scanline('film', 'stop', '--json')).json.data.frames, 5);
    });

    test('with no sound asked for, or none played, the file has pictures only', async () =>
    {
        await scanline('launch', page(), '--headless', '--paused', '--deterministic', 'true');

        const mute = await scanline('film', '--frames', 30, '--sound', 'false', '--json');

        assert.match(mute.json.summary, /H\.264 with no sound \(none was asked for\)/);
        assert.equal(described(mute.json.data.film).tracks, 1);
        await scanline('close');

        await scanline('launch', page('?silent'), '--headless', '--paused', '--deterministic', 'true');

        const silent = await scanline('film', '--frames', 30, '--json');

        assert.match(silent.json.summary, /H\.264 with no sound \(the page played none through Web Audio while it was filmed\)/);
        assert.equal(silent.json.data.audio, null);
        assert.equal(described(silent.json.data.film).samples[0], 30);
    });

    test('the page as composited can be filmed instead of the canvas: each picture is still of its own frame', async (t) =>
    {
        await scanline('launch', page(), '--headless', '--paused', '--deterministic', 'true');

        const started = await scanline('film', 'start', '--source', 'page');

        assert.match(started.out, /^Filming the page as composited at 1280×\d+/);
        await scanline('step', 40, '--fast');
        await scanline('policy', '() => ({})', '--frames', 20);

        const stopped = await scanline('film', 'stop', '--json');

        assert.equal(stopped.code, 0, stopped.out);
        assert.equal(stopped.json.data.frames, 60);
        assert.equal(stopped.json.data.width, 1280, 'the page is 1280 wide, where its canvas is 320');
        assert.equal(described(stopped.json.data.film).samples[0], 60);
        assert.equal(stopped.json.data.audio.samples, 48000);
        assert.match((await scanline('film', 'start', '--source', 'window')).out, /source is "canvas" .* or "page"/);

        if (!ffmpeg)
        {
            t.diagnostic('ffmpeg is not installed, so the film was not played back');

            return;
        }

        const raw = join(scratch, 'page.rgb');
        const { width, height } = stopped.json.data;

        assert.equal(spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', stopped.json.data.film, '-vf', 'select=eq(n\\,0)+eq(n\\,39)+eq(n\\,59)', '-fps_mode', 'passthrough', '-pix_fmt', 'rgb24', '-f', 'rawvideo', raw]).status, 0);

        const pictures = readFileSync(raw);

        // The canvas is at the page's top-left: frame n's bar is where frame n put it, though
        // the picture was taken by the browser after the step and not by the page during it.
        for (const [index, frame] of [1, 40, 60].entries())
        {
            const row = pictures.subarray(index * width * height * 3 + 120 * width * 3).subarray(0, 320 * 3);
            const bar = [...Array(320).keys()].filter((x) => row[x * 3] > 200 && row[x * 3 + 1] > 200);

            assert.deepEqual([bar[0], bar.length], [(frame * 4) % 320, 8], `the bar of frame ${frame}`);
        }
    });

    test('a kept run is played again and filmed, the whole of it or a part', async () =>
    {
        await scanline('launch', page(), '--headless', '--paused', '--deterministic', 'true');
        await scanline('step', 120, '--fast', '--events', '[{"at": 20, "key": "ArrowLeft", "press": true}]');

        const run = (await scanline('save_run', '--json')).json.data.run;
        const part = await scanline('film', '--run', run, '--from_frame', 30, '--to_frame', 90, '--json');

        assert.equal(part.code, 0, part.out);
        assert.match(part.json.summary, /^The film is .*: 60 frames at 60 a second \(1\.0 s\), 320×240 H\.264 with AAC sound/);
        assert.match(part.json.summary, new RegExp(`Replayed ${run} to frame 90 of 120\\. Paused\\.`));
        assert.equal(part.json.data.played.diverged, null);
        assert.equal(described(part.json.data.film).samples[0], 60);

        const whole = await scanline('film', '--run', run, '--json');

        assert.equal(whole.json.data.frames, 120);

        // A take is filmed as it is played: the film begins with it, and is stopped afterwards.
        await scanline('take', 'start', 'beeps');
        await scanline('step', 45, '--fast');
        await scanline('take', 'stop');

        const played = await scanline('take', 'play', 'beeps', '--film', '{"sound": false, "max_edge": 160}');

        assert.match(played.out, /Played take «beeps» to frame \d+/, played.out);

        const taken = await scanline('film', 'stop', '--json');

        assert.equal(taken.json.data.frames, 165, 'the take plays from the page\'s load: the 120 frames before it and its own 45');
        assert.equal(taken.json.data.width, 160);
        assert.equal(taken.json.data.audio, null);
        await scanline('take', 'remove', 'beeps');
        assert.match(whole.json.summary, /All 4 fingerprints along the way match the original/);
        assert.match((await scanline('film', '--run', 'run_999')).out, /No run "run_999"/);
    });
});
