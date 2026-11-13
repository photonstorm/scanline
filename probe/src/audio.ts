// Suspends audio with the clock, so a paused game is silent and its audio time does not
// run ahead of its frames.

import { isPaused, onPauseChange } from './clock/gate';
import { disguise } from './masquerade';
import { declare } from './mods';
import { G, nDefineProperty } from './natives';
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
