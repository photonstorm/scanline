// Suspends audio with the clock, so a paused game is silent and its audio time does not
// run ahead of its frames.

import { isPaused, onPauseChange } from './clock/gate';
import { disguise } from './masquerade';
import { declare } from './mods';
import { G, nativeNow, nDefineProperty, nSetTimeout } from './natives';
import { seeContext } from './sound';

// Weak references: the probe must not keep a page's audio context alive.
const contexts: Array<WeakRef<any>> = [];
const suspendedByUs = new WeakSet<object>();

function track (context: any): void
{
    contexts.push(new G.WeakRef(context));
    seeContext(context);

    if (isPaused())
    {
        hold(context);
    }
}

function hold (context: any): void
{
    if (context.state === 'running')
    {
        suspendedByUs.add(context);
        nativeSuspend.call(context).catch(() => undefined);
    }
}

let nativeSuspend: () => Promise<void>;
let nativeResume: () => Promise<void>;

// ---- Sound a frame at a time ----
//
// While the page is stepped its audio contexts are held (suspended), so their clocks do not
// run ahead of the frames. A film needs the sound that goes with each frame: so between two
// frames each held context is let go until its clock has moved on by exactly the film's time
// so far, and held again. The context renders in whole blocks (128 sample frames, under
// 3 ms), so it stops a little past the mark; the next mark is measured from the start, not
// from where it stopped, so nothing adds up. What the context renders is unbroken: holding
// it stops its clock and loses nothing.

// Where each context's clock stood when the film's time was zero.
let origins = new G.WeakMap() as WeakMap<object, number>;

export function beginAudioSteps (): void
{
    origins = new G.WeakMap();
}

// Lets every held context play until `elapsed` seconds of film have been heard. Answers
// with how many contexts could not be brought there (the page holds them itself, or closed them).
export async function stepAudioTo (elapsed: number, before: number): Promise<number>
{
    let stuck = 0;
    const turns: Array<Promise<void>> = [];

    for (const reference of contexts)
    {
        const context = reference.deref();

        if (!context || context.state === 'closed')
        {
            continue;
        }

        // One that joins part-way starts from the frame before this one.
        if (!origins.has(context))
        {
            origins.set(context, context.currentTime - before);
        }

        const target = origins.get(context)! + elapsed;

        if (context.currentTime >= target - 0.0005)
        {
            continue;
        }

        // Only what the probe itself is holding: a context the page suspended is the page's.
        if (!suspendedByUs.has(context) && context.state !== 'running')
        {
            stuck++;
            continue;
        }

        turns.push((async () =>
        {
            const ours = suspendedByUs.has(context);

            if (ours)
            {
                await nativeResume.call(context);
            }

            const gaveUp = nativeNow() + 2000;

            while (context.currentTime < target && context.state === 'running' && nativeNow() < gaveUp)
            {
                await new G.Promise((resolve: () => void) => nSetTimeout(resolve, 1));
            }

            if (ours && isPaused())
            {
                await nativeSuspend.call(context);
            }
        })().catch(() => undefined));
    }

    await G.Promise.all(turns);

    return stuck;
}

export function installAudio (): void
{
    for (const name of ['AudioContext', 'webkitAudioContext'])
    {
        const Native = G[name];

        if (typeof Native !== 'function')
        {
            continue;
        }

        nativeSuspend = Native.prototype.suspend;
        nativeResume = Native.prototype.resume;

        const Wrapped: any = function AudioContext (this: unknown, ...args: any[]): unknown
        {
            if (!new.target)
            {
                // Let the browser raise its own "must be called with new" error.
                return Native(...args);
            }

            const context = G.Reflect.construct(Native, args, new.target);

            track(context);

            return context;
        };

        for (const key of G.Object.getOwnPropertyNames(Native))
        {
            if (key !== 'length' && key !== 'name' && key !== 'prototype')
            {
                nDefineProperty(Wrapped, key, G.Object.getOwnPropertyDescriptor(Native, key));
            }
        }

        nDefineProperty(Wrapped, 'prototype', { value: Native.prototype, writable: false, enumerable: false, configurable: false });
        nDefineProperty(Native.prototype, 'constructor', { value: Wrapped, writable: true, enumerable: false, configurable: true });
        G.Object.setPrototypeOf(Wrapped, G.Object.getPrototypeOf(Native));

        disguise(Wrapped, Native);

        const descriptor = G.Object.getOwnPropertyDescriptor(G, name);

        nDefineProperty(G, name, { ...descriptor, value: Wrapped });
    }

    if (!nativeSuspend!)
    {
        return;
    }

    onPauseChange((paused) =>
    {
        for (const reference of contexts)
        {
            const context = reference.deref();

            if (!context || context.state === 'closed')
            {
                continue;
            }

            if (paused)
            {
                hold(context);
            }
            else if (suspendedByUs.has(context))
            {
                suspendedByUs.delete(context);
                nativeResume.call(context).catch(() => undefined);
            }
        }
    });

    declare({
        id: 'audio-suspend',
        what: 'Audio contexts are suspended while the page is paused and resumed when it runs',
        why: 'A paused game should be silent, and its audio clock should not run ahead',
        optional: false,
        active: () => contexts.length > 0
    });
}
