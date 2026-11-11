// Tests of the WGSL reader, which run in Node with no browser.
//
//   npm run test:wgsl

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { entryPoint, fragmentWriting, inputNames, layout, reachable, scan, valuesOf, vertexPositions } from '../../shared/wgsl.ts';

const SCENE = `
// A scene shader with the things real ones have.
enable f16;
const LIGHTS = 2;
alias Colour = vec4<f32>;

struct Light { position: vec3f, intensity: f32, colour: vec3<f32> }

struct Camera
{
    viewProj: mat4x4f,
    eye: vec3f,
    @align(16) fog: f32,
    lights: array<Light, LIGHTS>,
    normal: mat3x3<f32>,
};

@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var albedo: texture_2d<f32>;
@group(0) @binding(2) var smooth_: sampler;
@group(1) @binding(0) var<storage, read> bones: array<mat4x4f>;
var<private> scratch: f32 = 1.0 /* not a resource */;

struct VertexIn { @location(0) position: vec3f, @location(1) uv: vec2f, @builtin(vertex_index) index: u32 }
struct VertexOut { @builtin(position) position: vec4f, @location(0) uv: vec2f }

fn skinned (position: vec3f) -> vec4f
{
    return bones[0] * vec4f(position, 1.0);
}

@vertex fn vertex (in: VertexIn, @builtin(instance_index) instance: u32) -> VertexOut
{
    var out: VertexOut;

    if (in.index < 3u && 1 > 0) { out.uv = in.uv; }

    out.position = camera.viewProj * skinned(in.position);

    return out;
}

@fragment fn fragment (in: VertexOut, @builtin(front_facing) front: bool) -> @location(0) Colour
{
    let colour = textureSample(albedo, smooth_, in.uv);

    if (colour.a < 0.5) { discard; }

    return colour * camera.fog;
}
`;

test('finds the declarations of a module', () =>
{
    const module = scan(SCENE);

    assert.deepEqual([...module.structs.keys()], ['Light', 'Camera', 'VertexIn', 'VertexOut']);
    assert.deepEqual([...module.functions.keys()], ['skinned', 'vertex', 'fragment']);
    assert.equal(module.constants.get('LIGHTS'), 2);
    assert.equal(module.aliases.get('Colour'), 'vec4<f32>');

    const camera = module.globals.get('camera');

    assert.deepEqual([camera.space, camera.group, camera.binding, camera.type], ['uniform', 0, 0, 'Camera']);
    assert.deepEqual([module.globals.get('albedo').space, module.globals.get('albedo').type], ['handle', 'texture_2d<f32>']);
    assert.deepEqual([module.globals.get('bones').space, module.globals.get('bones').access, module.globals.get('bones').group], ['storage', 'read', 1]);
    assert.equal(module.globals.get('scratch').group, null);

    assert.equal(entryPoint(module, 'vertex').name, 'vertex');
    assert.equal(entryPoint(module, 'fragment', 'fragment').returnType, 'Colour');
    assert.equal(entryPoint(module, 'fragment', 'vertex'), null, 'a name of the wrong stage is not an entry point of this one');
});

test('says which resources an entry point reaches, through what it calls', () =>
{
    const module = scan(SCENE);
    const names = (stage) => reachable(module, entryPoint(module, stage)).map((global) => global.name).sort();

    assert.deepEqual(names('vertex'), ['bones', 'camera']);
    assert.deepEqual(names('fragment'), ['albedo', 'camera', 'smooth_']);
});

test('lays a uniform buffer out as the language says', () =>
{
    const module = scan(SCENE);
    const { size, leaves } = layout(module, module.globals.get('camera'));
    const at = Object.fromEntries(leaves.map((leaf) => [leaf.name, leaf.offset]));

    assert.equal(at['camera.viewProj'], 0);
    assert.equal(at['camera.eye'], 64);
    assert.equal(at['camera.fog'], 80, 'a member told to align to 16 starts on the next 16');
    assert.equal(at['camera.lights[0].position'], 96);
    assert.equal(at['camera.lights[0].intensity'], 108, 'a float fits in the space after a vec3');
    assert.equal(at['camera.lights[0].colour'], 112);
    assert.equal(at['camera.lights[1].position'], 128);
    assert.equal(at['camera.normal'], 160);
    assert.equal(size, 208);

    // A mat3x3 keeps each column in 16 bytes.
    const bytes = new Uint8Array(208);
    const floats = new Float32Array(bytes.buffer);

    floats.set([1, 2, 3, 0, 4, 5, 6, 0, 7, 8, 9, 0], 40);

    assert.deepEqual(valuesOf(leaves.find((leaf) => leaf.name === 'camera.normal'), bytes), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.equal(valuesOf(leaves.find((leaf) => leaf.name === 'camera.normal'), bytes.subarray(0, 200)), null, 'a value past the end of the bytes is not made up');
});

test('lists the first elements of an array with no length', () =>
{
    const module = scan(SCENE);
    const { leaves } = layout(module, module.globals.get('bones'));

    assert.deepEqual(leaves.map((leaf) => [leaf.name, leaf.offset]), [['bones[0]', 0], ['bones[1]', 64], ['bones[2]', 128], ['bones[3]', 192]]);
});

test('names vertex inputs by location', () =>
{
    const module = scan(SCENE);
    const names = inputNames(module, entryPoint(module, 'vertex'));

    assert.deepEqual([...names.entries()], [[0, { name: 'position', type: 'vec3f' }], [1, { name: 'uv', type: 'vec2f' }]]);
});

test('writes a fragment entry point that runs the page\'s and replaces a colour', () =>
{
    const module = scan(SCENE);
    const written = fragmentWriting(module, entryPoint(module, 'fragment'), 0, [1, 0.5, 0, 1]);

    assert.match(written, /@fragment fn scanline_fragment \(in: VertexOut, @builtin\(front_facing\) front: bool\) -> @location\(0\) Colour/);
    assert.match(written, /var scanline_out = fragment\(in, front\);/);
    assert.match(written, /scanline_out = vec4<f32>\(1\.0, 0\.5, 0\.0, 1\.0\);/);

    // The page's own is an ordinary function now, so it has no stage or input attributes.
    const again = scan(written);

    assert.equal(again.functions.get('fragment').stage, null);
    assert.deepEqual(again.functions.get('fragment').params.map((param) => param.attributes.length), [0, 0]);
    assert.equal(again.functions.get('fragment').returnAttributes.length, 0);
    assert.equal(again.functions.get('scanline_fragment').stage, 'fragment');
    assert.equal(again.functions.get('vertex').stage, 'vertex', 'the other stage is left as it was');

    assert.equal(fragmentWriting(module, entryPoint(module, 'fragment'), 1, [1, 1, 1, 1]), null, 'no output at that location');
});

test('replaces one member of a fragment output struct', () =>
{
    const module = scan(`
        struct Out { @location(0) colour: vec4f, @location(1) normal: vec4f, @builtin(frag_depth) depth: f32 }
        @fragment fn main () -> Out { var out: Out; return out; }
    `);
    const written = fragmentWriting(module, entryPoint(module, 'fragment'), 1, [0.25, 0, 0, 1]);

    assert.match(written, /scanline_out\.normal = vec4f\(0\.25, 0\.0, 0\.0, 1\.0\);/);
    assert.match(written, /@fragment fn scanline_fragment \(\) -> Out/);
});

test('writes a vertex entry point that carries the page\'s position', () =>
{
    const module = scan(SCENE);
    const written = vertexPositions(module, entryPoint(module, 'vertex'), 12, 256, 4);

    assert.match(written, /let scanline_made = vertex\(in, instance\);/);
    assert.match(written, /let scanline_slot = u32\(in\.index\) - 12u;/, 'the page\'s own vertex_index is used: a builtin can be asked for once');
    assert.match(written, /scanline_out\.clip = scanline_made\.position;/);
    assert.doesNotMatch(written, /scanline_index/);

    const plain = scan('@vertex fn main (@location(0) position: vec4f,) -> @builtin(position) vec4f { return position; }');
    const added = vertexPositions(plain, entryPoint(plain, 'vertex'), 0, 256, 1);

    assert.match(added, /@vertex fn scanline_vertex \(@location\(0\) position: vec4f, @builtin\(vertex_index\) scanline_index: u32\) -> ScanlinePlaced/);
    assert.match(added, /scanline_out\.clip = scanline_made;/);
    assert.equal(scan(added).functions.get('main').stage, null);
});

test('refuses what it cannot read', () =>
{
    assert.throws(() => scan('struct { }'));
    assert.throws(() => scan('fn broken ('));
    assert.throws(() => layout(scan('@group(0) @binding(0) var<uniform> u: array<f32, N * 2>;'), { name: 'u', type: 'array<f32, N * 2>' }));
});
