const key = new URL(self.location.href).searchParams.get('key');

self.postMessage({
    who: 'module',
    present: typeof globalThis[Symbol.for(key)] === 'function',
    leaked: Object.getOwnPropertyNames(globalThis).filter((name) => name.startsWith('__scanline'))
});
