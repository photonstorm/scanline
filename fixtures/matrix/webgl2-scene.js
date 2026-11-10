// The WebGL 2 version of the scene, shared by the page and the worker.

import { QUADS, instanceData } from './scene.js';

export function createWebGL2Scene (canvas)
{
    const gl = canvas.getContext('webgl2', { antialias: false });

    const compile = (type, source) =>
    {
        const shader = gl.createShader(type);

        gl.shaderSource(shader, source);
        gl.compileShader(shader);

        return shader;
    };

    const program = gl.createProgram();

    gl.attachShader(program, compile(gl.VERTEX_SHADER, `#version 300 es
        layout(location = 0) in vec2 corner;
        layout(location = 1) in vec4 rect;
        layout(location = 2) in vec4 colour;
        out vec4 tint;
        void main () { tint = colour; gl_Position = vec4(rect.xy + corner * rect.zw, 0.0, 1.0); }
    `));

    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, `#version 300 es
        precision mediump float;
        in vec4 tint;
        out vec4 result;
        void main () { result = tint; }
    `));

    gl.linkProgram(program);

    const vao = gl.createVertexArray();

    gl.bindVertexArray(vao);

    const corners = gl.createBuffer();

    gl.bindBuffer(gl.ARRAY_BUFFER, corners);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const instances = gl.createBuffer();

    gl.bindBuffer(gl.ARRAY_BUFFER, instances);
    gl.bufferData(gl.ARRAY_BUFFER, QUADS.length * 32, gl.DYNAMIC_DRAW);

    for (const [location, offset] of [[1, 0], [2, 16]])
    {
        gl.enableVertexAttribArray(location);
        gl.vertexAttribPointer(location, 4, gl.FLOAT, false, 32, offset);
        gl.vertexAttribDivisor(location, 1);
    }

    return (elapsed) =>
    {
        gl.viewport(0, 0, 320, 240);
        gl.useProgram(program);
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, instances);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, instanceData(elapsed));
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, QUADS.length);
    };
}
