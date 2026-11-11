// A small game-like scene in raw WebGL 2, with one planted bug per variant.
//
// Variant 0 is correct. What each other variant gets wrong is written down in
// evals/bugs.json, not here: a page under evaluation should not explain itself.

const WIDTH = 480;
const HEIGHT = 360;

export function run (variant)
{
    const canvas = document.getElementById('game');
    const gl = canvas.getContext('webgl2', { antialias: false, depth: true, alpha: false });

    // ---- Shaders ----

    const compile = (type, source) =>
    {
        const shader = gl.createShader(type);

        gl.shaderSource(shader, source);
        gl.compileShader(shader);

        return shader;
    };

    const link = (vertex, fragment) =>
    {
        const program = gl.createProgram();
        const vs = compile(gl.VERTEX_SHADER, vertex);
        const fs = compile(gl.FRAGMENT_SHADER, fragment);

        gl.attachShader(program, vs);
        gl.attachShader(program, fs);
        gl.bindAttribLocation(program, 0, 'corner');
        gl.linkProgram(program);
        gl.deleteShader(vs);
        gl.deleteShader(fs);

        return program;
    };

    const SPRITE_VS = `#version 300 es
        layout(location = 0) in vec2 corner;
        uniform vec2 resolution;
        uniform vec4 rect;
        uniform float depth;
        out vec2 uv;
        void main ()
        {
            vec2 pixel = rect.xy + corner * rect.zw;
            uv = corner;
            gl_Position = vec4(pixel.x / resolution.x * 2.0 - 1.0, 1.0 - pixel.y / resolution.y * 2.0, depth * 2.0 - 1.0, 1.0);
        }`;

    const SPRITE_FS = `#version 300 es
        precision mediump float;
        uniform sampler2D map;
        uniform vec4 tint;
        uniform float textured;
        in vec2 uv;
        out vec4 colour;
        void main ()
        {
            colour = tint * mix(vec4(1.0), texture(map, uv), textured);
        }`;

    const SPARK_FS = `#version 300 es
        precision mediump float;
        uniform vec4 tint;
        in vec2 uv;
        out vec4 colour;
        void main ()
        {
            float glow = max(0.0, 1.0 - length(uv - 0.5) * 2.0);
            colour = vec4(tint.rgb, tint.a * glow);
        }`;

    // Light shafts from the sun: the haze is marched from each pixel towards the sun.
    const SHAFT_FS = `#version 300 es
        precision mediump float;
        uniform sampler2D map;
        uniform vec4 tint;
        in vec2 uv;
        out vec4 colour;
        const int SAMPLES = 64;
        const vec2 SUN = vec2(0.82, 0.12);
        void main ()
        {
            vec2 stride = (SUN - uv) / float(SAMPLES);
            vec2 at = uv;
            float light = 0.0;
            for (int i = 0; i < SAMPLES; i++)
            {
                light += texture(map, at).r;
                at += stride;
            }
            colour = vec4(tint.rgb, tint.a * light / float(SAMPLES));
        }`;

    const sprite = link(SPRITE_VS, SPRITE_FS);
    const shafts = variant === 14 ? link(SPRITE_VS, SHAFT_FS) : null;
    const shaftUniforms = shafts ? {
        resolution: gl.getUniformLocation(shafts, 'resolution'),
        rect: gl.getUniformLocation(shafts, 'rect'),
        depth: gl.getUniformLocation(shafts, 'depth'),
        tint: gl.getUniformLocation(shafts, 'tint'),
        textured: null,
        map: gl.getUniformLocation(shafts, 'map')
    } : null;

    let sparks = link(SPRITE_VS, SPARK_FS);

    const uniformsOf = (program) => ({
        resolution: gl.getUniformLocation(program, 'resolution'),
        rect: gl.getUniformLocation(program, 'rect'),
        depth: gl.getUniformLocation(program, 'depth'),
        tint: gl.getUniformLocation(program, 'tint'),
        textured: gl.getUniformLocation(program, 'textured'),
        map: gl.getUniformLocation(program, 'map')
    });

    const spriteUniforms = uniformsOf(sprite);

    let sparkUniforms = uniformsOf(sparks);

    // ---- Geometry: one unit quad ----

    const quad = gl.createBuffer();

    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    // ---- Textures ----

    function makeCrateTexture ()
    {
        const size = 64;
        const pixels = new Uint8Array(size * size * 4);

        for (let y = 0; y < size; y++)
        {
            for (let x = 0; x < size; x++)
            {
                const edge = x < 4 || y < 4 || x >= size - 4 || y >= size - 4;
                const plank = Math.floor(y / 16) % 2 === 0;
                const shade = edge ? 90 : (plank ? 190 : 160);

                pixels.set([shade, Math.round(shade * 0.7), Math.round(shade * 0.4), 255], (y * size + x) * 4);
            }
        }

        const texture = gl.createTexture();

        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

        if (variant !== 2)
        {
            gl.generateMipmap(gl.TEXTURE_2D);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
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

        const texture = gl.createTexture();

        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 32, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

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

        const texture = gl.createTexture();

        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, size, size, 0, gl.RED, gl.UNSIGNED_BYTE, pixels);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);

        return texture;
    }

    function makeMapTarget ()
    {
        const texture = gl.createTexture();

        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, MAP_SIZE, MAP_SIZE, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

        return texture;
    }

    const MAP_SIZE = variant === 10 ? 256 : 64;
    const crateTexture = makeCrateTexture();
    const barTexture = makeBarTexture();
    const hazeTexture = variant === 14 ? makeHazeTexture() : null;
    const mapFramebuffer = gl.createFramebuffer();

    let mapTexture = makeMapTarget();

    gl.bindFramebuffer(gl.FRAMEBUFFER, mapFramebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, mapTexture, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    // The renderer remembers what is bound, to skip binds that would change nothing.
    let boundTexture = null;

    function useTexture (texture)
    {
        if (boundTexture !== texture)
        {
            gl.bindTexture(gl.TEXTURE_2D, texture);
            boundTexture = texture;
        }
    }

    // ---- The world ----

    const crates = [
        { x: 60, y: 180, size: 80, depth: 0.5 },
        { x: 200, y: 160, size: 100, depth: 0.4 },
        { x: 340, y: 190, size: 70, depth: 0.6 }
    ];

    const state = window.game = { frame: 0, time: 0, health: 0.75, crates: crates.length, sparks: 12 };

    function drawSprite (uniforms, x, y, width, height, depth, tint, texture)
    {
        gl.uniform4f(uniforms.rect, x, y, width, height);
        gl.uniform1f(uniforms.depth, depth);

        if (tint)
        {
            gl.uniform4f(uniforms.tint, tint[0], tint[1], tint[2], tint[3]);
        }

        gl.uniform1f(uniforms.textured, texture ? 1 : 0);

        if (texture)
        {
            useTexture(texture);
        }

        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    // The minimap: the crates as dots, drawn to a small texture that the HUD then shows.
    function renderMap ()
    {
        if (variant === 10)
        {
            mapTexture = makeMapTarget();
            boundTexture = null;
        }

        if (variant !== 12)
        {
            // The HUD left the minimap's own texture bound. It cannot be sampled while it is drawn to.
            useTexture(barTexture);
        }

        gl.bindFramebuffer(gl.FRAMEBUFFER, mapFramebuffer);

        if (variant === 10)
        {
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, mapTexture, 0);
        }

        gl.viewport(0, 0, MAP_SIZE, MAP_SIZE);
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.BLEND);
        gl.clearColor(0.05, 0.1, 0.15, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);

        gl.useProgram(sprite);
        gl.uniform2f(spriteUniforms.resolution, WIDTH, HEIGHT);

        for (const crate of crates)
        {
            // Upside down on purpose: a render target's first row is its bottom, and the HUD
            // draws the texture with its first row at the top.
            drawSprite(spriteUniforms, crate.x + crate.size / 2 - 20, HEIGHT - (crate.y + crate.size / 2 + 20), 40, 40, 0, [1, 0.8, 0.2, 1], null);
        }

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);

        if (variant !== 9)
        {
            gl.viewport(0, 0, WIDTH, HEIGHT);
        }
    }

    function drawGround ()
    {
        drawSprite(spriteUniforms, 0, 260, WIDTH, 100, 0.9, variant === 4 ? null : [0.25, 0.5, 0.2, 1], null);
    }

    function drawCrates ()
    {
        for (const crate of crates)
        {
            // The middle crate faces the other way.
            const flipped = variant === 1 || crate === crates[1];
            const x = flipped && variant === 1 ? crate.x + crate.size : crate.x;
            const width = flipped && variant === 1 ? -crate.size : crate.size;

            if (variant === 8)
            {
                // The texture was bound when it was made; nothing has changed it since.
                gl.uniform4f(spriteUniforms.rect, x, crate.y, width, crate.size);
                gl.uniform1f(spriteUniforms.depth, crate.depth);
                gl.uniform4f(spriteUniforms.tint, 1, 1, 1, 1);
                gl.uniform1f(spriteUniforms.textured, 1);
                gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
            }
            else
            {
                drawSprite(spriteUniforms, x, crate.y, width, crate.size, crate.depth, [1, 1, 1, 1], crateTexture);
            }
        }
    }

    function drawGlass ()
    {
        if (variant !== 3)
        {
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        }

        gl.depthMask(false);
        drawSprite(spriteUniforms, 150, 120, 220, 160, 0.3, [0.2, 0.4, 1, 0.4], null);
        gl.depthMask(true);
        gl.disable(gl.BLEND);
    }

    function drawShafts ()
    {
        gl.useProgram(shafts);
        gl.uniform2f(shaftUniforms.resolution, WIDTH, HEIGHT);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
        gl.depthMask(false);

        drawSprite(shaftUniforms, 0, 0, WIDTH, HEIGHT, 0.1, [1, 0.95, 0.8, 0.3], hazeTexture);

        gl.depthMask(true);
        gl.disable(gl.BLEND);
        gl.useProgram(sprite);
    }

    function drawSparks (time)
    {
        if (variant === 11)
        {
            gl.deleteProgram(sparks);
            sparks = link(SPRITE_VS, SPARK_FS);
            sparkUniforms = uniformsOf(sparks);
        }

        gl.useProgram(sparks);
        gl.uniform2f(sparkUniforms.resolution, WIDTH, HEIGHT);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
        gl.depthMask(false);

        for (let i = 0; i < state.sparks; i++)
        {
            const angle = i * 0.5236 + time * 0.001;
            const radius = 40 + 10 * Math.sin(time * 0.002 + i);

            drawSprite(sparkUniforms, 240 + Math.cos(angle) * radius - 8, 90 + Math.sin(angle) * radius - 8, 16, 16, 0.2, [1, 0.9, 0.4, 0.9], null);
        }

        gl.depthMask(true);
        gl.disable(gl.BLEND);
        gl.useProgram(sprite);
    }

    function drawHud ()
    {
        gl.disable(gl.DEPTH_TEST);

        drawSprite(spriteUniforms, 10, 10, 204, 16, 0, [0.1, 0.1, 0.1, 1], null);

        // The bar is drawn whole and clipped to how much health is left.
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(12, HEIGHT - 24, Math.round(200 * state.health), 12);
        drawSprite(spriteUniforms, 12, 12, 200, 12, 0, [1, 1, 1, 1], barTexture);

        if (variant !== 7)
        {
            gl.disable(gl.SCISSOR_TEST);
        }

        drawSprite(spriteUniforms, 406, 10, 64, 64, 0, [1, 1, 1, 1], mapTexture);
    }

    function frame (time)
    {
        state.frame++;
        state.time = time;

        gl.enable(gl.CULL_FACE);
        gl.frontFace(gl.CW);

        renderMap();

        gl.clearColor(0.35, 0.6, 0.9, 1);
        gl.clearDepth(variant === 5 ? 0 : 1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LESS);

        drawGround();

        // Variant 13 gets the order wrong on one frame in forty: a flicker.
        if (variant === 6 || (variant === 13 && state.frame % 40 === 0))
        {
            drawGlass();
            drawCrates();
        }
        else
        {
            drawCrates();
            drawGlass();
        }

        if (variant === 14)
        {
            drawShafts();
        }

        drawSparks(time);
        drawHud();

        requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
}
