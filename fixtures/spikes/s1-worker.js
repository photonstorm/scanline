// First line of a worker: was the probe here before us?
const key = new URL(self.location.href).searchParams.get('key');
const present = typeof globalThis[Symbol.for(key)] === 'function';
const who = new URL(self.location.href).searchParams.get('who');
const leaked = Object.getOwnPropertyNames(globalThis).filter((name) => name.startsWith('__scanline'));

const report = { who, present, leaked, webgpu: typeof GPUDevice === 'function' };

if (who === 'offscreen')
{
    const gl = new OffscreenCanvas(64, 64).getContext('webgl2');

    report.gl = Boolean(gl);
}

if (who === 'nested-parent')
{
    const child = new Worker(`./s1-worker.js?who=nested-child&key=${key}`);

    child.onmessage = (event) => self.postMessage(event.data);
}

if (typeof SharedWorkerGlobalScope !== 'undefined' && self instanceof SharedWorkerGlobalScope)
{
    self.onconnect = (event) => event.ports[0].postMessage(report);
}
else if (typeof ServiceWorkerGlobalScope !== 'undefined' && self instanceof ServiceWorkerGlobalScope)
{
    self.addEventListener('message', (event) => event.source.postMessage(report));
}
else
{
    self.postMessage(report);
}
