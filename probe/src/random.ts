// Seeded random numbers for deterministic sessions (02-ARCHITECTURE.md, section 7).

import { patch } from './masquerade';
import { declare } from './mods';
import { G } from './natives';

export function installSeededRandom (seed: number): void
{
    let state = seed >>> 0;

    // mulberry32: small, fast, and good enough for games. Not for cryptography, which a
    // deterministic debugging session does not need.
    const next = (): number =>
    {
        state = (state + 0x6D2B79F5) >>> 0;

        let t = state;

        t = G.Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + G.Math.imul(t ^ (t >>> 7), t | 61);

        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    patch(G.Math, 'random', () => function random (): number
    {
        return next();
    });

    if (G.crypto && typeof G.Crypto === 'function')
    {
        patch(G.Crypto.prototype, 'getRandomValues', (native) => function getRandomValues (this: Crypto, array: any): any
        {
            // Let the browser validate the argument, then overwrite what it filled.
            native.call(this, array);

            const bytes = new G.Uint8Array(array.buffer, array.byteOffset, array.byteLength);

            for (let i = 0; i < bytes.length; i++)
            {
                bytes[i] = (next() * 256) | 0;
            }

            return array;
        });
    }

    declare({
        id: 'seeded-random',
        what: `Math.random and crypto.getRandomValues return a fixed sequence (seed ${seed})`,
        why: 'Deterministic session: the same inputs replay to the same frames',
        optional: false,
        active: () => true
    });
}
