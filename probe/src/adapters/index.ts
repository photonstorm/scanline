// Engine adapters (05-PAGE-PROTOCOL.md, section 2). Each recognises one engine and makes
// the protocol's calls on its behalf, so that draws resolve to the engine's own objects
// with no change to the page.
//
// An adapter is best effort. It reaches into an engine it did not ship with, so every one
// is wrapped: if it throws while installing or while the page runs, it switches itself off
// and the page carries on as if it had never been there.

import { config } from '../config';
import { declare } from '../mods';
import { isWindow } from '../natives';

const installers: Array<() => void> = [];

export function adapter (install: () => void): void
{
    installers.push(install);
}

export function installAdapters (): void
{
    // Adapters define globals engines look for and wrap engine functions: both are changes
    // a page could notice.
    if (config.unmodified || !isWindow)
    {
        return;
    }

    for (const install of installers)
    {
        try
        {
            install();
        }
        catch
        {
            // This engine goes unrecognised.
        }
    }

    declare({
        id: 'engine-adapters',
        what: 'Globals that three.js, PixiJS and PlayCanvas announce themselves to are defined (__THREE_DEVTOOLS__, __PIXI_APP_INIT__, __PIXI_RENDERER_INIT__, and a devtools hook at Symbol.for("playcanvas.inspector")); window.Phaser is watched with an accessor, and Object.prototype has setters for cameraRenderNode (the one property only Phaser\'s WebGL renderer assigns), _renderingManager (which a Babylon.js scene assigns) and defaultLayerWorld (which a PlayCanvas application assigns); a recognised engine has some of its render functions wrapped',
        why: 'Mapping draws to the engine objects they belong to',
        optional: true,
        active: () => true
    });
}
