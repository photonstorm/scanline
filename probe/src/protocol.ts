// The page protocol (05-PAGE-PROTOCOL.md): one global, `__scanline`, through which a page
// or an engine says what its draws mean and offers the debugger extra handles.
//
// Nothing here may throw into the page, and nothing a page passes is trusted: strings are
// cut to length, objects are copied as plain data, and the page's functions are only ever
// called when the host asks for them.

import { config } from './config';
import { currentFrame, notePageEvent, onFrameEnd } from './clock/gate';
import { frameGroups, noteEntity, plain, popGroup, pushGroup, rollGroups } from './groups';
import { declare } from './mods';
import { G, isWindow, nDefineProperty, nStringify } from './natives';
import { entryOf } from './registry';
import { emit, expose } from './transport';

export const PROTOCOL_VERSION = 1;

type Fn = (...args: any[]) => any;

interface View { id: string; label: string; description: string; set: Fn; on: boolean }
interface Control { id: string; label: string; type: string; min?: number; max?: number; options?: unknown[]; get: Fn; set: Fn }

const views = new G.Map() as Map<string, View>;
const controls = new G.Map() as Map<string, Control>;
const marks: Array<{ name: string; frame: number; data: unknown }> = [];
const exposed: Array<{ kind: string; id: number; names: unknown }> = [];
const used = new G.Set() as Set<string>;

let stateOf: Fn | null = null;
let stateSchema: unknown = null;
let time: Record<string, Fn> = {};
let checkpoint: { save?: Fn; restore?: Fn } = {};
let passes: unknown = null;
let explicitFrames = 0;

// What an adapter found (adapters/*.ts). One engine per page is the common case; the last
// to report wins the headline and the rest are listed.
export interface AdapterReport
{
    engine: string;
    version: string;
    tested: string;
    status: 'active' | 'partial' | 'off';
    renderer?: string;
    notes: string[];
}

const adapters: AdapterReport[] = [];

// What an adapter can say of the engine's state: scene counts, the engine's own statistics.
const engineState = new G.Map() as Map<string, Fn>;

export function provideEngineState (engine: string, from: Fn): void
{
    engineState.set(engine, from);
}

// A control registered by the page, or by an adapter for an engine's own settings.
export function addControl (control: any): void
{
    if (control && typeof control.get === 'function' && typeof control.set === 'function' && control.id !== undefined)
    {
        const id = text(control.id, 60);

        controls.set(id, {
            id,
            label: text(control.label ?? id, 120),
            type: text(control.type ?? 'number', 20),
            min: typeof control.min === 'number' ? control.min : undefined,
            max: typeof control.max === 'number' ? control.max : undefined,
            options: G.Array.isArray(control.options) ? (plain(control.options) as unknown[]) : undefined,
            get: control.get,
            set: control.set
        });
    }
}

export function reportAdapter (report: AdapterReport): void
{
    const at = adapters.findIndex((other) => other.engine === report.engine);

    if (at >= 0)
    {
        adapters[at] = report;
    }
    else
    {
        adapters.push(report);
    }
}

function text (value: unknown, most: number): string
{
    const string = typeof value === 'string' ? value : G.String(value);

    return string.length > most ? string.slice(0, most) : string;
}

// The page's own description of itself, as text of bounded size.
function readState (most: number): { text: string | null; error?: string; truncated?: boolean }
{
    if (stateOf === null)
    {
        return { text: null };
    }

    try
    {
        const json = nStringify(plainState(stateOf()));

        return json.length > most ? { text: json.slice(0, most), truncated: true } : { text: json };
    }
    catch (error: any)
    {
        return { text: null, error: text(error?.message ?? error, 200) };
    }
}

// What each adapter says of its engine, as text of bounded size.
function readEngine (): Array<{ engine: string; text?: string; error?: string }>
{
    const out: Array<{ engine: string; text?: string; error?: string }> = [];

    for (const [engine, from] of engineState)
    {
        try
        {
            const json = nStringify(plainState(from()));

            out.push({ engine, text: json.length > 3000 ? json.slice(0, 3000) : json });
        }
        catch (error: any)
        {
            out.push({ engine, error: text(error?.message ?? error, 200) });
        }
    }

    return out;
}

// The page's state as plain data, for a policy to decide by. Null when it provides none.
export function pageState (): unknown
{
    if (stateOf === null)
    {
        return null;
    }

    try
    {
        return plainState(stateOf());
    }
    catch
    {
        return null;
    }
}

// State may be wider and deeper than an entity's few fields, but is still copied as plain data.
function plainState (value: unknown, depth = 0): unknown
{
    if (value === null || typeof value !== 'object')
    {
        return plain(value);
    }

    if (depth >= 5)
    {
        return '…';
    }

    if (G.Array.isArray(value))
    {
        return (value as unknown[]).slice(0, 64).map((item) => plainState(item, depth + 1));
    }

    const out: Record<string, unknown> = {};
    let count = 0;

    for (const key in value as Record<string, unknown>)
    {
        if (count++ >= 64)
        {
            break;
        }

        try
        {
            out[text(key, 60)] = plainState((value as Record<string, unknown>)[key], depth + 1);
        }
        catch
        {
            // A getter that throws says nothing.
        }
    }

    return out;
}

function controlRow (control: Control): Record<string, unknown>
{
    let value: unknown = null;
    let error: string | undefined;

    try
    {
        value = plain(control.get());
    }
    catch (thrown: any)
    {
        error = text(thrown?.message ?? thrown, 200);
    }

    return { id: control.id, label: control.label, type: control.type, min: control.min, max: control.max, options: control.options, value, error };
}

// Checks a value against what the control said it takes. Returns why not, or null.
function refuse (control: Control, value: unknown): string | null
{
    switch (control.type)
    {
        case 'number':
            if (typeof value !== 'number' || !G.Number.isFinite(value))
            {
                return 'it takes a number';
            }

            if (control.min !== undefined && value < control.min)
            {
                return `its minimum is ${control.min}`;
            }

            if (control.max !== undefined && value > control.max)
            {
                return `its maximum is ${control.max}`;
            }

            return null;

        case 'boolean':
            return typeof value === 'boolean' ? null : 'it takes true or false';

        case 'enum':
            return control.options && control.options.some((option) => option === value) ? null : `it takes one of ${nStringify(control.options ?? [])}`;

        case 'color':
        case 'vector':
            return G.Array.isArray(value) && (value as unknown[]).every((part) => typeof part === 'number' && G.Number.isFinite(part))
                ? null
                : 'it takes a list of numbers';

        default:
            return null;
    }
}

// A function that swallows whatever the page's mistake was. The protocol only describes;
// it must never be the reason a page fails.
function safe<T extends Fn> (name: string, body: T): T
{
    return function (this: unknown, ...args: any[])
    {
        used.add(name);

        try
        {
            return body.apply(this, args);
        }
        catch
        {
            return undefined;
        }
    } as T;
}

// Calls a newer page makes that this version does not know are ignored, however deep.
function forgiving<T extends object> (target: T): T
{
    const nothing: any = new G.Proxy(function () { /* ignored */ }, {
        get: (_target: unknown, key: string | symbol) => (typeof key === 'symbol' || key === 'then' ? undefined : nothing),
        apply: () => nothing
    });

    return new G.Proxy(target, {
        get: (inner: any, key: string | symbol) => (key in inner || typeof key === 'symbol' || key === 'then' ? inner[key] : nothing),
        set: () => true
    });
}

function build (): object
{
    const api = {
        version: PROTOCOL_VERSION,

        // ---- Naming things ----

        label: safe('label', (object: any, name: unknown) =>
        {
            const entry = entryOf(object);
            const label = text(name, 200);

            if (entry)
            {
                entry.label = label;
            }

            // WebGPU objects carry a label of their own, which the browser's messages use.
            if (object && typeof object === 'object' && object.label === '')
            {
                object.label = label;
            }
        }),

        group: (name: unknown, body: unknown) =>
        {
            used.add('group');
            pushGroup(name);

            try
            {
                return typeof body === 'function' ? body() : undefined;
            }
            finally
            {
                popGroup();
            }
        },

        push: safe('push', (name: unknown) => pushGroup(name)),
        pop: safe('pop', () => popGroup()),

        entity: safe('entity', (reference: unknown, info: unknown) =>
        {
            // The reference is the page's own object. Only what it says about it is kept.
            noteEntity(info === undefined && reference && typeof reference === 'object' ? reference : info);
        }),

        mark: safe('mark', (name: unknown, data?: unknown) =>
        {
            const mark = { name: text(name, 120), frame: currentFrame(), data: data === undefined ? null : plain(data) };

            marks.push(mark);

            if (marks.length > 50)
            {
                marks.shift();
            }

            notePageEvent(mark.name);
            emit('mark', mark);
        }),

        // ---- Frames and time ----

        frame: forgiving({
            begin: safe('frame.begin', () => undefined),
            end: safe('frame.end', () => { explicitFrames++; })
        }),

        time: forgiving({
            provide: safe('time.provide', (given: any) =>
            {
                const next: Record<string, Fn> = {};

                for (const name of ['pause', 'resume', 'step', 'setScale'])
                {
                    if (typeof given?.[name] === 'function')
                    {
                        next[name] = given[name];
                    }
                }

                time = next;
            }),

            // A deterministic session tells the engine its seed and step. The page passes a
            // function, which is called at once if the session is deterministic, and the
            // same facts are returned (null otherwise).
            deterministic: safe('time.deterministic', (apply?: unknown) =>
            {
                const facts = config.deterministic ? { seed: config.deterministic.seed, fixedDt: config.deterministic.fixedDt } : null;

                if (facts && typeof apply === 'function')
                {
                    apply(facts);
                }

                return facts;
            })
        }),

        checkpoint: forgiving({
            provide: safe('checkpoint.provide', (given: any) =>
            {
                checkpoint = {
                    save: typeof given?.save === 'function' ? given.save : undefined,
                    restore: typeof given?.restore === 'function' ? given.restore : undefined
                };
            })
        }),

        // ---- State for the agent ----

        state: forgiving({
            provide: safe('state.provide', (from: unknown) => { stateOf = typeof from === 'function' ? from as Fn : null; }),
            describe: safe('state.describe', (schema: unknown) => { stateSchema = plain(schema); })
        }),

        // ---- Views and controls ----

        views: forgiving({
            register: safe('views.register', (view: any) =>
            {
                if (view && typeof view.set === 'function' && view.id !== undefined)
                {
                    const id = text(view.id, 60);

                    views.set(id, { id, label: text(view.label ?? id, 120), description: text(view.description ?? '', 300), set: view.set, on: false });
                }
            })
        }),

        controls: forgiving({
            register: safe('controls.register', (control: any) => addControl(control))
        }),

        uniforms: forgiving({
            expose: safe('uniforms.expose', (program: any, names?: unknown) =>
            {
                const entry = entryOf(program);

                if (entry)
                {
                    entry.p.exposed = names === undefined ? true : plain(names);
                    exposed.push({ kind: entry.kind, id: entry.id, names: entry.p.exposed });

                    if (exposed.length > 200)
                    {
                        exposed.shift();
                    }
                }
            })
        }),

        passes: forgiving({
            describe: safe('passes.describe', (list: unknown) => { passes = plain(list); })
        })
    };

    return forgiving(api);
}

export function installProtocol (): void
{
    onFrameEnd(rollGroups);

    expose('protocol.describe', (args: { groups?: number }) => ({
        version: PROTOCOL_VERSION,
        present: !config.unmodified,
        used: [...used],
        adapters,
        engine: readEngine(),
        state: readState(4000),
        stateSchema,
        controls: [...controls.values()].map(controlRow),
        views: [...views.values()].map((view) => ({ id: view.id, label: view.label, description: view.description, on: view.on })),
        passes,
        time: G.Object.keys(time),
        checkpoint: { save: Boolean(checkpoint.save), restore: Boolean(checkpoint.restore) },
        marks,
        explicitFrames,
        exposed,
        groups: frameGroups(args.groups ?? 400),
        frame: currentFrame()
    }));

    expose('protocol.state', () => readState(4000));

    expose('protocol.set', (args: { id: string; value: unknown }) =>
    {
        const control = controls.get(args.id);

        if (!control)
        {
            return { unknown: true, known: [...controls.keys()] };
        }

        const why = refuse(control, args.value);

        if (why)
        {
            return { refused: why, control: controlRow(control) };
        }

        const before = controlRow(control).value;

        control.set(args.value);

        return { before, control: controlRow(control) };
    });

    expose('protocol.view', (args: { id: string; on: boolean }) =>
    {
        const view = views.get(args.id);

        if (!view)
        {
            return { unknown: true, known: [...views.keys()] };
        }

        view.set(Boolean(args.on));
        view.on = Boolean(args.on);

        return { id: view.id, label: view.label, description: view.description, on: view.on };
    });

    expose('protocol.time', (args: { call: string; value?: unknown }) =>
    {
        const call = time[args.call];

        if (!call)
        {
            return { unknown: true, known: G.Object.keys(time) };
        }

        return { returned: plain(call(args.value)) };
    });

    expose('protocol.save', () =>
    {
        if (!checkpoint.save)
        {
            return { unknown: true };
        }

        // As text: whatever the page returns must survive the trip and come back unchanged.
        const state = nStringify(checkpoint.save());

        return state === undefined ? { empty: true } : { state, frame: currentFrame() };
    });

    expose('protocol.restore', (args: { state: string }) =>
    {
        if (!checkpoint.restore)
        {
            return { unknown: true };
        }

        checkpoint.restore(G.JSON.parse(args.state));

        return { frame: currentFrame() };
    });

    // Unmodified mode changes nothing a page can see, so the page runs as it would outside Scanline.
    if (config.unmodified)
    {
        return;
    }

    try
    {
        nDefineProperty(G, '__scanline', { value: build(), configurable: true, enumerable: false, writable: false });
    }
    catch
    {
        return;
    }

    declare({
        id: 'protocol-global',
        what: `A global named __scanline (the page protocol, version ${PROTOCOL_VERSION}) is defined${isWindow ? '' : ' in this worker'}`,
        why: 'A page or engine uses it, when it is there, to name its draws and offer controls',
        optional: true,
        active: () => true
    });
}

// For adapters: the same calls the page would make.
export { pushGroup, popGroup, noteEntity };
