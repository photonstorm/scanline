---
name: scanline-memory
description: Find GPU memory leaks and growth in a WebGL or WebGPU page, with Scanline. Use when a canvas game or renderer uses more memory the longer it runs, crashes or loses its context after a while, slows down over time, or creates textures, buffers, render targets or shaders it never frees. Covers snapshots, diffing by the line of code that created each object, checking the estimate against the GPU process's real memory, and the common shapes a leak takes.
---

# Memory that grows

A leak on the GPU is objects that were created and never destroyed. Scanline keeps a registry of every GPU object the page makes, with the line of code that made it, so the question "what is piling up, and who makes it?" has a direct answer.

Tools are `gfx_*` over MCP or `scanline <command>` in a shell. The `scanline` skill covers launching and looking.

## The recipe

1. `gfx_launch(url)` and let the page reach a steady state: past loading, into the part that grows.
2. `gfx_memory(snapshot: "before")`.
3. Make it do the thing that leaks, for long enough to matter. `gfx_step(frames: 600)`, or play (see `scanline-play`), or resize the window, or change level and come back: whichever the report says.
4. `gfx_memory(diff: ["before", "now"])`.

The diff lists what was created since the snapshot and is still alive, grouped by the line that created it, with counts and estimated bytes. A leak is a group whose count keeps rising: run step 3 again and diff again. Twice as long should give twice as many.

`group_by: "kind"` or `"format"` regroups the same diff when the creation site is one shared helper.

## Read the creating line

Each group names a file, line and function. Open it. The question is not "why is this created" but "where is the matching delete, and why is it not reached". `gfx_resource(handle)` on one of the objects gives its size, format and label, and for a texture `preview: true` shows what is in it, which often says what it was for.

## Is the estimate real?

Sizes are estimates from dimensions and formats, and results say so. The diff also reports the GPU process's own memory at both snapshots, as the operating system counts it, and says whether that bears the estimate out. Report both. If the estimate grows and the process does not, the driver may be deferring, or the objects are small; if the process grows and the estimate does not, the growth is not in objects the page creates (look at canvas resizes and the browser's own caches).

## Common shapes

| What the diff shows | What it usually is |
|---|---|
| One texture or buffer per frame from one line | An upload that creates instead of updating: `createTexture` or `createBuffer` in the draw path. Create once, then `texSubImage2D`, `bufferSubData` or `writeBuffer` |
| A set of render targets for each resize | The resize handler makes new targets and drops the old ones without `deleteTexture`, `deleteFramebuffer`, `deleteRenderbuffer` or `destroy()` |
| Programs or shader modules that rise steadily | A shader compiled per object or per frame: cache by source. This also costs frame time |
| Objects that rise on each level load and never fall | A scene that is dropped without disposing its GPU objects. In three.js, `dispose()` on geometries, materials and textures; in PixiJS, `destroy` with its texture options |
| Counts steady, bytes rising | Something is being re-created larger: a growing atlas or a buffer that doubles |
| WebGPU objects that are dropped but not destroyed | Garbage collection will free them eventually, and not soon. Call `destroy()` on textures and buffers |

## Churn is not a leak, and is still a problem

`gfx_resources()` with no kind counts what is alive and how many have been created in all. Thousands created and few alive means objects are made and destroyed again and again. For buffers and textures that is wasted time each frame; for shaders and programs it means compiling every frame. A capture's summary lists what one frame created and deleted.

## Prove the fix

After the change: reload, take the same snapshot, do the same thing for the same number of frames, and diff. The group should be gone, and the GPU process's growth with it. Report the counts before and after.

## Limits

- "Last used" is exact for WebGL. For WebGPU it is sampled, a frame in sixteen: `used ~f120` is the last sampled frame an object was used in, and `not seen in use` after the page has run a second or more means nothing bound it, set it or drew to it. Let the page run before trusting it.
- Memory the browser keeps for its own purposes (decoded images, the compositor) is in the process figure and not in the estimate.
- Compressed, depth and multisampled textures are counted by format rules; drivers may round up.
