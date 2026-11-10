// Control traffic between the probe and the host.
//
// Host to probe: the host evaluates `globalThis[Symbol.for(key)](method, argsJson)` in the
// probe's context. Probe to host: small JSON events through a Runtime.addBinding function.
// Bulk data does not travel this way (02-ARCHITECTURE.md, section 3.6).

import { config } from './config';
import { G, nDefineProperty, nParse, nStringify, type Fn } from './natives';

type Handler = (args: any) => unknown;

const handlers = new Map<string, Handler>();

let send: ((payload: string) => void) | null = null;

export function expose (method: string, handler: Handler): void
{
    handlers.set(method, handler);
}

export function emit (type: string, data: Record<string, unknown> = {}): void
{
    if (send === null)
    {
        return;
    }

    try
    {
        send(nStringify({ t: type, ...data }));
    }
    catch
    {
        // The host has gone away, or the data could not be serialised. Neither may disturb the page.
    }
}

// Results go back as JSON text so the host needs no object handles and nothing in the
// result depends on the page's own toJSON or prototype changes.
function call (method: string, argsJson?: string): string | Promise<string>
{
    const handler = handlers.get(method);

    if (!handler)
    {
        return nStringify({ error: `Unknown probe method "${method}"` });
    }

    try
    {
        const result = handler(argsJson ? nParse(argsJson) : {});

        if (result && typeof (result as Promise<unknown>).then === 'function')
        {
            return (result as Promise<unknown>).then(
                (value) => nStringify({ ok: value ?? null }),
                (error) => nStringify({ error: String(error?.message ?? error) })
            );
        }

        return nStringify({ ok: result ?? null });
    }
    catch (error: any)
    {
        return nStringify({ error: String(error?.message ?? error) });
    }
}

export function installTransport (): boolean
{
    const symbol = G.Symbol.for(config.key);

    if (G[symbol])
    {
        // Already injected into this global (the host may evaluate the probe more than once).
        return false;
    }

    if (config.binding && typeof G[config.binding] === 'function')
    {
        const binding: Fn = G[config.binding];

        send = (payload) => binding(payload);

        // Take the binding off the global so page code that enumerates it sees nothing new.
        try
        {
            delete G[config.binding];
        }
        catch
        {
            // Not configurable in this browser: it stays, and is listed as a modification.
        }
    }

    nDefineProperty(G, symbol, {
        value: call,
        enumerable: false,
        writable: false,
        configurable: false
    });

    return true;
}

export function bindingLeftBehind (): boolean
{
    return Boolean(config.binding) && typeof G[config.binding] === 'function';
}
