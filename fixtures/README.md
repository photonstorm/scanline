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
