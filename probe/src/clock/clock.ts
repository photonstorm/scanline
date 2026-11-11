// The virtual clock. One source of time behind requestAnimationFrame timestamps,
// performance.now, Date and timers (02-ARCHITECTURE.md, section 5).
//
// Until the clock is first engaged (a pause, a step, a time scale, or a deterministic
// session) every reading is the native one, so an untouched session sees real time exactly.

import { G, NativeDate, nativeDateNow, nativeNow, nDefineProperty } from '../natives';
import { disguise, patch } from '../masquerade';
import { declare } from '../mods';

let engaged = false;

// While frozen, time moves only when the frame gate advances it.
let frozen = false;
let frozenAt = 0;

// While tracking real time: virtual = virtualAnchor + (real - realAnchor) * scale.
let scale = 1;
let realAnchor = 0;
let virtualAnchor = 0;

// Date.now() = dateOrigin + virtual now. Fixed when the clock engages, so Date does not jump.
let dateOrigin = 0;

// Readings never go backwards, whatever the native frame timestamp says.
let last = 0;

function engage (): void
{
    if (engaged)
    {
        return;
    }

    const now = nativeNow();

    engaged = true;
    realAnchor = now;
    virtualAnchor = now;
    last = now;
    dateOrigin = nativeDateNow() - now;
}

// A deterministic session's clock starts from fixed points instead of from whenever the
// page happened to load, so every run reads the same times: page time from zero, and the
// date from the first instant of 2026 (UTC).
const DETERMINISTIC_EPOCH = 1767225600000;

export function startClockAtZero (): void
{
    engaged = true;
    realAnchor = nativeNow();
    virtualAnchor = 0;
    last = 0;
    dateOrigin = DETERMINISTIC_EPOCH;

    // A session that starts paused has frozen the clock already, at whatever the real time was.
    frozenAt = 0;
}

export const clock = {

    get engaged (): boolean
    {
        return engaged;
    },

    get frozen (): boolean
    {
        return frozen;
    },

    get scale (): number
    {
        return scale;
    },

    now (): number
    {
        if (!engaged)
        {
            return nativeNow();
        }

        if (frozen)
        {
            return frozenAt;
        }

        const value = virtualAnchor + (nativeNow() - realAnchor) * scale;

        if (value > last)
        {
            last = value;
        }

        return last;
    },

    // The timestamp a frame callback receives for a native frame timestamp.
    frameTime (nativeTimestamp: number): number
    {
        if (!engaged)
        {
            return nativeTimestamp;
        }

        if (frozen)
        {
            return frozenAt;
        }

        const value = virtualAnchor + (nativeTimestamp - realAnchor) * scale;

        if (value > last)
        {
            last = value;
        }

        return last;
    },

    dateNow (): number
    {
        return engaged ? dateOrigin + clock.now() : nativeDateNow();
    },

    freeze (): void
    {
        if (frozen)
        {
            return;
        }

        engage();
        frozenAt = clock.now();
        frozen = true;
    },

    // Only meaningful while frozen: the frame gate moves time to the next frame. Never backwards.
    advanceTo (time: number): void
    {
        if (time > frozenAt)
        {
            frozenAt = time;
            last = frozenAt;
        }
    },

    thaw (): void
    {
        if (!frozen)
        {
            return;
        }

        realAnchor = nativeNow();
        virtualAnchor = frozenAt;
        frozen = false;
    },

    setScale (value: number): void
    {
        if (value === scale)
        {
            return;
        }

        engage();

        if (!frozen)
        {
            virtualAnchor = clock.now();
            realAnchor = nativeNow();
        }

        scale = value;
    }
};

export function installClock (): void
{
    patch(G.Performance.prototype, 'now', () => function now (this: Performance): number
    {
        return clock.now();
    });

    // Date keeps its prototype and statics; only "now" and the no-argument constructor change.
    const VirtualDate: any = function Date (this: unknown, ...args: any[]): Date | string
    {
        if (!new.target)
        {
            return new NativeDate(clock.dateNow()).toString();
        }

        const values = args.length === 0 ? [clock.dateNow()] : args;

        return G.Reflect.construct(NativeDate, values, new.target);
    };

    for (const name of G.Object.getOwnPropertyNames(NativeDate))
    {
        if (name === 'now' || name === 'length' || name === 'name' || name === 'prototype')
        {
            continue;
        }

        nDefineProperty(VirtualDate, name, G.Object.getOwnPropertyDescriptor(NativeDate, name));
    }

    const now = function now (): number
    {
        return G.Math.floor(clock.dateNow());
    };

    disguise(now, NativeDate.now);

    nDefineProperty(VirtualDate, 'now', { value: now, writable: true, enumerable: false, configurable: true });
    nDefineProperty(VirtualDate, 'prototype', { value: NativeDate.prototype, writable: false, enumerable: false, configurable: false });
    nDefineProperty(NativeDate.prototype, 'constructor', { value: VirtualDate, writable: true, enumerable: false, configurable: true });

    disguise(VirtualDate, NativeDate);

    nDefineProperty(G, 'Date', { value: VirtualDate, writable: true, enumerable: false, configurable: true });

    declare({
        id: 'clock',
        what: 'requestAnimationFrame, performance.now, Date and timers read one virtual clock',
        why: 'Pause, step and time scale. Identical to real time until first used.',
        optional: false,
        active: () => engaged
    });
}
