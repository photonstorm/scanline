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
import { currentFrame, onFrameBegin, onPauseChange } from './clock/gate';
import { allContexts } from './contexts';
import { G, nAddEventListener, nativeNow } from './natives';
import { emit, expose } from './transport';

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

    installOwnership();
    installAnnotation();
}

// ---- Marking the frozen frame ----
//
// Once Debug has frozen the page, the person can show the agent what they mean: a click
// marks a point, a drag marks a box. The marks are taken here, before the page's own
// listeners, and reach the agent as canvas pixels. A thin outline shows the person what
// they marked; it is removed, with the listeners' effect, as soon as the page moves on.

let annotating = false;
let outline: any = null;

function canvasPoint (event: any): { x: number; y: number; canvas: any } | null
{
    // The largest canvas with a rendering context: the one the person is looking at.
    let canvas: any = null;

    for (const info of allContexts())
    {
        if (info.canvas && typeof info.canvas.getBoundingClientRect === 'function' && (!canvas || info.canvas.width * info.canvas.height > canvas.width * canvas.height))
        {
            canvas = info.canvas;
        }
    }

    if (!canvas)
    {
        return null;
    }

    const rect = canvas.getBoundingClientRect();

    if (rect.width <= 0 || rect.height <= 0)
    {
        return null;
    }

    const clamp = (value: number, most: number): number => G.Math.max(0, G.Math.min(most - 1, G.Math.floor(value)));

    return {
        x: clamp((event.clientX - rect.left) * canvas.width / rect.width, canvas.width),
        y: clamp((event.clientY - rect.top) * canvas.height / rect.height, canvas.height),
        canvas
    };
}

function show (left: number, top: number, width: number, height: number): void
{
    try
    {
        if (!outline)
        {
            outline = G.document.createElement('div');
            outline.setAttribute('aria-hidden', 'true');
            outline.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #f2b84b;box-shadow:0 0 0 1px rgba(0,0,0,0.7);box-sizing:border-box;';
            G.document.documentElement.appendChild(outline);
        }

        outline.style.left = `${left}px`;
        outline.style.top = `${top}px`;
        outline.style.width = `${G.Math.max(6, width)}px`;
        outline.style.height = `${G.Math.max(6, height)}px`;
        outline.style.borderRadius = width < 6 && height < 6 ? '50%' : '0';
    }
    catch
    {
        // The mark still reaches the agent.
    }
}

function stopAnnotating (): void
{
    annotating = false;

    if (outline)
    {
        outline.remove();
        outline = null;
    }
}

function installAnnotation (): void
{
    let from: { x: number; y: number; clientX: number; clientY: number } | null = null;

    // The page is not to see the event. A pointer event's default is left alone: to
    // prevent it would stop the browser sending the mouse events the marks are read from.
    const take = (event: any, prevent = true): boolean =>
    {
        if (!annotating || !event.isTrusted)
        {
            return false;
        }

        event.stopImmediatePropagation();

        if (prevent && event.cancelable)
        {
            event.preventDefault();
        }

        return true;
    };

    const listen = (type: string, handler: (event: any) => void): void =>
    {
        nAddEventListener.call(G, type, handler, { capture: true, passive: false });
    };

    listen('mousedown', (event) =>
    {
        if (!take(event) || event.button !== 0)
        {
            return;
        }

        const at = canvasPoint(event);

        from = at ? { x: at.x, y: at.y, clientX: event.clientX, clientY: event.clientY } : null;

        if (from)
        {
            show(event.clientX - 3, event.clientY - 3, 0, 0);
        }
    });

    listen('mousemove', (event) =>
    {
        if (take(event) && from)
        {
            show(G.Math.min(from.clientX, event.clientX), G.Math.min(from.clientY, event.clientY), G.Math.abs(event.clientX - from.clientX), G.Math.abs(event.clientY - from.clientY));
        }
    });

    listen('mouseup', (event) =>
    {
        if (!take(event) || !from || event.button !== 0)
        {
            return;
        }

        const to = canvasPoint(event);
        const start = from;

        from = null;

        if (!to)
        {
            return;
        }

        // A drag of a few pixels or more is a box; less is a point.
        if (G.Math.abs(event.clientX - start.clientX) < 4 && G.Math.abs(event.clientY - start.clientY) < 4)
        {
            emit('annotation', { x: start.x, y: start.y, frame: currentFrame(), space: 'canvas_px' });
        }
        else
        {
            emit('annotation', {
                x: G.Math.min(start.x, to.x),
                y: G.Math.min(start.y, to.y),
                w: G.Math.abs(to.x - start.x) + 1,
                h: G.Math.abs(to.y - start.y) + 1,
                frame: currentFrame(),
                space: 'canvas_px'
            });
        }
    });

    for (const type of ['click', 'dblclick', 'contextmenu'])
    {
        listen(type, (event) => { take(event); });
    }

    for (const type of ['pointerdown', 'pointerup', 'pointermove'])
    {
        listen(type, (event) => { take(event, false); });
    }

    // The frame the marks were about is gone once the page moves, by a step or a resume.
    onPauseChange((paused) =>
    {
        if (!paused)
        {
            stopAnnotating();
        }
    });

    onFrameBegin(() =>
    {
        if (annotating || outline)
        {
            stopAnnotating();
        }
    });

    expose('annotate.start', () =>
    {
        annotating = true;

        return { annotating };
    });

    expose('annotate.stop', () =>
    {
        stopAnnotating();

        return { annotating };
    });
}

// ---- One owner of the input ----
//
// When the agent has taken the input, what the person does at the keyboard and mouse must
// not reach the page: a stray key would spoil a replay. The browser cannot tell the two
// apart, since both are real input to it, so the host says which events are its own just
// before it sends them (admit) and everything else is stopped here, before the page's
// listeners and before the input recorder.

const INPUT_EVENTS = [
    'keydown', 'keyup', 'keypress', 'mousedown', 'mouseup', 'mousemove', 'click', 'dblclick', 'auxclick', 'contextmenu', 'wheel',
    'pointerdown', 'pointerup', 'pointermove', 'pointercancel', 'touchstart', 'touchmove', 'touchend', 'touchcancel'
];

let blocking = false;
let stopped = 0;

// What the host has said is its own: key codes, and points in the page, each good for a
// short while. One call from the host becomes several events here (a click is a pointer
// down, a mouse down, a pointer up, a mouse up and a click), so an entry is not used up.
const GOOD_FOR = 1500;
const keysAdmitted = new G.Map() as Map<string, number>;

let pointsAdmitted: Array<{ x: number; y: number; until: number }> = [];

function near (x: number, y: number, now: number): boolean
{
    for (const point of pointsAdmitted)
    {
        // A whole pixel either way: the browser rounds where an event lands.
        if (point.until > now && G.Math.abs(point.x - x) <= 1.5 && G.Math.abs(point.y - y) <= 1.5)
        {
            return true;
        }
    }

    return false;
}

function admitted (event: any): boolean
{
    const now = nativeNow();

    if (typeof event.code === 'string' && typeof event.key === 'string')
    {
        return (keysAdmitted.get(event.code) ?? 0) > now;
    }

    if (event.changedTouches)
    {
        for (const touch of event.changedTouches as Iterable<{ clientX: number; clientY: number }>)
        {
            if (near(touch.clientX, touch.clientY, now))
            {
                return true;
            }
        }

        return false;
    }

    return near(event.clientX, event.clientY, now);
}

function installOwnership (): void
{
    const stop = (event: any): void =>
    {
        if (!blocking || !event.isTrusted || admitted(event))
        {
            return;
        }

        stopped++;
        event.stopImmediatePropagation();

        if (event.cancelable)
        {
            event.preventDefault();
        }
    };

    for (const type of INPUT_EVENTS)
    {
        nAddEventListener.call(G, type, stop, { capture: true, passive: false });
    }

    // on: the person's input is kept from the page from now.
    expose('input.block', (args: { on: boolean }) =>
    {
        blocking = G.Boolean(args.on);
        keysAdmitted.clear();
        pointsAdmitted = [];

        return { blocking, stopped };
    });

    // The host's own events are about to arrive.
    expose('input.admit', (args: { keys?: string[]; points?: Array<[number, number]> }) =>
    {
        const now = nativeNow();
        const until = now + GOOD_FOR;

        for (const code of args.keys ?? [])
        {
            keysAdmitted.set(code, until);
        }

        pointsAdmitted = pointsAdmitted.filter((point) => point.until > now);

        for (const [x, y] of args.points ?? [])
        {
            pointsAdmitted.push({ x, y, until });
        }

        return { keys: keysAdmitted.size, points: pointsAdmitted.length };
    });
}
