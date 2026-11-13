// Watches (docs/GAME.md, section 3): values of the game's own objects, read as each frame
// ends, checked against rules, and kept for the last 600 frames.
//
// A watch is an expression the agent names (`game.player.body.velocity`) or an object the page
// registers through the page protocol (`__scanline.watch(name, object, options)`). Either way
// the probe reads properties, never calls the page's methods, and copies only primitives.
// Reading a getter is the one way a watch can run page code; a getter that throws is noted.

import { currentFrame, onFrameCheck } from './clock/gate';
import { G, nativeNow, NativeFunction } from './natives';
import { emit, expose } from './transport';

// What a value is on the wire. JSON has no NaN, infinities or undefined, which are exactly what a
// watch is for, so those travel as { $: name }.
type Wire = number | boolean | string | null | { $: string };

interface Rule
{
    rule: 'finite' | 'defined' | 'range' | 'type' | 'changes' | 'steady';
    prop?: string;
    min?: number;
    max?: number;
    type?: string;
    break?: boolean;
}

interface Broken
{
    rule: string;
    prop: string;
    frame: number;
    before: Wire;
    after: Wire;
}

interface Watch
{
    name: string;
    source: 'expression' | 'page';
    expr?: string;
    kind?: string;
    read: () => unknown;
    props: string[] | null;     // dotted paths; null: every own primitive property
    depth: number;
    rules: Rule[];
    frames: number[];           // the history: a frame and its values, oldest first
    rows: Array<Record<string, Wire>>;
    last: Record<string, Wire> | null;
    broken: Broken[];           // the latest 50 rules that broke
    breaking: Set<string>;      // which rule and property are broken now
    error: string | null;
    added: number;
}

const HISTORY = 600;
const PROPS_PER_WATCH = 64;
const WATCHES = 100;
// The cost limit (W9): past this many properties a frame, every other frame is read.
const PROPS_EVERY_FRAME = 200;

const watches = new G.Map() as Map<string, Watch>;

let costMs = 0;
let propsRead = 0;
let thinned = false;

function cut (value: unknown, most: number): string
{
    const text = G.String(value);

    return text.length > most ? `${text.slice(0, most - 1)}…` : text;
}

function wire (value: unknown): Wire
{
    switch (typeof value)
    {
        case 'number':
            return G.Number.isFinite(value) ? value as number : { $: G.String(value) };
        case 'boolean':
            return value as boolean;
        case 'string':
            return cut(value, 200);
        case 'undefined':
            return { $: 'undefined' };
        case 'bigint':
            return cut(value, 40);
        default:
            return value === null ? null : { $: typeof value === 'function' ? 'function' : 'object' };
    }
}

function primitive (value: unknown): boolean
{
    return value === null || value === undefined || (typeof value !== 'object' && typeof value !== 'function');
}

function at (object: unknown, path: string): unknown
{
    if (path === '')
    {
        return object;
    }

    let here: any = object;

    for (const part of path.split('.'))
    {
        if (here === null || here === undefined)
        {
            return undefined;
        }

        here = here[part];
    }

    return here;
}

// An object's own primitive properties, as dotted paths, down to `depth` levels.
function flatten (object: any, depth: number, prefix: string, out: Record<string, Wire>, count: { n: number }): void
{
    let keys: string[];

    try
    {
        keys = G.Object.keys(object);
    }
    catch
    {
        return;
    }

    for (const key of keys)
    {
        if (count.n >= PROPS_PER_WATCH)
        {
            return;
        }

        const path = prefix ? `${prefix}.${key}` : key;
        let value: unknown;

        try
        {
            value = object[key];
        }
        catch
        {
            out[path] = { $: 'error' };
            count.n++;
            continue;
        }

        if (primitive(value))
        {
            out[path] = wire(value);
            count.n++;
        }
        else if (depth > 1 && typeof value === 'object')
        {
            flatten(value, depth - 1, path, out, count);
        }
    }
}

function readValues (watch: Watch): Record<string, Wire>
{
    const out: Record<string, Wire> = {};
    let value: unknown;

    try
    {
        value = watch.read();
        watch.error = null;
    }
    catch (error: any)
    {
        watch.error = cut(error?.message ?? error, 200);

        for (const prop of watch.props ?? (watch.last ? G.Object.keys(watch.last) : ['']))
        {
            out[prop] = { $: 'error' };
        }

        return out;
    }

    if (watch.props)
    {
        for (const prop of watch.props)
        {
            try
            {
                out[prop] = wire(at(value, prop));
            }
            catch
            {
                out[prop] = { $: 'error' };
            }
        }
    }
    else if (primitive(value))
    {
        out[''] = wire(value);
    }
    else
    {
        flatten(value, watch.depth, '', out, { n: 0 });
    }

    return out;
}

function same (a: Wire, b: Wire): boolean
{
    if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object')
    {
        return a.$ === b.$;
    }

    return a === b;
}

function isNumber (value: Wire): boolean
{
    return typeof value === 'number' || (value !== null && typeof value === 'object' && (value.$ === 'NaN' || value.$ === 'Infinity' || value.$ === '-Infinity'));
}

function typeOf (value: Wire): string
{
    if (value === null)
    {
        return 'null';
    }

    if (typeof value === 'object')
    {
        return isNumber(value) ? 'number' : value.$;
    }

    return typeof value;
}

// Whether a value breaks a rule, given the frame before's.
function breaks (rule: Rule, value: Wire, before: Wire | undefined): boolean
{
    switch (rule.rule)
    {
        case 'finite':
            return isNumber(value) && typeof value !== 'number';
        case 'defined':
            return value === null || (typeof value === 'object' && value.$ === 'undefined');
        case 'range':
            return isNumber(value) && (typeof value !== 'number' || (rule.min !== undefined && value < rule.min) || (rule.max !== undefined && value > rule.max));
        case 'type':
            return rule.type !== undefined && typeOf(value) !== rule.type;
        case 'changes':
            return before !== undefined && same(value, before);
        case 'steady':
            return before !== undefined && !same(value, before);
        default:
            return false;
    }
}

function show (value: Wire | undefined): string
{
    if (value === undefined)
    {
        return 'nothing';
    }

    if (value !== null && typeof value === 'object')
    {
        return value.$;
    }

    return typeof value === 'string' ? `"${cut(value, 40)}"` : G.String(value);
}

// Checks one watch's values against its rules. Returns why the game should stop, if a rule
// that breaks has broken on this frame.
function check (watch: Watch, values: Record<string, Wire>, frame: number): string | null
{
    let stop: string | null = null;

    watch.rules.forEach((rule, index) =>
    {
        const props = rule.prop !== undefined ? [rule.prop] : G.Object.keys(values);

        for (const prop of props)
        {
            if (!(prop in values))
            {
                continue;
            }

            const value = values[prop];
            const before = watch.last?.[prop];
            const key = `${index}|${prop}`;

            if (!breaks(rule, value, before))
            {
                watch.breaking.delete(key);
                continue;
            }

            // Told once when it breaks, not on every frame it stays broken.
            if (watch.breaking.has(key))
            {
                continue;
            }

            watch.breaking.add(key);

            const broken: Broken = { rule: rule.rule, prop, frame, before: before ?? null, after: value };

            watch.broken.push(broken);

            if (watch.broken.length > 50)
            {
                watch.broken.shift();
            }

            emit('watch-broken', { name: watch.name, ...broken, breaks: rule.break === true });

            if (rule.break && stop === null)
            {
                const label = prop === '' ? cut(watch.name, 60) : `${cut(watch.name, 60)}.${cut(prop, 60)}`;

                stop = `watch «${label}» broke its rule ${rule.rule}: ${show(before)} became ${show(value)}`;
            }
        }
    });

    return stop;
}

function readAll (): string | null
{
    if (watches.size === 0)
    {
        costMs = 0;
        propsRead = 0;
        thinned = false;

        return null;
    }

    const frame = currentFrame();

    // Past the limit, every other frame.
    if (thinned && frame % 2 === 1)
    {
        return null;
    }

    const started = nativeNow();
    let stop: string | null = null;
    let count = 0;

    for (const watch of watches.values())
    {
        const values = readValues(watch);
        const why = check(watch, values, frame);

        stop = stop ?? why;
        watch.last = values;
        watch.frames.push(frame);
        watch.rows.push(values);

        if (watch.frames.length > HISTORY)
        {
            watch.frames.shift();
            watch.rows.shift();
        }

        for (const _ in values)
        {
            count++;
        }
    }

    propsRead = count;
    thinned = count > PROPS_EVERY_FRAME;

    // A moving average, so one slow frame does not hide the usual cost.
    const spent = nativeNow() - started;

    costMs = costMs === 0 ? spent : costMs * 0.9 + spent * 0.1;

    return stop;
}

function rulesFrom (given: unknown, breakAll: boolean): Rule[]
{
    const kinds = ['finite', 'defined', 'range', 'type', 'changes', 'steady'];
    const rules: Rule[] = [];

    if (G.Array.isArray(given))
    {
        for (const item of (given as any[]).slice(0, 16))
        {
            const kind = typeof item === 'string' ? item : item?.rule;

            if (!kinds.includes(kind))
            {
                continue;
            }

            rules.push({
                rule: kind,
                prop: typeof item?.prop === 'string' ? cut(item.prop, 120) : undefined,
                min: typeof item?.min === 'number' ? item.min : undefined,
                max: typeof item?.max === 'number' ? item.max : undefined,
                type: typeof item?.type === 'string' ? cut(item.type, 20) : undefined,
                break: item?.break === true || breakAll
            });
        }
    }

    // Numbers are finite unless the watch says otherwise.
    if (rules.length === 0)
    {
        rules.push({ rule: 'finite', break: breakAll });
    }

    return rules;
}

function propsFrom (given: unknown): string[] | null
{
    if (!G.Array.isArray(given))
    {
        return null;
    }

    const props = (given as unknown[]).filter((prop) => typeof prop === 'string').slice(0, PROPS_PER_WATCH).map((prop) => cut(prop, 120));

    return props.length ? props : null;
}

function add (watch: Watch): Watch
{
    const old = watches.get(watch.name);

    // Watched again under the same name (a player made again after it died): the history stays.
    if (old)
    {
        watch.frames = old.frames;
        watch.rows = old.rows;
        watch.last = old.last;
        watch.broken = old.broken;
    }
    else if (watches.size >= WATCHES)
    {
        throw new G.Error(`At most ${WATCHES} watches; remove some first`);
    }

    watches.set(watch.name, watch);

    return watch;
}

function blank (name: string, source: 'expression' | 'page', read: () => unknown): Watch
{
    return {
        name, source, read, props: null, depth: 1, rules: [], frames: [], rows: [], last: null, broken: [], breaking: new G.Set(), error: null, added: currentFrame()
    };
}

// ---- What a page's objects commonly have ----

const SPRITE = ['x', 'y', 'rotation', 'angle', 'scale.x', 'scale.y', 'scaleX', 'scaleY', 'alpha', 'visible', 'frame.name', 'texture.label', 'body.velocity.x', 'body.velocity.y', 'velocity.x', 'velocity.y', 'vx', 'vy'];
const OBJECT3D = ['position.x', 'position.y', 'position.z', 'rotation.x', 'rotation.y', 'rotation.z', 'scale.x', 'scale.y', 'scale.z', 'visible'];

// The paths of a kind that this object has.
function present (object: unknown, paths: string[]): string[]
{
    return paths.filter((path) =>
    {
        try
        {
            const value = at(object, path);

            return value !== undefined && primitive(value);
        }
        catch
        {
            return false;
        }
    });
}

// The page protocol's side: `__scanline.watch(name, object, options)`.
export function pageWatch (name: unknown, object: unknown, options: any, kind?: 'sprite' | 'object3d'): void
{
    if (object === null || object === undefined)
    {
        return;
    }

    const label = cut(name ?? 'object', 80);
    const watch = blank(label, 'page', () => object);

    watch.props = propsFrom(options?.props) ?? (kind ? present(object, kind === 'sprite' ? SPRITE : OBJECT3D) : null);
    watch.depth = G.Math.max(1, G.Math.min(3, typeof options?.depth === 'number' ? options.depth : 1));
    watch.rules = rulesFrom(options?.rules, options?.break === true);
    watch.kind = kind;

    add(watch);
}

export function pageUnwatch (name: unknown): void
{
    watches.delete(cut(name, 80));
}

function columns (watch: Watch, count: number): Record<string, unknown>
{
    const from = G.Math.max(0, watch.rows.length - count);
    const rows = watch.rows.slice(from);
    const props = watch.last ? G.Object.keys(watch.last) : [];
    const values: Record<string, Wire[]> = {};

    for (const prop of props)
    {
        values[prop] = rows.map((row: Record<string, Wire>) => (prop in row ? row[prop] : { $: 'undefined' }));
    }

    return { frames: watch.frames.slice(from), values };
}

function describe (watch: Watch, history: number): Record<string, unknown>
{
    const props = watch.last ? G.Object.keys(watch.last).map((prop: string) => ({ prop, value: watch.last![prop], broken: [...watch.breaking].some((key) => key.endsWith(`|${prop}`)) })) : [];

    return {
        name: watch.name,
        source: watch.source,
        expr: watch.expr,
        kind: watch.kind,
        props,
        rules: watch.rules,
        broken: watch.broken.slice(-10),
        error: watch.error,
        frames: watch.frames.length,
        added: watch.added,
        history: history > 0 ? columns(watch, history) : undefined
    };
}

export function watchSummary (): Record<string, unknown> | null
{
    if (watches.size === 0)
    {
        return null;
    }

    return { frame: currentFrame(), watches: [...watches.values()].map((watch) => describe(watch, 0)) };
}

export function installWatches (): void
{
    onFrameCheck(readAll);

    expose('watch.add', (args: { expr: string; name?: string; props?: string[]; depth?: number; rules?: unknown; break?: boolean }) =>
    {
        let read: () => unknown;

        try
        {
            // Compiled once. The host has lifted the page's Content Security Policy for the probe.
            read = new NativeFunction(`return (${args.expr});`) as () => unknown;
        }
        catch (error: any)
        {
            return { refused: `the expression does not compile: ${cut(error?.message ?? error, 200)}` };
        }

        const watch = blank(cut(args.name ?? args.expr, 80), 'expression', read);

        watch.expr = cut(args.expr, 400);
        watch.props = propsFrom(args.props);
        watch.depth = G.Math.max(1, G.Math.min(3, args.depth ?? 1));
        watch.rules = rulesFrom(args.rules, args.break === true);

        try
        {
            add(watch);
        }
        catch (error: any)
        {
            return { refused: cut(error?.message ?? error, 200) };
        }

        // Its first values now, so the answer says what it watches.
        watch.last = readValues(watch);

        return describe(watch, 0);
    });

    expose('watch.remove', (args: { name?: string; all?: boolean }) =>
    {
        if (args.all)
        {
            const removed = [...watches.keys()];

            watches.clear();

            return { removed };
        }

        const name = G.String(args.name ?? '');

        return watches.delete(name) ? { removed: [name] } : { unknown: true, known: [...watches.keys()] };
    });

    expose('watch.list', (args: { history?: number; name?: string }) =>
    {
        const history = G.Math.max(0, G.Math.min(HISTORY, args.history ?? 0));
        let chosen = [...watches.values()];

        if (args.name !== undefined && args.name !== null)
        {
            chosen = chosen.filter((watch) => watch.name === args.name);

            if (chosen.length === 0)
            {
                return { unknown: true, known: [...watches.keys()] };
            }
        }

        return {
            frame: currentFrame(),
            cost: { ms: costMs, props: propsRead, thinned, limit: PROPS_EVERY_FRAME },
            watches: chosen.map((watch) => describe(watch, history))
        };
    });

    expose('watch.set', (args: { name: string; prop: string; value: unknown }) =>
    {
        const watch = watches.get(args.name);

        if (!watch)
        {
            return { unknown: true, known: [...watches.keys()] };
        }

        const prop = G.String(args.prop ?? '');
        const value = args.value;

        if (!primitive(value) || value === undefined)
        {
            return { refused: 'a watched value is set to a number, a boolean, a string or null' };
        }

        let object: unknown;

        try
        {
            object = watch.read();
        }
        catch (error: any)
        {
            return { refused: `the watch cannot be read: ${cut(error?.message ?? error, 200)}` };
        }

        const before = wire(at(object, prop));

        if (before !== null && typeof before === 'object' && before.$ !== 'undefined' && !isNumber(before))
        {
            return { refused: `${prop || 'its value'} is ${before.$}, not a value that can be set` };
        }

        if (before !== null && typeof before !== 'object' && typeof before !== typeof value)
        {
            return { refused: `${prop || 'its value'} is a ${typeof before}, so it takes a ${typeof before}` };
        }

        if (isNumber(before) && typeof value !== 'number')
        {
            return { refused: `${prop || 'its value'} is a number, so it takes a number` };
        }

        try
        {
            if (prop === '')
            {
                if (watch.source !== 'expression')
                {
                    return { refused: 'a watched object is set by property' };
                }

                const assign = new NativeFunction('__scanlineValue', `(${watch.expr}) = __scanlineValue;`) as (value: unknown) => void;

                assign(value);
            }
            else
            {
                const parts = prop.split('.');
                const last = parts.pop()!;
                const owner: any = at(object, parts.join('.'));

                if (owner === null || typeof owner !== 'object')
                {
                    return { refused: `${parts.join('.') || 'the watched value'} is not an object` };
                }

                owner[last] = value;
            }
        }
        catch (error: any)
        {
            return { refused: `the page refused it: ${cut(error?.message ?? error, 200)}` };
        }

        const after = wire(at(prop === '' ? watch.read() : object, prop));

        // Shown at once, though the frame's own read comes when it ends.
        if (watch.last)
        {
            watch.last = { ...watch.last, [prop]: after };
        }

        return { before, after, frame: currentFrame() };
    });
}
