// The Debug key.
//
// A person hunting a glitch presses it at the moment the glitch shows. The probe's listener
// is added before any of the page's, at the top of the capture phase, so the key is taken
// here and the page never sees it: no keydown, no keyup, no default action.
//
// This is the in-page stand-in for the global hotkey the design asks for. It works while
// the page has the keyboard, including under pointer lock and in fullscreen, but not when
// another window does.

import { config } from './config';
import { currentFrame } from './clock/gate';
import { G } from './natives';
import { emit } from './transport';

export function installHandoff (): void
{
    const key = config.debugKey;

    if (!key || key === 'none' || typeof G.addEventListener !== 'function' || typeof G.document === 'undefined')
    {
        return;
    }

    const taken = (event: any): boolean => event.code === key || event.key === key;

    G.addEventListener('keydown', (event: any) =>
    {
        if (!taken(event))
        {
            return;
        }

        event.preventDefault();
        event.stopImmediatePropagation();

        if (!event.repeat)
        {
            emit('debug-key', { frame: currentFrame() });
        }
    }, true);

    G.addEventListener('keyup', (event: any) =>
    {
        if (taken(event))
        {
            event.preventDefault();
            event.stopImmediatePropagation();
        }
    }, true);
}
