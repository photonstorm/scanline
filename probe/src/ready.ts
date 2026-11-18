// When a page is ready: loaded, and about to play.
//
// A page says so itself through the page protocol (`__scanline.ready()`, after
// `__scanline.loading()` to say that it will). For one that says nothing, the probe watches
// the work a page does while it loads and calls it ready when that has been quiet for a
// moment: requests and the reading of their bodies, images, audio and bitmap decoding,
// WebAssembly, fonts, WebGPU's set-up, shaders still building in the background, and what
// the host reports of the network (scripts and modules, which the page's own calls do not
// show). It is a guess, and says what it went by.
//
// In a session that holds the page's time (started paused, or deterministic), the frame gate
// is "loading" until then (clock/gate.ts): the page's frames run only while this work is in
// flight, uncounted, and the start line is drawn when the page is ready.

import { config } from './config';
import { drawStartLine, gateState, isLoading, setLoadingWork } from './clock/gate';
import { webgpuStarting } from './contexts';
import { disguise, patch } from './masquerade';
import { declare, warn } from './mods';
import { G, isWindow, nAddEventListener, nativeNow, nDefineProperty, nGetOwnPropertyDescriptor, nSetTimeout, type Fn } from './natives';
import { emit, expose } from './transport';

interface Work
{
    kind: string;
    what: string;
    since: number;
}

const work = new G.Map() as Map<number, Work>;
const nThen: Fn = G.Promise.prototype.then;

let nextWork = 1;

// Whether any work has been seen since the document began: a page that never does any is
// not held a moment longer than the quiet takes, and none of its timers run meanwhile.
let sawWork = false;

// What the host says of the network: requests in flight that a script began.
let network = { inFlight: 0, sample: [] as string[] };

// The last time a page asked whether a shader or program had finished building in the
// background (KHR_parallel_shader_compile) and was told it had not.
let building = -1e9;

const BUILDING_FOR = 250;

// The page said it will say when it is ready, and whether it has.
let declared = false;
let said: number | null = null;

let state: 'loading' | 'ready' = 'loading';
let reason = '';
let readyAt = 0;
let readyFrame = 0;
let loadingFrames = 0;
let quietSince: number | null = null;
let waiters: Array<() => void> = [];

function clip (value: unknown): string
{
    let text = '';

    try
    {
        text = typeof value === 'string' ? value : G.String((value as any)?.url ?? value ?? '');
    }
    catch
    {
        // Something that cannot be named is still counted.
    }

    return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

// Work has begun. The function returned ends it; calling it twice does nothing.
export function began (kind: string, what: unknown = ''): () => void
{
    if (state === 'ready')
    {
        return () => undefined;
    }

    const id = nextWork++;

    work.set(id, { kind, what: clip(what), since: nativeNow() });
    sawWork = true;

    return () =>
    {
        work.delete(id);
    };
}

// Follows a promise to its end without touching what the page is given.
function follow<T> (kind: string, what: unknown, promise: T): T
{
    if (state === 'ready' || promise === null || typeof promise !== 'object')
    {
        return promise;
    }

    const done = began(kind, what);

    try
    {
        nThen.call(promise, done, done);
    }
    catch
    {
        done();
    }

    return promise;
}

function fontsLoading (): boolean
{
    try
    {
        return isWindow && G.document.fonts?.status === 'loading';
    }
    catch
    {
        return false;
    }
}

// What is in flight, in words for a person: "2 requests (…/a.png, …/b.png), 1 audio decode".
function waitingOn (): Array<{ kind: string; count: number; sample: string[] }>
{
    const kinds = new G.Map() as Map<string, { kind: string; count: number; sample: string[] }>;
    const add = (kind: string, what: string, count = 1): void =>
    {
        let entry = kinds.get(kind);

        if (!entry)
        {
            entry = { kind, count: 0, sample: [] };
            kinds.set(kind, entry);
        }

        entry.count += count;

        if (what && entry.sample.length < 3)
        {
            entry.sample.push(what);
        }
    };

    for (const item of work.values())
    {
        add(item.kind, item.what);
    }

    if (network.inFlight > 0)
    {
        add('script or module request', network.sample[0] ?? '', network.inFlight);
    }

    if (nativeNow() - building < BUILDING_FOR)
    {
        add('shader build', '');
    }

    if (webgpuStarting().pending > 0)
    {
        add('WebGPU adapter or device', '', webgpuStarting().pending);
    }

    if (fontsLoading())
    {
        add('font', '');
    }

    if (declared && said === null)
    {
        add('the page\'s own word (it called loading() and has not called ready())', '');
    }

    return [...kinds.values()];
}

function busy (): boolean
{
    return work.size > 0
        || network.inFlight > 0
        || nativeNow() - building < BUILDING_FOR
        || webgpuStarting().pending > 0
        || fontsLoading()
        || (declared && said === null);
}

function documentLoaded (): boolean
{
    return !isWindow || G.document.readyState === 'complete';
}

function finish (why: string): void
{
    if (state === 'ready')
    {
        return;
    }

    const pending = waitingOn();
    const done = (): void =>
    {
        state = 'ready';
        reason = why;
        readyAt = nativeNow();
        readyFrame = gateState().frame;
        loadingFrames = gateState().loadingFrames;
        work.clear();

        if (why === 'timeout')
        {
            warn('not-ready', `The page had not finished loading after ${G.Math.round(config.readyTimeoutMs / 1000)} s, so it was taken as ready as it stood. Still in flight: ${words(pending)}.`);
        }

        emit('ready', { reason: why, ms: readyAt, frame: readyFrame, loadingFrames, pending: why === 'timeout' ? pending : [] });

        const waiting = waiters;

        waiters = [];

        for (const resolve of waiting)
        {
            resolve();
        }
    };

    // The line is drawn between two frames; where the gate is not loading it is drawn at once.
    drawStartLine(done);
}

function words (pending: Array<{ kind: string; count: number; sample: string[] }>): string
{
    return pending.length === 0
        ? 'nothing Scanline follows'
        : pending.map((entry) => `${entry.count} ${entry.kind}${entry.count === 1 || entry.kind.includes(' ') ? '' : 's'}${entry.sample.length ? ` (${entry.sample.join(', ')})` : ''}`).join('; ');
}

function tick (): void
{
    if (state === 'ready')
    {
        return;
    }

    const now = nativeNow();
    const working = busy();

    setLoadingWork(working || sawWork);

    if (working || !documentLoaded())
    {
        quietSince = null;
    }
    else
    {
        quietSince ??= now;
    }

    if (said !== null)
    {
        finish('page');
    }
    else if (quietSince !== null && now - quietSince >= config.readyQuietMs && !declared)
    {
        finish('quiet');
    }
    else if (now > config.readyTimeoutMs)
    {
        finish('timeout');
    }

    if ((state as string) !== 'ready')
    {
        nSetTimeout(tick, 16);
    }
}

// The page protocol's side.
export function pageLoading (): void
{
    if (state === 'loading')
    {
        declared = true;
        sawWork = true;
    }
}

export function pageReady (): void
{
    if (said !== null)
    {
        return;
    }

    said = gateState().frame;

    if (state === 'ready')
    {
        // Too late to be the start line: the quiet was taken for it.
        if (reason !== 'page')
        {
            warn('ready-late', 'The page called __scanline.ready() after Scanline had already taken it as ready (its loading went quiet first). Call __scanline.loading() as the page starts, so that Scanline waits for ready().');
        }

        return;
    }

    finish('page');
}

export function readyReport (): Record<string, unknown>
{
    return {
        state,
        reason,
        // Real milliseconds since the document began.
        ms: state === 'ready' ? readyAt : nativeNow(),
        frame: readyFrame,
        loadingFrames: state === 'ready' ? loadingFrames : gateState().loadingFrames,
        held: isLoading(),
        declared,
        said,
        pending: state === 'ready' ? [] : waitingOn(),
        waiting: state === 'ready' ? '' : words(waitingOn())
    };
}

// Resolves when the page is ready, or after `timeout` ms if it is not by then.
export function whenReady (timeout?: number): Promise<void>
{
    if (state === 'ready')
    {
        return G.Promise.resolve();
    }

    return new G.Promise((resolve: () => void) =>
    {
        waiters.push(resolve);

        if (timeout !== undefined)
        {
            nSetTimeout(resolve, G.Math.max(0, timeout));
        }
    });
}

function wrapAccessor (proto: any, name: string, after: (self: any, value: unknown) => void): void
{
    const descriptor = proto ? nGetOwnPropertyDescriptor(proto, name) : undefined;

    if (!descriptor || typeof descriptor.set !== 'function')
    {
        return;
    }

    const native: Fn = descriptor.set;
    const set = function (this: any, value: unknown): void
    {
        native.call(this, value);

        try
        {
            after(this, value);
        }
        catch
        {
            // Watching must never be why a page fails.
        }
    };

    nDefineProperty(proto, name, { ...descriptor, set: disguise(set, native) });
}

function installWatchers (): void
{
    // Requests the page makes itself, and the reading of what comes back.
    patch(G, 'fetch', (native) => function fetch (this: any, ...args: any[]): unknown
    {
        return follow('request', args[0], native.apply(this, args));
    });

    if (G.Response)
    {
        for (const name of ['arrayBuffer', 'blob', 'bytes', 'formData', 'json', 'text'])
        {
            patch(G.Response.prototype, name, (native) => function (this: any, ...args: any[]): unknown
            {
                return follow('response body', this?.url, native.apply(this, args));
            });
        }
    }

    if (typeof G.XMLHttpRequest === 'function')
    {
        const urls = new G.WeakMap() as WeakMap<object, string>;

        patch(G.XMLHttpRequest.prototype, 'open', (native) => function open (this: any, ...args: any[]): unknown
        {
            urls.set(this, clip(args[1]));

            return native.apply(this, args);
        });

        patch(G.XMLHttpRequest.prototype, 'send', (native) => function send (this: any, ...args: any[]): unknown
        {
            if (state === 'loading')
            {
                const done = began('request', urls.get(this) ?? '');

                nAddEventListener.call(this, 'loadend', done, { once: true });

                try
                {
                    return native.apply(this, args);
                }
                catch (error)
                {
                    done();

                    throw error;
                }
            }

            return native.apply(this, args);
        });
    }

    // An image given an address: until it loads or fails.
    if (G.HTMLImageElement)
    {
        const watched = new G.WeakMap() as WeakMap<object, () => void>;

        wrapAccessor(G.HTMLImageElement.prototype, 'src', (image, value) =>
        {
            watched.get(image)?.();

            if (state !== 'loading' || image.complete)
            {
                return;
            }

            const done = began('image', value);

            watched.set(image, done);
            nAddEventListener.call(image, 'load', done, { once: true });
            nAddEventListener.call(image, 'error', done, { once: true });
        });

        patch(G.HTMLImageElement.prototype, 'decode', (native) => function decode (this: any, ...args: any[]): unknown
        {
            return follow('image decode', this?.currentSrc, native.apply(this, args));
        });
    }

    patch(G, 'createImageBitmap', (native) => function createImageBitmap (this: any, ...args: any[]): unknown
    {
        return follow('bitmap decode', '', native.apply(this, args));
    });

    const audio = G.BaseAudioContext ?? G.AudioContext ?? G.webkitAudioContext;

    if (audio)
    {
        patch(audio.prototype, 'decodeAudioData', (native) => function decodeAudioData (this: any, ...args: any[]): unknown
        {
            return follow('audio decode', '', native.apply(this, args));
        });
    }

    if (G.WebAssembly)
    {
        for (const name of ['compile', 'compileStreaming', 'instantiate', 'instantiateStreaming'])
        {
            patch(G.WebAssembly, name, (native) => function (this: any, ...args: any[]): unknown
            {
                return follow('WebAssembly build', '', native.apply(this, args));
            });
        }
    }

    if (G.FontFace)
    {
        patch(G.FontFace.prototype, 'load', (native) => function load (this: any, ...args: any[]): unknown
        {
            return follow('font', this?.family, native.apply(this, args));
        });
    }

    // A page that builds its shaders in the background asks, usually once a frame, whether
    // they are done. While the answer is no it is still loading, and needs its frames to ask again.
    const COMPLETION_STATUS = 0x91B1;

    for (const name of ['WebGLRenderingContext', 'WebGL2RenderingContext'])
    {
        const proto = G[name]?.prototype;

        if (!proto)
        {
            continue;
        }

        for (const method of ['getProgramParameter', 'getShaderParameter'])
        {
            patch(proto, method, (native) => function (this: any, ...args: any[]): unknown
            {
                const answer = native.apply(this, args);

                if (args[1] === COMPLETION_STATUS && answer === false && state === 'loading')
                {
                    building = nativeNow();
                    sawWork = true;
                }

                return answer;
            });
        }
    }
}

export function installReady (): void
{
    expose('ready.state', readyReport);

    expose('ready.wait', async (args: { timeout?: number }) =>
    {
        const from = nativeNow();
        const was = state;

        await whenReady(args?.timeout ?? config.readyTimeoutMs);

        return { ...readyReport(), waited: was === 'ready' ? 0 : nativeNow() - from };
    });

    // From the host: requests in flight that the page's own calls do not show.
    expose('ready.net', (args: { inFlight: number; sample?: string[] }) =>
    {
        network = { inFlight: G.Math.max(0, args.inFlight | 0), sample: (args.sample ?? []).slice(0, 3).map(clip) };

        if (network.inFlight > 0)
        {
            sawWork = true;
        }
    });

    // Unmodified mode wraps nothing more than it must: there the guess goes by the document,
    // the network as the host sees it, and WebGPU's set-up.
    if (!config.unmodified)
    {
        try
        {
            installWatchers();
        }
        catch (error: any)
        {
            emit('probe-fault', { where: 'ready watchers', message: G.String(error?.stack ?? error) });
        }

        declare({
            id: 'ready-watchers',
            what: 'fetch, the Response body readers, XMLHttpRequest open and send, the image src setter and decode, createImageBitmap, decodeAudioData, WebAssembly compile and instantiate, FontFace.load and getProgramParameter and getShaderParameter are wrapped',
            why: 'Telling when a page has finished loading',
            optional: true,
            active: () => true
        });
    }

    nSetTimeout(tick, 0);
}
