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
| `worker.html` | WebGL 2 in a worker | as `webgl2.html` | `transferControlToOffscreen`, frame loop in the worker. |
| `timers.html` | WebGL 1 | 5 `drawArrays` | Frame loop on `setInterval`, no `requestAnimationFrame`. |
