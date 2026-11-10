import { loop } from './scene.js';
import { createWebGL2Scene } from './webgl2-scene.js';

self.onmessage = (event) =>
{
    const state = loop('worker', createWebGL2Scene(event.data.canvas));

    // The page cannot read a worker's globals, so the state is posted on request.
    self.onmessage = () => self.postMessage({ ...state });
};
