// The frame gate: pause, step, resume, run-until.
//
// Each requestAnimationFrame callback the page registers is registered natively, one for
// one, so the browser runs them exactly as it would have (order, timestamps, a microtask
// checkpoint after each). The gate decides, when a native frame fires, whether the page's
// callbacks run or are held. Pausing withholds the next frame; it never blocks the main
// thread (01-PRD.md, principle 5).
//
// A frame, here, is: the clock moves, the frame callbacks run, then (when the clock is
// frozen) the timers that have come due run. A page with no frame callbacks still steps:
// its frames are the clock moving and its timers running.

import { G, hasRaf, nativeNow, nCancelFrame, nClearTimeout, nextTask, nRequestFrame, nSetTimeout, type Fn } from '../natives';
import { patch } from '../masquerade';
import { emit } from '../transport';
import { clearWarning, warn } from '../mods';
import { clock } from './clock';
import { drainTimers, onTimerCallback, pendingTimers, resumeTimers, suspendTimers } from './timers';

interface Entry
{
    id: number;
    cb: Fn;
    native: number;
}

export interface FrameSample
{
    frame: number;
    start: number;      // real time the frame began, ms since page start
    wall: number;       // the same instant as wall-clock ms, to line up protocol events
    cpu: number;        // real ms spent in the frame's callbacks
    interval: number;   // real ms since the previous frame began
}

export type StopReason = 'pause' | 'step' | 'until' | 'idle' | 'start';

interface Until
{
    frame?: number;
    time?: number;
    test?: () => unknown;
    frameMsOver?: number;
    error?: boolean;
    event?: string;
    what: string;
}

// Entries registered natively and waiting for the next native frame.
let armed = new Set<Entry>();

// Entries firing in the native frame now in progress.
let current = new Set<Entry>();

// Entries whose native frame fired while the gate was closed.
let held: Entry[] = [];

const byId = new Map<number, Entry>();

let nextId = 1;

let frame = 0;
let paused = false;
let budget = 0;
let fixed = false;
let stepDt = 1000 / 60;
let pauseRequested = false;
let inFrame = false;
let draining = false;
let frameOpen = false;
let nativeStamp = -1;
let frameTime = 0;
let frameStart = 0;
let lastFrameStart = 0;
let sawRaf = false;
let watchdog = 0;
let heartbeat = 0;
let until: Until | null = null;
let stopInfo: { reason: StopReason; detail?: string } = { reason: 'start' };
let errorSeen = false;
let eventSeen: string | null = null;

let settleWaiters: Array<(value: StopInfo) => void> = [];

export interface StopInfo
{
    frame: number;
    reason: StopReason;
    detail?: string;
    remaining: number;
}

const SAMPLES = 600;
const samples: FrameSample[] = [];

// Hooks other modules attach.
const frameEndHooks: Array<(stopping: boolean) => void> = [];
const frameBeginHooks: Array<(flag: boolean) => void> = [];
const pauseHooks: Array<(paused: boolean) => void> = [];

export function onFrameBegin (hook: () => void): void
{
    frameBeginHooks.push(hook);
}

// `stopping` is true when the page will be paused after this frame, which is when the
// frame's final image has to be kept.
export function onFrameEnd (hook: (stopping: boolean) => void): void
{
    frameEndHooks.push(hook);
}

// After a frame and the timers that came due with it. For a page that draws from timers,
// this is the first moment the whole frame has been issued.
const settledHooks: Array<(flag: boolean) => void> = [];

export function onFrameSettled (hook: () => void): void
{
    settledHooks.push(hook);
}

export function onPauseChange (hook: (paused: boolean) => void): void
{
    pauseHooks.push(hook);
}

// Ask for the next frame's end hooks to run as if the page were stopping, without stopping.
let grabRequested = false;

export function requestGrab (): void
{
    grabRequested = true;
}

export function noteError (): void
{
    errorSeen = true;
}

export function notePageEvent (name: string): void
{
    eventSeen = name;
}

export function gateState (): {
    frame: number; paused: boolean; fixed: boolean; stepDt: number; time: number; scale: number;
    inFrame: boolean; sawRaf: boolean; pendingCallbacks: number; pendingTimers: number; stop: typeof stopInfo;
}
{
    return {
        frame,
        paused,
        fixed,
        stepDt,
        time: clock.now(),
        scale: clock.scale,
        inFrame,
        sawRaf,
        pendingCallbacks: armed.size + held.length,
        pendingTimers: pendingTimers(),
        stop: stopInfo
    };
}

// The number of the frame in progress, or of the last one completed when between frames.
// Frames are numbered from 1; 0 means none has run. Everything that happens during a frame
// (a draw, an error, a texture fetched) carries the same number as the image it produces.
export function currentFrame (): number
{
    return inFrame ? frame + 1 : frame;
}

// An exception leaving a page callback is reported by the browser only after the probe's
// own end-of-frame work, by which time the frame number has moved on. Remember where it
// was thrown so the error can be given its true frame.
let thrown: { error: unknown; frame: number } | null = null;

export function noteThrow (error: unknown): void
{
    thrown = { error, frame: currentFrame() };

    // Seen now, not when the browser reports it, so "run until an error" stops on this frame.
    errorSeen = true;
}

export function frameOfThrow (error: unknown): number | null
{
    return thrown !== null && thrown.error === error ? thrown.frame : null;
}

export function isPaused (): boolean
{
    return paused;
}

export function frameSamples (count: number): FrameSample[]
{
    return samples.slice(-count);
}

// Which frame was in progress at a wall-clock time. Used to tie console messages and errors
// reported through the protocol to frames.
export function frameAtWall (wall: number): number
{
    for (let i = samples.length - 1; i >= 0; i--)
    {
        if (samples[i].wall <= wall)
        {
            return samples[i].frame;
        }
    }

    return samples.length ? samples[0].frame : frame;
}

function armEntry (entry: Entry): void
{
    armed.add(entry);
    entry.native = nRequestFrame((stamp: number) => fire(entry, stamp));
}

function rearmHeld (): void
{
    const waiting = held;

    held = [];

    for (const entry of waiting)
    {
        if (byId.has(entry.id))
        {
            armEntry(entry);
        }
    }
}

function fire (entry: Entry, stamp: number): void
{
    if (stamp !== nativeStamp)
    {
        // First callback of a new native frame. Everything armed before now fires in it.
        nativeStamp = stamp;

        if (inFrame)
        {
            // The previous frame never saw its last callback (the browser dropped it). Close it.
            frameOpen = false;
            endFrame();
        }

        current = armed;
        armed = new Set();
        frameOpen = !draining && (!paused || budget > 0);

        if (frameOpen)
        {
            beginFrame(stamp);
        }
    }

    const live = current.delete(entry) && byId.has(entry.id);

    try
    {
        if (live)
        {
            if (frameOpen)
            {
                byId.delete(entry.id);
                entry.cb.call(undefined, frameTime);
            }
            else
            {
                held.push(entry);
            }
        }
    }
    catch (error)
    {
        noteThrow(error);

        throw error;
    }
    finally
    {
        if (current.size === 0 && frameOpen)
        {
            frameOpen = false;
            endFrame();
        }
    }
}

function beginFrame (stamp: number): void
{
    inFrame = true;
    frameStart = nativeNow();

    if (paused)
    {
        budget--;
    }

    if (clock.frozen)
    {
        // One step after the previous frame's timestamp, so stepped frames are exactly
        // stepDt apart even though the clock froze a little after that frame began.
        // A page with no frame before this one (or whose clock has since moved past that
        // point) steps from where the clock stands.
        const next = frameTime + stepDt;

        clock.advanceTo(frameTime > 0 && next > clock.now() ? next : clock.now() + stepDt);
    }

    frameTime = clock.frameTime(stamp);

    for (const hook of frameBeginHooks)
    {
        guarded(hook);
    }
}

// A fault in the probe's own bookkeeping must never surface in the page.
function guarded (hook: (flag: boolean) => void, flag = false): void
{
    try
    {
        hook(flag);
    }
    catch (error: any)
    {
        emit('probe-fault', { where: 'frame hook', message: String(error?.stack ?? error) });
    }
}

function untilHit (cpu: number): string | null
{
    if (until === null)
    {
        return null;
    }

    if (until.frame !== undefined && frame >= until.frame)
    {
        return until.what;
    }

    if (until.time !== undefined && clock.now() >= until.time)
    {
        return until.what;
    }

    if (until.frameMsOver !== undefined && cpu > until.frameMsOver)
    {
        return `frame ${frame} took ${cpu.toFixed(2)} ms of CPU time (over ${until.frameMsOver})`;
    }

    if (until.error && errorSeen)
    {
        return 'an error was raised';
    }

    if (until.event !== undefined && eventSeen === until.event)
    {
        return until.what;
    }

    if (until.test)
    {
        try
        {
            if (until.test())
            {
                return until.what;
            }
        }
        catch
        {
            // The expression may refer to things that do not exist yet. Keep running.
        }
    }

    return null;
}

function doPause (reason: StopReason, detail?: string): void
{
    paused = true;
    budget = 0;
    pauseRequested = false;
    until = null;
    stopInfo = { reason, detail };

    clock.freeze();
    suspendTimers();
    stopHeartbeat();

    for (const hook of pauseHooks)
    {
        guarded(hook, true);
    }
}

function endFrame (): void
{
    const cpu = nativeNow() - frameStart;

    inFrame = false;
    frame++;

    samples.push({
        frame,
        start: frameStart,
        wall: G.performance.timeOrigin + frameStart,
        cpu,
        interval: lastFrameStart ? frameStart - lastFrameStart : 0
    });

    if (samples.length > SAMPLES)
    {
        samples.shift();
    }

    lastFrameStart = frameStart;

    if (!paused)
    {
        const hit = untilHit(cpu);

        if (hit !== null)
        {
            doPause('until', hit);
        }
        else if (pauseRequested)
        {
            doPause('pause');
        }
    }
    else if (budget === 0)
    {
        stopInfo = { reason: 'step' };
    }

    const stopping = paused && budget === 0;
    const grab = grabRequested;

    grabRequested = false;

    for (const hook of frameEndHooks)
    {
        guarded(hook, stopping || grab);
    }

    if (clock.frozen)
    {
        draining = true;

        drainTimers(() =>
        {
            draining = false;
            afterFrame();
        });
    }
    else
    {
        afterFrame();
    }
}

// ---- A hold ----
//
// The host sometimes has to hand the page something from outside at a known frame: a
// network response, in a session whose runs must replay exactly. For that it asks for a
// hold. Frames stop between two of them, the host does what it has to, and lets go.
//
// A hold is not a pause. Nothing that is waiting on the page is told, and whatever the
// page was doing (running, running until something, stepping through frames) carries on
// from where it was when the hold is let go.

let holdWanted: Array<(value: { frame: number }) => void> = [];
let holding = false;
let holdResume: 'run' | 'step' | null = null;
let holdUntil: Until | null = null;
let holdStays = false;

function takeHold (): boolean
{
    if (holdWanted.length === 0 || holding || inFrame || draining)
    {
        return false;
    }

    holding = true;

    if (!paused)
    {
        // Running: stopped as a pause stops it, but quietly, and what it was running
        // until is kept to be put back.
        holdUntil = until;
        doPause('pause');
        holdResume = 'run';
    }
    else
    {
        holdResume = budget > 0 ? 'step' : null;
    }

    const waiters = holdWanted;

    holdWanted = [];

    for (const resolve of waiters)
    {
        resolve({ frame });
    }

    return true;
}

export function hold (): Promise<{ frame: number }>
{
    if (holding || (paused && budget === 0 && !inFrame && !draining))
    {
        return G.Promise.resolve({ frame });
    }

    return new G.Promise((resolve: (value: { frame: number }) => void) =>
    {
        holdWanted.push(resolve);

        // A frame should end within a few milliseconds. If none is coming (a hidden
        // window, or nothing scheduled) the hold is taken where things stand.
        nSetTimeout(takeHold, 300);
    });
}

export function letGo (): { frame: number }
{
    if (!holding)
    {
        return { frame };
    }

    const how = holdResume;
    const wanted = holdUntil;

    holding = false;
    holdResume = null;
    holdUntil = null;

    if (how === 'run' && paused && !holdStays)
    {
        resume();
        until = wanted;
    }
    else if (how === 'step' && paused && budget > 0 && !inFrame && !draining)
    {
        nextSteppedFrame();
    }

    holdStays = false;

    return { frame };
}

function afterFrame (): void
{
    for (const hook of settledHooks)
    {
        guarded(hook);
    }

    // A hold is taken here, between two frames. A page that was running or part-way
    // through a step stays where it is until the hold is let go.
    if (holdWanted.length > 0 && takeHold() && holdResume !== null)
    {
        return;
    }

    if (!paused)
    {
        // Callbacks that fired while timers were draining were held. Let them go.
        if (held.length)
        {
            rearmHeld();
        }

        return;
    }

    if (budget > 0)
    {
        nextSteppedFrame();
    }
    else
    {
        settle();
    }
}

// A frame with no frame callbacks: the clock moves and timers run.
function timerFrame (): void
{
    beginFrame(nativeNow());
    endFrame();
}

function nextSteppedFrame (): void
{
    clearWatchdog();

    if (held.length || armed.size)
    {
        rearmHeld();

        const expected = frame;

        if (fast)
        {
            // Not waiting for the display: the frame runs as the next task. The browser
            // presents the canvas when it next gets round to it, not after every frame.
            nextTask(() =>
            {
                if (paused && budget > 0 && frame === expected && !inFrame && !draining)
                {
                    manualFrame();
                }
            });

            return;
        }

        // If the window is hidden the browser fires no frames. Release this one by hand.

        watchdog = nSetTimeout(() =>
        {
            watchdog = 0;

            if (paused && budget > 0 && frame === expected && !inFrame && !draining)
            {
                manualFrame();
            }
        }, 250);

        return;
    }

    if (pendingTimers() === 0)
    {
        // Nothing is scheduled at all: no step would do anything.
        budget = 0;
        stopInfo = { reason: 'idle', detail: 'The page has no frame callbacks and no timers pending.' };
        settle();

        return;
    }

    nextTask(() =>
    {
        if (paused && budget > 0 && !inFrame && !draining)
        {
            if (held.length || armed.size)
            {
                nextSteppedFrame();
            }
            else
            {
                timerFrame();
            }
        }
    });
}

// Run the armed callbacks without waiting for the browser to produce a frame.
// Each frame run by hand has a stamp of its own. The real clock will not do: the browser
// coarsens it, and two frames run back to back would read the same instant and be taken
// for one. Negative, so it can never equal a stamp the browser gives.
let manualStamp = 0;

function manualFrame (): void
{
    const entries = [...armed];
    const stamp = --manualStamp;

    for (const entry of entries)
    {
        nCancelFrame(entry.native);
    }

    if (entries.length === 0)
    {
        timerFrame();

        return;
    }

    for (const entry of entries)
    {
        try
        {
            fire(entry, stamp);
        }
        catch (error)
        {
            // Natively each callback's exception is reported and the rest still run.
            G.reportError?.(error);
        }
    }
}

function clearWatchdog (): void
{
    if (watchdog !== 0)
    {
        nClearTimeout(watchdog);
        watchdog = 0;
    }
}

function settle (): void
{
    clearWatchdog();

    const info: StopInfo = { frame, reason: stopInfo.reason, detail: stopInfo.detail, remaining: budget };
    const waiters = settleWaiters;

    settleWaiters = [];

    emit('stopped', { frame, reason: info.reason, detail: info.detail });

    for (const resolve of waiters)
    {
        resolve(info);
    }
}

function whenSettled (): Promise<StopInfo>
{
    return new G.Promise((resolve: (value: StopInfo) => void) =>
    {
        settleWaiters.push(resolve);
    });
}

// A deterministic session that is running has to produce frames even when the page
// registers no frame callbacks, so its timers still advance.
function startHeartbeat (): void
{
    if (heartbeat !== 0 || !fixed || paused || !hasRaf)
    {
        return;
    }

    heartbeat = nRequestFrame(() =>
    {
        heartbeat = 0;

        if (!fixed || paused)
        {
            return;
        }

        if (current.size === 0 && armed.size === 0 && held.length === 0 && !inFrame && !draining && pendingTimers() > 0)
        {
            timerFrame();
        }

        startHeartbeat();
    });
}

function stopHeartbeat (): void
{
    if (heartbeat !== 0)
    {
        nCancelFrame(heartbeat);
        heartbeat = 0;
    }
}

// ---- Commands ----

export function pause (): Promise<StopInfo>
{
    if (paused)
    {
        // A pause asked for during a hold outlasts it.
        if (holding && holdResume === 'run')
        {
            holdStays = true;
        }

        return G.Promise.resolve({ frame, reason: stopInfo.reason, detail: stopInfo.detail, remaining: budget });
    }

    const settled = whenSettled();

    pauseRequested = true;

    const pauseNow = (): void =>
    {
        // Only if this request is still outstanding. Once the pause has happened, or the page
        // has been resumed, a late fallback must do nothing: it would pause a running page.
        if (pauseRequested && !paused && !inFrame)
        {
            doPause('pause');

            if (!draining)
            {
                settle();
            }
        }
    };

    if (!inFrame && armed.size === 0 && current.size === 0)
    {
        // No frame is coming. Pause where we are.
        pauseNow();
    }
    else
    {
        // A frame should arrive within a few milliseconds. If the window is hidden it will not.
        nSetTimeout(pauseNow, 300);
    }

    return settled;
}

export function resume (options: { scale?: number } = {}): { frame: number }
{
    if (options.scale !== undefined && options.scale > 0)
    {
        clock.setScale(options.scale);
    }

    if (!paused)
    {
        return { frame };
    }

    paused = false;
    budget = 0;
    pauseRequested = false;
    clearWatchdog();

    if (!fixed)
    {
        clock.thaw();
        resumeTimers();
    }

    for (const hook of pauseHooks)
    {
        guarded(hook, false);
    }

    rearmHeld();
    startHeartbeat();

    return { frame };
}

// Set for the length of a step that asked not to wait for the display between frames.
let fast = false;

export async function step (options: { frames?: number; dt?: number; fast?: boolean } = {}): Promise<StopInfo>
{
    if (!paused)
    {
        await pause();
    }

    if (inFrame || draining || budget > 0)
    {
        // A previous step is still running. Wait for it, then carry on.
        await whenSettled();
    }

    if (options.dt !== undefined && options.dt > 0)
    {
        stepDt = options.dt;
    }

    const count = G.Math.max(1, G.Math.floor(options.frames ?? 1));
    const settled = whenSettled();

    fast = options.fast === true;
    budget = count;
    nextSteppedFrame();

    return settled.finally(() =>
    {
        fast = false;
    });
}

export function runUntil (condition: {
    frame?: number; frames?: number; ms?: number; expr?: string; frameMsOver?: number; error?: boolean; event?: string;
}): Promise<StopInfo>
{
    const next: Until = { what: '' };

    if (condition.frame !== undefined)
    {
        next.frame = condition.frame;
        next.what = `reached frame ${condition.frame}`;
    }
    else if (condition.frames !== undefined)
    {
        next.frame = frame + condition.frames;
        next.what = `ran ${condition.frames} frames`;
    }

    if (condition.ms !== undefined)
    {
        next.time = clock.now() + condition.ms;
        next.what = `${condition.ms} ms of page time passed`;
    }

    if (condition.expr !== undefined)
    {
        // Compiled once. The host has lifted the page's Content Security Policy for the probe.
        next.test = new G.Function(`return (${condition.expr});`) as () => unknown;
        next.what = `expression became true: ${condition.expr}`;
    }

    if (condition.frameMsOver !== undefined)
    {
        next.frameMsOver = condition.frameMsOver;
    }

    if (condition.error)
    {
        errorSeen = false;
        next.error = true;
    }

    if (condition.event !== undefined)
    {
        eventSeen = null;
        next.event = condition.event;
        next.what = `the page raised "${condition.event}"`;
    }

    until = next;

    const settled = whenSettled();

    resume();

    return settled;
}

export function setFixedStep (options: { fixed?: boolean; dt?: number }): void
{
    if (options.dt !== undefined && options.dt > 0)
    {
        stepDt = options.dt;
    }

    if (options.fixed !== undefined && options.fixed !== fixed)
    {
        fixed = options.fixed;

        if (fixed)
        {
            clock.freeze();
            suspendTimers();
            startHeartbeat();
        }
        else if (!paused)
        {
            stopHeartbeat();
            clock.thaw();
            resumeTimers();
        }
    }
}

export function installGate (startPaused: boolean): void
{
    if (hasRaf)
    {
        patch(G, 'requestAnimationFrame', () => function requestAnimationFrame (callback: Fn): number
        {
            if (typeof callback !== 'function')
            {
                // Let the browser raise its own TypeError.
                return nRequestFrame(callback);
            }

            const entry: Entry = { id: nextId++, cb: callback, native: 0 };

            byId.set(entry.id, entry);
            sawRaf = true;
            clearWarning('no-raf');
            armEntry(entry);

            return entry.id;
        });

        patch(G, 'cancelAnimationFrame', () => function cancelAnimationFrame (id: number): void
        {
            const entry = byId.get(id);

            if (!entry)
            {
                return;
            }

            byId.delete(id);

            if (armed.delete(entry) || current.delete(entry))
            {
                nCancelFrame(entry.native);
            }
            else
            {
                held = held.filter((other) => other !== entry);
            }
        });
    }
    else
    {
        warn('no-raf-api', 'This global has no requestAnimationFrame (a shared or service worker). Frames are timer-driven.');
    }

    // A timer callback that draws while the page is stepping has produced an image that must
    // be kept before the browser presents and clears it.
    onTimerCallback(() =>
    {
        if (draining && paused && budget === 0)
        {
            for (const hook of frameEndHooks)
            {
                guarded(hook, true);
            }
        }
    }, noteThrow);

    if (startPaused)
    {
        doPause('start');
    }
}
