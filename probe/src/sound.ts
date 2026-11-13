// Audio inspection (docs/GAME.md, section 4): the Web Audio graph as the page builds it, what is
// playing, the buffers and where they came from, levels, and changes made from the debugger
// (mute, solo, bypass, a parameter held).
//
// The probe keeps weak references only: a page's nodes and buffers are freed as they would be.
// Connections are recorded as the page makes them, by wrapping AudioNode's connect and
// disconnect, so the graph is the page's own. Each context gets one analyser, fed from whatever
// the page sends to its destination, for levels; it is not connected to anything audible.

import { currentFrame } from './clock/gate';
import { config } from './config';
import { disguise, patch } from './masquerade';
import { declare } from './mods';
import { G, nAddEventListener, nDefineProperty, nSetTimeout, type Fn } from './natives';
import { emit, expose } from './transport';

interface NodeInfo
{
    id: string;
    ref: WeakRef<any>;
    type: string;
    context: string;
    frame: number;
    label?: string;
    // Scheduled sources: when start and stop were called, and whether it has ended.
    started?: { frame: number; at: number; when: number };
    stopped?: { frame: number; when: number };
    ended?: boolean;
}

interface Edge { to: string; output: number; input: number; param?: string }

interface ContextInfo
{
    id: string;
    ref: WeakRef<any>;
    kind: string;
    destination: string;
    tap: any | null;
    frame: number;
}

interface BufferInfo
{
    id: string;
    ref: WeakRef<any>;
    origin: 'decoded' | 'created' | 'seen';
    url?: string;
    frame: number;
    context?: string;
}

interface AudioPatch
{
    id: string;
    mode: 'mute' | 'solo' | 'bypass' | 'param';
    node: string;
    text: string;
    undo: () => void;
}

const nodeIds = new G.WeakMap() as WeakMap<object, string>;
const nodes = new G.Map() as Map<string, NodeInfo>;
const edges = new G.Map() as Map<string, Edge[]>;
const contextIds = new G.WeakMap() as WeakMap<object, string>;
const contexts = new G.Map() as Map<string, ContextInfo>;
const bufferIds = new G.WeakMap() as WeakMap<object, string>;
const buffers = new G.Map() as Map<string, BufferInfo>;
const mediaIds = new G.WeakMap() as WeakMap<object, string>;
const media = new G.Map() as Map<string, WeakRef<any>>;
const paramOwner = new G.WeakMap() as WeakMap<object, { node: string; name: string }>;
const paramNames = new G.WeakMap() as WeakMap<object, string[]>;
const automation = new G.WeakMap() as WeakMap<object, Array<{ call: string; args: unknown[]; frame: number }>>;
const urlOf = new G.WeakMap() as WeakMap<object, string>;
const muted = new G.Set() as Set<string>;
const patches: AudioPatch[] = [];
const clipped = new G.Set() as Set<string>;

const counter = { node: 0, context: 0, buffer: 0, media: 0, patch: 0 };
let nativeConnect: Fn | null = null;
let nativeDisconnect: Fn | null = null;
let installed = false;

const NODES = 2000;

function kindOf (object: unknown): string
{
    // The browser's own class name, which a page cannot change on a native object.
    const tag = G.Object.prototype.toString.call(object) as string;

    return tag.slice(8, -1);
}

function cut (value: unknown, most: number): string
{
    const text = G.String(value);

    return text.length > most ? `${text.slice(0, most - 1)}…` : text;
}

function contextOf (context: any): ContextInfo | null
{
    if (!context || typeof context !== 'object')
    {
        return null;
    }

    let id = contextIds.get(context);

    if (id === undefined)
    {
        id = `actx_${++counter.context}`;
        contextIds.set(context, id);

        const info: ContextInfo = { id, ref: new G.WeakRef(context), kind: kindOf(context), destination: '', tap: null, frame: currentFrame() };

        contexts.set(id, info);

        try
        {
            info.destination = see(context.destination);
        }
        catch
        {
            // A context the browser would not describe.
        }
    }

    return contexts.get(id) ?? null;
}

// The names of a node's AudioParams, found once for each kind of node.
function paramsOf (node: any): string[]
{
    const proto = G.Object.getPrototypeOf(node);
    const known = paramNames.get(proto);

    if (known)
    {
        return known;
    }

    const names: string[] = [];

    for (let owner = proto; owner && owner !== G.Object.prototype; owner = G.Object.getPrototypeOf(owner))
    {
        for (const name of G.Object.getOwnPropertyNames(owner) as string[])
        {
            const descriptor = G.Object.getOwnPropertyDescriptor(owner, name);

            if (descriptor?.get && !names.includes(name))
            {
                try
                {
                    if (descriptor.get.call(node) instanceof G.AudioParam)
                    {
                        names.push(name);
                    }
                }
                catch
                {
                    // Not readable on this node.
                }
            }
        }
    }

    paramNames.set(proto, names);

    return names;
}

// A node's handle, made the first time the probe sees it.
function see (node: any): string
{
    let id = nodeIds.get(node);

    if (id !== undefined)
    {
        return id;
    }

    id = `anode_${++counter.node}`;
    nodeIds.set(node, id);

    let context = '';

    try
    {
        context = contextOf(node.context)?.id ?? '';
    }
    catch
    {
        // Detached.
    }

    nodes.set(id, { id, ref: new G.WeakRef(node), type: kindOf(node), context, frame: currentFrame() });

    for (const name of paramsOf(node))
    {
        try
        {
            paramOwner.set(node[name], { node: id, name });
        }
        catch
        {
            // Not readable.
        }
    }

    if (nodes.size > NODES)
    {
        sweep();
    }

    return id;
}

function seeBuffer (buffer: any, origin: BufferInfo['origin'], url?: string, context?: string): string
{
    let id = bufferIds.get(buffer);

    if (id !== undefined)
    {
        const info = buffers.get(id);

        // Seen first on a source, then known to have been decoded.
        if (info && origin !== 'seen')
        {
            info.origin = origin;
            info.url = url ?? info.url;
        }

        return id;
    }

    id = `abuf_${++counter.buffer}`;
    bufferIds.set(buffer, id);
    buffers.set(id, { id, ref: new G.WeakRef(buffer), origin, url, frame: currentFrame(), context });

    return id;
}

function seeMedia (element: any): string
{
    let id = mediaIds.get(element);

    if (id === undefined)
    {
        id = `amedia_${++counter.media}`;
        mediaIds.set(element, id);
        media.set(id, new G.WeakRef(element));
    }

    return id;
}

// Forgets what the page has let go of.
function sweep (): void
{
    for (const [id, info] of nodes)
    {
        if (!info.ref.deref())
        {
            nodes.delete(id);
            edges.delete(id);
            muted.delete(id);
        }
    }

    for (const [id, info] of buffers)
    {
        if (!info.ref.deref())
        {
            buffers.delete(id);
        }
    }

    for (const [id, ref] of media)
    {
        if (!ref.deref())
        {
            media.delete(id);
        }
    }
}

function nodeOf (id: string): any
{
    return nodes.get(id)?.ref.deref() ?? null;
}

// The analyser a context's output is copied to, made when the page first sends something to
// its destination.
function tapOf (context: any): any
{
    const info = contextOf(context);

    if (!info || config.unmodified)
    {
        return null;
    }

    if (!info.tap)
    {
        try
        {
            // Made with the constructor, which is not wrapped, so the tap is not one of the page's nodes.
            const tap = new G.AnalyserNode(context, { fftSize: 2048 });

            info.tap = tap;
            nodeIds.set(tap, '');
        }
        catch
        {
            return null;
        }
    }

    return info.tap;
}

function isDestination (target: any): boolean
{
    return kindOf(target) === 'AudioDestinationNode';
}

// Where a connection goes, as an edge.
function edgeTo (target: any, output: number, input: number): Edge
{
    if (target instanceof G.AudioParam)
    {
        const owner = paramOwner.get(target);

        return { to: owner?.node ?? '?', output, input: 0, param: owner?.name ?? 'param' };
    }

    return { to: see(target), output, input };
}

function connectNatively (node: any, edge: Edge): void
{
    const target = edge.param ? nodeOf(edge.to)?.[edge.param] : nodeOf(edge.to);

    if (!target || !nativeConnect)
    {
        return;
    }

    try
    {
        if (edge.param)
        {
            nativeConnect.call(node, target, edge.output);
        }
        else
        {
            nativeConnect.call(node, target, edge.output, edge.input);
        }

        if (!edge.param && isDestination(target))
        {
            const tap = tapOf(target.context);

            if (tap)
            {
                nativeConnect.call(node, tap, edge.output);
            }
        }
    }
    catch
    {
        // The page has since changed something that makes this connection invalid.
    }
}

function disconnectNatively (node: any): void
{
    try
    {
        nativeDisconnect?.call(node);
    }
    catch
    {
        // Not connected.
    }
}

function installGraph (): void
{
    if (typeof G.AudioNode !== 'function')
    {
        return;
    }

    nativeConnect = patch(G.AudioNode.prototype, 'connect', (native) => function connect (this: any, target: any, ...rest: any[]): unknown
    {
        const from = see(this);
        const output = typeof rest[0] === 'number' ? rest[0] : 0;
        const input = typeof rest[1] === 'number' ? rest[1] : 0;
        let result: unknown;

        if (muted.has(from))
        {
            // A muted node's connections are kept, and made when it is heard again.
            result = target instanceof G.AudioNode ? target : undefined;
        }
        else
        {
            result = native.call(this, target, ...rest);
        }

        const list = edges.get(from) ?? [];
        const edge = edgeTo(target, output, input);

        if (!list.some((other) => other.to === edge.to && other.output === edge.output && other.input === edge.input && other.param === edge.param))
        {
            list.push(edge);
        }

        edges.set(from, list);

        if (!muted.has(from) && !edge.param && isDestination(target))
        {
            const tap = tapOf(target.context);

            if (tap)
            {
                try
                {
                    native.call(this, tap, output);
                }
                catch
                {
                    // The tap is the debugger's; the page's connection stands.
                }
            }
        }

        return result;
    });

    nativeDisconnect = patch(G.AudioNode.prototype, 'disconnect', (native) => function disconnect (this: any, ...args: any[]): unknown
    {
        const from = see(this);
        let result: unknown;

        try
        {
            result = native.apply(this, args);
        }
        catch (error)
        {
            // A muted node is not connected natively, so the browser would refuse.
            if (!muted.has(from))
            {
                throw error;
            }
        }

        const list = edges.get(from) ?? [];
        const [first, second, third] = args;
        let kept: Edge[];

        if (args.length === 0)
        {
            kept = [];
        }
        else if (typeof first === 'number')
        {
            kept = list.filter((edge) => edge.output !== first);
        }
        else
        {
            const target = edgeTo(first, 0, 0);

            kept = list.filter((edge) => !(edge.to === target.to && edge.param === target.param && (second === undefined || edge.output === second) && (third === undefined || edge.input === third)));

            if (!target.param && isDestination(first))
            {
                const tap = contextOf(first.context)?.tap;

                try
                {
                    if (tap)
                    {
                        native.call(this, tap);
                    }
                }
                catch
                {
                    // Not tapped.
                }
            }
        }

        edges.set(from, kept);

        return result;
    });

    // AudioBufferSourceNode has a start of its own (it takes an offset and a duration).
    const owners = [G.AudioScheduledSourceNode?.prototype, G.AudioBufferSourceNode?.prototype].filter((owner) => owner && G.Object.prototype.hasOwnProperty.call(owner, 'start'));

    for (const owner of owners)
    {
        patch(owner, 'start', (native) => function start (this: any, ...args: any[]): unknown
        {
            const result = native.apply(this, args);
            const info = nodes.get(see(this));

            if (info)
            {
                info.started = { frame: currentFrame(), at: this.context?.currentTime ?? 0, when: typeof args[0] === 'number' ? args[0] : 0 };
                info.ended = false;
                nAddEventListener.call(this, 'ended', () => { info.ended = true; });
            }

            try
            {
                if (this.buffer)
                {
                    seeBuffer(this.buffer, 'seen');
                }
            }
            catch
            {
                // Not a buffer source.
            }

            return result;
        });
    }

    for (const owner of [G.AudioScheduledSourceNode?.prototype, G.AudioBufferSourceNode?.prototype].filter((owner) => owner && G.Object.prototype.hasOwnProperty.call(owner, 'stop')))
    {
        patch(owner, 'stop', (native) => function stop (this: any, ...args: any[]): unknown
        {
            const result = native.apply(this, args);
            const info = nodes.get(see(this));

            if (info)
            {
                info.stopped = { frame: currentFrame(), when: typeof args[0] === 'number' ? args[0] : 0 };
            }

            return result;
        });
    }

    // Automation: the last calls on each parameter.
    for (const name of ['setValueAtTime', 'linearRampToValueAtTime', 'exponentialRampToValueAtTime', 'setTargetAtTime', 'setValueCurveAtTime', 'cancelScheduledValues', 'cancelAndHoldAtTime'])
    {
        if (typeof G.AudioParam?.prototype?.[name] !== 'function')
        {
            continue;
        }

        patch(G.AudioParam.prototype, name, (native) => function (this: any, ...args: any[]): unknown
        {
            const result = native.apply(this, args);
            const list = automation.get(this) ?? [];

            list.push({ call: name, args: args.map((arg) => (typeof arg === 'number' ? arg : kindOf(arg))), frame: currentFrame() });

            if (list.length > 16)
            {
                list.shift();
            }

            automation.set(this, list);

            return result;
        });
    }

    const Base = G.BaseAudioContext ?? G.AudioContext;

    if (typeof Base === 'function')
    {
        // Each node made by a context's factory is seen as it is made, so a node that is never
        // connected is still in the graph.
        for (const name of G.Object.getOwnPropertyNames(Base.prototype) as string[])
        {
            if (!name.startsWith('create') || name === 'createBuffer' || name === 'createPeriodicWave')
            {
                continue;
            }

            patch(Base.prototype, name, (native) => function (this: any, ...args: any[]): unknown
            {
                const made = native.apply(this, args);

                see(made);

                if (name === 'createMediaElementSource' && args[0])
                {
                    seeMedia(args[0]);
                }

                return made;
            });
        }

        patch(Base.prototype, 'createBuffer', (native) => function createBuffer (this: any, ...args: any[]): unknown
        {
            const made = native.apply(this, args);

            seeBuffer(made, 'created', undefined, contextOf(this)?.id);

            return made;
        });

        patch(Base.prototype, 'decodeAudioData', (native) => function decodeAudioData (this: any, data: any, ...rest: any[]): unknown
        {
            const url = data && typeof data === 'object' ? urlOf.get(data) : undefined;
            const context = contextOf(this)?.id;
            const done = (buffer: unknown): void =>
            {
                if (buffer && typeof buffer === 'object')
                {
                    seeBuffer(buffer, 'decoded', url, context);
                }
            };

            if (typeof rest[0] === 'function')
            {
                const success = rest[0];

                rest[0] = function (this: unknown, buffer: unknown): unknown
                {
                    done(buffer);

                    return success.call(this, buffer);
                };
            }

            const result = native.call(this, data, ...rest);

            if (result && typeof result.then === 'function')
            {
                G.Promise.prototype.then.call(result, done, () => undefined);
            }

            return result;
        });
    }

    // Where the bytes of a decoded buffer came from.
    if (typeof G.Response === 'function')
    {
        patch(G.Response.prototype, 'arrayBuffer', (native) => function arrayBuffer (this: any): unknown
        {
            const result = native.call(this);
            const url = G.String(this.url ?? '');

            G.Promise.prototype.then.call(result, (data: object) => { urlOf.set(data, url); }, () => undefined);

            return result;
        });
    }

    // A copy of fetched bytes (games decode a copy to keep the original) keeps their address.
    patch(G.ArrayBuffer.prototype, 'slice', (native) => function slice (this: any, ...args: any[]): unknown
    {
        const copy = native.apply(this, args);
        const url = urlOf.get(this);

        if (url !== undefined)
        {
            urlOf.set(copy, url);
        }

        return copy;
    });

    const response = typeof G.XMLHttpRequest === 'function' ? G.Object.getOwnPropertyDescriptor(G.XMLHttpRequest.prototype, 'response') : null;

    if (response?.get)
    {
        const nativeGet: Fn = response.get;
        const get = disguise(function (this: any): unknown
        {
            const value = nativeGet.call(this);

            if (value instanceof G.ArrayBuffer)
            {
                urlOf.set(value, G.String(this.responseURL ?? ''));
            }

            return value;
        } as Fn, nativeGet);

        nDefineProperty(G.XMLHttpRequest.prototype, 'response', { ...response, get });
    }

    if (typeof G.HTMLMediaElement === 'function')
    {
        patch(G.HTMLMediaElement.prototype, 'play', (native) => function play (this: any, ...args: any[]): unknown
        {
            seeMedia(this);

            return native.apply(this, args);
        });
    }

    declare({
        id: 'audio-graph',
        what: 'AudioNode connect, disconnect, start and stop, AudioParam automation, a context\'s create functions and decodeAudioData, Response.arrayBuffer, ArrayBuffer.slice, XMLHttpRequest\'s response and HTMLMediaElement.play are wrapped; each audio context has an analyser fed from what reaches its destination',
        why: 'Audio inspection: the graph as the page builds it, where buffers came from, and levels',
        optional: true,
        active: () => contexts.size > 0
    });
}

// ---- Reading ----

function decibels (value: number): number | null
{
    return value > 0 ? 20 * G.Math.log10(value) : null;
}

function levelOf (analyser: any): { peak: number | null; rms: number | null; clipping: boolean }
{
    const samples = new G.Float32Array(analyser.fftSize);

    analyser.getFloatTimeDomainData(samples);

    let peak = 0;
    let sum = 0;

    for (let index = 0; index < samples.length; index++)
    {
        const value = G.Math.abs(samples[index]);

        peak = value > peak ? value : peak;
        sum += samples[index] * samples[index];
    }

    return { peak: decibels(peak), rms: decibels(G.Math.sqrt(sum / samples.length)), clipping: peak >= 1 };
}

function contextRow (info: ContextInfo): Record<string, unknown> | null
{
    const context = info.ref.deref();

    if (!context)
    {
        return null;
    }

    let level = null;

    if (info.tap && context.state === 'running')
    {
        try
        {
            level = levelOf(info.tap);

            // Told once each time the output starts to clip.
            if (level.clipping && !clipped.has(info.id))
            {
                clipped.add(info.id);
                emit('audio-clipping', { context: info.id, frame: currentFrame(), peak: level.peak });
            }
            else if (!level.clipping)
            {
                clipped.delete(info.id);
            }
        }
        catch
        {
            level = null;
        }
    }

    return {
        id: info.id,
        kind: info.kind,
        state: context.state,
        sampleRate: context.sampleRate,
        currentTime: context.currentTime,
        baseLatency: context.baseLatency,
        destination: info.destination,
        level,
        nodes: [...nodes.values()].filter((node) => node.context === info.id && node.ref.deref()).length
    };
}

function bufferRow (info: BufferInfo): Record<string, unknown> | null
{
    const buffer = info.ref.deref();

    if (!buffer)
    {
        return null;
    }

    const bytes = buffer.length * buffer.numberOfChannels * 4;
    let file: number | null = null;

    if (info.url)
    {
        try
        {
            const entry = G.performance.getEntriesByName(info.url)[0];

            file = entry ? entry.encodedBodySize || entry.transferSize || null : null;
        }
        catch
        {
            file = null;
        }
    }

    return { id: info.id, origin: info.origin, url: info.url ? cut(info.url, 300) : null, file, duration: buffer.duration, channels: buffer.numberOfChannels, sampleRate: buffer.sampleRate, bytes, frame: info.frame, context: info.context ?? null };
}

function primitiveProps (node: any): Record<string, unknown>
{
    const out: Record<string, unknown> = {};
    const proto = G.Object.getPrototypeOf(node);

    for (const name of G.Object.getOwnPropertyNames(proto) as string[])
    {
        const descriptor = G.Object.getOwnPropertyDescriptor(proto, name);

        if (!descriptor?.get || name === 'context')
        {
            continue;
        }

        try
        {
            const value = descriptor.get.call(node);

            if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string')
            {
                out[name] = typeof value === 'string' ? cut(value, 80) : value;
            }
            else if (value && kindOf(value) === 'AudioBuffer')
            {
                out[name] = seeBuffer(value, 'seen');
            }
            else if (value && value instanceof G.HTMLMediaElement)
            {
                out[name] = seeMedia(value);
            }
            else if (value && (kindOf(value) === 'Float32Array'))
            {
                out[name] = `${value.length} values`;
            }
        }
        catch
        {
            // Not readable.
        }
    }

    return out;
}

function nodeRow (info: NodeInfo, full: boolean): Record<string, unknown> | null
{
    const node = info.ref.deref();

    if (!node)
    {
        return null;
    }

    const params: Record<string, unknown> = {};

    for (const name of paramsOf(node))
    {
        try
        {
            const param = node[name];
            const row: Record<string, unknown> = { value: param.value };

            if (full)
            {
                row.default = param.defaultValue;
                row.min = param.minValue;
                row.max = param.maxValue;
                row.automation = automation.get(param) ?? [];
            }

            params[name] = row;
        }
        catch
        {
            // Not readable.
        }
    }

    const playing = info.started !== undefined && !info.ended;

    return {
        id: info.id,
        type: info.type,
        context: info.context,
        label: info.label ?? null,
        frame: info.frame,
        outputs: (edges.get(info.id) ?? []).map((edge) => ({ ...edge })),
        params,
        props: primitiveProps(node),
        started: info.started ?? null,
        stopped: info.stopped ?? null,
        playing,
        muted: muted.has(info.id),
        patched: patches.filter((patch) => patch.node === info.id).map((patch) => patch.mode)
    };
}

function inputsOf (id: string): Array<{ from: string } & Edge>
{
    const out: Array<{ from: string } & Edge> = [];

    for (const [from, list] of edges)
    {
        for (const edge of list)
        {
            if (edge.to === id)
            {
                out.push({ from, ...edge });
            }
        }
    }

    return out;
}

function mediaRow (id: string, element: any): Record<string, unknown>
{
    let file: number | null = null;

    try
    {
        const entry = G.performance.getEntriesByName(element.currentSrc)[0];

        file = entry ? entry.encodedBodySize || entry.transferSize || null : null;
    }
    catch
    {
        file = null;
    }

    return {
        id,
        kind: element.tagName === 'VIDEO' ? 'video' : 'audio',
        src: cut(element.currentSrc || element.src || '', 300),
        file,
        currentTime: element.currentTime,
        duration: G.Number.isFinite(element.duration) ? element.duration : null,
        volume: element.volume,
        muted: element.muted,
        paused: element.paused,
        loop: element.loop,
        playbackRate: element.playbackRate,
        inDocument: element.isConnected
    };
}

function allMedia (): Array<Record<string, unknown>>
{
    try
    {
        for (const element of G.document?.querySelectorAll?.('audio, video') ?? [])
        {
            seeMedia(element);
        }
    }
    catch
    {
        // Not a window.
    }

    const rows: Array<Record<string, unknown>> = [];

    for (const [id, ref] of media)
    {
        const element = ref.deref();

        if (element)
        {
            rows.push(mediaRow(id, element));
        }
    }

    return rows;
}

// Which nodes the sound from `id` reaches, following outputs (not parameters).
function reaches (id: string, seen = new G.Set() as Set<string>): Set<string>
{
    for (const edge of edges.get(id) ?? [])
    {
        if (!edge.param && !seen.has(edge.to))
        {
            seen.add(edge.to);
            reaches(edge.to, seen);
        }
    }

    return seen;
}

function findings (rows: Array<Record<string, any>>, bufferRows: Array<Record<string, any>>, contextRows: Array<Record<string, any>>): string[]
{
    const found: string[] = [];
    const now = currentFrame();

    for (const context of contextRows)
    {
        if (context.state === 'suspended' && context.kind === 'AudioContext')
        {
            found.push(`${context.id} is suspended${context.nodes > 1 ? ` with ${context.nodes} nodes` : ''}: nothing it plays is heard until the page resumes it (often after a click).`);
        }

        if (context.level?.clipping)
        {
            found.push(`${context.id} is clipping: its output peaks at or above 0 dBFS.`);
        }
    }

    const destinations = new G.Set(contextRows.map((context) => context.destination));

    for (const row of rows)
    {
        const isSink = row.type === 'AudioDestinationNode' || row.type === 'AnalyserNode' || row.type === 'MediaStreamAudioDestinationNode';

        if (!isSink && row.outputs.length === 0 && inputsOf(row.id).length > 0)
        {
            found.push(`${row.id} (${row.type}) has inputs but is connected to nothing, so what reaches it is not heard.`);
        }

        if (row.playing && row.props.loop !== true && row.started && row.stopped === null && now - row.started.frame > 3600 && row.type === 'AudioBufferSourceNode')
        {
            found.push(`${row.id} was started at frame ${row.started.frame} and has neither ended nor been stopped.`);
        }

        if (row.type === 'GainNode' && typeof row.params.gain?.value === 'number' && row.params.gain.value > 1)
        {
            const heard = [...reaches(row.id)].some((id) => destinations.has(id));

            if (heard)
            {
                found.push(`${row.id} (GainNode) has gain ${row.params.gain.value.toFixed(2)}, above 1, on the way to the destination: it can clip.`);
            }
        }
    }

    for (const buffer of bufferRows)
    {
        if (buffer.bytes >= 16 * 1048576)
        {
            found.push(`${buffer.id} holds ${(buffer.bytes / 1048576).toFixed(0)} MB decoded (${(buffer.duration as number).toFixed(0)} s, ${buffer.channels} channels at ${buffer.sampleRate} Hz)${buffer.url ? ` from ${buffer.url}` : ''}: long music is lighter streamed from a media element.`);
        }
    }

    const byUrl = new G.Map() as Map<string, string[]>;

    for (const buffer of bufferRows)
    {
        if (buffer.origin === 'decoded' && buffer.url)
        {
            byUrl.set(buffer.url, [...(byUrl.get(buffer.url) ?? []), buffer.id]);
        }
    }

    for (const [url, ids] of byUrl)
    {
        if (ids.length > 1)
        {
            found.push(`${url} was decoded ${ids.length} times (${ids.join(', ')}): one buffer would do.`);
        }
    }

    return found;
}

// ---- Changes ----

function undoPatch (id: string): boolean
{
    const at = patches.findIndex((patch) => patch.id === id);

    if (at < 0)
    {
        return false;
    }

    const [removed] = patches.splice(at, 1);

    removed.undo();

    return true;
}

function mute (id: string): () => void
{
    const node = nodeOf(id);

    if (!node || muted.has(id))
    {
        return () => undefined;
    }

    muted.add(id);
    disconnectNatively(node);

    return () =>
    {
        if (!muted.delete(id))
        {
            return;
        }

        const now = nodeOf(id);

        for (const edge of edges.get(id) ?? [])
        {
            connectNatively(now, edge);
        }
    };
}

function addPatch (mode: AudioPatch['mode'], node: string, text: string, undo: () => void): AudioPatch
{
    const made: AudioPatch = { id: `apatch_${++counter.patch}`, mode, node, text, undo };

    patches.push(made);

    return made;
}

function makePatch (args: { node: string; mode: string; param?: string; value?: number }): Record<string, unknown>
{
    const info = nodes.get(args.node);
    const node = nodeOf(args.node);

    if (!info || !node)
    {
        return { unknown: true };
    }

    switch (args.mode)
    {
        case 'mute':
            return { patch: addPatch('mute', args.node, `${args.node} (${info.type}) muted`, mute(args.node)).id };

        case 'solo':
        {
            // Every source in its context that does not reach it is muted.
            const undos: Array<() => void> = [];
            const upstream = (id: string): boolean => id === args.node || reaches(id).has(args.node);
            let count = 0;

            for (const other of nodes.values())
            {
                const isSource = /SourceNode$|^OscillatorNode$/.test(other.type);

                if (other.context === info.context && isSource && !upstream(other.id) && !muted.has(other.id))
                {
                    undos.push(mute(other.id));
                    count++;
                }
            }

            return { patch: addPatch('solo', args.node, `${args.node} (${info.type}) solo: ${count} other source${count === 1 ? '' : 's'} muted`, () => undos.forEach((undo) => undo())).id, muted: count };
        }

        case 'bypass':
        {
            const inputs = inputsOf(args.node).filter((edge) => !edge.param);
            const outputs = edges.get(args.node) ?? [];
            const added: Array<{ from: any; edge: Edge }> = [];

            for (const input of inputs)
            {
                const from = nodeOf(input.from);

                if (!from || muted.has(input.from))
                {
                    continue;
                }

                for (const output of outputs)
                {
                    const edge = { ...output, output: input.output };

                    connectNatively(from, edge);
                    added.push({ from, edge });
                }
            }

            const unmute = mute(args.node);

            return {
                patch: addPatch('bypass', args.node, `${args.node} (${info.type}) bypassed`, () =>
                {
                    for (const { from, edge } of added)
                    {
                        const target = edge.param ? nodeOf(edge.to)?.[edge.param] : nodeOf(edge.to);

                        try
                        {
                            nativeDisconnect?.call(from, target);
                        }
                        catch
                        {
                            // Already gone.
                        }

                        // The page's own connections from that node to the same place stay.
                        for (const own of edges.get(see(from)) ?? [])
                        {
                            if (own.to === edge.to && own.param === edge.param)
                            {
                                connectNatively(from, own);
                            }
                        }
                    }

                    unmute();
                }).id
            };
        }

        case 'param':
        {
            const name = G.String(args.param ?? '');

            if (!paramsOf(node).includes(name))
            {
                return { refused: `${info.type} has no parameter ${cut(name, 40)}; it has ${paramsOf(node).join(', ') || 'none'}` };
            }

            if (typeof args.value !== 'number' || !G.Number.isFinite(args.value))
            {
                return { refused: 'a parameter takes a finite number' };
            }

            const param = node[name];
            const before = param.value;

            try
            {
                param.cancelScheduledValues(0);
                param.value = args.value;
            }
            catch (error: any)
            {
                return { refused: cut(error?.message ?? error, 200) };
            }

            return {
                patch: addPatch('param', args.node, `${args.node} (${info.type}) ${name} set from ${before} to ${param.value}`, () =>
                {
                    try
                    {
                        param.value = before;
                    }
                    catch
                    {
                        // Gone.
                    }
                }).id,
                before,
                after: param.value
            };
        }

        default:
            return { refused: `no mode ${cut(args.mode, 20)}; the modes are mute, solo, bypass and param` };
    }
}

// A node's level on request: an analyser joined to it for a moment.
function measure (id: string): Promise<Record<string, unknown>>
{
    const node = nodeOf(id);

    if (!node || !nativeConnect || !nativeDisconnect)
    {
        return G.Promise.resolve({ level: null, why: 'gone' });
    }

    if (node.numberOfOutputs === 0)
    {
        return G.Promise.resolve({ level: null, why: 'it has no output' });
    }

    if (node.context?.state !== 'running')
    {
        return G.Promise.resolve({ level: null, why: `its context is ${node.context?.state ?? 'gone'}` });
    }

    let analyser: any;

    try
    {
        analyser = new G.AnalyserNode(node.context, { fftSize: 2048 });
        nodeIds.set(analyser, '');
        nativeConnect.call(node, analyser);
    }
    catch (error: any)
    {
        return G.Promise.resolve({ level: null, why: cut(error?.message ?? error, 120) });
    }

    return new G.Promise((resolve: (value: Record<string, unknown>) => void) =>
    {
        nSetTimeout(() =>
        {
            let level = null;

            try
            {
                level = levelOf(analyser);
                nativeDisconnect!.call(node, analyser);
            }
            catch
            {
                // Read what there was.
            }

            resolve({ level });
        }, 80);
    });
}

// A context made by the page, seen as it is made (audio.ts wraps the constructors).
export function seeContext (context: unknown): void
{
    if (installed)
    {
        contextOf(context);
    }
}

export function labelAudio (object: unknown, label: string): boolean
{
    if (!object || typeof object !== 'object' || typeof G.AudioNode !== 'function' || !(object instanceof G.AudioNode))
    {
        return false;
    }

    const info = nodes.get(see(object));

    if (info)
    {
        info.label = label;
    }

    return true;
}

export function installSound (): void
{
    if (installed || config.unmodified)
    {
        return;
    }

    installed = true;
    installGraph();

    expose('audio.state', (args: { view?: string }) =>
    {
        sweep();

        const contextRows = [...contexts.values()].map(contextRow).filter(Boolean) as Array<Record<string, any>>;
        const rows = [...nodes.values()].map((info) => nodeRow(info, false)).filter(Boolean) as Array<Record<string, any>>;
        const bufferRows = [...buffers.values()].map(bufferRow).filter(Boolean) as Array<Record<string, any>>;
        const elements = allMedia();
        const view = args.view ?? 'summary';

        return {
            frame: currentFrame(),
            contexts: contextRows,
            nodes: view === 'graph' || view === 'summary' ? rows : rows.filter((row) => row.playing),
            playing: rows.filter((row) => row.playing).map((row) => row.id),
            buffers: view === 'buffers' || view === 'summary' ? bufferRows : [],
            bufferCount: bufferRows.length,
            bufferBytes: bufferRows.reduce((sum, row) => sum + (row.bytes as number), 0),
            elements,
            patches: patches.map((patch) => ({ id: patch.id, mode: patch.mode, node: patch.node, text: patch.text })),
            findings: findings(rows, bufferRows, contextRows)
        };
    });

    expose('audio.node', async (args: { node: string }) =>
    {
        const info = nodes.get(args.node);

        if (!info)
        {
            return { unknown: true };
        }

        const row = nodeRow(info, true);

        if (!row)
        {
            return { gone: true };
        }

        const measured = await measure(args.node);

        return { ...row, inputs: inputsOf(args.node), ...measured };
    });

    expose('audio.patch', (args: { node?: string; mode?: string; param?: string; value?: number; undo?: string; all?: boolean }) =>
    {
        if (args.all)
        {
            const undone = patches.map((patch) => patch.id).reverse();

            undone.forEach(undoPatch);

            return { undone };
        }

        if (args.undo)
        {
            return undoPatch(args.undo) ? { undone: [args.undo] } : { unknown: true, known: patches.map((patch) => patch.id) };
        }

        return makePatch({ node: G.String(args.node ?? ''), mode: G.String(args.mode ?? ''), param: args.param, value: args.value });
    });
}
