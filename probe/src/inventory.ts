// What the host can ask about the registry: lists, one object in full, memory, GL state.

import { currentFrame } from './clock/gate';
import { allContexts, contextById, type ContextInfo } from './contexts';
import { formatName } from './gl/formats';
import { CAP_CODES, trackerFor, type UniformSlot } from './gl/tracker';
import { verify } from './gl/verify';
import { natives } from './hooks/install';
import { G } from './natives';
import { alive, all, entryOf, find, kinds, prune, siteText, type Entry, type Kind } from './registry';
import { expose } from './transport';

const TARGETS: Record<number, string> = { 0x0DE1: '2D', 0x8513: 'cube', 0x806F: '3D', 0x8C1A: '2D array' };
const SHADER_TYPES: Record<number, string> = { 0x8B31: 'vertex', 0x8B30: 'fragment' };
const BUFFER_USAGE: Array<[number, string]> = [
    [0x0001, 'MAP_READ'], [0x0002, 'MAP_WRITE'], [0x0004, 'COPY_SRC'], [0x0008, 'COPY_DST'], [0x0010, 'INDEX'],
    [0x0020, 'VERTEX'], [0x0040, 'UNIFORM'], [0x0080, 'STORAGE'], [0x0100, 'INDIRECT'], [0x0200, 'QUERY_RESOLVE']
];
const TEXTURE_USAGE: Array<[number, string]> = [
    [0x01, 'COPY_SRC'], [0x02, 'COPY_DST'], [0x04, 'TEXTURE_BINDING'], [0x08, 'STORAGE_BINDING'], [0x10, 'RENDER_ATTACHMENT']
];

function flags (value: unknown, names: Array<[number, string]>): string
{
    if (typeof value !== 'number')
    {
        return '';
    }

    return names.filter(([bit]) => (value & bit) !== 0).map(([, name]) => name).join('|');
}

// One line saying what an object is: "2048×2048 RGBA8, 12 levels".
function what (entry: Entry): string
{
    const p = entry.p;

    switch (entry.kind)
    {
        case 'texture':
            if (entry.api === 'webgpu')
            {
                return `${p.width}×${p.height}${p.depthOrArrayLayers > 1 ? `×${p.depthOrArrayLayers}` : ''} ${p.format}`
                    + (p.mipLevelCount > 1 ? `, ${p.mipLevelCount} levels` : '')
                    + (p.sampleCount > 1 ? `, ${p.sampleCount}× MSAA` : '')
                    + (p.dimension !== '2d' ? `, ${p.dimension}` : '');
            }

            if (!p.width)
            {
                return 'no storage yet';
            }

            return `${p.width}×${p.height}${p.depth > 1 ? `×${p.depth}` : ''} ${formatName(p.internalFormat)}`
                + (p.levels > 1 ? `, ${p.levels} levels` : '')
                + (p.target !== undefined && p.target !== 0x0DE1 ? `, ${TARGETS[p.target] ?? 'unknown target'}` : '')
                + (p.renderTarget ? ', render target' : '');

        case 'buffer':
            if (entry.api === 'webgpu')
            {
                return `${p.size} bytes, ${flags(p.usage, BUFFER_USAGE)}`;
            }

            return `${p.size} bytes${p.element === true ? ', index' : (p.element === false ? ', vertex or data' : ', never bound')}`;

        case 'shader':
            return entry.api === 'webgpu'
                ? `WGSL, ${p.source.length} characters`
                : `${SHADER_TYPES[p.type] ?? 'unknown'} shader, ${p.source.length} characters${p.compiles === 0 ? ', never compiled' : ''}`;

        case 'program':
            return `${p.shaders.length} shaders${p.links === 0 ? ', never linked' : (p.links > 1 ? `, linked ${p.links} times` : '')}`;

        case 'pipeline':
            return `${p.type} pipeline${p.async ? ', created asynchronously' : ''}`;

        case 'framebuffer':
            return `${G.Object.keys(p.attachments).length} attachments`;

        case 'renderbuffer':
            return p.width ? `${p.width}×${p.height} ${formatName(p.internalFormat)}${p.samples > 1 ? `, ${p.samples}× MSAA` : ''}` : 'no storage yet';

        case 'layout':
            return `${p.type} layout`;

        case 'query':
            return p.transformFeedback ? 'transform feedback' : (p.type ? `${p.type} query set of ${p.count}` : 'query');

        default:
            return '';
    }
}

function row (entry: Entry): Record<string, unknown>
{
    return {
        id: entry.id,
        kind: entry.kind,
        api: entry.api,
        context: entry.context,
        label: entry.label,
        what: what(entry),
        bytes: entry.bytes,
        created: entry.created,
        used: entry.used,
        written: entry.written,
        alive: alive(entry),
        destroyedAt: entry.destroyed ? entry.destroyedAt : null,
        site: siteText(entry.site)
    };
}

function contextOf (entry: Entry): ContextInfo | undefined
{
    return entry.api === 'webgl' ? contextById(entry.context) : undefined;
}

const UNIFORM_TYPES: Record<number, string> = {
    0x1406: 'float', 0x8B50: 'vec2', 0x8B51: 'vec3', 0x8B52: 'vec4', 0x1404: 'int', 0x8B53: 'ivec2', 0x8B54: 'ivec3',
    0x8B55: 'ivec4', 0x1405: 'uint', 0x8DC6: 'uvec2', 0x8DC7: 'uvec3', 0x8DC8: 'uvec4', 0x8B56: 'bool', 0x8B57: 'bvec2',
    0x8B58: 'bvec3', 0x8B59: 'bvec4', 0x8B5A: 'mat2', 0x8B5B: 'mat3', 0x8B5C: 'mat4', 0x8B5E: 'sampler2D',
    0x8B60: 'samplerCube', 0x8B5F: 'sampler3D', 0x8DC1: 'sampler2DArray', 0x8B62: 'sampler2DShadow'
};

// Everything about one object, including what only the context can say (compile logs,
// link status, active uniforms). Those are asked of the context now, natively.
async function detail (entry: Entry): Promise<Record<string, unknown>>
{
    const out: Record<string, unknown> = { ...row(entry) };
    const object = entry.ref.deref() as any;
    const info = contextOf(entry);
    const p = entry.p;

    if (entry.api === 'webgpu')
    {
        const { device, ...rest } = p;

        G.Object.assign(out, rest, { device });

        if (entry.kind === 'texture')
        {
            out.usage = flags(p.usage, TEXTURE_USAGE);
        }
        else if (entry.kind === 'buffer')
        {
            out.usage = flags(p.usage, BUFFER_USAGE);
        }
        else if (entry.kind === 'shader' && object)
        {
            try
            {
                const messages = await natives.GPUShaderModule?.getCompilationInfo?.call(object) ?? await object.getCompilationInfo();

                out.messages = G.Array.from(messages.messages as ArrayLike<any>, (message: any) => ({
                    type: message.type,
                    line: message.lineNum,
                    column: message.linePos,
                    text: G.String(message.message)
                }));
            }
            catch
            {
                out.messages = null;
            }
        }

        return out;
    }

    const gl = info?.ctx;
    const n = info?.natives;
    const usable = Boolean(gl && n && object && !info!.lost && alive(entry));

    switch (entry.kind)
    {
        case 'shader':
            out.type = SHADER_TYPES[p.type] ?? 'unknown';
            out.source = p.source;
            out.compiles = p.compiles;

            if (usable && p.compiles > 0)
            {
                out.compiled = n!.getShaderParameter.call(gl, object, 0x8B81);
                out.log = G.String(n!.getShaderInfoLog.call(gl, object) ?? '');

                // What the browser actually compiled: ANGLE's translation of the source.
                const debug = n!.getExtension.call(gl, 'WEBGL_debug_shaders');

                out.translated = debug ? G.String(debug.getTranslatedShaderSource(object)) : null;
            }

            break;

        case 'program':
        {
            out.shaders = p.shaders;
            out.links = p.links;

            if (usable && p.links > 0)
            {
                out.linked = n!.getProgramParameter.call(gl, object, 0x8B82);
                out.log = G.String(n!.getProgramInfoLog.call(gl, object) ?? '');

                const attributes = [];
                const attributeCount: number = n!.getProgramParameter.call(gl, object, 0x8B89) ?? 0;

                for (let i = 0; i < attributeCount; i++)
                {
                    const active = n!.getActiveAttrib.call(gl, object, i);

                    if (active)
                    {
                        attributes.push({ name: active.name, type: UNIFORM_TYPES[active.type] ?? active.type, size: active.size, location: n!.getAttribLocation.call(gl, object, active.name) });
                    }
                }

                const uniforms = [];
                const uniformCount: number = n!.getProgramParameter.call(gl, object, 0x8B86) ?? 0;
                const slots: Map<string, UniformSlot> = p.uniforms;

                for (let i = 0; i < uniformCount; i++)
                {
                    const active = n!.getActiveUniform.call(gl, object, i);

                    if (!active)
                    {
                        continue;
                    }

                    // The page may have asked for "lights" or "lights[0]"; both name the same uniform.
                    const slot = slots.get(active.name) ?? slots.get(active.name.replace(/\[0\]$/, ''));

                    uniforms.push({
                        name: active.name,
                        type: UNIFORM_TYPES[active.type] ?? active.type,
                        size: active.size,
                        // The last value the page set. Null: never set since the last link, so it holds its default.
                        value: slot && slot.set >= 0 ? slot.values.slice(0, 64) : null,
                        setAt: slot && slot.set >= 0 ? slot.set : null
                    });
                }

                out.attributes = attributes;
                out.uniforms = uniforms;
            }

            break;
        }

        case 'texture':
            G.Object.assign(out, {
                target: TARGETS[p.target] ?? null,
                width: p.width ?? 0,
                height: p.height ?? 0,
                depth: p.depth ?? 1,
                format: p.internalFormat === undefined ? null : formatName(p.internalFormat),
                levels: p.levels,
                immutable: Boolean(p.immutable),
                compressed: Boolean(p.compressed),
                renderTarget: Boolean(p.renderTarget),
                generatedMips: Boolean(p.generatedMips),
                params: p.params
            });
            break;

        case 'framebuffer':
            out.attachments = p.attachments;
            out.drawBuffers = p.drawBuffers ?? null;
            break;

        default:
        {
            const { uniforms, ...rest } = p;

            G.Object.assign(out, rest);
        }
    }

    return out;
}

const RENDER_ATTACHMENT = 0x10;

function isRenderTarget (entry: Entry): boolean
{
    return entry.api === 'webgpu' ? typeof entry.p.usage === 'number' && (entry.p.usage & RENDER_ATTACHMENT) !== 0 : Boolean(entry.p.renderTarget);
}

// Estimated memory of a canvas's drawing buffer: colour front and back, plus depth and
// stencil and multisample storage where the context asked for them.
function canvasBytes (info: ContextInfo): number
{
    const pixels = info.canvas.width * info.canvas.height;

    if (info.api === 'webgpu')
    {
        return info.gpu ? pixels * (info.gpu.format === 'rgba16float' ? 8 : 4) * 2 : 0;
    }

    const attributes = (info.attributes ?? {}) as { depth?: boolean; stencil?: boolean; antialias?: boolean };
    const depthStencil = attributes.depth || attributes.stencil ? 4 : 0;
    const samples = attributes.antialias ? 4 : 0;

    return pixels * (4 * 2 + depthStencil + (4 + depthStencil) * samples);
}

export function installInventory (): void
{
    expose('registry.list', (args: { kind?: Kind; dead?: boolean; sort?: string; filter?: string; offset?: number; limit?: number }) =>
    {
        prune();

        const wanted = args.kind ? [args.kind] : kinds();
        const needle = args.filter ? args.filter.toLowerCase() : null;

        let rows = wanted.flatMap((kind) => all(kind)).filter((entry) => args.dead || alive(entry)).map(row);

        if (needle)
        {
            rows = rows.filter((entry) => `${entry.label ?? ''} ${entry.what} ${entry.site}`.toLowerCase().includes(needle));
        }

        const key = args.sort === 'created' ? 'created' : (args.sort === 'last_used' ? 'used' : 'bytes');

        // Ties go to the lower ID, except "newest first", where the higher ID is the newer.
        rows.sort((a: any, b: any) => (b[key] - a[key]) || (key === 'created' ? b.id - a.id : a.id - b.id));

        const offset = args.offset ?? 0;

        return { total: rows.length, rows: rows.slice(offset, offset + (args.limit ?? 25)) };
    });

    expose('registry.get', (args: { kind: Kind; id: number }) =>
    {
        const entry = find(args.kind, args.id);

        if (!entry)
        {
            throw new Error(`No ${args.kind} ${args.id}. It may have been destroyed long ago and dropped from the registry.`);
        }

        return detail(entry);
    });

    // Estimated bytes by category, and counts by kind. Provenance: estimated.
    expose('registry.summary', () =>
    {
        const byKind: Record<string, { alive: number; bytes: number; created: number }> = {};
        const categories = { textures: 0, renderTargets: 0, buffers: 0, renderbuffers: 0, canvases: 0 };

        for (const kind of kinds())
        {
            const list = all(kind);
            const live = list.filter(alive);

            byKind[kind] = { alive: live.length, bytes: live.reduce((sum, entry) => sum + entry.bytes, 0), created: list.length ? list[list.length - 1].id : 0 };

            for (const entry of live)
            {
                if (kind === 'texture')
                {
                    categories[isRenderTarget(entry) ? 'renderTargets' : 'textures'] += entry.bytes;
                }
                else if (kind === 'buffer')
                {
                    categories.buffers += entry.bytes;
                }
                else if (kind === 'renderbuffer')
                {
                    categories.renderbuffers += entry.bytes;
                }
            }
        }

        for (const info of allContexts())
        {
            if (info.api === 'webgl' || info.api === 'webgl2' || info.api === 'webgpu')
            {
                categories.canvases += canvasBytes(info);
            }
        }

        // Lines of code that many live objects came from: where a leak shows first.
        const sites: { kind: string; site: string; alive: number; bytes: number; first: number; last: number }[] = [];

        for (const kind of kinds())
        {
            const groups: Map<number, { alive: number; bytes: number; first: number; last: number }> = new G.Map();

            for (const entry of all(kind))
            {
                if (!alive(entry))
                {
                    continue;
                }

                const group = groups.get(entry.site);

                if (group)
                {
                    group.alive++;
                    group.bytes += entry.bytes;
                    group.first = Math.min(group.first, entry.created);
                    group.last = Math.max(group.last, entry.created);
                }
                else
                {
                    groups.set(entry.site, { alive: 1, bytes: entry.bytes, first: entry.created, last: entry.created });
                }
            }

            for (const [site, group] of groups)
            {
                // Created over several frames, not all at once in a loader.
                if (group.alive >= 8 && group.last - group.first >= 4)
                {
                    sites.push({ kind, site: siteText(site), ...group });
                }
            }
        }

        sites.sort((a, b) => b.alive - a.alive);

        return { byKind, categories, sites: sites.slice(0, 6), frame: currentFrame(), total: (G.Object.values(categories) as number[]).reduce((a, b) => a + b, 0) };
    });

    // Every live object that holds memory, compactly, for the host to keep and compare.
    expose('registry.snapshot', () =>
    {
        const rows: unknown[] = [];

        for (const kind of ['texture', 'buffer', 'renderbuffer'] as const)
        {
            for (const entry of all(kind))
            {
                if (alive(entry))
                {
                    rows.push([kind, entry.id, entry.bytes, siteText(entry.site), entry.created, what(entry), entry.label]);
                }
            }
        }

        return { rows };
    });

    expose('registry.verify', (args: { context?: number }) =>
    {
        return allContexts()
            .filter((info) => (info.api === 'webgl' || info.api === 'webgl2') && (args.context === undefined || info.id === args.context))
            .map((info) => ({ context: info.id, ...verify(info) }));
    });

    // The state a draw issued now would use, from the mirror: no questions asked of the context.
    expose('registry.state', (args: { context: number }) =>
    {
        const info = contextById(args.context);
        const t = info ? trackerFor(info) : null;

        if (!info || !t)
        {
            throw new Error(`Context ${args.context} is not a WebGL context. WebGPU has no global state: the state of a draw is its pipeline and bind groups.`);
        }

        // 0 for an object the registry has no record of.
        const id = (object: object | null): number | null => (object ? entryOf(object)?.id ?? 0 : null);

        const enabled: number[] = [];

        for (let i = 0; i < CAP_CODES.length; i++)
        {
            if (t.caps[i] === 1)
            {
                enabled.push(CAP_CODES[i]);
            }
        }

        return {
            program: id(t.program),
            framebuffer: id(t.drawFramebuffer),
            readFramebuffer: id(t.readFramebuffer),
            vertexArray: id(t.vaoObject),
            arrayBuffer: id(t.arrayBuffer),
            elementBuffer: id(t.vao.element),
            activeUnit: t.unit,
            textures: t.units.map((unit, index) => ({ unit: index, t2d: id(unit.t2d), cube: id(unit.cube), t3d: id(unit.t3d), array: id(unit.array), sampler: id(unit.sampler) }))
                .filter((unit) => unit.t2d !== null || unit.cube !== null || unit.t3d !== null || unit.array !== null),
            attributes: t.vao.attribs.map((attrib, index) => ({ index, ...attrib, buffer: id(attrib.buffer) })).filter((attrib) => attrib.enabled),
            enabled,
            viewport: t.viewport,
            scissor: t.scissor,
            blend: { color: t.blendColor, equationRgb: t.blendEquationRgb, equationAlpha: t.blendEquationAlpha, srcRgb: t.blendSrcRgb, dstRgb: t.blendDstRgb, srcAlpha: t.blendSrcAlpha, dstAlpha: t.blendDstAlpha },
            depth: { func: t.depthFunc, mask: t.depthMask, range: t.depthRange },
            stencil: { front: t.stencilFront, back: t.stencilBack },
            cull: { face: t.cullFace, frontFace: t.frontFace },
            colorMask: t.colorMask,
            clear: { color: t.clearColor, depth: t.clearDepth, stencil: t.clearStencil },
            polygonOffset: [t.polygonOffsetFactor, t.polygonOffsetUnits]
        };
    });
}
