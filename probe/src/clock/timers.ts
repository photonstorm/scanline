// setTimeout and setInterval on the virtual clock.
//
// While the clock tracks real time, each timer is one native timer, so ordering and
// clamping are the browser's own. While the clock is frozen (paused, stepping, or a
// deterministic session) no native timers are armed: the frame gate calls drain() after
// each frame and the timers that have come due run then, each in a task of its own.

import { G, nClearTimeout, nextTask, nIndirectEval, nSetTimeout, type Fn } from '../natives';
import { patch } from '../masquerade';
import { clock } from './clock';

interface Timer
{
    id: number;
    fn: Fn;
    args: any[];
    due: number;
    interval: number;   // 0 for a one-shot
    native: number;     // native handle while armed, else 0
    nesting: number;
    order: number;
}

const timers = new Map<number, Timer>();

let nextId = 1;
let order = 0;
let nesting = 0;

// Called after each timer callback, so the frame gate can keep an image the callback drew.
let afterCallback: () => void = () => undefined;

// Called with an exception a timer callback threw, before the browser reports it.
let onThrow: (error: unknown) => void = () => undefined;

export function onTimerCallback (hook: () => void, thrown: (error: unknown) => void): void
{
    afterCallback = hook;
    onThrow = thrown;
}

function run (timer: Timer): void
{
    if (timer.interval > 0)
    {
        timer.due += timer.interval;
        timer.order = order++;
    }
    else
    {
        timers.delete(timer.id);
    }

    const outer = nesting;

    nesting = timer.nesting;

    // An exception propagates to the task, where the browser reports it as it would for a
    // native timer. The finally block keeps the probe's own state straight.
    try
    {
        timer.fn.apply(G, timer.args);
    }
    catch (error)
    {
        onThrow(error);

        throw error;
    }
    finally
    {
        nesting = outer;
        afterCallback();
    }
}

function arm (timer: Timer): void
{
    if (clock.frozen || timer.native !== 0)
    {
        return;
    }

    const delay = G.Math.max(0, (timer.due - clock.now()) / clock.scale);

    timer.native = nSetTimeout(() =>
    {
        timer.native = 0;

        if (!timers.has(timer.id))
        {
            return;
        }

        if (clock.frozen)
        {
            // The clock froze between arming and firing. The drain will run it.
            return;
        }

        try
        {
            run(timer);
        }
        finally
        {
            if (timers.has(timer.id))
            {
                arm(timer);
            }
        }
    }, delay);
}

function disarm (timer: Timer): void
{
    if (timer.native !== 0)
    {
        nClearTimeout(timer.native);
        timer.native = 0;
    }
}

function create (handler: unknown, delay: unknown, args: any[], repeat: boolean): number
{
    const fn: Fn = typeof handler === 'function' ? (handler as Fn) : () => nIndirectEval(G.String(handler));

    let ms = G.Number(delay);

    if (!(ms > 0))
    {
        ms = 0;
    }

    // The browser clamps deeply nested timers to 4 ms. Frozen time must do the same, or a
    // setTimeout(0) loop would spin forever inside one step.
    const level = nesting + 1;

    if (level > 5 && ms < 4)
    {
        ms = 4;
    }

    const timer: Timer = {
        id: nextId++,
        fn,
        args,
        due: clock.now() + ms,
        interval: repeat ? G.Math.max(ms, 1) : 0,
        native: 0,
        nesting: level,
        order: order++
    };

    timers.set(timer.id, timer);
    arm(timer);

    return timer.id;
}

function clear (id: unknown): void
{
    const timer = timers.get(id as number);

    if (timer)
    {
        disarm(timer);
        timers.delete(timer.id);
    }
}

// The clock has frozen: native timers must not fire.
export function suspendTimers (): void
{
    for (const timer of timers.values())
    {
        disarm(timer);
    }
}

// The clock is tracking real time again.
export function resumeTimers (): void
{
    for (const timer of timers.values())
    {
        arm(timer);
    }
}

export function pendingTimers (): number
{
    return timers.size;
}

function earliestDue (): Timer | null
{
    const now = clock.now();

    let best: Timer | null = null;

    for (const timer of timers.values())
    {
        if (timer.due <= now && (best === null || timer.due < best.due || (timer.due === best.due && timer.order < best.order)))
        {
            best = timer;
        }
    }

    return best;
}

const DRAIN_LIMIT = 10000;

// Run every timer that is due at the current virtual time, each in its own task so that
// promise continuations run between them as they would natively. Calls `done` when none are left.
export function drainTimers (done: (ran: number) => void): void
{
    let ran = 0;

    const step = (): void =>
    {
        const timer = clock.frozen ? earliestDue() : null;

        if (timer === null || ran >= DRAIN_LIMIT)
        {
            done(ran);

            return;
        }

        ran++;

        try
        {
            run(timer);
        }
        finally
        {
            nextTask(step);
        }
    };

    if (earliestDue() === null)
    {
        done(0);
    }
    else
    {
        nextTask(step);
    }
}

export function installTimers (): void
{
    patch(G, 'setTimeout', () => function setTimeout (handler: unknown, delay?: unknown, ...args: any[]): number
    {
        return create(handler, delay, args, false);
    });

    patch(G, 'setInterval', () => function setInterval (handler: unknown, delay?: unknown, ...args: any[]): number
    {
        return create(handler, delay, args, true);
    });

    patch(G, 'clearTimeout', () => function clearTimeout (id?: unknown): void
    {
        clear(id);
    });

    patch(G, 'clearInterval', () => function clearInterval (id?: unknown): void
    {
        clear(id);
    });
}
