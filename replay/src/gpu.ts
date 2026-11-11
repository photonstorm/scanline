// Replaying a captured WebGPU frame.
//
// The capture's objects are made again from the descriptors they were created with, their
// contents are put back, and the frame's calls are run in order on a fresh device.
//
// Two things differ from the page that was captured:
//
//   - There is no canvas. Where the page called getCurrentTexture, the replay hands back an
//     ordinary texture of the same size and format, which never expires and can be read at
//     any point.
//   - WebGPU does nothing until commands are submitted, and a pass cannot be read part-way
//     through. To see a target after one draw, the replay splits the frame there: it ends
//     the open pass, finishes and submits every encoder so far, reads, then opens new
//     encoders and a new pass that loads what the old one stored and has the same state set.
//     Later calls reach the new encoder and pass, because the capture names objects by
//     number and the replay maps those numbers to whatever stands in for them.

export type Json = any;

export interface CaptureData
{
    header: Json;
    objects: Json[];
    methods?: string[];
    commands: Json[];
    draws: Json[];
    blobs: number[];
}

export interface Loaded
{
    data: CaptureData;
    blobs: Array<Uint8Array | null>;
}

const TYPED: Record<string, any> = {
    Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array
};

const COPY_SRC = 0x01;
const COPY_DST = 0x02;
const RENDER_ATTACHMENT = 0x10;
const TEXTURE_BINDING = 0x04;

// Depth and stencil formats: which aspects each has.
const DEPTH_FORMATS: Record<string, { depth: boolean; stencil: boolean }> = {
    'depth16unorm': { depth: true, stencil: false },
    'depth24plus': { depth: true, stencil: false },
    'depth24plus-stencil8': { depth: true, stencil: true },
    'depth32float': { depth: true, stencil: false },
    'depth32float-stencil8': { depth: true, stencil: true },
    'stencil8': { depth: false, stencil: true }
};
const BUFFER_MAP_READ = 0x0001;
const BUFFER_MAP_WRITE = 0x0002;
const BUFFER_COPY_SRC = 0x0004;
const BUFFER_COPY_DST = 0x0008;

// The calls that draw in a render pass.
export const DRAW_CALLS = ['draw', 'drawIndexed', 'drawIndirect', 'drawIndexedIndirect'];

// State a pass keeps until it ends: set again on the pass that continues a split one.
const PASS_STATE = ['setPipeline', 'setBindGroup', 'setVertexBuffer', 'setIndexBuffer', 'setViewport', 'setScissorRect', 'setBlendConstant', 'setStencilReference', 'setImmediates'];

// Bytes per pixel of the formats a target can be read in, and how to turn one into numbers.
const READABLE: Record<string, { bytes: number; kind: 'u8' | 'bgra' | 'f16' | 'f32' | 'u16' | 'u32'; channels: number }> = {
    'rgba8unorm': { bytes: 4, kind: 'u8', channels: 4 },
    'rgba8unorm-srgb': { bytes: 4, kind: 'u8', channels: 4 },
    'bgra8unorm': { bytes: 4, kind: 'bgra', channels: 4 },
    'bgra8unorm-srgb': { bytes: 4, kind: 'bgra', channels: 4 },
    'r8unorm': { bytes: 1, kind: 'u8', channels: 1 },
    'rg8unorm': { bytes: 2, kind: 'u8', channels: 2 },
    'rgba16float': { bytes: 8, kind: 'f16', channels: 4 },
    'rg16float': { bytes: 4, kind: 'f16', channels: 2 },
    'r16float': { bytes: 2, kind: 'f16', channels: 1 },
    'rgba32float': { bytes: 16, kind: 'f32', channels: 4 },
    'rg32float': { bytes: 8, kind: 'f32', channels: 2 },
    'r32float': { bytes: 4, kind: 'f32', channels: 1 },
    'rgba16uint': { bytes: 8, kind: 'u16', channels: 4 },
    'r32uint': { bytes: 4, kind: 'u32', channels: 1 },
    'rgba32uint': { bytes: 16, kind: 'u32', channels: 4 }
};

export function halfToFloat (half: number): number
{
    const exponent = (half >> 10) & 0x1F;
    const fraction = half & 0x3FF;
    const sign = half & 0x8000 ? -1 : 1;

    if (exponent === 0)
    {
        return sign * 2 ** -14 * (fraction / 1024);
    }

    if (exponent === 31)
    {
        return fraction ? NaN : sign * Infinity;
    }

    return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

export interface Raw
{
    width: number;
    height: number;
    format: string;
    bytes: number;       // per pixel
    data: Uint8Array;    // rows from the top, packed
}

// One pixel of a raw read as four numbers: 0–255 for 8-bit formats, as stored otherwise.
export function pixelOf (raw: Raw, index: number): number[]
{
    const how = READABLE[raw.format];
    const at = index * raw.bytes;
    const view = new DataView(raw.data.buffer, raw.data.byteOffset + at, raw.bytes);
    const out = [0, 0, 0, how.kind === 'u8' || how.kind === 'bgra' ? 255 : 1];

    for (let channel = 0; channel < how.channels; channel++)
    {
        switch (how.kind)
        {
            case 'u8': out[channel] = view.getUint8(channel); break;
            case 'bgra': out[channel === 0 ? 2 : (channel === 2 ? 0 : channel)] = view.getUint8(channel); break;
            case 'f16': out[channel] = halfToFloat(view.getUint16(channel * 2, true)); break;
            case 'f32': out[channel] = view.getFloat32(channel * 4, true); break;
            case 'u16': out[channel] = view.getUint16(channel * 2, true); break;
            case 'u32': out[channel] = view.getUint32(channel * 4, true); break;
        }
    }

    return out;
}

export function isFloat (format: string): boolean
{
    const kind = READABLE[format]?.kind;

    return kind === 'f16' || kind === 'f32';
}

// A raw read as RGBA8 rows from the top: what an image is made of.
export function toRgba8 (raw: Raw): Uint8Array
{
    const how = READABLE[raw.format];
    const pixels = raw.width * raw.height;

    if (how.kind === 'u8' && how.channels === 4)
    {
        return raw.data;
    }

    const out = new Uint8Array(pixels * 4);
    const scale = how.kind === 'u8' || how.kind === 'bgra' ? 1 : 255;

    for (let i = 0; i < pixels; i++)
    {
        const value = pixelOf(raw, i);

        for (let channel = 0; channel < 4; channel++)
        {
            const scaled = value[channel] * scale;

            out[i * 4 + channel] = scaled > 255 ? 255 : (scaled > 0 ? scaled : 0);
        }
    }

    return out;
}

export interface Open
{
    key: string;            // the pass
    encoderKey: string;
    kind: 'render' | 'compute';
    descriptor: Json;       // as given to the browser
    state: number[];        // the commands that set its state, in order
}

// What a render pass has set so far, by the capture's own numbers for its objects.
export interface PassNow
{
    pipeline: number | null;
    groups: Map<number, { id: number; offsets: any[] }>;
    vertex: Map<number, { id: number; offset: number; size: number | null }>;
    index: { id: number; format: string; offset: number; size: number | null } | null;
    viewport: number[] | null;
    scissor: number[] | null;
}

export class GpuRun
{
    item: Loaded;
    data: CaptureData;
    methods: string[];
    device: any;
    queue: any;
    canvasTexture: any;
    objects = new Map<string, any>();
    records = new Map<string, Json>();
    views = new Map<string, any>();
    notes: string[] = [];
    uncaptured = 0;
    failed = 0;

    // The frame of a recording the canvas texture was last handed out in.
    canvasFrame = -1;

    // Encoders the frame has made and not finished, in the order it made them.
    encoders: Array<{ key: string; encoder: any }> = [];
    // Command buffers finished and not yet submitted.
    pending: any[] = [];
    submitted = new Set<any>();
    open: Open | null = null;

    // Which texture each view is of, and which depth-stencil texture each colour target was
    // last drawn to alongside: what the depth and stencil views read.
    viewOwner = new WeakMap<object, any>();
    depthBehind = new Map<any, any>();

    // When set, every command runs inside an error scope and what it raised is kept.
    scopes: Array<Promise<void>> | null = null;
    errors: Json[] = [];

    // What an analysis hangs on the replay.
    //   onDraw   before a draw in a render pass; true means the analysis issued it itself.
    //   onBegin  may change the descriptor a render pass is begun with.
    //   onEnd    after a render pass ends (or is cut short by a flush), with its encoder.
    //   onTexture  after a texture is made, before the frame or in it.
    onDraw: ((index: number, name: string, args: any[]) => Promise<boolean>) | null = null;
    onBegin: ((descriptor: Json, index: number) => Json) | null = null;
    onEnd: ((open: Open, encoder: any) => void) | null = null;
    onTexture: ((texture: any, id: number) => void) | null = null;

    constructor (item: Loaded, methods: string[])
    {
        this.item = item;
        this.data = item.data;
        this.methods = methods;

        for (const record of this.data.objects)
        {
            this.records.set(`${record.kind}:${record.id}`, record);
        }
    }

    static async create (item: Loaded, methods: string[], wanted: string[] = []): Promise<GpuRun>
    {
        const gpu = (navigator as any).gpu;

        if (!gpu)
        {
            throw new Error('The replay page has no WebGPU (navigator.gpu is missing), so a WebGPU capture cannot be replayed in this browser.');
        }

        const adapter = await gpu.requestAdapter();

        if (!adapter)
        {
            throw new Error('The browser gave the replay page no WebGPU adapter.');
        }

        const run = new GpuRun(item, methods);
        const header = item.data.header;
        const features = [...new Set<string>([...(header.features ?? []), ...wanted])].filter((feature: string) => adapter.features.has(feature));
        const limits: Record<string, number> = {};

        for (const key of Object.keys(header.limits ?? {}))
        {
            if (typeof adapter.limits[key] === 'number')
            {
                limits[key] = header.limits[key];
            }
        }

        try
        {
            run.device = await adapter.requestDevice({ requiredFeatures: features, requiredLimits: limits });
        }
        catch
        {
            // The page's limits could not be had again: the defaults are the best there is.
            run.device = await adapter.requestDevice({ requiredFeatures: features });
            run.note('The replay could not get a device with the limits the page had, and used the defaults.');
        }

        for (const feature of header.features ?? [])
        {
            if (!features.includes(feature))
            {
                run.note(`The replay has no ${feature}, which the page's device had.`);
            }
        }

        run.queue = run.device.queue;
        run.device.onuncapturederror = (event: any) =>
        {
            run.uncaptured++;
            event.preventDefault?.();
        };

        // What stands in for the canvas.
        run.canvasTexture = run.device.createTexture({
            label: 'scanline: the canvas',
            size: [Math.max(1, header.width), Math.max(1, header.height)],
            format: header.format,
            usage: (header.usage ?? RENDER_ATTACHMENT) | COPY_SRC | COPY_DST | RENDER_ATTACHMENT
        });

        return run;
    }

    note (text: string): void
    {
        if (!this.notes.includes(text))
        {
            this.notes.push(text);
        }
    }

    blob (index: number): Uint8Array
    {
        // A flight recording's blob numbers start where its dropped frames' left off.
        const bytes = this.item.blobs[index - (this.data.header.blobBase ?? 0)];

        if (!bytes)
        {
            throw new Error(`Blob ${index} of the capture has not been loaded.`);
        }

        return bytes;
    }

    // ---- Objects made before the frame ----

    // A descriptor as the probe kept it, turned back into one the browser takes.
    revive (value: Json): any
    {
        if (value === null || typeof value !== 'object')
        {
            return value ?? undefined;
        }

        if (Array.isArray(value))
        {
            return value.map((item) => this.revive(item));
        }

        if (typeof value.ref === 'string' && typeof value.id === 'number')
        {
            if ('view' in value)
            {
                return this.view(value.id, value.view);
            }

            return this.object(value.ref, value.id);
        }

        if (typeof value.object === 'string')
        {
            // A GPU object the probe had no record of (an external texture) cannot be made
            // again. Anything else is not something a WebGPU descriptor can hold: it is
            // there because an engine passed an object of its own as the descriptor, with
            // members the browser never reads. PixiJS does, for its samplers.
            if (value.object.startsWith('GPU'))
            {
                throw new Error(`a ${value.object}, which a capture cannot hold`);
            }

            return undefined;
        }

        const out: Record<string, any> = {};

        for (const key of Object.keys(value))
        {
            const member = this.revive(value[key]);

            if (member !== undefined)
            {
                out[key] = member;
            }
        }

        return out;
    }

    view (texture: number, descriptor: Json): any
    {
        const key = `${texture}:${JSON.stringify(descriptor ?? null)}`;

        let view = this.views.get(key);

        if (!view)
        {
            const owner = texture ? this.object('texture', texture) : this.canvasTexture;

            view = owner.createView(this.revive(descriptor));
            this.viewOwner.set(view, owner);
            this.views.set(key, view);
        }

        return view;
    }

    object (kind: string, id: number): any
    {
        const key = `${kind}:${id}`;

        if (this.objects.has(key))
        {
            return this.objects.get(key);
        }

        const record = this.records.get(key);

        if (!record)
        {
            throw new Error(`${key} is not part of this capture`);
        }

        // A layout asked of a pipeline (getBindGroupLayout) is made by no call the capture
        // holds, whenever it was first asked for: it is asked of the pipeline again here.
        const fromPipeline = kind === 'layout' && record.pipeline;

        if (record.createdInFrame && !fromPipeline)
        {
            throw new Error(`${key} is made during the frame and has not been made yet`);
        }

        const made = this.make(record);

        this.objects.set(key, made);

        return made;
    }

    make (record: Json): any
    {
        const device = this.device;
        const label = record.label ?? undefined;

        switch (record.kind)
        {
            case 'shader':
                return device.createShaderModule({ label, code: record.source });

            case 'sampler':
                return device.createSampler(this.revive(record.descriptor));

            case 'query':
                return device.createQuerySet({ label, type: record.type, count: record.count });

            case 'texture':
                return this.makeTexture(record);

            case 'buffer':
                return this.makeBuffer(record);

            case 'layout':
                if (record.pipeline)
                {
                    return this.object('pipeline', record.pipeline).getBindGroupLayout(record.index ?? 0);
                }

                return record.type === 'pipeline' ? device.createPipelineLayout(this.revive(record.descriptor)) : device.createBindGroupLayout(this.revive(record.descriptor));

            case 'pipeline':
                return record.type === 'compute' ? device.createComputePipeline(this.revive(record.descriptor)) : device.createRenderPipeline(this.revive(record.descriptor));

            case 'bind_group':
                return device.createBindGroup(this.revive(record.descriptor));
        }

        throw new Error(`a ${record.kind} cannot be made again`);
    }

    makeTexture (record: Json): any
    {
        const multisampled = (record.sampleCount ?? 1) > 1;

        const texture = this.device.createTexture({
            label: record.label ?? undefined,
            size: [record.width, record.height, record.depthOrArrayLayers ?? 1],
            format: record.format,
            // Copies in and out, so it can be filled and read. A multisampled texture allows neither.
            // A depth or stencil texture can also be sampled, which is how its depth is read.
            // So can a multisampled one, which is how one sample of it is read.
            usage: (multisampled ? record.usage : (record.usage | COPY_SRC | COPY_DST)) | (DEPTH_FORMATS[record.format] || multisampled ? TEXTURE_BINDING : 0),
            mipLevelCount: record.levels ?? 1,
            sampleCount: record.sampleCount ?? 1,
            dimension: record.dimension ?? '2d',
            viewFormats: record.viewFormats ?? []
        });

        for (const part of record.data ?? [])
        {
            const bytes = this.blob(part.blob);
            const perRow = bytes.length / Math.max(1, part.height);

            this.queue.writeTexture(
                { texture, mipLevel: part.level, origin: [0, 0, part.layer] },
                bytes,
                { bytesPerRow: perRow, rowsPerImage: part.height },
                [part.width, part.height, 1]
            );
        }

        if (record.unreadable && !multisampled && !/^depth|stencil/.test(record.format))
        {
            this.note(`A ${record.format} texture the frame used could not be read (${record.unreadable}) and is empty in the replay.`);
        }

        this.onTexture?.(texture, record.id);

        return texture;
    }

    makeBuffer (record: Json): any
    {
        const mappable = (record.usage & (BUFFER_MAP_READ | BUFFER_MAP_WRITE)) !== 0;
        const bytes = record.data === undefined || record.data === null ? null : this.blob(record.data);

        // A mappable buffer may carry almost no other usage, so it is filled while mapped at creation.
        const buffer = this.device.createBuffer({
            label: record.label ?? undefined,
            size: record.size,
            usage: mappable ? record.usage : (record.usage | BUFFER_COPY_SRC | BUFFER_COPY_DST),
            mappedAtCreation: mappable && bytes !== null && record.size % 4 === 0
        });

        if (bytes !== null)
        {
            if (buffer.mapState === 'mapped')
            {
                new Uint8Array(buffer.getMappedRange()).set(bytes);
                buffer.unmap();
            }
            else if (!mappable)
            {
                // Writes are in whole words.
                const whole = bytes.length - (bytes.length % 4);

                if (whole > 0)
                {
                    this.queue.writeBuffer(buffer, 0, bytes, 0, whole);
                }
            }
        }
        else if (record.unreadable && record.size > 0)
        {
            this.note(`A buffer the frame used could not be read (${record.unreadable}) and is empty in the replay.`);
        }

        return buffer;
    }

    // ---- Commands ----

    decode (value: Json): any
    {
        if (value === null || typeof value !== 'object')
        {
            return value;
        }

        if (Array.isArray(value))
        {
            return value.map((item) => this.decode(item));
        }

        if (value.$u === 1)
        {
            return undefined;
        }

        if (typeof value.l === 'number')
        {
            return this.objects.get(`l:${value.l}`) ?? null;
        }

        if (typeof value.o === 'string' && typeof value.i === 'number')
        {
            return this.object(value.o, value.i);
        }

        if (value.v && typeof value.v === 'object' && 't' in value.v)
        {
            return this.view(value.v.t, value.v.d);
        }

        if (value.dev === 1)
        {
            return this.device;
        }

        if (value.q === 1)
        {
            return this.queue;
        }

        if (value.ctx === 1)
        {
            return null;
        }

        if (typeof value.b === 'number' && typeof value.a === 'string')
        {
            // A copy, so that the view starts where the type needs it to.
            const bytes = this.blob(value.b).slice();

            return value.a === 'ArrayBuffer' ? bytes.buffer : new (TYPED[value.a] ?? Uint8Array)(bytes.buffer, 0, Math.floor(bytes.byteLength / ((TYPED[value.a] ?? Uint8Array).BYTES_PER_ELEMENT)));
        }

        if (typeof value.x === 'string')
        {
            throw new Error(`a ${value.x}, which a capture cannot hold`);
        }

        const out: Record<string, any> = {};

        for (const key of Object.keys(value))
        {
            out[key] = this.decode(value[key]);
        }

        return out;
    }

    // Which frame of a recording a command belongs to, counted from 0. Always 0 for a capture of one frame.
    frameOf (index: number): number
    {
        const marks: Json[] = this.data.header.frames ?? [];

        let frame = 0;

        while (frame < marks.length && marks[frame].command <= index)
        {
            frame++;
        }

        return frame;
    }

    name (index: number): [string, string]
    {
        const qualified = this.methods[this.data.commands[index][0]] ?? '';
        const dot = qualified.indexOf('.');

        return [qualified.slice(0, dot), qualified.slice(dot + 1)];
    }

    register (made: Json, result: any): void
    {
        if (!made || result === undefined || result === null)
        {
            return;
        }

        this.objects.set(typeof made.l === 'number' ? `l:${made.l}` : `${made.o}:${made.i}`, result);
    }

    keyOf (reference: Json): string
    {
        return typeof reference?.l === 'number' ? `l:${reference.l}` : `${reference?.o}:${reference?.i}`;
    }

    async execute (index: number): Promise<void>
    {
        if (this.scopes === null)
        {
            // One call that cannot be made must not stop the rest of the frame.
            try
            {
                await this.run(index);
            }
            catch (error: any)
            {
                const [owner, name] = this.name(index);

                this.failed++;
                this.note(`Call ${index} (${owner}.${name}) could not be replayed: ${String(error?.message ?? error)}.`);
            }

            return;
        }

        this.device.pushErrorScope('validation');

        try
        {
            await this.run(index);
        }
        catch (error: any)
        {
            this.errors.push({ command: index, error: `the replay could not make this call: ${String(error?.message ?? error)}` });
        }

        this.scopes.push(this.device.popErrorScope().then((raised: any) =>
        {
            if (raised)
            {
                this.errors.push({ command: index, error: String(raised.message) });
            }
        }));
    }

    async run (index: number): Promise<void>
    {
        const [, encoded, made, self] = this.data.commands[index];
        const [owner, name] = this.name(index);

        if (owner === 'GPUCanvasContext')
        {
            if (name === 'getCurrentTexture')
            {
                // In a recording of several frames, each frame's canvas texture starts empty.
                const frame = this.frameOf(index);

                if (frame !== this.canvasFrame)
                {
                    if (this.canvasFrame !== -1)
                    {
                        const encoder = this.device.createCommandEncoder();

                        encoder.beginRenderPass({ colorAttachments: [{ view: this.canvasTexture.createView(), clearValue: [0, 0, 0, 0], loadOp: 'clear', storeOp: 'store' }] }).end();
                        this.queue.submit([encoder.finish()]);
                    }

                    this.canvasFrame = frame;
                }

                this.register(made, this.canvasTexture);
            }

            return;
        }

        // Left out: an object destroyed in the frame may be a target that is read afterwards.
        if (name === 'destroy' || (owner === 'GPUDevice' && name.endsWith('Async')))
        {
            return;
        }

        if (name === 'importExternalTexture')
        {
            this.note('The frame imported an external texture (a video frame), which a capture cannot hold. Draws that sample it will fail in the replay.');

            return;
        }

        const receiver = this.decode(self);

        if (!receiver)
        {
            this.note(`A ${owner}.${name} call was made on an object the replay does not have.`);

            return;
        }

        if (owner === 'GPUBuffer' && name === 'unmap')
        {
            return this.unmap(receiver, encoded[0]);
        }

        if (owner === 'GPUQueue' && name === 'submit')
        {
            const buffers = (this.decode(encoded[0]) as any[]).filter((buffer) => buffer && !this.submitted.has(buffer));

            for (const buffer of buffers)
            {
                this.submitted.add(buffer);
            }

            this.pending = this.pending.filter((buffer) => !this.submitted.has(buffer));

            if (buffers.length)
            {
                this.queue.submit(buffers);
            }

            return;
        }

        if (owner === 'GPUQueue' && name === 'copyExternalImageToTexture')
        {
            const source = encoded[0]?.source;

            if (!source || typeof source.img !== 'number')
            {
                this.note('The frame copied an image the capture could not hold into a texture. That texture is not filled in the replay.');

                return;
            }

            const pixels = new ImageData(new Uint8ClampedArray(this.blob(source.img)), source.w, source.h);
            const bitmap = await createImageBitmap(pixels, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });

            this.queue.copyExternalImageToTexture({ ...this.decode({ ...encoded[0], source: null }), source: bitmap }, this.decode(encoded[1]), this.decode(encoded[2]));

            return;
        }

        if (typeof receiver[name] !== 'function')
        {
            this.note(`The replay's browser has no ${owner}.${name}.`);

            return;
        }

        const args: any[] = encoded.map((value: Json) => this.decode(value));

        if (owner === 'GPUCommandEncoder' && (name === 'beginRenderPass' || name === 'beginComputePass'))
        {
            const descriptor = name === 'beginRenderPass' ? (this.onBegin ? this.onBegin(this.kept(args[0]), index) : this.kept(args[0])) : args[0];
            const pass = name === 'beginRenderPass' ? receiver.beginRenderPass(descriptor) : receiver.beginComputePass(descriptor);

            // The depth-stencil texture that goes with each colour target of the pass.
            if (name === 'beginRenderPass' && descriptor?.depthStencilAttachment?.view)
            {
                const behind = this.viewOwner.get(descriptor.depthStencilAttachment.view);

                for (const attachment of descriptor.colorAttachments ?? [])
                {
                    const colour = attachment ? this.viewOwner.get(attachment.resolveTarget ?? attachment.view) : null;

                    if (colour && behind)
                    {
                        this.depthBehind.set(colour, behind);
                    }
                }
            }

            this.register(made, pass);
            this.open = { key: this.keyOf(made), encoderKey: this.keyOf(self), kind: name === 'beginRenderPass' ? 'render' : 'compute', descriptor, state: [] };

            return;
        }

        if (owner === 'GPUDevice' && name === 'createTexture' && args[0] && typeof args[0].usage === 'number')
        {
            // So that it can be read back, as the probe arranges in the page; and a depth or
            // stencil texture sampled, which is how the depth view reads it.
            args[0] = { ...args[0], usage: args[0].usage | ((args[0].sampleCount ?? 1) === 1 ? (COPY_SRC | COPY_DST) : 0) | (DEPTH_FORMATS[args[0].format] || (args[0].sampleCount ?? 1) > 1 ? TEXTURE_BINDING : 0) };
        }

        if (owner === 'GPUDevice' && name === 'createBuffer' && args[0] && typeof args[0].usage === 'number' && !(args[0].usage & BUFFER_MAP_READ))
        {
            // So that an analysis can read it, as buffers made before the frame can be.
            args[0] = { ...args[0], usage: args[0].usage | BUFFER_COPY_SRC };
        }

        let target = receiver;

        if (this.onDraw && this.open && owner === 'GPURenderPassEncoder' && (DRAW_CALLS.includes(name) || name === 'executeBundles'))
        {
            if (await this.onDraw(index, name, args))
            {
                return;
            }

            // The analysis may have split the pass, and this call belongs on what continues it.
            target = this.decode(self);
        }

        const result = target[name](...args);

        this.register(made, result);

        if (owner === 'GPUDevice' && name === 'createTexture' && result && typeof made?.i === 'number')
        {
            this.onTexture?.(result, made.i);
        }

        if (owner === 'GPUTexture' && name === 'createView' && result)
        {
            this.viewOwner.set(result, receiver);
        }

        if (owner === 'GPUDevice' && name === 'createCommandEncoder')
        {
            this.encoders.push({ key: this.keyOf(made), encoder: result });
        }
        else if (owner === 'GPUCommandEncoder' && name === 'finish')
        {
            this.encoders = this.encoders.filter((entry) => entry.key !== this.keyOf(self));
            this.pending.push(result);
        }
        else if (owner === 'GPURenderPassEncoder' || owner === 'GPUComputePassEncoder')
        {
            if (name === 'end')
            {
                if (this.open?.kind === 'render')
                {
                    this.onEnd?.(this.open, this.objects.get(this.open.encoderKey));
                }

                this.open = null;
            }
            else if (this.open && PASS_STATE.includes(name))
            {
                this.open.state.push(index);
            }
        }
    }

    // A render pass descriptor that keeps what the pass draws, so it can be read and carried on from.
    kept (descriptor: Json): Json
    {
        const out = { ...descriptor };

        delete out.timestampWrites;

        out.colorAttachments = Array.from(descriptor.colorAttachments ?? [], (attachment: any) => (attachment ? { ...attachment, storeOp: 'store' } : attachment));

        if (descriptor.depthStencilAttachment)
        {
            const depth = { ...descriptor.depthStencilAttachment };

            if (depth.depthStoreOp)
            {
                depth.depthStoreOp = 'store';
            }

            if (depth.stencilStoreOp)
            {
                depth.stencilStoreOp = 'store';
            }

            out.depthStencilAttachment = depth;
        }

        return out;
    }

    // The same pass again, picking up where it was left.
    continued (descriptor: Json): Json
    {
        const out = { ...descriptor };

        out.colorAttachments = Array.from(descriptor.colorAttachments ?? [], (attachment: any) =>
        {
            if (!attachment)
            {
                return attachment;
            }

            const next = { ...attachment, loadOp: 'load' };

            delete next.clearValue;

            return next;
        });

        if (descriptor.depthStencilAttachment)
        {
            const depth = { ...descriptor.depthStencilAttachment };

            if (depth.depthLoadOp)
            {
                depth.depthLoadOp = 'load';
            }

            if (depth.stencilLoadOp)
            {
                depth.stencilLoadOp = 'load';
            }

            out.depthStencilAttachment = depth;
        }

        return out;
    }

    async unmap (buffer: any, written: Json): Promise<void>
    {
        if (!Array.isArray(written) || written.length === 0)
        {
            if (buffer.mapState === 'mapped')
            {
                buffer.unmap();
            }

            return;
        }

        if (buffer.mapState !== 'mapped')
        {
            try
            {
                await buffer.mapAsync(0x0002);
            }
            catch
            {
                this.note('A buffer the frame wrote to while mapped could not be mapped in the replay.');

                return;
            }
        }

        for (const range of written)
        {
            const bytes = this.blob(range.b);

            new Uint8Array(buffer.getMappedRange(range.o, bytes.length)).set(bytes);
        }

        buffer.unmap();
    }

    // Makes everything issued so far take effect, and leaves the frame able to carry on.
    async flush (): Promise<void>
    {
        const open = this.open;

        if (open)
        {
            this.objects.get(open.key)?.end();

            if (open.kind === 'render')
            {
                this.onEnd?.(open, this.objects.get(open.encoderKey));
            }
        }

        // Command buffers finished earlier come first, then every encoder still open.
        const buffers = this.pending;

        this.pending = [];

        for (const entry of this.encoders)
        {
            buffers.push(entry.encoder.finish());
            entry.encoder = this.device.createCommandEncoder();
            this.objects.set(entry.key, entry.encoder);
        }

        for (const buffer of buffers)
        {
            this.submitted.add(buffer);
        }

        if (buffers.length)
        {
            this.queue.submit(buffers);
        }

        if (open)
        {
            const encoder = this.objects.get(open.encoderKey);

            if (open.kind === 'render')
            {
                open.descriptor = this.continued(open.descriptor);
            }

            this.objects.set(open.key, open.kind === 'render' ? encoder.beginRenderPass(open.descriptor) : encoder.beginComputePass(open.descriptor));

            // The state the old pass had set.
            const state = open.state;

            open.state = [];

            for (const index of state)
            {
                await this.run(index);
            }
        }
    }

    // Runs the capture from its start up to, but not including, command `end`.
    async play (end: number, after?: (index: number) => Promise<void>, before?: (index: number) => Promise<void>): Promise<void>
    {
        const stop = Math.min(end, this.data.commands.length);

        for (let i = 0; i < stop; i++)
        {
            if (before)
            {
                await before(i);
            }

            await this.execute(i);

            if (after)
            {
                await after(i);
            }
        }
    }

    // ---- What an analysis asks of the pass that is open ----

    // The pass that is open, as it stands now: a flush replaces it.
    pass (): any
    {
        return this.open ? this.objects.get(this.open.key) : null;
    }

    // What the open pass has set, read from the calls that set it.
    now (): PassNow
    {
        const out: PassNow = { pipeline: null, groups: new Map(), vertex: new Map(), index: null, viewport: null, scissor: null };
        const given = (value: Json): any => (value && typeof value === 'object' && value.$u === 1 ? undefined : value);

        for (const index of this.open?.state ?? [])
        {
            const [, encoded] = this.data.commands[index];
            const [, name] = this.name(index);

            switch (name)
            {
                case 'setPipeline':
                    out.pipeline = encoded[0]?.i ?? null;
                    break;

                case 'setBindGroup':
                    if (encoded[1] && typeof encoded[1].i === 'number')
                    {
                        out.groups.set(Number(encoded[0]) || 0, { id: encoded[1].i, offsets: encoded.slice(2).map((value: Json) => this.decode(value)) });
                    }
                    else
                    {
                        out.groups.delete(Number(encoded[0]) || 0);
                    }
                    break;

                case 'setVertexBuffer':
                    if (encoded[1] && typeof encoded[1].i === 'number')
                    {
                        out.vertex.set(Number(encoded[0]) || 0, { id: encoded[1].i, offset: given(encoded[2]) ?? 0, size: given(encoded[3]) ?? null });
                    }
                    else
                    {
                        out.vertex.delete(Number(encoded[0]) || 0);
                    }
                    break;

                case 'setIndexBuffer':
                    out.index = encoded[0] && typeof encoded[0].i === 'number' ? { id: encoded[0].i, format: String(encoded[1]), offset: given(encoded[2]) ?? 0, size: given(encoded[3]) ?? null } : null;
                    break;

                case 'setViewport':
                    out.viewport = encoded.slice(0, 6).map(Number);
                    break;

                case 'setScissorRect':
                    out.scissor = encoded.slice(0, 4).map(Number);
                    break;
            }
        }

        return out;
    }

    // Sets on another pass what the open pass has set, leaving out the calls named.
    apply (pass: any, without: string[] = []): void
    {
        for (const index of this.open?.state ?? [])
        {
            const [, encoded] = this.data.commands[index];
            const [, name] = this.name(index);

            if (!without.includes(name) && typeof pass[name] === 'function')
            {
                pass[name](...encoded.map((value: Json) => this.decode(value)));
            }
        }
    }

    // Part of a buffer as it stands. Call flush first. Null when it cannot be read.
    async bytes (buffer: any, offset: number, size: number): Promise<Uint8Array | null>
    {
        if (!buffer || !(buffer.usage & BUFFER_COPY_SRC))
        {
            return null;
        }

        // Copies are in whole words.
        const from = Math.max(0, offset - (offset % 4));
        const length = Math.min(buffer.size - (buffer.size % 4), Math.ceil((offset + size) / 4) * 4) - from;

        if (length <= 0)
        {
            return null;
        }

        const into = this.device.createBuffer({ size: length, usage: BUFFER_MAP_READ | BUFFER_COPY_DST });
        const encoder = this.device.createCommandEncoder();

        encoder.copyBufferToBuffer(buffer, from, into, 0, length);
        this.queue.submit([encoder.finish()]);

        try
        {
            await into.mapAsync(0x0001);
        }
        catch
        {
            into.destroy();

            return null;
        }

        const out = new Uint8Array(into.getMappedRange()).slice(offset - from, offset - from + size);

        into.unmap();
        into.destroy();

        return out;
    }

    // Runs `body` and gives back what the browser said was invalid in it, or null.
    async checked (body: () => void): Promise<string | null>
    {
        this.device.pushErrorScope('validation');

        let thrown: string | null = null;

        try
        {
            body();
        }
        catch (error: any)
        {
            thrown = String(error?.message ?? error);
        }

        const raised = await this.device.popErrorScope();

        return thrown ?? (raised ? String(raised.message) : null);
    }

    // ---- Reading back ----

    texture (target: Json): any
    {
        if (!target || !target.texture)
        {
            return this.canvasTexture;
        }

        const texture = this.objects.get(`texture:${target.texture}`) ?? (this.records.get(`texture:${target.texture}`)?.createdInFrame ? null : this.object('texture', target.texture));

        if (!texture)
        {
            throw new Error(`Texture ${target.texture} has not been made at this point of the frame.`);
        }

        return texture;
    }

    // A target, or part of one, as it stands. Call flush first.
    async read (target: Json, region?: { x: number; y: number; w: number; h: number }): Promise<Raw>
    {
        const texture = this.texture(target);
        const level = target?.level ?? 0;
        const how = READABLE[texture.format];

        if (!how)
        {
            throw new Error(`A ${texture.format} target cannot be read back yet.`);
        }

        if (texture.sampleCount > 1)
        {
            throw new Error('A multisampled target cannot be read: read the texture it resolves to.');
        }

        const full = { x: 0, y: 0, w: Math.max(1, texture.width >> level), h: Math.max(1, texture.height >> level) };
        const area = region ?? full;

        if (area.x < 0 || area.y < 0 || area.x + area.w > full.w || area.y + area.h > full.h)
        {
            throw new Error(`(${area.x}, ${area.y}) is outside the target, which is ${full.w}×${full.h}.`);
        }

        const rowBytes = area.w * how.bytes;
        const stride = Math.ceil(rowBytes / 256) * 256;
        const buffer = this.device.createBuffer({ size: Math.max(4, stride * area.h), usage: BUFFER_MAP_READ | BUFFER_COPY_DST });
        const encoder = this.device.createCommandEncoder();

        encoder.copyTextureToBuffer({ texture, mipLevel: level, origin: { x: area.x, y: area.y, z: target?.layer ?? 0 } }, { buffer, bytesPerRow: stride, rowsPerImage: area.h }, { width: area.w, height: area.h, depthOrArrayLayers: 1 });
        this.queue.submit([encoder.finish()]);

        await buffer.mapAsync(0x0001);

        const mapped = new Uint8Array(buffer.getMappedRange());
        const data = new Uint8Array(rowBytes * area.h);

        for (let y = 0; y < area.h; y++)
        {
            data.set(mapped.subarray(y * stride, y * stride + rowBytes), y * rowBytes);
        }

        buffer.unmap();
        buffer.destroy();

        return { width: area.w, height: area.h, format: texture.format, bytes: how.bytes, data };
    }

    dispose (): void
    {
        this.device.onuncapturederror = null;
        this.device.destroy();
    }
}

export function targetOf (row: Json): Json
{
    return row.target ? { texture: row.target, level: row.targetLevel || 0 } : null;
}

export function sameTarget (row: Json, target: Json): boolean
{
    return !row.noTarget && (row.target || 0) === (target?.texture || 0) && (!target?.texture || (row.targetLevel || 0) === (target.level || 0));
}

export function endOf (data: CaptureData, draw: number | null | undefined): number
{
    if (draw === null || draw === undefined)
    {
        return data.commands.length;
    }

    const row = data.draws[draw];

    if (!row)
    {
        throw new Error(`The capture has ${data.draws.length} events, numbered from 0; there is no draw ${draw}.`);
    }

    return row.command + 1;
}

export const gpuApi = {

    // The picture of a target after an event (or after the whole frame).
    async image (item: Loaded, methods: string[], args: { draw?: number | null; target?: Json }): Promise<Json>
    {
        const run = await GpuRun.create(item, methods);
        const started = performance.now();

        try
        {
            await run.play(endOf(item.data, args.draw));
            await run.flush();

            const row = args.draw === null || args.draw === undefined ? null : item.data.draws[args.draw];

            if (row?.noTarget && !args.target)
            {
                throw new Error(`Event ${args.draw} (${row.method}) draws to no colour target. Pass target to see a texture as it stood after it.`);
            }

            const target = args.target ?? (row ? targetOf(row) : null);
            const raw = await run.read(target);

            // Let anything the frame raised be reported before the count is read.
            await run.queue.onSubmittedWorkDone();

            return { width: raw.width, height: raw.height, data: toRgba8(raw), target, float: isFloat(raw.format), error: run.uncaptured + run.failed, notes: run.notes, ms: performance.now() - started };
        }
        finally
        {
            run.dispose();
        }
    },

    // The depth or the stencil buffer that goes with a target, after an event or at the end
    // of the frame. Depth is read by a pass that samples the depth texture into a float
    // target, which works for the formats a copy cannot read (depth24plus). Stencil is copied
    // out. Either way the answer is four bytes a pixel, as the WebGL recipes give it: a depth
    // as a 24-bit number in the first three, a stencil value in the first.
    async depthStencil (item: Loaded, methods: string[], args: { draw?: number | null; target?: Json; aspect: 'depth' | 'stencil' }): Promise<Json>
    {
        const run = await GpuRun.create(item, methods);

        try
        {
            await run.play(endOf(item.data, args.draw));
            await run.flush();

            const row = args.draw === null || args.draw === undefined ? null : item.data.draws[args.draw];
            const target = args.target ?? (row ? targetOf(row) : null);
            const behind = run.depthBehind.get(run.texture(target));
            const aspects = behind ? DEPTH_FORMATS[behind.format] : undefined;

            if (!behind || !aspects || !aspects[args.aspect])
            {
                return { unsupported: args.aspect === 'depth' ? 'no-depth' : 'no-stencil-buffer' };
            }

            const device = run.device;
            const width: number = behind.width;
            const height: number = behind.height;
            const data = new Uint8Array(width * height * 4);

            const copyOut = async (texture: any, aspect: string, bytes: number): Promise<Uint8Array> =>
            {
                const stride = Math.ceil(width * bytes / 256) * 256;
                const buffer = device.createBuffer({ size: Math.max(4, stride * height), usage: BUFFER_MAP_READ | BUFFER_COPY_DST });
                const encoder = device.createCommandEncoder();

                encoder.copyTextureToBuffer({ texture, aspect }, { buffer, bytesPerRow: stride, rowsPerImage: height }, { width, height, depthOrArrayLayers: 1 });
                run.queue.submit([encoder.finish()]);

                await buffer.mapAsync(0x0001);

                const mapped = new Uint8Array(buffer.getMappedRange());
                const out = new Uint8Array(width * height * bytes);

                for (let y = 0; y < height; y++)
                {
                    out.set(mapped.subarray(y * stride, y * stride + width * bytes), y * width * bytes);
                }

                buffer.unmap();
                buffer.destroy();

                return out;
            };

            if (args.aspect === 'stencil')
            {
                if (behind.sampleCount > 1)
                {
                    return { unsupported: 'multisampled-stencil' };
                }

                const values = await copyOut(behind, 'stencil-only', 1);

                for (let i = 0; i < values.length; i++)
                {
                    data[i * 4] = values[i];
                    data[i * 4 + 3] = 255;
                }
            }
            else
            {
                const multisampled = behind.sampleCount > 1;
                const module = device.createShaderModule({ code: `
                    @group(0) @binding(0) var depth: ${multisampled ? 'texture_depth_multisampled_2d' : 'texture_depth_2d'};
                    @vertex fn vertex (@builtin(vertex_index) index: u32) -> @builtin(position) vec4f
                    {
                        return vec4f(f32(i32(index) % 2) * 4.0 - 1.0, f32(i32(index) / 2) * 4.0 - 1.0, 0.0, 1.0);
                    }
                    @fragment fn fragment (@builtin(position) at: vec4f) -> @location(0) vec4f
                    {
                        return vec4f(textureLoad(depth, vec2i(at.xy), 0), 0.0, 0.0, 1.0);
                    }` });
                const pipeline = device.createRenderPipeline({
                    layout: 'auto',
                    vertex: { module, entryPoint: 'vertex' },
                    fragment: { module, entryPoint: 'fragment', targets: [{ format: 'r32float' }] }
                });
                const out = device.createTexture({ size: [width, height], format: 'r32float', usage: RENDER_ATTACHMENT | COPY_SRC });
                const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: behind.createView({ aspect: 'depth-only' }) }] });
                const encoder = device.createCommandEncoder();
                const pass = encoder.beginRenderPass({ colorAttachments: [{ view: out.createView(), clearValue: [0, 0, 0, 0], loadOp: 'clear', storeOp: 'store' }] });

                pass.setPipeline(pipeline);
                pass.setBindGroup(0, group);
                pass.draw(3);
                pass.end();
                run.queue.submit([encoder.finish()]);

                const depths = new Float32Array((await copyOut(out, 'all', 4)).buffer);

                for (let i = 0; i < depths.length; i++)
                {
                    const n = Math.min(16777215, Math.round(Math.min(1, Math.max(0, depths[i])) * 16777215));

                    data[i * 4] = n & 255;
                    data[i * 4 + 1] = (n >> 8) & 255;
                    data[i * 4 + 2] = (n >> 16) & 255;
                    data[i * 4 + 3] = 255;
                }

                out.destroy();
            }

            await run.queue.onSubmittedWorkDone();

            return { width, height, data, format: behind.format, error: run.uncaptured + run.failed, notes: run.notes };
        }
        finally
        {
            run.dispose();
        }
    },

    // Which calls raised a validation error, and what the browser said.
    async errors (item: Loaded, methods: string[]): Promise<Json>
    {
        const run = await GpuRun.create(item, methods);

        try
        {
            run.scopes = [];

            await run.play(item.data.commands.length);
            await run.flush();
            await Promise.all(run.scopes);

            return { errors: run.errors.sort((a, b) => a.command - b.command).slice(0, 200), notes: run.notes };
        }
        finally
        {
            run.dispose();
        }
    },

    // What each event did to its own target: how many pixels it changed, and the box they fall in.
    async effects (item: Loaded, methods: string[], args: { budget?: number }): Promise<Json>
    {
        const data = item.data;
        const started = performance.now();
        const budget = args.budget ?? 600e6;

        let cost = 0;

        for (const row of data.draws)
        {
            const texture = row.target ? data.objects.find((object) => object.kind === 'texture' && object.id === row.target) : null;
            const level = row.targetLevel || 0;

            cost += texture ? Math.max(1, texture.width >> level) * Math.max(1, texture.height >> level) : data.header.width * data.header.height;
        }

        if (cost > budget)
        {
            return { skipped: true, cost, budget };
        }

        const run = await GpuRun.create(item, methods);

        try
        {
            const byCommand = new Map<number, number>();

            data.draws.forEach((row, index) => byCommand.set(row.command, index));

            const keyOf = (row: Json): string => (row.target ? `${row.target}:${row.targetLevel || 0}` : 'canvas');
            const held = new Map<string, Raw>();
            const effects: Json[] = [];

            let before: Raw | null = null;

            await run.play(data.commands.length, async (index) =>
            {
                const draw = byCommand.get(index);

                if (draw === undefined)
                {
                    return;
                }

                const row = data.draws[draw];

                if (row.noTarget)
                {
                    effects.push({ draw, none: true });

                    // A compute pass may have written to anything.
                    held.clear();

                    return;
                }

                let after: Raw;

                try
                {
                    await run.flush();
                    after = await run.read(targetOf(row));
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
                const { width, height, bytes } = after;

                let changed = 0;
                let left = width;
                let right = -1;
                let top = height;
                let bottom = -1;

                for (let y = 0; y < height; y++)
                {
                    for (let x = 0; x < width; x++)
                    {
                        const at = (y * width + x) * bytes;

                        for (let k = 0; k < bytes; k++)
                        {
                            if (a[at + k] !== b[at + k])
                            {
                                changed++;

                                if (x < left) { left = x; }
                                if (x > right) { right = x; }
                                if (y < top) { top = y; }
                                if (y > bottom) { bottom = y; }

                                break;
                            }
                        }
                    }
                }

                effects.push(changed === 0 ? { draw, changed } : { draw, changed, x: left, y: top, w: right - left + 1, h: bottom - top + 1 });
            },
            async (index) =>
            {
                const draw = byCommand.get(index);

                if (draw === undefined)
                {
                    const [, name] = run.name(index);

                    // Writes that are not events can change a texture too.
                    if (name === 'writeTexture' || name === 'copyExternalImageToTexture')
                    {
                        held.clear();
                    }

                    return;
                }

                const row = data.draws[draw];

                before = row.noTarget ? null : (held.get(keyOf(row)) ?? null);

                if (!before && !row.noTarget)
                {
                    try
                    {
                        await run.flush();
                        before = await run.read(targetOf(row));
                    }
                    catch
                    {
                        before = null;
                    }
                }
            });

            return { effects, cost, notes: run.notes, ms: performance.now() - started };
        }
        finally
        {
            run.dispose();
        }
    },

    // The canvas at the end of each frame of a recording.
    async frames (item: Loaded, methods: string[], lastOf: Map<number, number>, keep: (frame: number, width: number, height: number, data: Uint8Array) => void): Promise<string[]>
    {
        const run = await GpuRun.create(item, methods);

        try
        {
            await run.play(item.data.commands.length, async (index) =>
            {
                const frame = lastOf.get(index);

                if (frame !== undefined)
                {
                    await run.flush();

                    const raw = await run.read(null);

                    keep(frame, raw.width, raw.height, toRgba8(raw));
                }
            });

            return run.notes;
        }
        finally
        {
            run.dispose();
        }
    },

    // Every event that changed one pixel of a target, in order, with the value before and after.
    async trace (item: Loaded, methods: string[], args: { x: number; y: number; target?: Json }): Promise<Json>
    {
        const run = await GpuRun.create(item, methods);
        const started = performance.now();

        try
        {
            const byCommand = new Map<number, number>();

            item.data.draws.forEach((row, index) => byCommand.set(row.command, index));

            const changes: Json[] = [];

            let before: number[] | null = null;
            let touched = 0;
            let float = false;

            await run.play(item.data.commands.length, async (index) =>
            {
                const draw = byCommand.get(index);

                if (draw === undefined || !sameTarget(item.data.draws[draw], args.target))
                {
                    return;
                }

                await run.flush();

                const raw = await run.read(args.target ?? null, { x: args.x, y: args.y, w: 1, h: 1 });
                const value = pixelOf(raw, 0);

                float = isFloat(raw.format);
                touched++;

                if (before === null || value.some((channel, i) => channel !== before![i]))
                {
                    changes.push({ draw, before, after: value });
                    before = value;
                }
            });

            return { changes, events: touched, float, final: before, error: run.uncaptured, notes: run.notes, ms: performance.now() - started };
        }
        finally
        {
            run.dispose();
        }
    }
};
