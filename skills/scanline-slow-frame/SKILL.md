---
name: scanline-slow-frame
description: Find why a WebGL or WebGPU page renders slowly, with Scanline. Use when a canvas game or renderer drops frames, a frame takes too long, the GPU is the bottleneck, or you need to know which pass, draw or shader costs the most and what change makes it cheaper. Covers measuring first, classifying the cost by experiment, ranking by shader, reading the shader, and proving a cheaper version live before changing source.
---

# Where a slow frame's time goes

Do not guess at the cost from the code. Measure, classify, then change one thing and measure again.

Tools are `gfx_*` over MCP or `scanline <command>` in a shell. The `scanline` skill covers launching and looking.

## 1. Is it slow, and is it the GPU?

Launch on the real GPU, not headless-software, and let it run a little: `gfx_launch(url, start: "paused")`, `gfx_step(frames: 60)`, then `gfx_stats(window_frames: 30)`.

Read three numbers: the frame interval, CPU time per frame (script), and GPU time per frame. GPU time arrives a few frames late; if it is missing, step a few more frames and ask again.

- **CPU time high, GPU low:** the cost is in script, not drawing. Scanline can tell you how many draws and state changes the frame issues (`gfx_stats`, and a capture's counts), which is often the reason, but profile the script with the browser's own tools.
- **GPU time high:** carry on here.
- **Neither high, but frames are late:** something outside the page's own timings. `gfx_trace(frames: 120)` records the browser's own trace and says how busy the GPU process was and on what.

Timings on a paused, stepped page are of the frames you stepped. A single frame is noise: use 30 or more.

## 2. Is it the pixels, or the geometry and draw count?

`gfx_experiment(kind: "scissor_1px")` runs the page for a number of frames with every draw clipped to one pixel, measures, and takes the change away again.

- **Frame gets much cheaper:** the cost is filling pixels: fragment shaders, overdraw, resolution, blending. Go to step 3.
- **Frame hardly changes:** the cost is per draw or per vertex: too many draws, heavy vertex shaders, big buffers uploaded each frame. Look at the capture's counts, at what the frame created (`gfx_resources()` flags churn), and at `gfx_experiment(kind: "skip", filter: {…})` to find what a group of draws costs.

## 3. Which shader?

`gfx_capture()`, then `gfx_profile(capture, by: "pass")` to see which pass holds the time, and `gfx_profile(capture, by: "shader")` to rank the programs. It replays each draw several times inside a timer and says how it measured. Trust the order and the rough proportions, not the last digit.

On a WebGPU page `profile` is not built. Use the per-pass GPU times in `gfx_stats`, `gfx_pass_tree(capture)` to see what each pass draws, and `gfx_experiment(kind: "skip", filter: {pipeline: "pip_N"})` to measure what one pipeline costs.

`gfx_view(capture, view: "overdraw")` counts how many times each pixel was drawn. High overdraw with a cheap shader is a sorting or culling problem, not a shader problem.

## 4. Read the shader

`gfx_shader_analysis(handle)` on the costliest program or pipeline reads its source for what it could cost: texture samples, how many are inside loops, the loop bounds, discards. A sample inside a loop of 64 on a full-screen pass is 64 samples for every pixel on screen: that is usually the answer.

`gfx_resource(handle: "shd_N")` gives the whole source.

## 5. Try the cheaper version live

Change the running page, not the source:

- `gfx_patch_shader(handle, edits: [{find: "SAMPLES 64", replace: "SAMPLES 24"}])`, or `defines: {SAMPLES: 24}` on GLSL. A shader that does not compile changes nothing and you get the log.
- Take a `gfx_screenshot()` before and after and `gfx_diff(a, b)` them: a cheaper frame that looks different is a trade, and the person should hear how different. Report the number of pixels changed and by how much.
- `gfx_step(frames: 34)` and `gfx_stats(window_frames: 30)` again for the new GPU time.

`gfx_patches()` states the change in words for the source. `gfx_patches(revert: "all")` puts the page back.

## 6. Change the source and measure with no patch

Make the change, `gfx_navigate(reload: true)`, step the same number of frames, and compare `gfx_stats` with step 1. Report both figures and the picture difference.

## What the figures cannot tell you

- GPU timer queries are quantised and can be disabled by the browser; results say when a figure is missing or coarse.
- Replayed per-draw times leave out what the page did between draws, so they sum to less than the frame.
- A software or headless-software profile measures a CPU rasteriser. Never draw conclusions about GPU cost from it.
- Scanline itself costs time: about 80 ns for each graphics call at the default level. A frame with tens of thousands of calls is measurably slower under it. `gfx_launch(level: "off")` shows the page with the instrumentation doing as little as it can.
