// The replay page. Scanline opens it as a second, hidden target in the browser the game is
// running in, gives it a capture, and has it run the captured frame again on the same GPU
// (02-ARCHITECTURE.md, section 4.4).
//
// Every question about a point inside a frame is answered here: the picture after draw N,
// which draws changed a pixel. There is no mid-frame halt of the game; the capture is run
// as far as the question needs and the result read back. Answers are `gpu-measured`.

import { METHOD_NAMES } from '../../probe/src/hooks/generated';
import { gpuApi } from './gpu';

type Json = any;

interface CaptureData
{
    header: Json;
    initial: Json;
    objects: Json[];
    methods?: string[];
    commands: Json[];
    draws: Json[];
    blobs: number[];
}

interface Loaded
{
    data: CaptureData;
    blobs: Array<Uint8Array | null>;
}

const loaded = new Map<string, Loaded>();

// ---- Loading ----

function fromBase64 (text: string): Uint8Array
{
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i++)
    {
        bytes[i] = binary.charCodeAt(i);
    }

    return bytes;
}

async function gunzip (bytes: Uint8Array): Promise<Uint8Array>
{
    return new Uint8Array(await new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
}

async function gzip (bytes: Uint8Array): Promise<Uint8Array>
{
    return new Uint8Array(await new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
}

function toBase64 (bytes: Uint8Array): string
{
    let binary = '';

    for (let i = 0; i < bytes.length; i += 0x8000)
    {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[]);
    }

    return btoa(binary);
}

// ---- Running a capture ----

const TYPED: Record<string, any> = {
    Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array
};

const TEXTURE_2D = 0x0DE1;
const TEXTURE_CUBE_MAP = 0x8513;
const TEXTURE_3D = 0x806F;
const TEXTURE_2D_ARRAY = 0x8C1A;

// How RGBA data read back from a texture is uploaded into a texture of each internal
// format: [format, channels]. The type comes from the kind of data (bytes or floats).
const UPLOAD: Record<number, [number, number]> = {
    0x1908: [0x1908, 4], 0x8058: [0x1908, 4], 0x8C43: [0x1908, 4], 0x8056: [0x1908, 4], 0x8057: [0x1908, 4], 0x881A: [0x1908, 4], 0x8814: [0x1908, 4],
    0x1907: [0x1907, 3], 0x8051: [0x1907, 3], 0x8C41: [0x1907, 3], 0x8D62: [0x1907, 3], 0x881B: [0x1907, 3], 0x8815: [0x1907, 3], 0x8C3A: [0x1907, 3], 0x8C3D: [0x1907, 3],
    0x8229: [0x1903, 1], 0x822D: [0x1903, 1], 0x822E: [0x1903, 1],
    0x822B: [0x8227, 2], 0x822F: [0x8227, 2], 0x8230: [0x8227, 2]
};

class Run
{
    capture: Loaded;
    canvas: OffscreenCanvas | HTMLCanvasElement;
    gl: any;
    gl2: boolean;
    objects = new Map<string, any>();
    locations = new Map<string, WebGLUniformLocation | null>();
    extensions = new Map<string, any>();
    notes: string[] = [];

    // What the run has bound, tracked as commands go by, so readbacks can put it back.
    drawFramebuffer: any = null;
    readFramebuffer: any = null;
    packBuffer: any = null;

    // Scratch framebuffers that stand in for multisampled ones when they are read.
    resolves = new Map<any, { from: any; width: number; height: number }>();

    // `extra` adds to the page's own context attributes: a stencil buffer for counting overdraw.
    constructor (capture: Loaded, extra: Record<string, unknown> = {})
    {
        const header = capture.data.header;

        this.capture = capture;
        this.gl2 = header.api === 'webgl2';
        this.canvas = document.createElement('canvas');
        this.canvas.width = header.width;
        this.canvas.height = header.height;

        // The page's own attributes, but the drawing buffer is kept so it can be read at any point.
        this.gl = this.canvas.getContext(header.api, { ...(header.attributes ?? {}), ...extra, preserveDrawingBuffer: true });

        if (!this.gl)
        {
            throw new Error(`The browser would not create a ${header.api} context for the replay.`);
        }

        for (const name of header.extensions ?? [])
        {
            this.extensions.set(name, this.gl.getExtension(name));
        }
    }

    note (text: string): void
    {
        if (!this.notes.includes(text))
        {
            this.notes.push(text);
        }
    }

    // The capture's number for one of the replay's own objects of a kind, or null.
    idOf (object: any, kind = 'buffer'): number | null
    {
        if (!object)
        {
            return null;
        }

        for (const [key, made] of this.objects)
        {
            if (made === object && key.startsWith(`${kind}:`))
            {
                return Number(key.slice(kind.length + 1));
            }
        }

        return null;
    }

    object (kind: string, id: number | null): any
    {
        return id ? this.objects.get(`${kind}:${id}`) ?? null : null;
    }

    blob (index: number): Uint8Array
    {
        // A flight recording's blob numbers start where its dropped frames' left off.
        const bytes = this.capture.blobs[index - (this.capture.data.header.blobBase ?? 0)];

        if (!bytes)
        {
            throw new Error(`Blob ${index} of the capture was not delivered to the replay page.`);
        }

        return bytes;
    }

    // A blob as a typed array of the kind the page passed. Copied, so views are aligned.
    typed (name: string, bytes: Uint8Array): any
    {
        const copy = bytes.slice().buffer;

        if (name === 'ArrayBuffer')
        {
            return copy;
        }

        if (name === 'DataView')
        {
            return new DataView(copy);
        }

        return new (TYPED[name] ?? Uint8Array)(copy);
    }

    decode (value: Json): any
    {
        if (value === null || typeof value !== 'object')
        {
            return value;
        }

        if ('o' in value)
        {
            return this.object(value.o, value.i);
        }

        if ('u' in value)
        {
            return this.location(value.u, value.n);
        }

        if ('f' in value)
        {
            return Number(value.f);
        }

        if ('img' in value)
        {
            return new ImageData(new Uint8ClampedArray(this.blob(value.img).slice().buffer), value.w, value.h);
        }

        if ('b' in value)
        {
            return this.typed(value.t, this.blob(value.b));
        }

        if ('a' in value)
        {
            const items = value.a.map((item: Json) => (typeof item === 'string' ? Number(item) : this.decode(item)));

            return value.t ? new (TYPED[value.t] ?? Float32Array)(items) : items;
        }

        return null;
    }

    location (program: number, name: string): WebGLUniformLocation | null
    {
        const key = `${program}:${name}`;

        if (!this.locations.has(key))
        {
            const object = this.object('program', program);

            this.locations.set(key, object ? this.gl.getUniformLocation(object, name) : null);
        }

        return this.locations.get(key) ?? null;
    }

    // ---- Objects ----

    createObjects (): void
    {
        const gl = this.gl;
        const objects = this.capture.data.objects;

        // Made empty first, so that anything can refer to anything.
        for (const object of objects)
        {
            if (object.createdInFrame || this.wasCreatedInFrame(object))
            {
                continue;
            }

            let made: any = null;

            switch (object.kind)
            {
                case 'texture': made = gl.createTexture(); break;
                case 'buffer': made = gl.createBuffer(); break;
                case 'shader': made = gl.createShader(object.type); break;
                case 'program': made = gl.createProgram(); break;
                case 'framebuffer': made = gl.createFramebuffer(); break;
                case 'renderbuffer': made = gl.createRenderbuffer(); break;
                case 'sampler': made = this.gl2 ? gl.createSampler() : null; break;
                case 'vertex_array': made = this.createVertexArray(); break;
                case 'query': made = this.gl2 ? (object.transformFeedback ? gl.createTransformFeedback() : gl.createQuery()) : null; break;
            }

            this.objects.set(`${object.kind}:${object.id}`, made);
        }

        const of = (kind: string): Json[] => objects.filter((object) => object.kind === kind && this.objects.get(`${kind}:${object.id}`));

        for (const buffer of of('buffer'))
        {
            this.fillBuffer(buffer);
        }

        for (const texture of of('texture'))
        {
            this.fillTexture(texture);
        }

        for (const renderbuffer of of('renderbuffer'))
        {
            if (renderbuffer.width && renderbuffer.height)
            {
                gl.bindRenderbuffer(0x8D41, this.object('renderbuffer', renderbuffer.id));

                if (renderbuffer.samples > 0 && this.gl2)
                {
                    gl.renderbufferStorageMultisample(0x8D41, renderbuffer.samples, renderbuffer.internalFormat, renderbuffer.width, renderbuffer.height);
                }
                else
                {
                    gl.renderbufferStorage(0x8D41, renderbuffer.internalFormat, renderbuffer.width, renderbuffer.height);
                }
            }
        }

        gl.bindRenderbuffer(0x8D41, null);

        for (const shader of of('shader'))
        {
            const object = this.object('shader', shader.id);

            gl.shaderSource(object, shader.source ?? '');
            gl.compileShader(object);
        }

        for (const program of of('program'))
        {
            this.buildProgram(program);
        }

        for (const sampler of of('sampler'))
        {
            const object = this.object('sampler', sampler.id);

            for (const pname of Object.keys(sampler.params ?? {}))
            {
                gl.samplerParameterf(object, Number(pname), sampler.params[pname]);
            }
        }

        for (const framebuffer of of('framebuffer'))
        {
            this.buildFramebuffer(framebuffer);
        }

        gl.bindFramebuffer(0x8D40, null);
    }

    // An object the frame itself creates is made when its create call is replayed.
    wasCreatedInFrame (object: Json): boolean
    {
        return object.created >= this.capture.data.header.frame;
    }

    createVertexArray (): any
    {
        if (this.gl2)
        {
            return this.gl.createVertexArray();
        }

        return this.extensions.get('OES_vertex_array_object')?.createVertexArrayOES() ?? null;
    }

    bindVertexArray (vao: any): void
    {
        if (this.gl2)
        {
            this.gl.bindVertexArray(vao);
        }
        else
        {
            this.extensions.get('OES_vertex_array_object')?.bindVertexArrayOES(vao);
        }
    }

    fillBuffer (buffer: Json): void
    {
        const gl = this.gl;
        const target = buffer.element ? 0x8893 : 0x8892;

        gl.bindBuffer(target, this.object('buffer', buffer.id));

        if (typeof buffer.data === 'number')
        {
            gl.bufferData(target, this.blob(buffer.data), buffer.usage || 0x88E4);
        }
        else if (buffer.size > 0)
        {
            gl.bufferData(target, buffer.size, buffer.usage || 0x88E4);

            if (buffer.unreadable)
            {
                this.note(`A buffer's contents could not be captured: ${buffer.unreadable}`);
            }
        }

        gl.bindBuffer(target, null);
    }

    fillTexture (texture: Json): void
    {
        const gl = this.gl;
        const target = texture.target;

        if (!target)
        {
            return;
        }

        const object = this.object('texture', texture.id);

        gl.bindTexture(target, object);

        // The page's unpack settings are applied later with the rest of the initial state.
        // Here the data is exactly what was read back: one byte alignment, no flips.
        gl.pixelStorei(0x0CF5, 1);

        for (const pname of Object.keys(texture.params ?? {}))
        {
            gl.texParameterf(target, Number(pname), texture.params[pname]);
        }

        if (!texture.width || !texture.height)
        {
            return;
        }

        const three = target === TEXTURE_3D || target === TEXTURE_2D_ARRAY;
        const data: Json[] = texture.data ?? [];
        const kind: string = data[0]?.kind ?? 'unorm8';
        const upload = UPLOAD[texture.internalFormat];
        const levels = texture.levels || 1;

        // Storage first.
        if (texture.immutable && this.gl2)
        {
            if (three)
            {
                gl.texStorage3D(target, levels, texture.internalFormat, texture.width, texture.height, texture.depth);
            }
            else
            {
                gl.texStorage2D(target, levels, texture.internalFormat, texture.width, texture.height);
            }
        }

        if (texture.unreadable || !upload || kind === 'int')
        {
            // Contents unknown. Allocate what can be allocated so the frame still runs.
            this.note(texture.unreadable
                ? `A ${texture.format} texture's contents could not be captured (${texture.unreadable}), so replay shows it empty.`
                : `Replaying ${texture.format} textures is not built yet, so one is empty in the replay.`);

            if (!texture.immutable && upload && !three)
            {
                const faces = target === TEXTURE_CUBE_MAP ? [0x8515, 0x8516, 0x8517, 0x8518, 0x8519, 0x851A] : [TEXTURE_2D];

                for (const face of faces)
                {
                    gl.texImage2D(face, 0, texture.internalFormat, texture.width, texture.height, 0, upload[0], texture.type || 0x1401, null);
                }
            }

            return;
        }

        const [format, channels] = upload;
        const type = kind === 'float' ? 0x1406 : 0x1401;

        for (const part of data)
        {
            const width = Math.max(1, texture.width >> part.level);
            const height = Math.max(1, texture.height >> part.level);
            const rgba = kind === 'float' ? new Float32Array(this.blob(part.blob).slice().buffer) : this.blob(part.blob);

            // The readback is always four channels; the upload is what the format takes.
            let pixels: Float32Array | Uint8Array = rgba;

            if (channels < 4)
            {
                pixels = new (rgba.constructor as any)(width * height * channels);

                for (let i = 0, o = 0; i < width * height; i++)
                {
                    for (let channel = 0; channel < channels; channel++)
                    {
                        pixels[o++] = rgba[i * 4 + channel];
                    }
                }
            }

            if (three)
            {
                if (texture.immutable)
                {
                    gl.texSubImage3D(target, part.level, 0, 0, part.layer, width, height, 1, format, type, pixels);
                }
                else
                {
                    if (part.layer === 0)
                    {
                        gl.texImage3D(target, part.level, texture.internalFormat, width, height, texture.depth, 0, format, type, null);
                    }

                    gl.texSubImage3D(target, part.level, 0, 0, part.layer, width, height, 1, format, type, pixels);
                }
            }
            else
            {
                const face = target === TEXTURE_CUBE_MAP ? 0x8515 + part.layer : TEXTURE_2D;

                if (texture.immutable)
                {
                    gl.texSubImage2D(face, part.level, 0, 0, width, height, format, type, pixels);
                }
                else
                {
                    gl.texImage2D(face, part.level, texture.internalFormat, width, height, 0, format, type, pixels);
                }
            }
        }

        if (texture.generatedMips && data.length)
        {
            gl.generateMipmap(target);
        }

        gl.bindTexture(target, null);
    }

    buildProgram (program: Json): void
    {
        const gl = this.gl;
        const object = this.object('program', program.id);

        for (const shader of program.shaders ?? [])
        {
            const attached = this.object('shader', shader);

            if (attached)
            {
                gl.attachShader(object, attached);
            }
        }

        // The same attribute locations the page's program had.
        for (const name of Object.keys(program.attributes ?? {}))
        {
            if (program.attributes[name] >= 0)
            {
                gl.bindAttribLocation(object, program.attributes[name], name);
            }
        }

        if (!(program.shaders ?? []).length)
        {
            return;
        }

        gl.linkProgram(object);

        if (!gl.getProgramParameter(object, 0x8B82))
        {
            this.note(`A program did not link in the replay: ${gl.getProgramInfoLog(object)}`);

            return;
        }

        for (const index of Object.keys(program.blockBindings ?? {}))
        {
            gl.uniformBlockBinding(object, Number(index), program.blockBindings[index]);
        }

        // Uniforms as they stood when the frame began, set by each one's declared type.
        const values: Record<string, number[]> = program.uniforms ?? {};
        const count: number = gl.getProgramParameter(object, 0x8B86);

        gl.useProgram(object);

        for (let i = 0; i < count; i++)
        {
            const active = gl.getActiveUniform(object, i);

            if (!active)
            {
                continue;
            }

            const base = active.name.replace(/\[0\]$/, '');

            for (const name of new Set([active.name, base]))
            {
                if (values[name])
                {
                    this.setUniform(gl.getUniformLocation(object, name), active.type, values[name]);
                }
            }

            // Elements of an array the page set one at a time.
            for (let element = 1; element < active.size; element++)
            {
                const name = `${base}[${element}]`;

                if (values[name])
                {
                    this.setUniform(gl.getUniformLocation(object, name), active.type, values[name]);
                }
            }
        }

        gl.useProgram(null);
    }

    setUniform (location: WebGLUniformLocation | null, type: number, values: number[]): void
    {
        const gl = this.gl;

        if (!location)
        {
            return;
        }

        switch (type)
        {
            case 0x1406: gl.uniform1fv(location, values); break;
            case 0x8B50: gl.uniform2fv(location, values); break;
            case 0x8B51: gl.uniform3fv(location, values); break;
            case 0x8B52: gl.uniform4fv(location, values); break;
            case 0x8B5A: gl.uniformMatrix2fv(location, false, values); break;
            case 0x8B5B: gl.uniformMatrix3fv(location, false, values); break;
            case 0x8B5C: gl.uniformMatrix4fv(location, false, values); break;
            case 0x8B65: gl.uniformMatrix2x3fv(location, false, values); break;
            case 0x8B66: gl.uniformMatrix2x4fv(location, false, values); break;
            case 0x8B67: gl.uniformMatrix3x2fv(location, false, values); break;
            case 0x8B68: gl.uniformMatrix3x4fv(location, false, values); break;
            case 0x8B69: gl.uniformMatrix4x2fv(location, false, values); break;
            case 0x8B6A: gl.uniformMatrix4x3fv(location, false, values); break;
            case 0x1405: gl.uniform1uiv(location, values); break;
            case 0x8DC6: gl.uniform2uiv(location, values); break;
            case 0x8DC7: gl.uniform3uiv(location, values); break;
            case 0x8DC8: gl.uniform4uiv(location, values); break;
            case 0x8B53: case 0x8B57: gl.uniform2iv(location, values); break;
            case 0x8B54: case 0x8B58: gl.uniform3iv(location, values); break;
            case 0x8B55: case 0x8B59: gl.uniform4iv(location, values); break;
            // Integers, booleans and every kind of sampler.
            default: gl.uniform1iv(location, values); break;
        }
    }

    buildFramebuffer (framebuffer: Json): void
    {
        const gl = this.gl;

        gl.bindFramebuffer(0x8D40, this.object('framebuffer', framebuffer.id));

        for (const point of Object.keys(framebuffer.attachments ?? {}))
        {
            const attached = framebuffer.attachments[point];

            if (attached.renderbuffer)
            {
                gl.framebufferRenderbuffer(0x8D40, Number(point), 0x8D41, this.object('renderbuffer', attached.renderbuffer));
            }
            else if (attached.layer !== undefined)
            {
                gl.framebufferTextureLayer(0x8D40, Number(point), this.object('texture', attached.texture), attached.level ?? 0, attached.layer);
            }
            else
            {
                gl.framebufferTexture2D(0x8D40, Number(point), attached.face ?? TEXTURE_2D, this.object('texture', attached.texture), attached.level ?? 0);
            }
        }

        if (framebuffer.drawBuffers && this.gl2)
        {
            gl.drawBuffers(framebuffer.drawBuffers);
        }

        if (framebuffer.readBuffer && this.gl2)
        {
            gl.readBuffer(framebuffer.readBuffer);
        }
    }

    // ---- State ----

    applyLayout (layout: Json): void
    {
        const gl = this.gl;
        const instancing = this.gl2 ? null : this.extensions.get('ANGLE_instanced_arrays');

        for (const attrib of layout.attribs ?? [])
        {
            if (attrib.buffer)
            {
                gl.bindBuffer(0x8892, this.object('buffer', attrib.buffer));

                if (attrib.integer && this.gl2)
                {
                    gl.vertexAttribIPointer(attrib.index, attrib.size, attrib.type, attrib.stride, attrib.offset);
                }
                else
                {
                    gl.vertexAttribPointer(attrib.index, attrib.size, attrib.type, attrib.normalized, attrib.stride, attrib.offset);
                }
            }

            if (attrib.enabled)
            {
                gl.enableVertexAttribArray(attrib.index);
            }

            if (attrib.divisor)
            {
                if (this.gl2)
                {
                    gl.vertexAttribDivisor(attrib.index, attrib.divisor);
                }
                else
                {
                    instancing?.vertexAttribDivisorANGLE(attrib.index, attrib.divisor);
                }
            }
        }

        gl.bindBuffer(0x8893, this.object('buffer', layout.element));
    }

    applyInitialState (): void
    {
        const gl = this.gl;
        const state = this.capture.data.initial;
        const caps = [0x0BE2, 0x0B44, 0x0B71, 0x0BD0, 0x8037, 0x809E, 0x80A0, 0x0C11, 0x0B90, 0x8C89];

        for (const vao of state.vertexArrays ?? [])
        {
            const object = this.object('vertex_array', vao.id);

            if (object)
            {
                this.bindVertexArray(object);
                this.applyLayout(vao);
            }
        }

        this.bindVertexArray(null);
        this.applyLayout(state.defaultVertexArray);
        this.bindVertexArray(this.object('vertex_array', state.vertexArray));

        gl.bindBuffer(0x8892, this.object('buffer', state.arrayBuffer));

        for (const target of Object.keys(state.otherBuffers ?? {}))
        {
            if (this.gl2)
            {
                gl.bindBuffer(Number(target), this.object('buffer', state.otherBuffers[target]));
            }
        }

        state.units.forEach((unit: Json, index: number) =>
        {
            gl.activeTexture(0x84C0 + index);
            gl.bindTexture(TEXTURE_2D, this.object('texture', unit.t2d));
            gl.bindTexture(TEXTURE_CUBE_MAP, this.object('texture', unit.cube));

            if (this.gl2)
            {
                gl.bindTexture(TEXTURE_3D, this.object('texture', unit.t3d));
                gl.bindTexture(TEXTURE_2D_ARRAY, this.object('texture', unit.array));
                gl.bindSampler(index, this.object('sampler', unit.sampler));
            }
        });

        gl.activeTexture(0x84C0 + state.unit);

        caps.forEach((cap, index) =>
        {
            if (cap === 0x8C89 && !this.gl2)
            {
                return;
            }

            if (state.caps[index])
            {
                gl.enable(cap);
            }
            else
            {
                gl.disable(cap);
            }
        });

        gl.viewport(...(state.viewport as [number, number, number, number]));
        gl.scissor(...(state.scissor as [number, number, number, number]));
        gl.clearColor(...(state.clearColor as [number, number, number, number]));
        gl.clearDepth(state.clearDepth);
        gl.clearStencil(state.clearStencil);
        gl.colorMask(...(state.colorMask as [boolean, boolean, boolean, boolean]));
        gl.depthMask(state.depthMask);
        gl.depthFunc(state.depthFunc);
        gl.depthRange(state.depthRange[0], state.depthRange[1]);
        gl.blendColor(...(state.blendColor as [number, number, number, number]));
        gl.blendEquationSeparate(state.blendEquationRgb, state.blendEquationAlpha);
        gl.blendFuncSeparate(state.blendSrcRgb, state.blendDstRgb, state.blendSrcAlpha, state.blendDstAlpha);
        gl.cullFace(state.cullFace);
        gl.frontFace(state.frontFace);
        gl.lineWidth(state.lineWidth);
        gl.polygonOffset(state.polygonOffset[0], state.polygonOffset[1]);
        gl.sampleCoverage(state.sampleCoverage[0], state.sampleCoverage[1]);

        for (const [face, side] of [[0x0404, state.stencilFront], [0x0405, state.stencilBack]] as Array<[number, Json]>)
        {
            gl.stencilFuncSeparate(face, side.func, side.ref, side.mask);
            gl.stencilMaskSeparate(face, side.writeMask);
            gl.stencilOpSeparate(face, side.fail, side.zfail, side.zpass);
        }

        // The page's pack and unpack settings, which its own uploads in the frame rely on.
        gl.pixelStorei(0x0CF5, 4);

        for (const pname of Object.keys(state.pixelStore ?? {}))
        {
            gl.pixelStorei(Number(pname), state.pixelStore[pname]);
        }

        gl.bindRenderbuffer(0x8D41, this.object('renderbuffer', state.renderbuffer));

        if (this.gl2)
        {
            gl.bindFramebuffer(0x8CA9, null);
            gl.drawBuffers(state.drawBuffers);
            gl.readBuffer(state.readBuffer);
            gl.bindFramebuffer(0x8CA9, this.object('framebuffer', state.drawFramebuffer));
            gl.bindFramebuffer(0x8CA8, this.object('framebuffer', state.readFramebuffer));
        }
        else
        {
            gl.bindFramebuffer(0x8D40, this.object('framebuffer', state.drawFramebuffer));
        }

        this.drawFramebuffer = this.object('framebuffer', state.drawFramebuffer);
        this.readFramebuffer = this.object('framebuffer', state.readFramebuffer);
        this.packBuffer = this.object('buffer', (state.otherBuffers ?? {})[0x88EB] ?? null);

        gl.useProgram(this.object('program', state.program));
    }

    // ---- Commands ----

    execute (command: Json): void
    {
        const [method, encoded, made] = command;

        // The capture's own table of method names, if it has one.
        const qualified = (this.capture.data.methods ?? METHOD_NAMES)[method];
        const dot = qualified.indexOf('.');
        const owner = qualified.slice(0, dot);
        const name = qualified.slice(dot + 1);

        if (name === 'getUniformLocation')
        {
            return;
        }

        const receiver = owner === 'gl' ? this.gl : this.extension(owner);

        if (!receiver || typeof receiver[name] !== 'function')
        {
            this.note(`The replay has no ${qualified}: the extension it belongs to is not available.`);

            return;
        }

        const args = encoded.map((value: Json) => this.decode(value));
        const result = receiver[name](...args);

        if (made && 'o' in made)
        {
            this.objects.set(`${made.o}:${made.i}`, result);
        }

        // Keep track of what a readback will have to put back.
        if (name === 'bindFramebuffer')
        {
            if (args[0] === 0x8D40 || args[0] === 0x8CA9)
            {
                this.drawFramebuffer = args[1];
            }

            if (args[0] === 0x8D40 || args[0] === 0x8CA8)
            {
                this.readFramebuffer = args[1];
            }
        }
        else if (name === 'bindBuffer' && args[0] === 0x88EB)
        {
            this.packBuffer = args[1];
        }
        else if (name === 'deleteFramebuffer')
        {
            if (this.drawFramebuffer === args[0]) { this.drawFramebuffer = null; }
            if (this.readFramebuffer === args[0]) { this.readFramebuffer = null; }
        }
    }

    extension (name: string): any
    {
        if (!this.extensions.has(name))
        {
            this.extensions.set(name, this.gl.getExtension(name));
        }

        return this.extensions.get(name);
    }

    // Runs the capture from its start up to, but not including, command `end`.
    play (end: number, each?: (index: number) => void, before?: (index: number) => void): void
    {
        this.createObjects();
        this.applyInitialState();

        const commands = this.capture.data.commands;
        const stop = Math.min(end, commands.length);

        // A recording of several frames: where each ends.
        const ends = new Set<number>((this.capture.data.header.frames ?? []).map((mark: Json) => mark.command));

        for (let i = 0; i < stop; i++)
        {
            if (i > 0 && ends.has(i))
            {
                this.endOfFrame();
            }

            before?.(i);
            this.execute(commands[i]);
            each?.(i);
        }
    }

    // Between two frames of a recording the browser presents the canvas and, unless the
    // page asked to keep its drawing buffer, clears it. The replay keeps its own buffer so
    // that it can be read, so it clears by hand, and puts back the state that takes.
    endOfFrame (): void
    {
        if (this.capture.data.header.attributes?.preserveDrawingBuffer)
        {
            return;
        }

        const gl = this.gl;
        const scissor = gl.isEnabled(0x0C11);
        const colour = gl.getParameter(0x0C22);
        const depth = gl.getParameter(0x0B73);
        const stencil = gl.getParameter(0x0B91);
        const mask = gl.getParameter(0x0C23);
        const depthMask = gl.getParameter(0x0B72);
        const stencilMask = gl.getParameter(0x0B98);
        const stencilBackMask = gl.getParameter(0x8CA5);
        const point = this.gl2 ? 0x8CA9 : 0x8D40;

        gl.bindFramebuffer(point, null);
        gl.disable(0x0C11);
        gl.colorMask(true, true, true, true);
        gl.depthMask(true);
        gl.stencilMask(0xFFFFFFFF);
        gl.clearColor(0, 0, 0, 0);
        gl.clearDepth(1);
        gl.clearStencil(0);
        gl.clear(0x4000 | 0x100 | 0x400);

        gl.clearColor(colour[0], colour[1], colour[2], colour[3]);
        gl.clearDepth(depth);
        gl.clearStencil(stencil);
        gl.colorMask(mask[0], mask[1], mask[2], mask[3]);
        gl.depthMask(depthMask);
        gl.stencilMaskSeparate(0x0404, stencilMask);
        gl.stencilMaskSeparate(0x0405, stencilBackMask);

        if (scissor)
        {
            gl.enable(0x0C11);
        }

        gl.bindFramebuffer(point, this.drawFramebuffer);
    }

    // A target exactly as read, bottom row first, for comparing with another read of it.
    raw (target: Json): { width: number; height: number; data: Uint8Array | Float32Array }
    {
        const { framebuffer, width, height, float, scratch } = this.targetFramebuffer(target);
        const data = this.read(framebuffer, 0, 0, width, height, float);

        if (scratch)
        {
            this.gl.deleteFramebuffer(scratch);
        }

        return { width, height, data };
    }

    // ---- Reading back ----

    // Reads pixels of a framebuffer into client memory and puts back what that disturbed.
    // `y` counts from the bottom, as WebGL does.
    read (framebuffer: any, x: number, y: number, width: number, height: number, float: boolean): Uint8Array | Float32Array
    {
        const gl = this.gl;
        const out = float ? new Float32Array(width * height * 4) : new Uint8Array(width * height * 4);
        const resolve = this.resolves.get(framebuffer);

        if (resolve)
        {
            // A multisampled target, resolved as it stands now. A blit is clipped by the
            // scissor box, so that is switched off round it.
            const scissor = gl.isEnabled(0x0C11);

            gl.disable(0x0C11);
            gl.bindFramebuffer(0x8CA8, resolve.from);
            gl.bindFramebuffer(0x8CA9, framebuffer);
            gl.blitFramebuffer(0, 0, resolve.width, resolve.height, 0, 0, resolve.width, resolve.height, 0x4000, 0x2600);
            gl.bindFramebuffer(0x8CA9, this.drawFramebuffer);

            if (scissor)
            {
                gl.enable(0x0C11);
            }
        }

        if (this.gl2)
        {
            gl.bindFramebuffer(0x8CA8, framebuffer);
            gl.bindBuffer(0x88EB, null);
        }
        else
        {
            gl.bindFramebuffer(0x8D40, framebuffer);
        }

        // The page's pack settings would bend the result; they are saved, zeroed and put back.
        const names = this.gl2 ? [0x0D05, 0x0D02, 0x0D03, 0x0D04] : [0x0D05];
        const saved = names.map((pname) => gl.getParameter(pname));

        gl.pixelStorei(0x0D05, 1);

        for (const pname of names.slice(1))
        {
            gl.pixelStorei(pname, 0);
        }

        gl.readPixels(x, y, width, height, 0x1908, float ? 0x1406 : 0x1401, out);

        names.forEach((pname, index) => gl.pixelStorei(pname, saved[index]));

        if (this.gl2)
        {
            gl.bindFramebuffer(0x8CA8, this.readFramebuffer);
            gl.bindBuffer(0x88EB, this.packBuffer);
        }
        else
        {
            gl.bindFramebuffer(0x8D40, this.drawFramebuffer);
        }

        return out;
    }

    // The framebuffer to read for a target: the canvas, or one holding the given texture level.
    targetFramebuffer (target: Json): { framebuffer: any; width: number; height: number; float: boolean; scratch: any }
    {
        const gl = this.gl;
        const header = this.capture.data.header;

        if (target?.framebuffer && !target.texture)
        {
            return this.renderbufferTarget(target.framebuffer);
        }

        if (!target || !target.texture)
        {
            return { framebuffer: null, width: header.width, height: header.height, float: false, scratch: null };
        }

        const texture = this.capture.data.objects.find((object) => object.kind === 'texture' && object.id === target.texture);
        const object = this.object('texture', target.texture);

        if (!texture || !object)
        {
            throw new Error(`Texture ${target.texture} is not part of this capture.`);
        }

        const level = target.level ?? 0;
        const scratch = gl.createFramebuffer();
        const point = this.gl2 ? 0x8CA8 : 0x8D40;

        gl.bindFramebuffer(point, scratch);
        gl.framebufferTexture2D(point, 0x8CE0, texture.target === TEXTURE_CUBE_MAP ? 0x8515 + (target.layer ?? 0) : TEXTURE_2D, object, level);

        const complete = gl.checkFramebufferStatus(point) === 0x8CD5;

        gl.bindFramebuffer(point, this.gl2 ? this.readFramebuffer : this.drawFramebuffer);

        if (!complete)
        {
            gl.deleteFramebuffer(scratch);

            throw new Error(`The ${texture.format} texture cannot be read back as a colour target.`);
        }

        const float = [0x881A, 0x8814, 0x881B, 0x8815, 0x822D, 0x822E, 0x822F, 0x8230, 0x8C3A].includes(texture.internalFormat) || texture.type === 0x1406;

        return { framebuffer: scratch, width: Math.max(1, texture.width >> level), height: Math.max(1, texture.height >> level), float, scratch };
    }

    // The framebuffer to read for one of the page's framebuffers whose colour is a
    // renderbuffer. A multisampled one cannot be read: it is resolved into a scratch
    // framebuffer of the same format first, each time it is read.
    renderbufferTarget (id: number): { framebuffer: any; width: number; height: number; float: boolean; scratch: any }
    {
        const gl = this.gl;
        const renderbuffer = colourRenderbuffer(this.capture.data, id);
        const object = this.object('framebuffer', id);

        if (!renderbuffer || !object)
        {
            throw new Error('That framebuffer has no colour to read: it is depth only, or its attachment is not part of this capture.');
        }

        const float = [0x881A, 0x8814, 0x881B, 0x8815, 0x822D, 0x822E, 0x822F, 0x8230, 0x8C3A].includes(renderbuffer.internalFormat);
        const size = { width: renderbuffer.width, height: renderbuffer.height };

        if (!renderbuffer.samples || !this.gl2)
        {
            return { framebuffer: object, ...size, float, scratch: null };
        }

        const bound = gl.getParameter(0x8CA7);
        const single = gl.createRenderbuffer();
        const scratch = gl.createFramebuffer();

        gl.bindRenderbuffer(0x8D41, single);
        gl.renderbufferStorage(0x8D41, renderbuffer.internalFormat, size.width, size.height);
        gl.bindRenderbuffer(0x8D41, bound);
        gl.bindFramebuffer(0x8CA8, scratch);
        gl.framebufferRenderbuffer(0x8CA8, 0x8CE0, 0x8D41, single);
        gl.bindFramebuffer(0x8CA8, this.readFramebuffer);

        this.resolves.set(scratch, { from: object, ...size });

        return { framebuffer: scratch, ...size, float, scratch };
    }

    // A target as RGBA8 rows, top to bottom.
    image (target: Json): { width: number; height: number; data: Uint8Array; float: boolean }
    {
        const { framebuffer, width, height, float, scratch } = this.targetFramebuffer(target);
        const raw = this.read(framebuffer, 0, 0, width, height, float);
        const data = new Uint8Array(width * height * 4);
        const stride = width * 4;

        for (let y = 0; y < height; y++)
        {
            const row = raw.subarray((height - 1 - y) * stride, (height - y) * stride);

            if (float)
            {
                for (let i = 0; i < stride; i++)
                {
                    const value = row[i] * 255;

                    data[y * stride + i] = value > 255 ? 255 : (value > 0 ? value : 0);
                }
            }
            else
            {
                data.set(row as Uint8Array, y * stride);
            }
        }

        if (scratch)
        {
            this.gl.deleteFramebuffer(scratch);
        }

        return { width, height, data, float };
    }

    dispose (): void
    {
        // Browsers allow only a handful of live contexts. Give this one back at once.
        this.gl.getExtension('WEBGL_lose_context')?.loseContext();
        this.canvas.width = 1;
        this.canvas.height = 1;
    }
}

function isGpu (item: Loaded): boolean
{
    return item.data.header.api === 'webgpu';
}

function methodsOf (item: Loaded): string[]
{
    return (item.data.methods ?? METHOD_NAMES) as string[];
}

function capture (key: string): Loaded
{
    const found = loaded.get(key);

    if (!found)
    {
        throw new Error(`Capture ${key} is not loaded in the replay page.`);
    }

    return found;
}

// The command index just past an event (a draw, clear or blit), or the whole frame.
function endOf (data: CaptureData, draw: number | null | undefined): number
{
    if (draw === null || draw === undefined)
    {
        return data.commands.length;
    }

    const row = data.draws[draw];

    if (!row)
    {
        throw new Error(`The capture has ${data.draws.length} draws, numbered from 0; there is no draw ${draw}.`);
    }

    return row.command + 1;
}

// What an event drew to, as something to read: a level of a texture, a framebuffer whose
// colour is a renderbuffer (or that has none), or null for the canvas.
function targetOfRow (row: Json): Json
{
    if (row.target)
    {
        return { texture: row.target, level: row.targetLevel || 0 };
    }

    return row.framebuffer ? { framebuffer: row.framebuffer } : null;
}

function keyOfTarget (target: Json): string
{
    if (target?.texture)
    {
        return `${target.texture}:${target.level || 0}`;
    }

    return target?.framebuffer ? `fbo:${target.framebuffer}` : 'canvas';
}

// The renderbuffer that holds a framebuffer's colour, if one does.
function colourRenderbuffer (data: CaptureData, framebuffer: number): Json | null
{
    const record = data.objects.find((object) => object.kind === 'framebuffer' && object.id === framebuffer);
    const attached = record?.attachments?.[0x8CE0];

    return attached?.renderbuffer ? data.objects.find((object) => object.kind === 'renderbuffer' && object.id === attached.renderbuffer) ?? null : null;
}

function sizeOfTarget (data: CaptureData, target: Json): [number, number]
{
    if (target?.texture)
    {
        const texture = data.objects.find((object) => object.kind === 'texture' && object.id === target.texture);
        const level = target.level || 0;

        if (texture)
        {
            return [Math.max(1, texture.width >> level), Math.max(1, texture.height >> level)];
        }
    }

    const renderbuffer = target?.framebuffer ? colourRenderbuffer(data, target.framebuffer) : null;

    return renderbuffer ? [renderbuffer.width, renderbuffer.height] : [data.header.width, data.header.height];
}

function sameTarget (row: Json, target: Json): boolean
{
    return keyOfTarget(targetOfRow(row)) === keyOfTarget(target);
}

async function packed (image: { width: number; height: number; data: Uint8Array }): Promise<Json>
{
    return { width: image.width, height: image.height, encoding: 'rgba8+gzip+base64', data: toBase64(await gzip(image.data)) };
}

// A program with another's vertex shader and a fragment shader that keeps every fragment
// and writes nothing that matters. Attributes sit where the original's do. Null when it
// cannot be made: the vertex shader's source is gone, or the pair will not link.
function shapeProgram (gl: any, original: any, feedback?: string[]): { program: any; uniforms: Array<{ name: string; type: number; size: number }>; blocks: string[] } | null
{
    try
    {
        const vertex = (gl.getAttachedShaders(original) ?? []).find((shader: any) => gl.getShaderParameter(shader, 0x8B4F) === 0x8B31);
        const source: string | null = vertex ? gl.getShaderSource(vertex) : null;

        if (!source)
        {
            return null;
        }

        const modern = /^\s*#version\s+300\s+es/.test(source);
        const fragment = gl.createShader(0x8B30);

        gl.shaderSource(fragment, modern
            ? '#version 300 es\nprecision highp float;\nuniform vec4 scanlineColour;\nout vec4 scanlineShape;\nvoid main () { scanlineShape = scanlineColour; }'
            : 'precision mediump float;\nuniform vec4 scanlineColour;\nvoid main () { gl_FragColor = scanlineColour; }');
        gl.compileShader(fragment);

        const again = gl.createShader(0x8B31);

        gl.shaderSource(again, source);
        gl.compileShader(again);

        const program = gl.createProgram();

        gl.attachShader(program, again);
        gl.attachShader(program, fragment);

        for (let i = 0; i < gl.getProgramParameter(original, 0x8B89); i++)
        {
            const name = gl.getActiveAttrib(original, i)?.name;
            const location = name ? gl.getAttribLocation(original, name) : -1;

            if (location >= 0)
            {
                gl.bindAttribLocation(program, location, name);
            }
        }

        if (feedback)
        {
            // Outputs of the vertex shader to be written to a buffer as it runs.
            gl.transformFeedbackVaryings(program, feedback, 0x8C8C);
        }

        gl.linkProgram(program);
        gl.deleteShader(again);
        gl.deleteShader(fragment);

        if (!gl.getProgramParameter(program, 0x8B82))
        {
            gl.deleteProgram(program);

            return null;
        }

        const uniforms: Array<{ name: string; type: number; size: number }> = [];

        for (let i = 0; i < gl.getProgramParameter(program, 0x8B86); i++)
        {
            const active = gl.getActiveUniform(program, i);

            // The colour is the caller's to set, not the page's.
            if (active && active.name !== 'scanlineColour')
            {
                uniforms.push({ name: active.name, type: active.type, size: active.size });
            }
        }

        const blocks: string[] = [];

        if (typeof gl.getActiveUniformBlockName === 'function')
        {
            for (let i = 0; i < gl.getProgramParameter(program, 0x8A36); i++)
            {
                blocks.push(gl.getActiveUniformBlockName(program, i));
            }
        }

        return { program, uniforms, blocks };
    }
    catch
    {
        return null;
    }
}

// Gives the shape program the values the original's uniforms hold now.
function syncUniforms (gl: any, original: any, shape: NonNullable<ReturnType<typeof shapeProgram>>): void
{
    const current = gl.getParameter(0x8B8D);

    gl.useProgram(shape.program);

    const set = (location: any, type: number, value: any): void =>
    {
        const list = typeof value === 'number' || typeof value === 'boolean' ? [Number(value)] : Array.from(value as ArrayLike<number | boolean>, Number);

        switch (type)
        {
            case 0x1406: gl.uniform1fv(location, list); break;
            case 0x8B50: gl.uniform2fv(location, list); break;
            case 0x8B51: gl.uniform3fv(location, list); break;
            case 0x8B52: gl.uniform4fv(location, list); break;
            case 0x8B5A: gl.uniformMatrix2fv(location, false, list); break;
            case 0x8B5B: gl.uniformMatrix3fv(location, false, list); break;
            case 0x8B5C: gl.uniformMatrix4fv(location, false, list); break;
            case 0x8B65: gl.uniformMatrix2x3fv(location, false, list); break;
            case 0x8B66: gl.uniformMatrix2x4fv(location, false, list); break;
            case 0x8B67: gl.uniformMatrix3x2fv(location, false, list); break;
            case 0x8B68: gl.uniformMatrix3x4fv(location, false, list); break;
            case 0x8B69: gl.uniformMatrix4x2fv(location, false, list); break;
            case 0x8B6A: gl.uniformMatrix4x3fv(location, false, list); break;
            case 0x1405: gl.uniform1uiv(location, list); break;
            case 0x8DC6: gl.uniform2uiv(location, list); break;
            case 0x8DC7: gl.uniform3uiv(location, list); break;
            case 0x8DC8: gl.uniform4uiv(location, list); break;
            case 0x8B53: case 0x8B57: gl.uniform2iv(location, list); break;
            case 0x8B54: case 0x8B58: gl.uniform3iv(location, list); break;
            case 0x8B55: case 0x8B59: gl.uniform4iv(location, list); break;
            // Integers, booleans and every kind of sampler.
            default: gl.uniform1iv(location, list); break;
        }
    };

    for (const uniform of shape.uniforms)
    {
        const base = uniform.name.replace(/\[0\]$/, '');

        for (let element = 0; element < uniform.size; element++)
        {
            const name = uniform.size > 1 || uniform.name.endsWith('[0]') ? `${base}[${element}]` : base;
            const from = gl.getUniformLocation(original, name);
            const to = gl.getUniformLocation(shape.program, name);

            if (from !== null && to !== null)
            {
                set(to, uniform.type, gl.getUniform(original, from));
            }
        }
    }

    for (let index = 0; index < shape.blocks.length; index++)
    {
        const there = gl.getUniformBlockIndex(original, shape.blocks[index]);

        if (there !== 0xFFFFFFFF)
        {
            gl.uniformBlockBinding(shape.program, index, gl.getActiveUniformBlockParameter(original, there, 0x8A3F));
        }
    }

    gl.useProgram(current);
}

const api = {

    // Receives a capture's description. Blobs follow with `blobs`.
    async load (args: { key: string; body: string }): Promise<Json>
    {
        const data: CaptureData = JSON.parse(new TextDecoder().decode(await gunzip(fromBase64(args.body))));

        loaded.set(args.key, { data, blobs: new Array(data.blobs.length).fill(null) });

        return { commands: data.commands.length, draws: data.draws.length, blobs: data.blobs.length };
    },

    async blobs (args: { key: string; from: number; blobs: string[] }): Promise<Json>
    {
        const target = capture(args.key);

        for (let i = 0; i < args.blobs.length; i++)
        {
            target.blobs[args.from + i] = await gunzip(fromBase64(args.blobs[i]));
        }

        return { have: target.blobs.filter(Boolean).length, of: target.blobs.length };
    },

    has (args: { key: string }): boolean
    {
        const found = loaded.get(args.key);

        return Boolean(found && found.blobs.every(Boolean));
    },

    unload (args: { key: string }): void
    {
        loaded.delete(args.key);
    },

    // The picture of a target after an event (or after the whole frame).
    async image (args: { key: string; draw?: number | null; target?: Json }): Promise<Json>
    {
        const item = capture(args.key);

        if (isGpu(item))
        {
            const image = await gpuApi.image(item, methodsOf(item), args);

            return { ...image, ...(await packed(image)) };
        }

        const run = new Run(item);
        const started = performance.now();

        try
        {
            run.play(endOf(item.data, args.draw));

            // By default, the target the event itself drew to.
            const row = args.draw === null || args.draw === undefined ? null : item.data.draws[args.draw];
            const target = args.target ?? (row ? targetOfRow(row) : null);
            const image = run.image(target);

            return { ...(await packed(image)), target, float: image.float, error: run.gl.getError(), notes: run.notes, ms: performance.now() - started };
        }
        finally
        {
            run.dispose();
        }
    },

    // Which calls raised a GL error, found by asking after every one. Slow (a round trip to
    // the GPU process per call), so only run for a frame known to have raised one.
    errors (args: { key: string }): Json
    {
        const item = capture(args.key);

        if (isGpu(item))
        {
            return gpuApi.errors(item, methodsOf(item));
        }

        const run = new Run(item);
        const found: Json[] = [];

        try
        {
            // Whatever recreating the objects raised is not the frame's doing.
            run.createObjects();
            run.applyInitialState();
            run.gl.getError();

            const commands = item.data.commands;

            for (let i = 0; i < commands.length && found.length < 200; i++)
            {
                run.execute(commands[i]);

                const error: number = run.gl.getError();

                if (error !== 0)
                {
                    found.push({ command: i, error });
                }
            }

            return { errors: found };
        }
        finally
        {
            run.dispose();
        }
    },

    // What each event did to its own target: how many pixels it changed, and the box they
    // fall in (top-left origin). One pass over the frame, reading the target back around
    // every event, so it is refused for a frame too big to do that in reasonable time.
    effects (args: { key: string; budget?: number }): Json
    {
        const item = capture(args.key);

        if (isGpu(item))
        {
            return gpuApi.effects(item, methodsOf(item), args);
        }

        const data = item.data;
        const started = performance.now();
        const budget = args.budget ?? 600e6;

        // An upper bound on the pixels to read: every event's target, once.
        let cost = 0;

        for (const row of data.draws)
        {
            const [width, height] = sizeOfTarget(data, targetOfRow(row));

            cost += width * height;
        }

        if (cost > budget)
        {
            return { skipped: true, cost, budget };
        }

        const run = new Run(item);

        try
        {
            const byCommand = new Map<number, number>();

            data.draws.forEach((row, index) => byCommand.set(row.command, index));

            const targetOf = targetOfRow;
            const keyOf = (row: Json): string => keyOfTarget(targetOfRow(row));
            const methods = data.methods ?? METHOD_NAMES;

            // The last read of each target stays good until something other than an event
            // could have written to a texture: an upload, a copy, a mipmap build.
            const held = new Map<string, { width: number; height: number; data: Uint8Array | Float32Array }>();
            const effects: Json[] = [];
            let before: { width: number; height: number; data: Uint8Array | Float32Array } | null = null;

            run.play(data.commands.length, (index) =>
            {
                const draw = byCommand.get(index);

                if (draw === undefined)
                {
                    return;
                }

                const row = data.draws[draw];
                let after;

                try
                {
                    after = run.raw(targetOf(row));
                }
                catch
                {
                    effects.push({ draw, unreadable: true });

                    return;
                }

                held.set(keyOf(row), after);

                if (!before || before.width !== after.width || before.height !== after.height)
                {
                    effects.push({ draw, first: true });

                    return;
                }

                const a = before.data;
                const b = after.data;
                const { width, height } = after;
                let changed = 0;
                let left = width;
                let right = -1;
                let bottom = height;
                let top = -1;

                for (let y = 0; y < height; y++)
                {
                    const offset = y * width * 4;

                    for (let x = 0; x < width; x++)
                    {
                        const i = offset + x * 4;

                        if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3])
                        {
                            changed++;

                            if (x < left) { left = x; }
                            if (x > right) { right = x; }
                            if (y < bottom) { bottom = y; }
                            if (y > top) { top = y; }
                        }
                    }
                }

                // Rows were read bottom first; the box is given from the top.
                effects.push(changed === 0 ? { draw, changed } : { draw, changed, x: left, y: height - 1 - top, w: right - left + 1, h: top - bottom + 1 });
            },
            (index) =>
            {
                const draw = byCommand.get(index);

                if (draw === undefined)
                {
                    if (/\.(tex|copyTex|compressedTex|generateMipmap|framebuffer|deleteTexture|renderbufferStorage)/.test(methods[data.commands[index][0]]))
                    {
                        held.clear();
                    }

                    return;
                }

                const row = data.draws[draw];

                before = held.get(keyOf(row)) ?? null;

                if (!before)
                {
                    // Reading sets no state the event depends on, but the target's framebuffer
                    // may not be complete yet, or the texture may have no storage.
                    try
                    {
                        before = run.raw(targetOf(row));
                    }
                    catch
                    {
                        before = null;
                    }
                }
            });

            return { effects, cost, ms: performance.now() - started };
        }
        finally
        {
            run.dispose();
        }
    },

    // Why a draw changed nothing: the draw run again with one test switched off at a time,
    // counting the pixels it then changes. Each try is the frame replayed up to the draw.
    why (args: { key: string; draw: number }): Json
    {
        const item = capture(args.key);

        if (isGpu(item))
        {
            // A WebGPU draw's tests are part of its pipeline: trying it without one means
            // making the pipeline again without it, which is not built.
            return { unsupported: true };
        }

        const row = item.data.draws[args.draw];

        if (!row)
        {
            throw new Error(`The capture has ${item.data.draws.length} events, numbered from 0; there is no draw ${args.draw}.`);
        }

        const target = targetOfRow(row);
        const started = performance.now();

        const attempt = (change: ((gl: any, width: number, height: number) => void) | null): number =>
        {
            const run = new Run(item);

            try
            {
                run.play(row.command);

                const before = run.raw(target);

                change?.(run.gl, before.width, before.height);
                run.execute(item.data.commands[row.command]);

                const after = run.raw(target).data;
                let changed = 0;

                for (let i = 0; i < after.length; i += 4)
                {
                    if (after[i] !== before.data[i] || after[i + 1] !== before.data[i + 1] || after[i + 2] !== before.data[i + 2] || after[i + 3] !== before.data[i + 3])
                    {
                        changed++;
                    }
                }

                return changed;
            }
            finally
            {
                run.dispose();
            }
        };

        const enabled: number[] = row.enabled ?? [];
        const mask: boolean[] = row.colorMask ?? [true, true, true, true];

        // Only what is switched on for this draw can have rejected it.
        const tests: { what: string; change: (gl: any, width: number, height: number) => void }[] = [];

        if (enabled.includes(0x0B44)) { tests.push({ what: 'cull', change: (gl) => gl.disable(0x0B44) }); }
        if (enabled.includes(0x0B71)) { tests.push({ what: 'depth', change: (gl) => gl.disable(0x0B71) }); }
        if (enabled.includes(0x0C11)) { tests.push({ what: 'scissor', change: (gl) => gl.disable(0x0C11) }); }
        if (enabled.includes(0x0B90)) { tests.push({ what: 'stencil', change: (gl) => gl.disable(0x0B90) }); }
        if (enabled.includes(0x0BE2)) { tests.push({ what: 'blend', change: (gl) => gl.disable(0x0BE2) }); }
        if (enabled.includes(0x8C89)) { tests.push({ what: 'rasterizer_discard', change: (gl) => gl.disable(0x8C89) }); }
        if (mask.some((channel) => !channel)) { tests.push({ what: 'color_mask', change: (gl) => gl.colorMask(true, true, true, true) }); }

        const size = sizeOfTarget(item.data, targetOfRow(row));
        const viewport: number[] = row.viewport ?? [0, 0, size[0], size[1]];

        if (viewport[0] !== 0 || viewport[1] !== 0 || viewport[2] !== size[0] || viewport[3] !== size[1])
        {
            tests.push({ what: 'viewport', change: (gl, width, height) => gl.viewport(0, 0, width, height) });
        }

        const unchanged = attempt(null);
        const tried = tests.map((test) => ({ what: test.what, changed: attempt(test.change) }));

        // Two tests can each be enough to reject a draw; then no single one shows it.
        const together = tried.every((entry) => entry.changed === 0) && tests.length > 1
            ? attempt((gl, width, height) => tests.forEach((test) => test.change(gl, width, height)))
            : null;

        return { unchanged, tried, together, ms: performance.now() - started };
    },

    // Overdraw of the canvas: how many times each pixel was drawn to. The stencil buffer
    // does the counting: every draw is made to add one to it wherever a fragment lands
    // (`all`), or only where the fragment also passes the depth test (`visible`). The
    // counts are then drawn out, one level at a time, as a picture that can be read back.
    async overdraw (args: { key: string; visible?: boolean }): Promise<Json>
    {
        const item = capture(args.key);

        if (isGpu(item))
        {
            return { unsupported: 'webgpu' };
        }

        if (item.data.draws.some((row) => row.kind === 'draw' && !row.target && row.stencil))
        {
            return { unsupported: 'stencil' };
        }

        const run = new Run(item, { stencil: true });
        const gl = run.gl;
        const started = performance.now();

        try
        {
            if (!gl.getContextAttributes().stencil)
            {
                return { unsupported: 'no-stencil' };
            }

            const byCommand = new Map<number, number>();

            item.data.draws.forEach((row, index) => byCommand.set(row.command, index));

            const counted = (index: number): boolean =>
            {
                const draw = byCommand.get(index);

                return draw !== undefined && item.data.draws[draw].kind === 'draw' && !item.data.draws[draw].target;
            };

            run.play(item.data.commands.length, (index) =>
            {
                if (counted(index))
                {
                    gl.disable(0x0B90);
                }
            },
            (index) =>
            {
                if (counted(index))
                {
                    // Count whatever lands, or only what the depth test lets through.
                    gl.enable(0x0B90);
                    gl.stencilFunc(0x0207, 0, 0xFF);
                    gl.stencilOp(0x1E00, args.visible ? 0x1E00 : 0x1E02, 0x1E02);
                    gl.stencilMask(0xFF);
                }
            });

            // Draw the counts out: a full-canvas quad for each level, where the stencil equals it.
            const { width, height } = item.data.header;
            const program = gl.createProgram();

            for (const [type, source] of [
                [0x8B31, 'attribute vec2 corner; void main () { gl_Position = vec4(corner, 0.0, 1.0); }'],
                [0x8B30, 'precision mediump float; uniform float level; void main () { gl_FragColor = vec4(level, 0.0, 0.0, 1.0); }']
            ] as Array<[number, string]>)
            {
                const shader = gl.createShader(type);

                gl.shaderSource(shader, source);
                gl.compileShader(shader);
                gl.attachShader(program, shader);
            }

            gl.bindAttribLocation(program, 0, 'corner');
            gl.linkProgram(program);

            if (run.gl2)
            {
                gl.bindVertexArray(null);
                gl.bindFramebuffer(0x8CA9, null);
            }
            else
            {
                gl.bindFramebuffer(0x8D40, null);
            }

            const quad = gl.createBuffer();

            gl.bindBuffer(0x8892, quad);
            gl.bufferData(0x8892, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), 0x88E4);
            gl.enableVertexAttribArray(0);
            gl.vertexAttribPointer(0, 2, 0x1406, false, 0, 0);

            if (run.gl2)
            {
                gl.vertexAttribDivisor(0, 0);
            }

            for (const cap of [0x0B71, 0x0B44, 0x0BE2, 0x0C11, 0x8037, 0x809E, 0x80A0])
            {
                gl.disable(cap);
            }

            gl.useProgram(program);
            gl.viewport(0, 0, width, height);
            gl.colorMask(true, true, true, true);
            gl.clearColor(0, 0, 0, 1);
            gl.clear(0x4000);
            gl.enable(0x0B90);
            gl.stencilMask(0);
            gl.stencilOp(0x1E00, 0x1E00, 0x1E00);

            const level = gl.getUniformLocation(program, 'level');
            const top = 64;

            for (let count = 1; count <= top; count++)
            {
                // The last level stands for itself and everything above it. The test compares
                // the level with what is stored, in that order: "level <= stored".
                gl.stencilFunc(count === top ? 0x0203 : 0x0202, count, 0xFF);
                gl.uniform1f(level, count / 255);
                gl.drawArrays(0x0005, 0, 4);
            }

            const pixels = run.image(null).data;
            const counts = new Uint8Array(width * height);

            for (let i = 0; i < counts.length; i++)
            {
                counts[i] = pixels[i * 4];
            }

            return { width, height, counts: toBase64(await gzip(counts)), top, notes: run.notes, ms: performance.now() - started };
        }
        finally
        {
            run.dispose();
        }
    },

    // GPU time of each draw. One draw is over too quickly to time, so each is issued
    // `times` times inside one timer query before the frame moves on, and the total divided.
    // The repeats draw for real, so the picture this replay leaves is not the frame's.
    async profile (args: { key: string; times?: number }): Promise<Json>
    {
        const item = capture(args.key);

        if (isGpu(item))
        {
            return { unsupported: 'webgpu' };
        }

        const run = new Run(item);
        const gl = run.gl;
        const times = Math.max(1, Math.min(args.times ?? 16, 256));
        const started = performance.now();

        try
        {
            const timer = run.gl2 ? gl.getExtension('EXT_disjoint_timer_query_webgl2') : null;

            if (!timer)
            {
                return { unsupported: 'no-timer' };
            }

            const byCommand = new Map<number, number>();

            item.data.draws.forEach((row, index) => byCommand.set(row.command, index));

            const queries: Array<{ draw: number; query: any }> = [];

            // Whatever the GPU still has to do is finished before a timer starts and before the
            // next draw is issued. A timer covers everything the GPU did while it ran, so a slow
            // draw still being shaded would be charged again to each draw queued behind it.
            // finish() does not wait in this browser. Reading a pixel back from the target that
            // was drawn to does; reading from anywhere else does not.
            const one: Record<number, ArrayBufferView> = {
                0x1401: new Uint8Array(4),
                0x1406: new Float32Array(4),
                0x140B: new Uint16Array(4),
                0x1404: new Int32Array(4),
                0x1405: new Uint32Array(4),
                0x8368: new Uint32Array(1)
            };

            const settle = (): void =>
            {
                const read = gl.getParameter(0x8CAA);
                const pack = gl.getParameter(0x88ED);

                if (pack)
                {
                    gl.bindBuffer(0x88EB, null);
                }

                gl.bindFramebuffer(0x8CA8, gl.getParameter(0x8CA6));

                // A target with no colour to read (depth only, or multisampled) raises an error
                // here and is not waited for. The errors are taken off the context.
                const type = gl.getParameter(0x8B9A);
                const into = one[type];

                if (into)
                {
                    gl.readPixels(0, 0, 1, 1, gl.getParameter(0x8B9B), type, into);
                }

                gl.bindFramebuffer(0x8CA8, read);

                if (pack)
                {
                    gl.bindBuffer(0x88EB, pack);
                }

                while (gl.getError()) { /* drained */ }
            };

            // Anything the context was doing before is finished first, so it is not charged to the first draw.
            gl.finish();
            gl.getParameter(0x8FBB);

            run.play(item.data.commands.length, undefined, (index) =>
            {
                const draw = byCommand.get(index);

                if (draw === undefined || item.data.draws[draw].kind !== 'draw' || gl.getQuery(0x88BF, 0x8865))
                {
                    return;
                }

                const query = gl.createQuery();

                settle();
                gl.beginQuery(0x88BF, query);

                for (let i = 0; i < times; i++)
                {
                    run.execute(item.data.commands[index]);
                }

                gl.endQuery(0x88BF);
                settle();
                queries.push({ draw, query });
            });

            const deadline = performance.now() + 5000;

            while (queries.some((entry) => !gl.getQueryParameter(entry.query, 0x8867)) && performance.now() < deadline)
            {
                gl.flush();
                await new Promise((resolve) => setTimeout(resolve, 4));
            }

            const disjoint = Boolean(gl.getParameter(0x8FBB));
            const rows: Json[] = [];

            for (const entry of queries)
            {
                if (gl.getQueryParameter(entry.query, 0x8867))
                {
                    rows.push({ draw: entry.draw, ns: Number(gl.getQueryParameter(entry.query, 0x8866)) / times });
                }

                gl.deleteQuery(entry.query);
            }

            return { rows, times, disjoint, notes: run.notes, ms: performance.now() - started };
        }
        finally
        {
            run.dispose();
        }
    },

    // What one draw is given and what its vertex shader makes of it.
    //
    // Given: each attribute the program reads, with the values of the first few vertices,
    // read from the buffers as they stand just before the draw.
    //
    // Made: the clip-space position of every vertex, taken with transform feedback from the
    // program's own vertex shader (WebGL 2). From those, how many triangles would reach the
    // rasteriser at all: not wholly outside the view volume, not behind the eye, not of no
    // area, not NaN. This is the first instance only.
    async geometry (args: { key: string; draw: number; vertices?: number }): Promise<Json>
    {
        const item = capture(args.key);

        if (isGpu(item))
        {
            return { unsupported: 'webgpu' };
        }

        const row = item.data.draws[args.draw];

        if (!row)
        {
            throw new Error(`The capture has ${item.data.draws.length} events, numbered from 0; there is no draw ${args.draw}.`);
        }

        if (row.kind !== 'draw')
        {
            return { unsupported: 'not-a-draw', kind: row.kind };
        }

        const run = new Run(item);
        const gl = run.gl;
        const show = Math.max(1, Math.min(args.vertices ?? 8, 64));
        const CAP = 60000;

        try
        {
            // Everything up to the draw, and not the draw itself.
            run.play(row.command);

            const program = gl.getParameter(0x8B8D);

            if (!program)
            {
                return { unsupported: 'no-program' };
            }

            const indexed = row.indexType !== null && row.indexType !== undefined;
            const count = Math.max(0, Math.min(row.count ?? 0, CAP));
            const first = row.first ?? 0;
            const arrayBuffer = gl.getParameter(0x8894);

            // Which vertices the draw names, in order.
            let indices: number[] | null = null;

            if (indexed && run.gl2 && count > 0)
            {
                const Typed = row.indexType === 0x1401 ? Uint8Array : (row.indexType === 0x1405 ? Uint32Array : Uint16Array);
                const data = new Typed(count);

                try
                {
                    gl.getBufferSubData(0x8893, row.indexOffset ?? 0, data);
                    indices = Array.from(data);
                }
                catch
                {
                    indices = null;
                }
            }

            const named = indices ?? Array.from({ length: count }, (_, i) => first + i);
            let lowest = Infinity;
            let highest = -Infinity;

            for (const index of named)
            {
                lowest = Math.min(lowest, index);
                highest = Math.max(highest, index);
            }

            // ---- What it is given ----

            const SIZES: Record<number, [any, number]> = {
                0x1400: [Int8Array, 1], 0x1401: [Uint8Array, 1], 0x1402: [Int16Array, 2], 0x1403: [Uint16Array, 2],
                0x1404: [Int32Array, 4], 0x1405: [Uint32Array, 4], 0x1406: [Float32Array, 4]
            };

            const attributes: Json[] = [];

            for (let i = 0; i < gl.getProgramParameter(program, 0x8B89); i++)
            {
                const active = gl.getActiveAttrib(program, i);
                const location = active ? gl.getAttribLocation(program, active.name) : -1;

                if (!active || location < 0)
                {
                    continue;
                }

                const out: Json = { name: active.name, location, glslType: active.type };

                if (!gl.getVertexAttrib(location, 0x8622))
                {
                    // Not an array: every vertex gets the one current value.
                    out.constant = Array.from(gl.getVertexAttrib(location, 0x8626) as ArrayLike<number>);
                    attributes.push(out);
                    continue;
                }

                const size = gl.getVertexAttrib(location, 0x8623);
                const type = gl.getVertexAttrib(location, 0x8625);
                const [Typed, bytes] = SIZES[type] ?? [null, 0];
                const stride = gl.getVertexAttrib(location, 0x8624) || size * bytes;
                const offset = gl.getVertexAttribOffset(location, 0x8645);
                const buffer = gl.getVertexAttrib(location, 0x889F);
                const divisor = run.gl2 ? gl.getVertexAttrib(location, 0x88FE) : 0;

                Object.assign(out, { size, type, normalized: gl.getVertexAttrib(location, 0x886A), stride, offset, divisor, buffer: run.idOf(buffer) });

                if (!buffer || !Typed || !run.gl2)
                {
                    out.missing = !buffer ? 'no buffer is bound to it' : 'its values cannot be read here';
                    attributes.push(out);
                    continue;
                }

                gl.bindBuffer(0x8892, buffer);

                const length = gl.getBufferParameter(0x8892, 0x8764);
                const values: Array<number[] | null> = [];

                // Per-instance attributes are shown for the first few instances; the rest
                // for the first few vertices the draw names.
                const which = divisor > 0 ? Array.from({ length: Math.min(show, row.instances ?? 1) }, (_, k) => k) : named.slice(0, show);

                for (const index of which)
                {
                    const at = offset + index * stride;

                    if (at < 0 || at + size * bytes > length)
                    {
                        values.push(null);
                        continue;
                    }

                    const data = new Typed(size);

                    gl.getBufferSubData(0x8892, at, data);
                    values.push(Array.from(data as ArrayLike<number>));
                }

                out.values = values;
                out.bufferBytes = length;

                // The furthest the draw reaches into the buffer.
                const reach = divisor > 0 ? offset + ((row.instances ?? 1) - 1) * stride + size * bytes : (named.length ? offset + highest * stride + size * bytes : 0);

                out.overrun = reach > length ? reach - length : 0;
                attributes.push(out);
            }

            gl.bindBuffer(0x8892, arrayBuffer);

            // ---- What the vertex shader makes of it ----
            //
            // WebGL 2's transform feedback takes points, lines or triangles drawn with
            // drawArrays and nothing else. So every vertex the draw names is run through the
            // vertex shader once, as a point, and the primitives are put together here from
            // the draw's mode and indices.

            let positions: Float32Array | null = null;
            let why: string | null = null;
            const base = Number.isFinite(lowest) ? lowest : 0;
            const span = Number.isFinite(highest) ? Math.min(highest - base + 1, CAP) : 0;

            if (!run.gl2)
            {
                why = 'WebGL 1 has no transform feedback, so the vertex shader\'s output cannot be read.';
            }
            else if (span === 0)
            {
                why = 'The draw names no vertices.';
            }
            else if (gl.getParameter(0x8E24) || gl.getQuery(0x8C88, 0x8865))
            {
                why = 'The page has transform feedback of its own running at this draw.';
            }
            else
            {
                const shape = shapeProgram(gl, program, ['gl_Position']);

                if (!shape)
                {
                    why = 'The vertex shader could not be linked on its own to read its output.';
                }
                else
                {
                    syncUniforms(gl, program, shape);

                    const feedback = gl.createTransformFeedback();
                    const into = gl.createBuffer();
                    const bound = gl.getParameter(0x8E25);
                    const discarding = gl.isEnabled(0x8C89);

                    while (gl.getError()) { /* what came before is not this draw's */ }

                    gl.bindBuffer(0x8892, into);
                    gl.bufferData(0x8892, span * 16, 0x88E9);
                    gl.bindBuffer(0x8892, arrayBuffer);

                    gl.useProgram(shape.program);
                    gl.bindTransformFeedback(0x8E22, feedback);
                    gl.bindBufferBase(0x8C8E, 0, into);
                    gl.enable(0x8C89);
                    gl.beginTransformFeedback(0x0000);
                    gl.drawArrays(0x0000, base, span);
                    gl.endTransformFeedback();
                    gl.bindBufferBase(0x8C8E, 0, null);
                    gl.bindTransformFeedback(0x8E22, bound);

                    if (!discarding)
                    {
                        gl.disable(0x8C89);
                    }

                    gl.useProgram(program);

                    const error = gl.getError();

                    if (error === 0)
                    {
                        positions = new Float32Array(span * 4);
                        gl.bindBuffer(0x8892, into);
                        gl.getBufferSubData(0x8892, 0, positions);
                        gl.bindBuffer(0x8892, arrayBuffer);
                    }
                    else
                    {
                        why = `The browser rejected the draw that reads the vertex shader's output (error 0x${error.toString(16)}): an attribute may read past the end of its buffer.`;
                    }

                    gl.deleteBuffer(into);
                    gl.deleteTransformFeedback(feedback);
                    gl.deleteProgram(shape.program);
                }
            }

            // ---- What would reach the rasteriser ----

            let summary: Json = null;

            if (positions)
            {
                const got = positions;
                const at = (vertex: number): number[] | null =>
                {
                    const slot = vertex - base;

                    return slot >= 0 && slot < span ? [got[slot * 4], got[slot * 4 + 1], got[slot * 4 + 2], got[slot * 4 + 3]] : null;
                };

                // The primitives, as lists of vertex numbers, in the winding the mode gives them.
                const primitives: number[][] = [];
                const n = named.length;

                switch (row.mode)
                {
                    case 0x0000: for (let i = 0; i < n; i++) { primitives.push([named[i]]); } break;
                    case 0x0001: for (let i = 0; i + 1 < n; i += 2) { primitives.push([named[i], named[i + 1]]); } break;
                    case 0x0003: for (let i = 0; i + 1 < n; i++) { primitives.push([named[i], named[i + 1]]); } break;
                    case 0x0002:
                        for (let i = 0; i + 1 < n; i++) { primitives.push([named[i], named[i + 1]]); }
                        if (n > 2) { primitives.push([named[n - 1], named[0]]); }
                        break;
                    case 0x0004: for (let i = 0; i + 2 < n; i += 3) { primitives.push([named[i], named[i + 1], named[i + 2]]); } break;
                    case 0x0005: for (let i = 0; i + 2 < n; i++) { primitives.push(i % 2 ? [named[i + 1], named[i], named[i + 2]] : [named[i], named[i + 1], named[i + 2]]); } break;
                    default: for (let i = 1; i + 1 < n; i++) { primitives.push([named[0], named[i], named[i + 1]]); } break;
                }

                const per = row.mode === 0x0000 ? 1 : (row.mode <= 0x0003 ? 2 : 3);
                const tally = { total: primitives.length, unread: 0, nan: 0, behind: 0, outside: 0, flat: 0, reach: 0, front: 0, back: 0 };
                const planes: Record<string, number> = { left: 0, right: 0, bottom: 0, top: 0, near: 0, far: 0 };
                const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
                const clockwise = gl.getParameter(0x0B46) === 0x0900;

                const sides: Array<[string, (c: number[]) => boolean]> = [
                    ['left', (c) => c[0] < -c[3]], ['right', (c) => c[0] > c[3]],
                    ['bottom', (c) => c[1] < -c[3]], ['top', (c) => c[1] > c[3]],
                    ['near', (c) => c[2] < -c[3]], ['far', (c) => c[2] > c[3]]
                ];

                for (const primitive of primitives)
                {
                    const found = primitive.map(at);

                    if (found.some((vertex) => vertex === null))
                    {
                        tally.unread++;
                        continue;
                    }

                    const v = found as number[][];

                    if (v.some((vertex) => vertex.some((part) => !Number.isFinite(part))))
                    {
                        tally.nan++;
                        continue;
                    }

                    if (v.every((vertex) => vertex[3] <= 0))
                    {
                        tally.behind++;
                        continue;
                    }

                    // Wholly beyond one side of the view volume: clipped away entire.
                    const beyond = sides.find(([, test]) => v.every(test));

                    if (beyond)
                    {
                        tally.outside++;
                        planes[beyond[0]]++;
                        continue;
                    }

                    if (per === 3 && v.every((vertex) => vertex[3] > 0))
                    {
                        const [a, b, c] = v.map((vertex) => [vertex[0] / vertex[3], vertex[1] / vertex[3]]);
                        const area = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);

                        if (Math.abs(area) < 1e-12)
                        {
                            tally.flat++;
                            continue;
                        }

                        // Counter-clockwise in window space is a positive area.
                        if ((area > 0) !== clockwise) { tally.front++; } else { tally.back++; }
                    }

                    for (const vertex of v)
                    {
                        if (vertex[3] > 0)
                        {
                            for (let axis = 0; axis < 3; axis++)
                            {
                                const ndc = vertex[axis] / vertex[3];

                                bounds.min[axis] = Math.min(bounds.min[axis], ndc);
                                bounds.max[axis] = Math.max(bounds.max[axis], ndc);
                            }
                        }
                    }

                    tally.reach++;
                }

                summary = {
                    ...tally,
                    per,
                    planes,
                    bounds: tally.reach > 0 ? bounds : null,
                    first: named.slice(0, show).map((vertex) => at(vertex))
                };
            }

            return {
                mode: row.mode,
                count: row.count,
                capped: (row.count ?? 0) > CAP ? CAP : null,
                first,
                indexed,
                instances: row.instances ?? 1,
                indices: indices ? { first: indices.slice(0, show * 3), lowest, highest } : null,
                attributes,
                output: summary,
                outputMissing: why,
                viewport: Array.from(gl.getParameter(0x0BA2) as ArrayLike<number>),
                cull: gl.isEnabled(0x0B44) ? gl.getParameter(0x0B45) : null,
                frontFace: gl.getParameter(0x0B46),
                notes: run.notes
            };
        }
        finally
        {
            run.dispose();
        }
    },

    // Which event owns each pixel. Every draw is issued with its own vertex shader and a
    // fragment shader that writes the event's number as a colour, with blending off; clears
    // write nothing. What a pixel holds at the end is the last draw whose shape covered it
    // and passed the tests. A fragment the page's shader would have discarded still counts.
    async drawId (args: { key: string; target?: Json }): Promise<Json>
    {
        const item = capture(args.key);

        if (isGpu(item))
        {
            return { unsupported: 'webgpu' };
        }

        const run = new Run(item);
        const gl = run.gl;

        try
        {
            const byCommand = new Map<number, number>();

            item.data.draws.forEach((row, index) => byCommand.set(row.command, index));

            const shapes = new Map<any, ReturnType<typeof shapeProgram>>();
            let restore: (() => void) | null = null;
            let skipped = 0;

            run.play(item.data.commands.length, () =>
            {
                restore?.();
                restore = null;
            },
            (index) =>
            {
                const draw = byCommand.get(index);

                if (draw === undefined || !sameTarget(item.data.draws[draw], args.target ?? null))
                {
                    return;
                }

                const event = item.data.draws[draw];

                if (event.kind === 'clear')
                {
                    // A clear leaves "nobody" behind, whatever colour the page clears to.
                    const colour = gl.getParameter(0x0C22);

                    gl.clearColor(0, 0, 0, 0);
                    restore = () => gl.clearColor(colour[0], colour[1], colour[2], colour[3]);

                    return;
                }

                if (event.kind !== 'draw')
                {
                    return;
                }

                const program = gl.getParameter(0x8B8D);

                if (program && !shapes.has(program))
                {
                    shapes.set(program, shapeProgram(gl, program));
                }

                const shape = program ? shapes.get(program) : null;

                if (!shape)
                {
                    skipped++;

                    return;
                }

                const blend = gl.isEnabled(0x0BE2);
                const mask = gl.getParameter(0x0C23);
                const id = draw + 1;

                syncUniforms(gl, program, shape);
                gl.useProgram(shape.program);
                gl.uniform4f(gl.getUniformLocation(shape.program, 'scanlineColour'), (id & 255) / 255, ((id >> 8) & 255) / 255, ((id >> 16) & 255) / 255, 1);
                gl.disable(0x0BE2);
                gl.colorMask(true, true, true, true);

                restore = () =>
                {
                    gl.useProgram(program);
                    gl.colorMask(mask[0], mask[1], mask[2], mask[3]);

                    if (blend)
                    {
                        gl.enable(0x0BE2);
                    }
                };
            });

            const image = run.image(args.target ?? null);

            if (image.float)
            {
                return { unsupported: 'float-target' };
            }

            return { ...(await packed(image)), skipped, notes: run.notes };
        }
        finally
        {
            run.dispose();
        }
    },

    // The depth buffer behind a target, after an event or at the end of the frame. WebGL
    // cannot read depth back, so it is copied by a blit into a depth texture, and a quad
    // drawn from that texture writes each depth as a 24-bit number in a colour.
    async depth (args: { key: string; draw?: number | null; target?: Json }): Promise<Json>
    {
        const item = capture(args.key);

        if (isGpu(item))
        {
            return { unsupported: 'webgpu' };
        }

        const run = new Run(item);
        const gl = run.gl;

        try
        {
            if (!run.gl2)
            {
                return { unsupported: 'webgl1' };
            }

            run.play(endOf(item.data, args.draw));

            const row = args.draw === null || args.draw === undefined ? null : item.data.draws[args.draw];
            const target = args.target ?? (row ? targetOfRow(row) : null);
            const [width, height] = sizeOfTarget(item.data, target);
            // The framebuffer whose depth goes with the target: the one an event drew to it through.
            const through = row && sameTarget(row, target) ? row : [...item.data.draws].reverse().find((event) => sameTarget(event, target));
            const source = through?.framebuffer ? run.object('framebuffer', through.framebuffer) : null;

            if (target && !source)
            {
                return { unsupported: 'no-depth' };
            }

            while (gl.getError()) { /* what the frame raised is not this view's */ }

            // The depth format has to match the source's, which for the canvas is the
            // browser's choice. Each likely one is tried until the blit is accepted.
            const texture = gl.createTexture();
            const copy = gl.createFramebuffer();
            let format = 0;

            gl.disable(0x0C11);

            for (const [candidate, attachment] of [[0x88F0, 0x821A], [0x81A6, 0x8D00], [0x8CAD, 0x821A], [0x8CAC, 0x8D00], [0x81A5, 0x8D00]])
            {
                gl.activeTexture(0x84C0);
                gl.bindTexture(TEXTURE_2D, texture);
                gl.texImage2D(TEXTURE_2D, 0, candidate, width, height, 0, attachment === 0x821A ? 0x84F9 : 0x1902,
                    candidate === 0x88F0 ? 0x84FA : (candidate === 0x8CAD ? 0x8DAD : (candidate === 0x8CAC ? 0x1406 : (candidate === 0x81A5 ? 0x1403 : 0x1405))), null);
                gl.texParameteri(TEXTURE_2D, 0x2801, 0x2600);
                gl.texParameteri(TEXTURE_2D, 0x2800, 0x2600);
                gl.texParameteri(TEXTURE_2D, 0x884C, 0);
                gl.bindFramebuffer(0x8CA9, copy);
                gl.framebufferTexture2D(0x8CA9, 0x8D00, TEXTURE_2D, null, 0);
                gl.framebufferTexture2D(0x8CA9, 0x821A, TEXTURE_2D, null, 0);
                gl.framebufferTexture2D(0x8CA9, attachment, TEXTURE_2D, texture, 0);
                gl.bindFramebuffer(0x8CA8, source);
                gl.blitFramebuffer(0, 0, width, height, 0, 0, width, height, 0x0100, 0x2600);

                if (gl.getError() === 0)
                {
                    format = candidate;
                    break;
                }
            }

            if (!format)
            {
                return { unsupported: 'no-depth' };
            }

            // Each depth, written as three bytes of colour.
            const out = gl.createTexture();
            const into = gl.createFramebuffer();

            gl.activeTexture(0x84C1);
            gl.bindTexture(TEXTURE_2D, out);
            gl.texImage2D(TEXTURE_2D, 0, 0x8058, width, height, 0, 0x1908, 0x1401, null);
            gl.bindFramebuffer(0x8CA9, into);
            gl.framebufferTexture2D(0x8CA9, 0x8CE0, TEXTURE_2D, out, 0);

            const program = gl.createProgram();

            for (const [type, source] of [[0x8B31, '#version 300 es\nvoid main () { gl_Position = vec4(float(gl_VertexID % 2) * 4.0 - 1.0, float(gl_VertexID / 2) * 4.0 - 1.0, 0.0, 1.0); }'],
                [0x8B30, '#version 300 es\nprecision highp float;\nprecision highp sampler2D;\nuniform sampler2D depth;\nout vec4 packed;\nvoid main () { float d = texelFetch(depth, ivec2(gl_FragCoord.xy), 0).r; highp uint n = min(uint(clamp(d, 0.0, 1.0) * 16777215.0 + 0.5), 16777215u); packed = vec4(float(n & 255u), float((n >> 8u) & 255u), float((n >> 16u) & 255u), 255.0) / 255.0; }']] as Array<[number, string]>)
            {
                const shader = gl.createShader(type);

                gl.shaderSource(shader, source);
                gl.compileShader(shader);
                gl.attachShader(program, shader);
            }

            gl.linkProgram(program);
            gl.useProgram(program);
            gl.activeTexture(0x84C0);
            gl.bindTexture(TEXTURE_2D, texture);
            gl.uniform1i(gl.getUniformLocation(program, 'depth'), 0);
            gl.bindVertexArray(null);
            gl.viewport(0, 0, width, height);

            for (const cap of [0x0BE2, 0x0B71, 0x0B90, 0x0B44, 0x0C11, 0x8C89, 0x809E, 0x8037])
            {
                gl.disable(cap);
            }

            gl.colorMask(true, true, true, true);
            gl.drawArrays(0x0004, 0, 3);

            const raw = new Uint8Array(width * height * 4);

            gl.bindFramebuffer(0x8CA8, into);
            gl.bindBuffer(0x88EB, null);
            gl.pixelStorei(0x0D05, 1);
            gl.readPixels(0, 0, width, height, 0x1908, 0x1401, raw);

            // Rows from the top, as every other picture has them.
            const data = new Uint8Array(raw.length);
            const stride = width * 4;

            for (let y = 0; y < height; y++)
            {
                data.set(raw.subarray((height - 1 - y) * stride, (height - y) * stride), y * stride);
            }

            return { ...(await packed({ width, height, data })), format, error: gl.getError(), notes: run.notes };
        }
        finally
        {
            run.dispose();
        }
    },

    // Where a float target holds a number that is not one: NaN, or infinite.
    async nan (args: { key: string; draw?: number | null; target?: Json }): Promise<Json>
    {
        const item = capture(args.key);

        if (isGpu(item))
        {
            return { unsupported: 'webgpu' };
        }

        const run = new Run(item);

        try
        {
            run.play(endOf(item.data, args.draw));

            const row = args.draw === null || args.draw === undefined ? null : item.data.draws[args.draw];
            const target = args.target ?? (row ? targetOfRow(row) : null);
            const { width, height, data } = run.raw(target);

            if (!(data instanceof Float32Array))
            {
                return { notFloat: true, width, height };
            }

            // One byte a pixel, rows from the top: 1 for NaN in any channel, 2 for infinite.
            const marks = new Uint8Array(width * height);
            let nan = 0;
            let infinite = 0;

            for (let y = 0; y < height; y++)
            {
                for (let x = 0; x < width; x++)
                {
                    const from = ((height - 1 - y) * width + x) * 4;
                    let mark = 0;

                    for (let channel = 0; channel < 4; channel++)
                    {
                        const value = data[from + channel];

                        if (Number.isNaN(value))
                        {
                            mark = 1;
                            break;
                        }

                        if (!Number.isFinite(value))
                        {
                            mark = 2;
                        }
                    }

                    marks[y * width + x] = mark;
                    nan += mark === 1 ? 1 : 0;
                    infinite += mark === 2 ? 1 : 0;
                }
            }

            return { width, height, nan, infinite, marks: toBase64(await gzip(marks)), notes: run.notes };
        }
        finally
        {
            run.dispose();
        }
    },

    // The frame with its triangles drawn as outlines, up to an event or to its end.
    async wireframe (args: { key: string; draw?: number | null; target?: Json }): Promise<Json>
    {
        const item = capture(args.key);

        if (isGpu(item))
        {
            return { unsupported: 'webgpu' };
        }

        const run = new Run(item);

        try
        {
            const mode = run.gl.getExtension('WEBGL_polygon_mode');

            if (!mode)
            {
                return { unsupported: 'no-polygon-mode' };
            }

            mode.polygonModeWEBGL(0x0408, 0x1B01);
            run.play(endOf(item.data, args.draw));

            const row = args.draw === null || args.draw === undefined ? null : item.data.draws[args.draw];
            const target = args.target ?? (row ? targetOfRow(row) : null);
            const image = run.image(target);

            return { ...(await packed(image)), notes: run.notes };
        }
        finally
        {
            run.dispose();
        }
    },

    // The history of one pixel: every event on its target, with the pixel's value before and
    // after, and for draws whether the pixel was covered at all and which tests it passed.
    //
    // Coverage and the tests are found with occlusion queries (WebGL 2). Just before each
    // draw, the same draw is issued again with every write masked off and the scissor box
    // shrunk to the one pixel: first with all tests off (did any fragment land here?), then
    // with one test on at a time (did it survive culling, the depth test, the stencil
    // test?). Nothing is written, so the frame goes on as if the extra draws never happened.
    async history (args: { key: string; x: number; y: number; target?: Json }): Promise<Json>
    {
        const item = capture(args.key);

        if (isGpu(item))
        {
            return { unsupported: 'webgpu' };
        }

        const run = new Run(item);
        const gl = run.gl;
        const started = performance.now();

        try
        {
            const byCommand = new Map<number, number>();

            item.data.draws.forEach((row, index) => byCommand.set(row.command, index));

            const rows: Json[] = [];
            const queries: Array<{ row: Json; test: string; query: any }> = [];

            let geometry: { framebuffer: any; width: number; height: number; float: boolean; scratch: any } | null = null;
            let current: Json | null = null;

            // The shape of a draw, apart from what its fragment shader does: the program's
            // own vertex shader with a fragment shader that keeps every fragment. A draw
            // whose shape covers the pixel while none of its own fragments survive there
            // had them discarded.
            const shapes = new Map<any, ReturnType<typeof shapeProgram>>();

            const shapeOf = (program: any): ReturnType<typeof shapeProgram> =>
            {
                if (!shapes.has(program))
                {
                    shapes.set(program, shapeProgram(gl, program));
                }

                return shapes.get(program)!;
            };

            const value = (): number[] => Array.from(run.read(geometry!.framebuffer, args.x, geometry!.height - 1 - args.y, 1, 1, geometry!.float));

            const ask = (row: Json, test: string, command: Json): void =>
            {
                const query = gl.createQuery();

                gl.beginQuery(0x8C2F, query);
                run.execute(command);
                gl.endQuery(0x8C2F);
                queries.push({ row, test, query });
            };

            run.play(item.data.commands.length, (index) =>
            {
                if (current !== null && byCommand.get(index) === current.draw)
                {
                    current.after = value();
                    rows.push(current);
                    current = null;
                }
            },
            (index) =>
            {
                const draw = byCommand.get(index);

                if (draw === undefined || !sameTarget(item.data.draws[draw], args.target))
                {
                    return;
                }

                const event = item.data.draws[draw];

                if (geometry === null)
                {
                    // The target exists by now: an event is about to draw to it.
                    try
                    {
                        geometry = run.targetFramebuffer(args.target);
                    }
                    catch
                    {
                        return;
                    }

                    if (args.x < 0 || args.y < 0 || args.x >= geometry.width || args.y >= geometry.height)
                    {
                        throw new Error(`(${args.x}, ${args.y}) is outside the target, which is ${geometry.width}×${geometry.height}.`);
                    }
                }

                const bottom = geometry.height - 1 - args.y;
                const box: number[] | null = event.scissor ?? null;

                current = {
                    draw,
                    kind: event.kind,
                    before: value(),
                    after: null,
                    scissor: box === null || (args.x >= box[0] && args.x < box[0] + box[2] && bottom >= box[1] && bottom < box[1] + box[3]),
                    covered: null,
                    shape: null,
                    cull: null,
                    depth: null,
                    stencil: null
                };

                // A query of the page's own, or transform feedback, would be disturbed by the extra draws.
                if (event.kind !== 'draw' || !run.gl2 || gl.getQuery(0x8C2F, 0x8865) || gl.getQuery(0x8D6A, 0x8865) || gl.getParameter(0x8E24))
                {
                    return;
                }

                const enabled: number[] = event.enabled ?? [];
                const saved = {
                    scissor: gl.isEnabled(0x0C11),
                    box: gl.getParameter(0x0C10),
                    depth: gl.isEnabled(0x0B71),
                    stencil: gl.isEnabled(0x0B90),
                    cull: gl.isEnabled(0x0B44),
                    mask: gl.getParameter(0x0C23),
                    depthMask: gl.getParameter(0x0B72),
                    front: gl.getParameter(0x0B98),
                    back: gl.getParameter(0x8CA5)
                };

                const only = (test: number | null): void =>
                {
                    for (const cap of [0x0B71, 0x0B90, 0x0B44])
                    {
                        if (cap === test) { gl.enable(cap); } else { gl.disable(cap); }
                    }
                };

                gl.colorMask(false, false, false, false);
                gl.depthMask(false);
                gl.stencilMask(0);
                gl.enable(0x0C11);
                gl.scissor(args.x, bottom, 1, 1);

                const command = item.data.commands[index];

                only(null);
                ask(current, 'covered', command);

                const program = gl.getParameter(0x8B8D);
                const shape = program ? shapeOf(program) : null;

                if (shape)
                {
                    syncUniforms(gl, program, shape);
                    gl.useProgram(shape.program);
                    ask(current, 'shape', command);
                    gl.useProgram(program);
                }

                if (enabled.includes(0x0B44))
                {
                    only(0x0B44);
                    ask(current, 'cull', command);
                }

                if (enabled.includes(0x0B71))
                {
                    only(0x0B71);
                    ask(current, 'depth', command);
                }

                if (enabled.includes(0x0B90))
                {
                    only(0x0B90);
                    ask(current, 'stencil', command);
                }

                // As it was.
                for (const [cap, on] of [[0x0B71, saved.depth], [0x0B90, saved.stencil], [0x0B44, saved.cull], [0x0C11, saved.scissor]] as Array<[number, boolean]>)
                {
                    if (on) { gl.enable(cap); } else { gl.disable(cap); }
                }

                gl.scissor(saved.box[0], saved.box[1], saved.box[2], saved.box[3]);
                gl.colorMask(saved.mask[0], saved.mask[1], saved.mask[2], saved.mask[3]);
                gl.depthMask(saved.depthMask);
                gl.stencilMaskSeparate(0x0404, saved.front);
                gl.stencilMaskSeparate(0x0405, saved.back);
            });

            // Query results arrive once the browser has had a turn.
            const deadline = performance.now() + 3000;

            while (queries.some((entry) => !gl.getQueryParameter(entry.query, 0x8867)) && performance.now() < deadline)
            {
                gl.flush();
                await new Promise((resolve) => setTimeout(resolve, 2));
            }

            for (const entry of queries)
            {
                if (gl.getQueryParameter(entry.query, 0x8867))
                {
                    entry.row[entry.test] = Boolean(gl.getQueryParameter(entry.query, 0x8866));
                }

                gl.deleteQuery(entry.query);
            }

            for (const shape of shapes.values())
            {
                if (shape)
                {
                    gl.deleteProgram(shape.program);
                }
            }

            return {
                rows,
                queries: run.gl2,
                float: Boolean(geometry && (geometry as { float: boolean }).float),
                error: gl.getError(),
                notes: run.notes,
                ms: performance.now() - started
            };
        }
        finally
        {
            run.dispose();
        }
    },

    // A recording of several frames, played through once: the canvas at the end of each
    // frame, as a hash of its pixels and a small picture for a contact sheet.
    async frames (args: { key: string; edge?: number }): Promise<Json>
    {
        const item = capture(args.key);
        const marks: Json[] = item.data.header.frames ?? [];
        const started = performance.now();
        const edge = args.edge ?? 96;
        const out: Json[] = [];
        const thumbs: Uint8Array[] = [];

        let size = { width: 0, height: 0 };
        let notes: string[] = [];

        // Rows from the top, RGBA8.
        const keep = (frame: number, width: number, height: number, data: Uint8Array): void =>
        {
            let hash = 0x811C9DC5;

            for (let i = 0; i < data.length; i++)
            {
                hash = Math.imul(hash ^ data[i], 0x01000193);
            }

            const step = Math.max(1, Math.ceil(Math.max(width, height) / edge));
            const w = Math.max(1, Math.floor(width / step));
            const h = Math.max(1, Math.floor(height / step));
            const thumb = new Uint8Array(w * h * 4);

            for (let y = 0; y < h; y++)
            {
                for (let x = 0; x < w; x++)
                {
                    const from = ((y * step) * width + x * step) * 4;

                    thumb.set(data.subarray(from, from + 4), (y * w + x) * 4);
                }
            }

            size = { width: w, height: h };
            thumbs.push(thumb);
            out.push({ frame, hash: (hash >>> 0).toString(16).padStart(8, '0') });
        };

        const lastOf = new Map<number, number>(marks.map((mark) => [mark.command - 1, mark.frame]));

        if (isGpu(item))
        {
            notes = await gpuApi.frames(item, methodsOf(item), lastOf, keep);
        }
        else
        {
            const run = new Run(item);

            try
            {
                run.play(item.data.commands.length, (index) =>
                {
                    const frame = lastOf.get(index);

                    if (frame !== undefined)
                    {
                        const image = run.image(null);

                        keep(frame, image.width, image.height, image.data);
                    }
                });

                notes = run.notes;
            }
            finally
            {
                run.dispose();
            }
        }

        const all = new Uint8Array(thumbs.reduce((sum, thumb) => sum + thumb.length, 0));

        let at = 0;

        for (const thumb of thumbs)
        {
            all.set(thumb, at);
            at += thumb.length;
        }

        return { frames: out, thumb: size, thumbs: toBase64(await gzip(all)), notes, ms: performance.now() - started };
    },

    // Every event that changed one pixel of a target, in order, with the value before and
    // after. The last is the draw that produced the pixel's final value.
    trace (args: { key: string; x: number; y: number; target?: Json }): Json
    {
        const item = capture(args.key);

        if (isGpu(item))
        {
            return gpuApi.trace(item, methodsOf(item), args);
        }

        const run = new Run(item);
        const started = performance.now();

        try
        {
            const byCommand = new Map<number, number>();

            item.data.draws.forEach((row, index) => byCommand.set(row.command, index));

            const changes: Json[] = [];

            let geometry: { framebuffer: any; width: number; height: number; float: boolean; scratch: any } | null = null;
            let before: number[] | null = null;
            let touched = 0;

            run.play(item.data.commands.length, (index) =>
            {
                const draw = byCommand.get(index);

                if (draw === undefined || !sameTarget(item.data.draws[draw], args.target))
                {
                    return;
                }

                // The target exists by now: an event has just drawn to it.
                if (geometry === null)
                {
                    geometry = run.targetFramebuffer(args.target);

                    if (args.x < 0 || args.y < 0 || args.x >= geometry.width || args.y >= geometry.height)
                    {
                        throw new Error(`(${args.x}, ${args.y}) is outside the target, which is ${geometry.width}×${geometry.height}.`);
                    }
                }

                touched++;

                const value = Array.from(run.read(geometry.framebuffer, args.x, geometry.height - 1 - args.y, 1, 1, geometry.float));

                if (before === null || value.some((channel, i) => channel !== before![i]))
                {
                    changes.push({ draw, before, after: value });
                    before = value;
                }
            });

            return { changes, events: touched, float: Boolean(geometry && (geometry as { float: boolean }).float), final: before, error: run.gl.getError(), notes: run.notes, ms: performance.now() - started };
        }
        finally
        {
            run.dispose();
        }
    }
};

(globalThis as any).__scanlineReplay = async (method: keyof typeof api, argsJson?: string): Promise<string> =>
{
    try
    {
        const handler = api[method] as (args: Json) => unknown;

        if (!handler)
        {
            return JSON.stringify({ error: `Unknown replay method "${String(method)}"` });
        }

        return JSON.stringify({ ok: (await handler(argsJson ? JSON.parse(argsJson) : {})) ?? null });
    }
    catch (error: any)
    {
        return JSON.stringify({ error: String(error?.message ?? error) });
    }
};
