// How an adapter wraps an engine's function: a group is opened before it runs and closed
// after, whatever it does. The engine's function always runs, with its own arguments and
// its own result; if the adapter's part throws, the adapter is switched off and the page
// carries on unwrapped in all but name.

import { noteEntity, popGroup, pushGroup } from '../groups';
import { G } from '../natives';
import { reportAdapter, type AdapterReport } from '../protocol';

export interface Adapter
{
    report: AdapterReport;
    on: boolean;
}

export function newAdapter (engine: string, tested: string): Adapter
{
    return { report: { engine, version: '', tested, status: 'partial', notes: [] }, on: true };
}

export function announce (adapter: Adapter): void
{
    reportAdapter(adapter.report);
}

export function note (adapter: Adapter, text: string): void
{
    if (!adapter.report.notes.includes(text) && adapter.report.notes.length < 8)
    {
        adapter.report.notes.push(text);
    }

    announce(adapter);
}

export function fail (adapter: Adapter, where: string, error: unknown): void
{
    adapter.on = false;
    adapter.report.status = 'off';
    note(adapter, `The adapter switched itself off: ${where} threw ${G.String((error as any)?.message ?? error).slice(0, 120)}. Draws are no longer grouped by engine object.`);
}

const wrapped = new G.WeakSet() as WeakSet<object>;

export function isWrapped (fn: unknown): boolean
{
    return typeof fn === 'function' && wrapped.has(fn);
}

// What a wrapped call is: the group's name, and the game object if there is one. Null for
// a call that should not be grouped.
export type Describe = (self: any, args: any[]) => { name: string; entity?: Record<string, unknown> } | null;

// Replaces target[name] with a function that runs the original inside a group. Returns
// whether it did (false when there is no such function, or it is wrapped already).
export function around (adapter: Adapter, target: any, name: string, describe: Describe): boolean
{
    const original = target?.[name];

    if (typeof original !== 'function' || wrapped.has(original))
    {
        return false;
    }

    const replacement = function (this: any, ...args: any[]): any
    {
        let opened = false;

        if (adapter.on)
        {
            try
            {
                const what = describe(this, args);

                if (what !== null)
                {
                    pushGroup(what.name);
                    opened = true;

                    if (what.entity)
                    {
                        noteEntity(what.entity);
                    }
                }
            }
            catch (error)
            {
                fail(adapter, name, error);
            }
        }

        try
        {
            return original.apply(this, args);
        }
        finally
        {
            if (opened)
            {
                popGroup();
            }
        }
    };

    wrapped.add(replacement);

    try
    {
        target[name] = replacement;
    }
    catch
    {
        return false;
    }

    return target[name] === replacement;
}

// Replaces target[name] with a function that tells the adapter before the original runs
// and after it returns or throws. For bookkeeping that opens no group of its own.
export function watch (adapter: Adapter, target: any, name: string, before: (self: any, args: any[]) => unknown, after?: (self: any, args: any[], token: unknown) => void): boolean
{
    const original = target?.[name];

    if (typeof original !== 'function' || wrapped.has(original))
    {
        return false;
    }

    const replacement = function (this: any, ...args: any[]): any
    {
        let token: unknown;
        let entered = false;

        if (adapter.on)
        {
            try
            {
                token = before(this, args);
                entered = true;
            }
            catch (error)
            {
                fail(adapter, name, error);
            }
        }

        try
        {
            return original.apply(this, args);
        }
        finally
        {
            if (entered && after && adapter.on)
            {
                try
                {
                    after(this, args, token);
                }
                catch (error)
                {
                    fail(adapter, name, error);
                }
            }
        }
    };

    wrapped.add(replacement);

    try
    {
        target[name] = replacement;
    }
    catch
    {
        return false;
    }

    return target[name] === replacement;
}

// The object that owns a method, walking up from an instance.
export function ownerOf (instance: any, method: string): any
{
    let at = instance;

    for (let depth = 0; at && depth < 8; depth++)
    {
        if (G.Object.prototype.hasOwnProperty.call(at, method))
        {
            return at;
        }

        at = G.Object.getPrototypeOf(at);
    }

    return null;
}

export function short (value: unknown, most = 60): string
{
    const string = typeof value === 'string' ? value : G.String(value ?? '');

    return string.length > most ? string.slice(0, most) : string;
}
