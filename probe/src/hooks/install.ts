// Puts the generated wrappers onto the native prototypes.
//
// Methods are patched in place on the prototypes the page uses. No Proxy and no subclass:
// patched objects stay genuine platform objects (02-ARCHITECTURE.md, section 3.2).

import { G, nDefineProperty, nGetOwnPropertyDescriptor, nGetOwnPropertyNames, nGetPrototypeOf, type Fn } from '../natives';
import { disguise } from '../masquerade';
import { GL_EXTENSION_WRAPPERS, GL_WRAPPERS, GPU_WRAPPERS, HANDLED, type Factory } from './generated';
import { bindExtension, hub, type Rec } from './hub';

// The unwrapped functions, by interface then method. The probe's own GPU work goes through
// these so it never shows up in counters or captures.
export const natives: Record<string, Record<string, Fn>> = {};

// What the interface definitions and the running browser disagree about.
export const coverage = {
    // On the prototype, absent from the definitions: wrapped generically.
    unknown: [] as string[],
    // In the definitions, absent from this browser.
    missing: [] as string[],
    // The method table promises a handler that nobody registered. A build fault.
    unhandled: [] as string[],
    interfaces: [] as string[]
};

export type Handlers = Record<string, Fn>;

const none: Fn = () => undefined;
const patched = new WeakSet<object>();

type Family = 'gl' | 'ext' | 'gpu';

// A wrapper for a method the generator did not know about. It is counted like any other.
function generic (native: Fn, family: Family): Fn
{
    return function (this: any): unknown
    {
        if (hub.off)
        {
            return native.apply(this, arguments as any);
        }

        const record = family === 'gl' ? hub.ctx(this) : (family === 'ext' ? hub.ext(this) : hub.gpu);
        const result = native.apply(this, arguments as any);

        record.calls++;

        return result;
    };
}

function installOn (proto: any, iface: string, factories: Record<string, Factory>, handlers: Handlers, family: Family): void
{
    if (!proto || patched.has(proto))
    {
        return;
    }

    patched.add(proto);
    coverage.interfaces.push(iface);

    const table = (natives[iface] ??= {});

    for (const name of nGetOwnPropertyNames(proto) as string[])
    {
        if (name === 'constructor')
        {
            continue;
        }

        const descriptor = nGetOwnPropertyDescriptor(proto, name);

        if (!descriptor || typeof descriptor.value !== 'function')
        {
            continue;
        }

        const native: Fn = descriptor.value;
        const factory = factories[name];

        let wrapper: Fn;

        if (factory)
        {
            // WebGL 1 and WebGL 2 share one handler per method, registered as `gl.<name>`.
            const handler = handlers[`${iface}.${name}`] ?? (family === 'gl' ? handlers[`gl.${name}`] : undefined);

            wrapper = factory(native, hub, handler ?? none);
        }
        else
        {
            coverage.unknown.push(`${iface}.${name}`);
            wrapper = generic(native, family);
        }

        table[name] = native;

        nDefineProperty(proto, name, { ...descriptor, value: disguise(wrapper, native) });
    }

    for (const name of G.Object.keys(factories))
    {
        if (!(name in table))
        {
            coverage.missing.push(`${iface}.${name}`);
        }
    }
}

let extensionHandlers: Handlers = {};

// Called when the page fetches an extension. Extension interfaces have no global
// constructor, so their prototypes can only be reached through an instance.
export function hookExtension (name: string, extension: object, record: Rec): void
{
    bindExtension(extension, record);

    const factories = GL_EXTENSION_WRAPPERS[name];

    if (factories)
    {
        installOn(nGetPrototypeOf(extension), name, factories, extensionHandlers, 'ext');
    }
}

export function installHooks (handlers: Handlers): void
{
    extensionHandlers = handlers;

    for (const key of HANDLED)
    {
        if (typeof handlers[key] !== 'function')
        {
            coverage.unhandled.push(key);
        }
    }

    for (const iface of G.Object.keys(GL_WRAPPERS))
    {
        if (typeof G[iface] === 'function')
        {
            installOn(G[iface].prototype, iface, GL_WRAPPERS[iface], handlers, 'gl');
        }
    }

    for (const iface of G.Object.keys(GPU_WRAPPERS))
    {
        if (typeof G[iface] === 'function')
        {
            installOn(G[iface].prototype, iface, GPU_WRAPPERS[iface], handlers, 'gpu');
        }
    }
}
