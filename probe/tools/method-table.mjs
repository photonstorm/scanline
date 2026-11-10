// What the probe needs to know about a method beyond its signature.
//
// The hook generator (gen-hooks.mjs) reads the published WebGL and WebGPU interface
// definitions for every method's name and arity, and this table for what the method means.
// A method that is not listed here still gets a wrapper: it is counted and, at the capture
// level, recorded.
//
// Entry fields:
//   draw       The method issues draws. `mode`, `count` and `instances` are argument indices
//              (or null); the generated wrapper passes them to the frame counters.
//              `multi` is the index of the argument holding the number of draws.
//   count      Name of a per-frame counter to increment ('clears', 'passes', 'submits', …).
//   post       A hand-written handler runs after the native call: handler(record, ...args, result).
//   intercept  A hand-written handler replaces the wrapper body: handler(self, native, args).
//              Used where the probe must change arguments (for example adding COPY_SRC).
//
// Later milestones add: how each method changes shadow state, and which arguments are data.

export const GL = {
    drawArrays: { draw: { mode: 0, count: 2, instances: null } },
    drawElements: { draw: { mode: 0, count: 1, instances: null } },
    drawArraysInstanced: { draw: { mode: 0, count: 2, instances: 3 } },
    drawElementsInstanced: { draw: { mode: 0, count: 1, instances: 4 } },
    drawRangeElements: { draw: { mode: 0, count: 3, instances: null } },
    clear: { count: 'clears' },
    clearBufferfv: { count: 'clears' },
    clearBufferiv: { count: 'clears' },
    clearBufferuiv: { count: 'clears' },
    clearBufferfi: { count: 'clears' },
    compileShader: { count: 'compiles' },
    linkProgram: { count: 'links' },
    getExtension: { post: true },
    readPixels: { count: 'readbacks' },
    getError: { count: 'getErrors' }
};

// Extension objects, keyed by the extension's interface name.
export const GL_EXTENSIONS = {
    ANGLE_instanced_arrays: {
        drawArraysInstancedANGLE: { draw: { mode: 0, count: 2, instances: 3 } },
        drawElementsInstancedANGLE: { draw: { mode: 0, count: 1, instances: 4 } }
    },
    WEBGL_multi_draw: {
        multiDrawArraysWEBGL: { draw: { mode: 0, multi: 5 } },
        multiDrawElementsWEBGL: { draw: { mode: 0, multi: 6 } },
        multiDrawArraysInstancedWEBGL: { draw: { mode: 0, multi: 7 } },
        multiDrawElementsInstancedWEBGL: { draw: { mode: 0, multi: 8 } }
    },
    WEBGL_draw_instanced_base_vertex_base_instance: {
        drawArraysInstancedBaseInstanceWEBGL: { draw: { mode: 0, count: 2, instances: 3 } },
        drawElementsInstancedBaseVertexBaseInstanceWEBGL: { draw: { mode: 0, count: 1, instances: 4 } }
    },
    WEBGL_multi_draw_instanced_base_vertex_base_instance: {
        multiDrawArraysInstancedBaseInstanceWEBGL: { draw: { mode: 0, multi: 9 } },
        multiDrawElementsInstancedBaseVertexBaseInstanceWEBGL: { draw: { mode: 0, multi: 11 } }
    },
    OES_vertex_array_object: {},
    WEBGL_draw_buffers: {},
    EXT_disjoint_timer_query: {},
    EXT_disjoint_timer_query_webgl2: {},
    WEBGL_lose_context: {},
    WEBGL_debug_shaders: {},
    WEBGL_polygon_mode: {},
    WEBGL_provoking_vertex: {},
    WEBGL_shader_pixel_local_storage: {}
};

// WebGPU, keyed by interface.
export const GPU = {
    GPU: {
        requestAdapter: { intercept: true }
    },
    GPUAdapter: {
        requestDevice: { intercept: true }
    },
    GPUDevice: {
        createShaderModule: { count: 'compiles' },
        createRenderPipeline: { count: 'links' },
        createRenderPipelineAsync: { count: 'links' },
        createComputePipeline: { count: 'links' },
        createComputePipelineAsync: { count: 'links' }
    },
    GPUQueue: {
        submit: { count: 'submits' }
    },
    GPUCommandEncoder: {
        beginRenderPass: { count: 'passes' },
        beginComputePass: { count: 'passes' }
    },
    GPURenderPassEncoder: {
        draw: { draw: { mode: null, count: 0, instances: 1 } },
        drawIndexed: { draw: { mode: null, count: 0, instances: 1 } },
        drawIndirect: { draw: { mode: null, count: null, instances: null } },
        drawIndexedIndirect: { draw: { mode: null, count: null, instances: null } }
    },
    GPUComputePassEncoder: {
        dispatchWorkgroups: { count: 'dispatches' },
        dispatchWorkgroupsIndirect: { count: 'dispatches' }
    },
    GPURenderBundleEncoder: {
        // Draws recorded into a bundle are counted when the bundle is built, not when it
        // runs. Counting at executeBundles needs the registry (milestone 2).
    },
    GPUCanvasContext: {
        configure: { intercept: true },
        unconfigure: { intercept: true },
        getCurrentTexture: { intercept: true }
    },
    GPUTexture: {},
    GPUBuffer: {}
};
