// Wrapped functions keep the name, length and source text of the native they wrap, so
// pages that check (feature detection, anti-tamper code, some polyfills) see no difference.

import { G, nDefineProperty, type Fn } from './natives';

const originals = new WeakMap<Fn, Fn>();
const nativeToString: Fn = G.Function.prototype.toString;

export function disguise<T extends Fn> (wrapper: T, native: Fn): T
{
    originals.set(wrapper, native);

    nDefineProperty(wrapper, 'name', { value: native.name, configurable: true });
    nDefineProperty(wrapper, 'length', { value: native.length, configurable: true });

    return wrapper;
}

// Replace a method where it lives (the object itself or somewhere up its prototype chain),
// keeping the property's flags. Returns the native, or null if there is no such function.
export function patch (target: any, name: string, make: (native: Fn) => Fn): Fn | null
{
    let owner = target;

    while (owner && !G.Object.prototype.hasOwnProperty.call(owner, name))
    {
        owner = G.Object.getPrototypeOf(owner);
    }

    if (!owner)
    {
        return null;
    }

    const descriptor = G.Object.getOwnPropertyDescriptor(owner, name);

    if (!descriptor || typeof descriptor.value !== 'function')
    {
        return null;
    }

    const native: Fn = descriptor.value;
    const wrapper = disguise(make(native), native);

    nDefineProperty(owner, name, { ...descriptor, value: wrapper });

    return native;
}

export function installMasquerade (): void
{
    const toString = function toString (this: unknown): string
    {
        const original = typeof this === 'function' ? originals.get(this as Fn) : undefined;

        return nativeToString.call(original ?? this);
    };

    disguise(toString, nativeToString);

    nDefineProperty(G.Function.prototype, 'toString', {
        value: toString,
        writable: true,
        enumerable: false,
        configurable: true
    });
}
