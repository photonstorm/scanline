// setTimeout and setInterval on the virtual clock.
//
// While the clock tracks real time, each timer is one native timer, so ordering and
// clamping are the browser's own. While the clock is frozen (paused, stepping, or a
// deterministic session) no native timers are armed: the frame gate calls drain() after
// each frame and the timers that have come due run then, each in a task of its own.
//
// A page can also run its loop on a MessageChannel (a message to itself is a task with no
// delay) or on scheduler.postTask. Left alone, such a loop would run on through a pause.
// So while the clock is frozen a message posted on a port is kept, and sent at the next
// drain: a loop of that kind takes one turn a frame. A task posted to the scheduler
// becomes a timer of this module. While the clock tracks real time both go straight to
// the browser.

import { G, nClearTimeout, nextTask, nIndirectEval, nSetTimeout, ownPorts, type Fn } from '../natives';
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

// Messages a page posted on a port while the clock was frozen, in order.
const heldMessages: Array<{ port: any; args: any[] }> = [];

let postNative: Fn | null = null;

// Messages the drain has sent on and not yet seen arrive, and messages that arrived while
// the clock was frozen without having been sent by the drain: they were in flight when the
// page was paused, and are handled at the next drain like the rest.
let inFlight = 0;

const lateArrivals: Array<() => void> = [];

function sendHeld (): number
{
    const late = lateArrivals.splice(0);

    for (const handle of late)
    {
        try
        {
            handle();
        }
        catch
        {
            // Reported by the handler's own wrapper.
        }
    }

    const batch = heldMessages.splice(0);

    inFlight = batch.length;

    for (const message of batch)
    {
        try
        {
            postNative!.apply(message.port, message.args);
        }
        catch
        {
            // The port has closed, or what was to be transferred has gone: as it would
            // have been had the page posted it now.
        }
    }

    return batch.length + late.length;
}

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
    sendHeld();

    for (const timer of timers.values())
    {
        arm(timer);
    }
}

export function pendingTimers (): number
{
    return timers.size + heldMessages.length + lateArrivals.length;
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

    // Messages kept since the last drain go first. Those posted while these are handled
    // wait for the next: one turn of a message loop a frame.
    const sent = clock.frozen ? sendHeld() : 0;

    if (sent > 0)
    {
        ran += sent;

        // Two tasks on, so that the messages have been delivered and handled before
        // the timers run and the frame is called settled.
        nextTask(() => nextTask(step));
    }
    else if (earliestDue() === null)
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

    // A message a page posts to itself on a channel.
    if (G.MessagePort)
    {
        postNative = patch(G.MessagePort.prototype, 'postMessage', (native) => function postMessage (this: any, ...args: any[]): void
        {
            if (!clock.frozen || ownPorts.has(this))
            {
                return native.apply(this, args);
            }

            heldMessages.push({ port: this, args });

            return undefined;
        });
    }

    // What a message handler draws is kept as a timer callback's is: in the same task,
    // before the browser presents the canvas and clears it. Handlers set as onmessage are
    // followed; one added with addEventListener is not, and a frame it draws may be
    // captured without its picture.
    const handler = G.MessagePort ? G.Object.getOwnPropertyDescriptor(G.MessagePort.prototype, 'onmessage') : undefined;

    if (handler && typeof handler.set === 'function' && typeof handler.get === 'function')
    {
        const given = new G.WeakMap() as WeakMap<object, unknown>;

        G.Object.defineProperty(G.MessagePort.prototype, 'onmessage', {
            configurable: handler.configurable,
            enumerable: handler.enumerable,
            get (this: any): unknown
            {
                return given.has(this) ? given.get(this) : handler.get!.call(this);
            },
            set (this: any, value: unknown)
            {
                if (ownPorts.has(this) || typeof value !== 'function')
                {
                    given.delete(this);
                    handler.set!.call(this, value);

                    return;
                }

                const page = value as Fn;

                given.set(this, value);
                handler.set!.call(this, function wrapped (this: unknown, ...args: any[]): unknown
                {
                    // Posted before the pause and arriving after it: not yet.
                    if (clock.frozen)
                    {
                        if (inFlight > 0)
                        {
                            inFlight--;
                        }
                        else
                        {
                            lateArrivals.push(() => wrapped.apply(this, args));
                            inFlight++;

                            return undefined;
                        }
                    }

                    try
                    {
                        return page.apply(this, args);
                    }
                    catch (error)
                    {
                        onThrow(error);

                        throw error;
                    }
                    finally
                    {
                        afterCallback();
                    }
                });
            }
        });
    }

    // scheduler.postTask(callback, {delay}): a timer by another name. scheduler.yield is a
    // task with no delay.
    const scheduler = G.scheduler;

    if (scheduler && typeof scheduler.postTask === 'function')
    {
        const later = (callback: Fn, delay: number, signal: any): Promise<unknown> => new G.Promise((resolve: Fn, reject: Fn) =>
        {
            if (signal?.aborted)
            {
                reject(signal.reason);

                return;
            }

            const id = create(() =>
            {
                try
                {
                    resolve(callback());
                }
                catch (error)
                {
                    reject(error);
                }
            }, delay, [], false);

            signal?.addEventListener?.('abort', () =>
            {
                clear(id);
                reject(signal.reason);
            });
        });

        // Always a timer of this module, running or frozen, so that one posted while the
        // page runs does not fire after it is paused. Priorities are not kept.
        patch(scheduler, 'postTask', (native) => function postTask (this: any, callback: Fn, options?: any): Promise<unknown>
        {
            if (typeof callback !== 'function')
            {
                return native.apply(this, arguments as any);
            }

            return later(callback, G.Number(options?.delay) || 0, options?.signal);
        });

        patch(scheduler, 'yield', () => function yield_ (this: any): Promise<unknown>
        {
            return later(() => undefined, 0, undefined);
        });
    }
}
