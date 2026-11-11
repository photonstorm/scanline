// What the host tells the probe at injection. The host wraps the built probe in a function
// that declares __SCANLINE_CONFIG__, so nothing is read from a global.

export type Level = 'off' | 'observe' | 'record' | 'capture';

export interface Config
{
    // Symbol.for(key) on the global holds the probe's entry point for the host.
    key: string;

    // Name of the Runtime.addBinding function the probe sends events through.
    binding: string;

    level: Level;

    // Change nothing the page can observe.
    unmodified: boolean;

    // Hold the first frame until the host steps or resumes.
    startPaused: boolean;

    // Deterministic session: time moves by fixedDt per frame, random numbers are seeded.
    // printEvery: a fingerprint of the frame is taken every so many frames (default 30; 0 for none).
    deterministic: null | { seed: number; fixedDt: number; printEvery?: number };

    // The key that means "freeze and capture now", as a KeyboardEvent code or key. 'none' for no key.
    debugKey: string;
    // 'shim': the probe grants pointer lock and delivers relative moves itself.
    pointerLock: 'native' | 'shim';

    probeVersion: string;
}

declare const __SCANLINE_CONFIG__: Partial<Config> | undefined;

const given: Partial<Config> = typeof __SCANLINE_CONFIG__ === 'object' && __SCANLINE_CONFIG__ ? __SCANLINE_CONFIG__ : {};

export const config: Config = {
    key: 'scanline.probe',
    binding: '',
    level: 'observe',
    unmodified: false,
    startPaused: false,
    deterministic: null,
    debugKey: 'F9',
    pointerLock: 'native',
    probeVersion: '0.0.1',
    ...given
};
