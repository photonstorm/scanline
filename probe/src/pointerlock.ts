// Pointer lock, stood in for (02-ARCHITECTURE.md, section 6).
//
// A game that looks around with the mouse asks for pointer lock and then reads how far the
// mouse moved, not where it is. The browser grants lock only to a real gesture in a focused
// window and has no way to inject a relative move, so an agent cannot play such a game
// through the browser's own lock. With `pointerLock: 'shim'` the probe grants the lock
// itself and delivers moves with explicit deltas.
//
// The moves are events the probe makes, so they report isTrusted false, and the browser's
// own cursor is not hidden or confined. A session launched without the shim is untouched.

import { currentFrame } from './clock/gate';
import { config } from './config';
import { patch } from './masquerade';
import { declare } from './mods';
import { G, isWindow, nAddEventListener, nDefineProperty, nGetOwnPropertyDescriptor } from './natives';
import { emit, expose } from './transport';

export function installPointerLock (): void
{
    if (!isWindow)
    {
        return;
    }

    const shim = config.pointerLock === 'shim' && !config.unmodified;

    let locked: any = null;
    let last = { x: 0, y: 0 };

    expose('pointer.state', () => ({ shim, locked: Boolean(locked), frame: currentFrame() }));

    expose('pointer.moveBy', (args: { dx?: number; dy?: number }) =>
    {
        if (!shim)
        {
            return { shim: false };
        }

        if (!locked || !locked.isConnected)
        {
            locked = null;

            return { shim: true, locked: false };
        }

        const dx = G.Number(args.dx) || 0;
        const dy = G.Number(args.dy) || 0;
        const init = { bubbles: true, cancelable: true, composed: true, view: G, clientX: last.x, clientY: last.y, screenX: last.x, screenY: last.y, movementX: dx, movementY: dy };

        locked.dispatchEvent(new G.PointerEvent('pointermove', { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
        locked.dispatchEvent(new G.MouseEvent('mousemove', init));

        return { shim: true, locked: true, dx, dy, frame: currentFrame() };
    });

    if (!shim)
    {
        // The browser's own lock, refused: said to whoever is driving, a few times at most.
        // It is refused when the window is not in front, which an agent's often is not.
        let told = 0;

        nAddEventListener.call(G.document, 'pointerlockerror', () =>
        {
            if (told++ < 3)
            {
                emit('pointer-lock-refused', { frame: currentFrame() });
            }
        }, true);

        return;
    }

    const changed = (): void =>
    {
        G.queueMicrotask(() => G.document.dispatchEvent(new G.Event('pointerlockchange', { bubbles: true })));
    };

    // Where the pointer was when lock was taken: what a locked move reports as its position.
    G.addEventListener('mousemove', (event: MouseEvent) =>
    {
        if (!locked && event.isTrusted)
        {
            last = { x: event.clientX, y: event.clientY };
        }
    }, { capture: true, passive: true });

    patch(G.Element.prototype, 'requestPointerLock', () => function requestPointerLock (this: Element): Promise<void>
    {
        if (locked !== this)
        {
            locked = this;
            changed();
        }

        return G.Promise.resolve();
    });

    patch(G.Document.prototype, 'exitPointerLock', () => function exitPointerLock (this: Document): void
    {
        if (locked)
        {
            locked = null;
            changed();
        }
    });

    const descriptor = nGetOwnPropertyDescriptor(G.Document.prototype, 'pointerLockElement');

    if (descriptor?.get)
    {
        const native = descriptor.get;

        nDefineProperty(G.Document.prototype, 'pointerLockElement', {
            ...descriptor,
            get: function pointerLockElement (this: Document): Element | null
            {
                return locked && locked.isConnected ? locked : native.call(this);
            }
        });
    }

    declare({
        id: 'pointer-lock-shim',
        what: 'requestPointerLock is granted by the debugger without a gesture, and relative mouse moves under it are not trusted events; the cursor is not hidden',
        why: 'The browser cannot inject a relative mouse move, so a game played by mouse-look could not be driven otherwise',
        optional: true,
        active: () => true
    });
}
