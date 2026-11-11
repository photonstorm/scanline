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
//   post       A hand-written handler runs after the native call:
//              handler(record, self, result, ...args).
//   intercept  A hand-written handler replaces the wrapper body: handler(self, native, args).
//              Used where the probe must change arguments (for example adding COPY_SRC).
//
// Later milestones add: how each method changes shadow state, and which arguments are data.

// Methods whose effect the WebGL tracker mirrors: bindings, state, object lifetimes and
// contents, uniforms. Each gets a post handler named `gl.<method>` in gl/tracker.ts.
const GL_TRACKED = [
    // Bindings
    'activeTexture', 'bindTexture', 'bindBuffer', 'bindBufferBase', 'bindBufferRange', 'bindFramebuffer',
    'bindRenderbuffer', 'useProgram', 'bindVertexArray', 'bindSampler', 'bindTransformFeedback',
    // State
    'enable', 'disable', 'viewport', 'scissor', 'clearColor', 'clearDepth', 'clearStencil', 'colorMask',
    'depthMask', 'depthFunc', 'depthRange', 'blendColor', 'blendEquation', 'blendEquationSeparate',
    'blendFunc', 'blendFuncSeparate', 'cullFace', 'frontFace', 'lineWidth', 'polygonOffset', 'sampleCoverage',
    'stencilFunc', 'stencilFuncSeparate', 'stencilMask', 'stencilMaskSeparate', 'stencilOp', 'stencilOpSeparate',
    'pixelStorei', 'drawBuffers', 'readBuffer',
    // Vertex layout
    'enableVertexAttribArray', 'disableVertexAttribArray', 'vertexAttribPointer', 'vertexAttribIPointer',
    'vertexAttribDivisor',
    // Textures
    'createTexture', 'deleteTexture', 'texImage2D', 'texImage3D', 'texStorage2D', 'texStorage3D',
    'texSubImage2D', 'texSubImage3D', 'compressedTexImage2D', 'compressedTexImage3D',
    'compressedTexSubImage2D', 'compressedTexSubImage3D', 'copyTexImage2D', 'copyTexSubImage2D',
    'copyTexSubImage3D', 'generateMipmap', 'texParameteri', 'texParameterf',
    // Buffers
    'createBuffer', 'deleteBuffer', 'bufferData', 'bufferSubData',
    // Shaders and programs
    'createShader', 'deleteShader', 'shaderSource', 'compileShader', 'createProgram', 'deleteProgram',
    'attachShader', 'detachShader', 'linkProgram', 'getUniformLocation', 'uniformBlockBinding',
    // Framebuffers and renderbuffers
    'createFramebuffer', 'deleteFramebuffer', 'framebufferTexture2D', 'framebufferRenderbuffer',
    'framebufferTextureLayer', 'createRenderbuffer', 'deleteRenderbuffer', 'renderbufferStorage',
    'renderbufferStorageMultisample',
    // Other objects
    'createSampler', 'deleteSampler', 'samplerParameteri', 'samplerParameterf', 'createVertexArray',
    'deleteVertexArray', 'createQuery', 'deleteQuery', 'createTransformFeedback', 'deleteTransformFeedback',
    // Uniforms
    'uniform1f', 'uniform2f', 'uniform3f', 'uniform4f', 'uniform1i', 'uniform2i', 'uniform3i', 'uniform4i',
    'uniform1ui', 'uniform2ui', 'uniform3ui', 'uniform4ui',
    'uniform1fv', 'uniform2fv', 'uniform3fv', 'uniform4fv', 'uniform1iv', 'uniform2iv', 'uniform3iv', 'uniform4iv',
    'uniform1uiv', 'uniform2uiv', 'uniform3uiv', 'uniform4uiv',
    'uniformMatrix2fv', 'uniformMatrix3fv', 'uniformMatrix4fv', 'uniformMatrix2x3fv', 'uniformMatrix3x2fv',
    'uniformMatrix2x4fv', 'uniformMatrix4x2fv', 'uniformMatrix3x4fv', 'uniformMatrix4x3fv'
];

export const GL = {
    drawArrays: { draw: { mode: 0, count: 2, instances: null } },
    drawElements: { draw: { mode: 0, count: 1, instances: null } },
    drawArraysInstanced: { draw: { mode: 0, count: 2, instances: 3 } },
    drawElementsInstanced: { draw: { mode: 0, count: 1, instances: 4 } },
    drawRangeElements: { draw: { mode: 0, count: 3, instances: null } },
    // A blit changes pixels as a draw does: a capture counts it as an event, and so must
    // anything that numbers a frame's events the way a capture does.
    blitFramebuffer: { count: 'blits' },
    clear: { count: 'clears' },
    clearBufferfv: { count: 'clears' },
    clearBufferiv: { count: 'clears' },
    clearBufferuiv: { count: 'clears' },
    clearBufferfi: { count: 'clears' },
    compileShader: { count: 'compiles' },
    linkProgram: { count: 'links' },
    getExtension: { post: true },
    readPixels: { count: 'readbacks' },
    getError: { count: 'getErrors' },
    // Intercepted: if the page starts a timer query of its own, the probe's must end first.
    beginQuery: { intercept: true }
};

for (const name of GL_TRACKED)
{
    GL[name] = { ...GL[name], post: true };
}

// Extension objects, keyed by the extension's interface name.
export const GL_EXTENSIONS = {
    ANGLE_instanced_arrays: {
        drawArraysInstancedANGLE: { draw: { mode: 0, count: 2, instances: 3 } },
        drawElementsInstancedANGLE: { draw: { mode: 0, count: 1, instances: 4 } },
        vertexAttribDivisorANGLE: { post: true }
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
    OES_vertex_array_object: {
        createVertexArrayOES: { post: true },
        deleteVertexArrayOES: { post: true },
        bindVertexArrayOES: { post: true }
    },
    WEBGL_draw_buffers: {
        drawBuffersWEBGL: { post: true }
    },
    EXT_disjoint_timer_query: {
        beginQueryEXT: { intercept: true }
    },
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
        // Intercepted: the probe adds COPY_SRC and a label to the descriptor.
        createTexture: { intercept: true },
        createBuffer: { intercept: true },
        createShaderModule: { count: 'compiles', post: true },
        createRenderPipeline: { count: 'links', post: true },
        createRenderPipelineAsync: { count: 'links', post: true },
        createComputePipeline: { count: 'links', post: true },
        createComputePipelineAsync: { count: 'links', post: true },
        createBindGroup: { post: true },
        createBindGroupLayout: { post: true },
        createPipelineLayout: { post: true },
        createSampler: { post: true },
        createQuerySet: { post: true },
        createCommandEncoder: { post: true },
        destroy: { post: true }
    },
    GPUQueue: {
        submit: { count: 'submits' },
        writeBuffer: { post: true },
        writeTexture: { post: true },
        copyExternalImageToTexture: { post: true }
    },
    GPUCommandEncoder: {
        // Intercepted: the probe adds timestamp writes to passes that have none.
        beginRenderPass: { intercept: true },
        beginComputePass: { intercept: true }
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
    GPUTexture: {
        createView: { post: true },
        destroy: { post: true }
    },
    GPUBuffer: {
        destroy: { post: true },
        // A capture reads what the page wrote to a mapped buffer just before it is unmapped.
        getMappedRange: { post: true },
        unmap: { intercept: true }
    },
    // A layout taken from a pipeline is an object like any other layout, and bind groups are made with it.
    GPURenderPipeline: {
        getBindGroupLayout: { post: true }
    },
    GPUComputePipeline: {
        getBindGroupLayout: { post: true }
    }
};
