// The Scanline probe. Injected into every frame and worker before page script runs
// (02-ARCHITECTURE.md, section 3).

import { installAudio } from './audio';
import { installCapture } from './capture';
import { installHandoff } from './handoff';
import { installPatches } from './patch';
import { installProtocol } from './protocol';
import { setDrawCounter } from './groups';
import { installAdapters } from './adapters';
import './adapters/three';
import './adapters/pixi';
import './adapters/phaser';
import { clock, startClockAtZero, installClock } from './clock/clock';
import { frameAtWall, frameSamples, gateState, hold, installGate, letGo, notePageEvent, onFrameEnd, pause, resume, runUntil, setFixedStep, step } from './clock/gate';
import { installTimers } from './clock/timers';
import { config, type Level } from './config';
import { allContexts, contextHandlers, describe, installContextDiscovery, knownAdapters } from './contexts';
import { installErrors } from './errors';
import { glHandlers, installGlTracking } from './gl/tracker';
import { gpuPatchHandlers, gpuPatchIntercepts } from './gpu/patch';
import { gpuHandlers, installGpuTracking } from './gpu/tracker';
import { COUNTERS, IDL_VERSION } from './hooks/generated';
import { hub, totals, type Counters } from './hooks/hub';
import { coverage, installHooks } from './hooks/install';
import { installImage } from './image';
import { installGamepads } from './gamepad';
import { installPointerLock } from './pointerlock';
import { installPolicy } from './policy';
import { installInputRecorder } from './input';
import { installInventory } from './inventory';
import { installMasquerade } from './masquerade';
import { currentWarnings, declare, modifications } from './mods';
import { G, isWindow } from './natives';
import { installSeededRandom } from './random';
import { gpuSamples, installTiming, timingHandlers, timingNotes } from './timing';
import { installReadback } from './readback';
import { bindingLeftBehind, emit, expose, installTransport } from './transport';

// Per-frame counters: the difference between cumulative totals at consecutive frame ends.
const FRAMES = 600;
const perFrame: Counters[] = [];

let previousTotals: Counters | null = null;

function records ()
{
    const seen = new G.Set([hub.gpu]);

    for (const info of allContexts())
    {
        seen.add(info.record);
    }

    return [...seen];
}

// Draws issued so far on every context: what a group is charged with.
setDrawCounter(() =>
{
    let draws = hub.gpu.draws;

    for (const info of allContexts())
    {
        if (info.record !== hub.gpu)
        {
            draws += info.record.draws;
        }
    }

    return draws;
});

function setLevel (level: Level): void
{
    config.level = level;
    hub.off = level === 'off';
}

function percentile (sorted: number[], p: number): number
{
    return sorted.length ? sorted[G.Math.min(sorted.length - 1, G.Math.floor(sorted.length * p))] : 0;
}

function summarise (values: number[]): { mean: number; p50: number; p95: number; max: number }
{
    const sorted = [...values].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);

    return {
        mean: sorted.length ? sum / sorted.length : 0,
        p50: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
        max: sorted.length ? sorted[sorted.length - 1] : 0
    };
}

// GPU time over the frames since `first`: the frames measured, and for WebGPU each pass.
function gpuReport (first: number): Record<string, unknown>
{
    const measured = gpuSamples(FRAMES).filter((sample) => sample.frame >= first);
    const passes = new G.Map() as Map<string, number[]>;

    for (const sample of measured)
    {
        for (const pass of sample.passes ?? [])
        {
            let times = passes.get(pass.label);

            if (!times)
            {
                times = [];
                passes.set(pass.label, times);
            }

            times.push(pass.ms);
        }
    }

    return {
        frames: measured.length,
        ms: summarise(measured.map((sample) => sample.ms)),
        passes: [...passes].map(([label, times]) => ({ label, frames: times.length, ...summarise(times) })),
        // WebGPU's times are timestamps, which the browser may coarsen; WebGL's are timer queries.
        timestamps: measured.some((sample) => sample.timestamps === true),
        notes: timingNotes()
    };
}

function boot (): void
{
    if (!installTransport())
    {
        return;
    }

    installMasquerade();
    installClock();
    installTimers();
    installGate(config.startPaused);
    installHooks({ ...contextHandlers, ...glHandlers, ...gpuHandlers, ...gpuPatchHandlers, ...gpuPatchIntercepts, ...timingHandlers });
    installContextDiscovery();
    installGlTracking();
    installGpuTracking();
    installInventory();
    installReadback();
    installTiming();
    installImage();
    installCapture();
    installHandoff();
    installPatches();
    installProtocol();
    installAdapters();
    installInputRecorder();
    installGamepads();
    installPointerLock();
    installPolicy();
    installErrors();
    installAudio();

    setLevel(config.level);

    if (config.deterministic)
    {
        installSeededRandom(config.deterministic.seed);

        // Before the clock is first frozen, which is where it would otherwise take its origin.
        startClockAtZero();
        setFixedStep({ fixed: true, dt: config.deterministic.fixedDt });

        declare({
            id: 'fixed-clock-origin',
            what: 'Page time starts at 0 and the date at 1 January 2026, and both move by a fixed step per frame',
            why: 'Deterministic session: every run reads the same times',
            optional: false,
            active: () => true
        });
    }

    declare({
        id: 'wrapped-functions',
        what: 'WebGL, WebGPU, getContext, frame and timer functions are wrapped. They report their native name, length and source text.',
        why: 'Observing and controlling rendering',
        optional: false,
        active: () => true
    });

    declare({
        id: 'binding-global',
        what: `A function named ${config.binding} stays on the global object`,
        why: 'The browser would not let the probe remove its event channel from the global',
        optional: false,
        active: bindingLeftBehind
    });

    onFrameEnd(() =>
    {
        if (hub.off)
        {
            return;
        }

        const now = totals(records());
        const delta: any = {};

        for (const name of COUNTERS)
        {
            delta[name] = now[name] - (previousTotals ? previousTotals[name] : 0);
        }

        previousTotals = now;
        perFrame.push(delta as Counters);

        if (perFrame.length > FRAMES)
        {
            perFrame.shift();
        }
    });

    expose('status', () =>
    {
        const gate = gateState();
        const contexts = allContexts().map(describe);
        const warnings = currentWarnings();

        // Only once the page is drawing: before that it may simply not have started its loop.
        if (!gate.sawRaf && totals(records()).draws > 0)
        {
            warnings.push({
                id: 'no-raf',
                text: 'This page has not called requestAnimationFrame. Frames are counted from timers only; pause and step still gate its timers.'
            });
        }

        return {
            probe: config.probeVersion,
            idl: IDL_VERSION,
            kind: isWindow ? 'window' : 'worker',
            top: isWindow ? G === G.top : false,
            url: G.String(G.location?.href ?? ''),
            level: config.level,
            unmodified: config.unmodified,
            deterministic: config.deterministic,
            debugKey: config.debugKey,
            ...gate,
            clockEngaged: clock.engaged,
            contexts,
            adapters: knownAdapters(),
            modifications: modifications(),
            warnings,
            hooks: {
                interfaces: coverage.interfaces,
                unknownMethods: coverage.unknown,
                missingMethods: coverage.missing.length,
                unhandled: coverage.unhandled
            }
        };
    });

    // Frames stopped between two of them for a moment, for the host to hand the page a
    // network response at a known frame. Not a pause: nothing waiting on the page is told.
    expose('net.hold', () => hold());
    expose('net.release', () => letGo());

    expose('pause', () => pause());
    expose('resume', (args) => resume(args));
    expose('step', (args) => step(args));
    expose('runUntil', (args) => runUntil(args));
    expose('setFixedStep', (args) => setFixedStep(args));

    expose('setLevel', (args: { level: Level }) =>
    {
        setLevel(args.level);

        return { level: config.level };
    });

    // Which frame each wall-clock time fell in. For console lines and errors from the protocol.
    expose('frameAt', (args: { wall: number[] }) => args.wall.map(frameAtWall));

    expose('stats', (args: { frames?: number }) =>
    {
        const count = G.Math.max(1, G.Math.min(FRAMES, args.frames ?? 120));
        const timing = frameSamples(count);
        const counted = perFrame.slice(-count);
        const counters: Record<string, { mean: number; max: number; last: number }> = {};

        for (const name of COUNTERS)
        {
            const values = counted.map((frame) => frame[name]);

            counters[name] = {
                mean: values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0,
                max: values.length ? G.Math.max(...values) : 0,
                last: values.length ? values[values.length - 1] : 0
            };
        }

        return {
            frames: timing.length,
            firstFrame: timing.length ? timing[0].frame : null,
            lastFrame: timing.length ? timing[timing.length - 1].frame : null,
            // Real milliseconds, measured in the page: provenance cpu-measured.
            intervalMs: summarise(timing.slice(1).map((sample) => sample.interval)),
            cpuMs: summarise(timing.map((sample) => sample.cpu)),
            gpu: gpuReport(timing.length ? timing[0].frame : 0),
            counters
        };
    });

    // For the page protocol (05-PAGE-PROTOCOL.md): a named event from the page.
    expose('pageEvent', (args: { name: string }) =>
    {
        notePageEvent(args.name);
    });

    // A worker that the host is holding at start blocks forever on `self.location`
    // (spike S1), so a worker's hello carries no URL. The host has it from the target.
    emit('hello', {
        kind: isWindow ? 'window' : 'worker',
        top: isWindow ? G === G.top : false,
        url: isWindow ? G.String(G.location.href) : '',
        probe: config.probeVersion
    });
}

boot();
