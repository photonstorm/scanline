// The same small game-like scene as scene.js, in raw WebGPU, with one planted bug per variant.
//
// Variant 0 is correct. What each other variant gets wrong is written down in
// evals/bugs.json, not here: a page under evaluation should not explain itself.

const WIDTH = 480;
const HEIGHT = 360;

export async function run (variant)
{
    const canvas = document.getElementById('game');
    const adapter = await navigator.gpu.requestAdapter();
    const device = await adapter.requestDevice();
    const context = canvas.getContext('webgpu');
    const format = navigator.gpu.getPreferredCanvasFormat();

    context.configure({ device, format, alphaMode: 'opaque' });

    // ---- Shaders ----

    const SPRITE = `
        struct Sprite
        {
            rect: vec4f,            // x, y, width, height, in pixels
            resolution: vec2f,
            depth: f32,
            tint: vec4f,
            textured: f32
        }

        @group(0) @binding(0) var<uniform> sprite: Sprite;
        @group(1) @binding(0) var map: texture_2d<f32>;
        @group(1) @binding(1) var filtering: sampler;

        struct Corner
        {
            @builtin(position) position: vec4f,
            @location(0) uv: vec2f
        }

        @vertex fn vertex (@location(0) corner: vec2f) -> Corner
        {
            let pixel = sprite.rect.xy + corner * sprite.rect.zw;

            return Corner(vec4f(pixel.x / sprite.resolution.x * 2.0 - 1.0, 1.0 - pixel.y / sprite.resolution.y * 2.0, sprite.depth, 1.0), corner);
        }

        @fragment fn fragment (in: Corner) -> @location(0) vec4f
        {
            return sprite.tint * mix(vec4f(1.0), textureSample(map, filtering, in.uv), sprite.textured);
        }`;

    const SPARK = `
        @fragment fn spark (in: Corner) -> @location(0) vec4f
        {
            let glow = max(0.0, 1.0 - length(in.uv - 0.5) * 2.0);

            return vec4f(sprite.tint.rgb, sprite.tint.a * glow);
        }`;

    // Light shafts from the sun: the haze is marched from each pixel towards the sun.
    const SHAFTS = `
        const SAMPLES = 64;
        const SUN = vec2f(0.82, 0.12);

        @fragment fn shafts (in: Corner) -> @location(0) vec4f
        {
            let stride = (SUN - in.uv) / f32(SAMPLES);
            var at = in.uv;
            var light = 0.0;

            for (var i = 0; i < SAMPLES; i++)
            {
                light += textureSampleLevel(map, filtering, at, 0.0).r;
                at += stride;
            }

            return vec4f(sprite.tint.rgb, sprite.tint.a * light / f32(SAMPLES));
        }`;

    const spriteModule = device.createShaderModule({ label: 'sprite', code: SPRITE });

    // ---- Layouts and pipelines ----

    const spriteLayout = device.createBindGroupLayout({
        label: 'sprite',
        entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }]
    });
    const textureLayout = device.createBindGroupLayout({
        label: 'texture',
        entries: [
            { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
            { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } }
        ]
    });
    const layout = device.createPipelineLayout({ label: 'sprites', bindGroupLayouts: [spriteLayout, textureLayout] });
    const corners = { arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] };
    const mixing = { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } };
    const adding = { color: { srcFactor: 'src-alpha', dstFactor: 'one' }, alpha: { srcFactor: 'one', dstFactor: 'one' } };

    const pipeline = (label, { module = spriteModule, entryPoint = 'fragment', blend, depth = 'less', write = true, target = format, depthless = false }) => device.createRenderPipeline({
        label,
        layout,
        vertex: { module, entryPoint: 'vertex', buffers: [corners] },
        fragment: { module, entryPoint, targets: [blend ? { format: target, blend } : { format: target }] },
        primitive: { topology: 'triangle-strip', cullMode: 'back', frontFace: 'cw' },
        ...(depthless ? {} : { depthStencil: { format: 'depth24plus', depthCompare: depth, depthWriteEnabled: write } })
    });

    const solid = pipeline('solid', {});
    const glass = pipeline('glass', variant === 3 ? { write: false } : { blend: mixing, write: false });
    const hud = pipeline('hud', { depth: 'always', write: false });
    const dots = pipeline('minimap dots', { target: 'rgba8unorm', depthless: true });
    const sparkPipeline = () => pipeline('sparks', { module: device.createShaderModule({ label: 'sparks', code: SPRITE + SPARK }), entryPoint: 'spark', blend: adding, write: false });
    const haze = variant === 14
        ? pipeline('haze', { module: device.createShaderModule({ label: 'haze', code: SPRITE + SHAFTS }), entryPoint: 'shafts', blend: adding, write: false })
        : null;

    let sparks = sparkPipeline();

    // ---- Geometry: one unit quad ----

    const quad = device.createBuffer({ label: 'quad', size: 32, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });

    device.queue.writeBuffer(quad, 0, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]));

    // ---- Textures ----

    const smooth = device.createSampler({ label: 'smooth', magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' });
    const nearest = device.createSampler({ label: 'nearest' });

    const textured = (label, texture, sampler) => device.createBindGroup({
        label,
        layout: textureLayout,
        entries: [{ binding: 0, resource: texture.createView() }, { binding: 1, resource: sampler }]
    });

    function makeCrateTexture ()
    {
        const size = 256;
        const levels = 9;
        const texture = device.createTexture({ label: 'crate', size: [size, size], format: 'rgba8unorm', mipLevelCount: levels, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });

        let pixels = new Uint8Array(size * size * 4);

        for (let y = 0; y < size; y++)
        {
            for (let x = 0; x < size; x++)
            {
                const edge = x < 16 || y < 16 || x >= size - 16 || y >= size - 16;
                const plank = Math.floor(y / 64) % 2 === 0;
                const shade = edge ? 90 : (plank ? 190 : 160);

                pixels.set([shade, Math.round(shade * 0.7), Math.round(shade * 0.4), 255], (y * size + x) * 4);
            }
        }

        device.queue.writeTexture({ texture }, pixels, { bytesPerRow: size * 4 }, [size, size]);

        // The smaller levels, each the average of the one before.
        for (let level = 1, edge = size / 2; level < levels && variant !== 2; level++, edge /= 2)
        {
            const smaller = new Uint8Array(edge * edge * 4);

            for (let y = 0; y < edge; y++)
            {
                for (let x = 0; x < edge; x++)
                {
                    for (let channel = 0; channel < 4; channel++)
                    {
                        const at = (dx, dy) => pixels[((y * 2 + dy) * edge * 2 + x * 2 + dx) * 4 + channel];

                        smaller[(y * edge + x) * 4 + channel] = Math.round((at(0, 0) + at(1, 0) + at(0, 1) + at(1, 1)) / 4);
                    }
                }
            }

            device.queue.writeTexture({ texture, mipLevel: level }, smaller, { bytesPerRow: edge * 4 }, [edge, edge]);
            pixels = smaller;
        }

        return texture;
    }

    function makeBarTexture ()
    {
        const pixels = new Uint8Array(32 * 4);

        for (let x = 0; x < 32; x++)
        {
            pixels.set([255, Math.round(40 + x * 6), 40, 255], x * 4);
        }

        const texture = device.createTexture({ label: 'health bar', size: [32, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });

        device.queue.writeTexture({ texture }, pixels, { bytesPerRow: 128 }, [32, 1]);

        return texture;
    }

    function makeHazeTexture ()
    {
        const size = 256;
        const pixels = new Uint8Array(size * size);

        for (let y = 0; y < size; y++)
        {
            for (let x = 0; x < size; x++)
            {
                const wave = Math.sin(x * 0.11) * Math.sin(y * 0.07 + x * 0.02) + Math.sin((x + y) * 0.045);

                pixels[y * size + x] = Math.round(140 + 50 * wave);
            }
        }

        const texture = device.createTexture({ label: 'haze', size: [size, size], format: 'r8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });

        device.queue.writeTexture({ texture }, pixels, { bytesPerRow: size }, [size, size]);

        return texture;
    }

    const MAP_SIZE = variant === 10 ? 256 : 64;
    const makeMapTarget = () => device.createTexture({
        label: 'minimap',
        size: [MAP_SIZE, MAP_SIZE],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    });

    const white = device.createTexture({ label: 'white', size: [1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });

    device.queue.writeTexture({ texture: white }, new Uint8Array([255, 255, 255, 255]), {}, [1, 1]);

    const plain = textured('plain', white, nearest);
    const crateGroup = textured('crate', makeCrateTexture(), smooth);
    const barGroup = textured('health bar', makeBarTexture(), smooth);
    const hazeGroup = variant === 14 ? textured('haze', makeHazeTexture(), smooth) : null;
    const depthTexture = device.createTexture({ label: 'depth', size: [WIDTH, HEIGHT], format: 'depth24plus', usage: GPUTextureUsage.RENDER_ATTACHMENT });

    let mapTexture = makeMapTarget();
    let mapGroup = textured('minimap', mapTexture, nearest);

    // ---- Sprites: each has a uniform buffer of its own ----

    function makeSprite (label)
    {
        const buffer = device.createBuffer({ label, size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

        return { buffer, group: device.createBindGroup({ label, layout: spriteLayout, entries: [{ binding: 0, resource: { buffer } }] }) };
    }

    function place (sprite, x, y, width, height, depth, tint, isTextured)
    {
        device.queue.writeBuffer(sprite.buffer, 0, new Float32Array([
            x, y, width, height,
            WIDTH, HEIGHT, depth, 0,
            tint[0], tint[1], tint[2], tint[3],
            isTextured ? 1 : 0, 0, 0, 0
        ]));
    }

    // ---- The world ----

    const crates = [
        { x: 60, y: 180, size: 80, depth: 0.5 },
        { x: 200, y: 160, size: 100, depth: 0.4 },
        { x: 340, y: 190, size: 70, depth: 0.6 }
    ];

    const state = window.game = { frame: 0, time: 0, health: 0.75, crates: crates.length, sparks: 12 };

    const ground = makeSprite('ground');
    const crateSprites = crates.map((crate, index) => makeSprite(`crate ${index}`));
    const dotSprites = crates.map((crate, index) => makeSprite(`minimap dot ${index}`));
    const glassSprite = makeSprite('glass');
    const hazeSprite = makeSprite('haze');
    const sparkSprites = Array.from({ length: state.sparks }, (unused, index) => makeSprite(`spark ${index}`));
    const barBack = makeSprite('health bar back');
    const bar = makeSprite('health bar');
    const mapSprite = makeSprite('minimap');

    // What never moves is placed once.
    if (variant === 4)
    {
        // The ground is a constant: its numbers are written out by hand.
        device.queue.writeBuffer(ground.buffer, 0, new Float32Array([0, 260, WIDTH, 100, WIDTH, HEIGHT, 0.9, 0.25, 0.5, 0.2, 1, 0]));
    }
    else
    {
        place(ground, 0, 260, WIDTH, 100, 0.9, [0.25, 0.5, 0.2, 1], false);
    }

    crates.forEach((crate, index) =>
    {
        // The middle crate faces the other way.
        const flipped = variant === 1;

        place(crateSprites[index], flipped ? crate.x + crate.size : crate.x, crate.y, flipped ? -crate.size : crate.size, crate.size, crate.depth, [1, 1, 1, 1], true);
        place(dotSprites[index], crate.x + crate.size / 2 - 20, crate.y + crate.size / 2 - 20, 40, 40, 0, [1, 0.8, 0.2, 1], false);
    });

    place(glassSprite, 150, 120, 220, 160, 0.3, [0.2, 0.4, 1, 0.4], false);
    place(hazeSprite, 0, 0, WIDTH, HEIGHT, 0.1, [1, 0.95, 0.8, 0.3], true);
    place(barBack, 10, 10, 204, 16, 0, [0.1, 0.1, 0.1, 1], false);
    place(bar, 12, 12, 200, 12, 0, [1, 1, 1, 1], true);
    place(mapSprite, 406, 10, 64, 64, 0, [1, 1, 1, 1], true);

    function draw (pass, sprite, texture)
    {
        pass.setBindGroup(0, sprite.group);

        if (texture)
        {
            pass.setBindGroup(1, texture);
        }

        pass.draw(4);
    }

    // The minimap: the crates as dots, drawn to a small texture that the HUD then shows.
    function renderMap (encoder)
    {
        if (variant === 10)
        {
            mapTexture = makeMapTarget();
            mapGroup = textured('minimap', mapTexture, nearest);
        }

        const pass = encoder.beginRenderPass({
            label: 'minimap',
            colorAttachments: [{ view: mapTexture.createView(), clearValue: [0.05, 0.1, 0.15, 1], loadOp: 'clear', storeOp: variant === 12 ? 'discard' : 'store' }]
        });

        pass.setPipeline(dots);
        pass.setVertexBuffer(0, quad);

        // Every pipeline here takes a texture, used or not. The dots use none.
        pass.setBindGroup(1, variant === 15 ? mapGroup : plain);

        for (const dot of dotSprites)
        {
            draw(pass, dot, null);
        }

        pass.end();
    }

    function drawCrates (pass)
    {
        pass.setPipeline(solid);

        for (const crate of crateSprites)
        {
            draw(pass, crate, variant === 8 ? barGroup : crateGroup);
        }
    }

    function drawGlass (pass)
    {
        pass.setPipeline(glass);
        draw(pass, glassSprite, plain);
    }

    function drawSparks (pass, time)
    {
        if (variant === 11)
        {
            sparks = sparkPipeline();
        }

        pass.setPipeline(sparks);
        pass.setBindGroup(1, plain);

        sparkSprites.forEach((spark, i) =>
        {
            const angle = i * 0.5236 + time * 0.001;
            const radius = 40 + 10 * Math.sin(time * 0.002 + i);

            place(spark, 240 + Math.cos(angle) * radius - 8, 90 + Math.sin(angle) * radius - 8, 16, 16, 0.2, [1, 0.9, 0.4, 0.9], false);
            draw(pass, spark, null);
        });
    }

    function drawHud (pass)
    {
        pass.setPipeline(hud);
        draw(pass, barBack, plain);

        // The bar is drawn whole and clipped to how much health is left.
        pass.setScissorRect(12, 12, Math.round(200 * state.health), 12);
        draw(pass, bar, barGroup);

        if (variant !== 7)
        {
            pass.setScissorRect(0, 0, WIDTH, HEIGHT);
        }

        draw(pass, mapSprite, mapGroup);
    }

    function frame (time)
    {
        state.frame++;
        state.time = time;

        const encoder = device.createCommandEncoder({ label: 'frame' });

        renderMap(encoder);

        const pass = encoder.beginRenderPass({
            label: 'scene',
            colorAttachments: [{ view: context.getCurrentTexture().createView(), clearValue: [0.35, 0.6, 0.9, 1], loadOp: 'clear', storeOp: 'store' }],
            depthStencilAttachment: { view: depthTexture.createView(), depthClearValue: variant === 5 ? 0 : 1, depthLoadOp: 'clear', depthStoreOp: 'discard' }
        });

        pass.setVertexBuffer(0, quad);

        if (variant === 9)
        {
            pass.setViewport(0, 0, MAP_SIZE, MAP_SIZE, 0, 1);
        }

        pass.setPipeline(solid);
        draw(pass, ground, plain);

        // Variant 13 gets the order wrong on one frame in forty: a flicker.
        if (variant === 6 || (variant === 13 && state.frame % 40 === 0))
        {
            drawGlass(pass);
            drawCrates(pass);
        }
        else
        {
            drawCrates(pass);
            drawGlass(pass);
        }

        if (variant === 14)
        {
            pass.setPipeline(haze);
            draw(pass, hazeSprite, hazeGroup);
        }

        drawSparks(pass, time);
        drawHud(pass);
        pass.end();
        device.queue.submit([encoder.finish()]);

        requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
}
