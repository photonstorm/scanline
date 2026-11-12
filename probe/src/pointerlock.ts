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

    if (config.pointerLock === 'app' && !config.unmodified)
    {
        installAppLock();

        return;
    }

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

// In the Scanline app. Its embedded browser (CEF) turns every pointer lock request down
// ("UnknownError"), so a game that steers by the mouse could not be played in it. The page's
// own request goes first, so a browser that grants it is left to; when it is refused after a
// real gesture, the probe grants it: pointerLockElement and pointerlockchange as the browser
// would give them, and the browser's refusal kept from the page. The app is told on the
// console, which it reads before anything else does (app/src/browser.rs), and holds the
// cursor still and hidden, so trusted mouse moves carry movementX and movementY as they do
// under a real lock. Esc, or the app's menu, gives the pointer back.
function installAppLock (): void
{
    const debug = G.console.debug.bind(G.console);
    const tell = (held: boolean): void => debug(`\u0001scanline:pointer-lock ${held ? 'held' : 'free'}`);

    let locked: any = null;
    let asking: any = null;
    // A page may lock again without a gesture after it let go of the lock itself, as in Chrome.
    let releasedByPage = false;

    const changed = (): void =>
    {
        G.queueMicrotask(() => G.document.dispatchEvent(new G.Event('pointerlockchange', { bubbles: true })));
    };

    const grant = (element: any): void =>
    {
        locked = element;
        asking = null;
        changed();
        tell(true);
    };

    // The browser's refusal: the lock is granted instead, and the page does not hear of it.
    G.addEventListener('pointerlockerror', (event: Event) =>
    {
        if (asking && asking.isConnected)
        {
            event.stopImmediatePropagation();
            grant(asking);
        }
    }, true);

    patch(G.Element.prototype, 'requestPointerLock', (native: any) => function requestPointerLock (this: Element, options?: unknown): Promise<void>
    {
        const element = this;
        const gesture = G.navigator.userActivation ? G.navigator.userActivation.isActive : true;

        if (locked === element)
        {
            return G.Promise.resolve();
        }

        asking = gesture || releasedByPage ? element : null;

        let asked: any;

        try
        {
            asked = native.call(element, options);
        }
        catch (error)
        {
            asked = G.Promise.reject(error);
        }

        return G.Promise.resolve(asked).then(() =>
        {
            asking = null;
        }, (error: any) =>
        {
            if (locked === element)
            {
                return undefined;
            }

            if (asking === element)
            {
                grant(element);

                return undefined;
            }

            throw error;
        });
    });

    patch(G.Document.prototype, 'exitPointerLock', (native: any) => function exitPointerLock (this: Document): void
    {
        if (locked)
        {
            locked = null;
            releasedByPage = true;
            changed();
            tell(false);

            return;
        }

        native.call(this);
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

    // Given back by Esc or the app's menu (app/src/browser.rs): not the page's own doing, so
    // the next lock needs a gesture, as in Chrome.
    G.addEventListener('scanline:release-pointer', () =>
    {
        if (locked)
        {
            locked = null;
            releasedByPage = false;
            changed();
            tell(false);
        }
    }, true);

    G.addEventListener('pagehide', () =>
    {
        if (locked)
        {
            tell(false);
        }
    });

    declare({
        id: 'pointer-lock-app',
        what: 'In the Scanline app, requestPointerLock is granted by the debugger when the embedded browser refuses it, and the app holds the cursor',
        why: 'The app\'s embedded browser refuses every pointer lock request, so a game steered by the mouse could not be played in it',
        optional: true,
        active: () => true
    });
}
