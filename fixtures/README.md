# Fixtures

Test pages. Each renders a known scene so a test or an agent can check what Scanline reports
against what is really there.

## The content matrix (`matrix/`)

Every page in the matrix draws the same scene on a 320×240 canvas:

| What | Where (canvas pixels, origin top-left) | Colour (RGBA 8-bit) |
|---|---|---|
| Background | everywhere else | 32, 64, 96, 255 |
| Red quad | x 40–79, y 40–79 | 255, 0, 0, 255 |
| Green quad | x 140–179, y 40–79 | 0, 255, 0, 255 |
| Blue quad | x 240–279, y 40–79 | 0, 0, 255, 255 |
| White mover | 20×20 at y 200–219; left edge x = floor(elapsed ms × 0.06) mod 300 | 255, 255, 255, 255 |

The mover advances one pixel per frame at a 1/60 s step, so its position says how much page
time has passed. Elapsed time is measured from the timestamp of the first frame.

Each page sets `window.fixture` (or posts it from a worker) to
`{ name, frames, elapsed, lastDelta, moverX }` after every frame.

| Page | API | Draws per frame | Notes |
|---|---|---|---|
| `webgl1.html` | WebGL 1 | 5 `drawArrays` | One uniform-coloured quad per draw. |
| `webgl2.html` | WebGL 2 | 1 `drawArraysInstanced`, 5 instances | Vertex array object, instance buffer updated each frame. |
| `webgpu.html` | WebGPU | 1 `draw`, 5 instances, 1 pass | Instance buffer written each frame. |
| `webgpu-invalid.html` | WebGPU | 1 `draw` the browser rejects | The draw reads past its vertex buffer, so the command buffer is dropped and nothing is drawn. For checking that rejected calls are reported. |
| `game.html` | WebGL 2 | 1 `drawArrays` for the player, 1 per spark | A game that takes input: a square steered with the arrow keys, sparks thrown in random directions from each click. For recording a run and replaying it. |
| `worker.html` | WebGL 2 in a worker | as `webgl2.html` | `transferControlToOffscreen`, frame loop in the worker. |
| `timers.html` | WebGL 1 | 5 `drawArrays` | Frame loop on `setInterval`, no `requestAnimationFrame`. |

## The slow frame (`slow/`)

`slow/webgl2.html` is a row of columns against a low sun at 1920×1080, in three passes: a mask of the sun and what stands in front of it, the scene, and light shafts added over the scene from the mask. The shafts are one full-screen draw whose fragment shader samples the mask 64 times a pixel, and they take nearly all of the frame's GPU time. Twenty-four samples look the same. It is the page journey J3 is run on (`tests/journeys.test.mjs`). `slow/webgpu.html` is the same scene in raw WebGPU: three labelled passes (`mask`, `scene`, `godrays`), five pipelines with layout `auto`, and the shafts' inputs in one bind group.

## Pixel history (`history/`)

`history/webgl2.html` is a still scene on a 320×240 canvas whose every pixel's history is known by hand. `?samples=4` draws it into a four-sample RGB8 renderbuffer (`fbo_1`) and resolves that to the canvas with a blit, which is then event 5.

| Event | What | Where (x, y from the top-left) | Depth |
|---|---|---|---|
| 0 | Clear to (32, 64, 96) | everywhere | cleared to 1 |
| 1 | Grey floor (128, 128, 128) | y 120 to 239 | 0.5 |
| 2 | Red disc: an 80×80 quad whose shader discards outside its inscribed circle | x 40 to 119, y 20 to 99 | 0.4 |
| 3 | Green ramp: a 160×60 quad at depth 0.9 whose shader writes its own depth, 0 at its left edge to 1 at its right | x 80 to 239, y 150 to 209 | written: (x − 80) / 160 |
| 4 | Blue quad | x 240 to 299, y 160 to 219 | 0.8 |

The depth test is `LESS` throughout. So:

| Pixel | History |
|---|---|
| (80, 60), the disc's middle | cleared, then red |
| (44, 24), a corner of the disc's quad | cleared; event 2 covers it and its shader discards it |
| (100, 180), the ramp's left | cleared, grey, then green: the shader wrote depth 0.125, in front of the floor |
| (220, 180), the ramp's right | cleared, grey; event 3 fails the depth test: the shader wrote 0.875 |
| (260, 180), the blue quad | cleared, grey; event 4 fails the depth test |

`history/nan.html` draws to a 160×120 RGBA16F texture and shows it on the canvas. Columns 0 to 39 of the texture hold NaN (`normalize(vec3(0))`), columns 40 to 79 hold infinity (`1.0 / 0.0`), the rest ordinary values.

## The page protocol (`protocol/`)

`protocol/webgl2.html` is an orchard: sky, ground and five trees, in raw WebGL 2, written the way the `scanline-debuggable-rendering` skill asks. Every object is labelled, every draw is in a group (`sky`, `ground`, `trees / tree-N`, and `debug` when the bounds view is on), each tree declares itself as an entity, and the page provides its state, three controls (`sun.height`, `wind`, `season`), one view (`bounds`), marks (`assets loaded`, `first frame`, `second passed` once a second), its own time control and a checkpoint. A frame is 11 draws, or 31 with the view on.

## Engine adapters (`adapters/`)

One scene per engine, each built to be awkward for mapping draws to objects.

| Page | What is in it |
|---|---|
| `three.html` (`?renderer=webgpu`) | A scene named `Courtyard`: a shadow-casting light `Sun`, `Ground`, five `Pillars` in one instanced mesh, a `Crate` with two materials (three draws), a transparent double-sided `GlassBall` (two draws), a `Marker` sprite and `Dust` points. 13 draws on WebGL, 4 of them the shadow map. |
| `pixi.html` (`?renderer=webgpu`) | A stage of seven sprites from two textures (`coin`, `gem`) whose fourth is additive, a `BlurredPanel` with a blur filter, a `MaskedGroup` with a stencil mask, a `BigStar` shape too large to batch, and `ScoreText`. 13 draws: 8 batches, 4 filter passes, 1 unbatched shape. |
| `phaser.html` | A scene `Yard` of seven images whose fourth is additive, a rectangle and a circle, a container `Crate` of two images, `ScoreText`, a `Player` sprite, and two cameras (`Main`, `Minimap`). 11 draws: 5 batches for each camera, and the minimap's background. |

## Inventory pages (`matrix/inventory-*.html`)

Objects with known sizes and contents, for checking what the live inventory reports. Both pages make the same things:

| Object | What it is | Known contents |
|---|---|---|
| `checker` | 4×4 RGBA8 texture | Texel (x, y) is (x × 60, y × 60, 128, 255) |
| `mipped` | 64×64 RGBA8 texture, 7 mip levels | 21,844 bytes with its chain (WebGL: every texel 10, 20, 30, 255) |
| `floaty` | 2×2 RGBA32F texture | Texel (0, 0) is (0.25, 1.5, −2, 1); texel (1, 0) is (100, 0, 0, 1) |
| Render target | 32×16 RGBA8, drawn every frame | Top half magenta, bottom half cyan, as rendered |
| Vertex buffer | 48 bytes | Twelve floats: −1, −1, 1, −1, −1, 1, 1, 1, 0.5, 1.5, 2.5, 3.5 |
| Index buffer (WebGL) | 12 bytes | Six 16-bit indices: 0, 1, 2, 2, 1, 3 |
| Program or pipeline | A textured quad | `tint` is (0.25, 0.5, 0.75, 1). In WebGL, `scale` is 0.5, `map` is 0, and `bias` is never set |
| `window.broken` | A shader that does not compile | Refers to `undefinedName` |

`window.leak(n)` creates `n` 256×256 RGBA8 textures (262,144 bytes each) that are never destroyed, all from one function, `leakTexture`.

The WebGPU page labels its objects; WebGL has no labels.
