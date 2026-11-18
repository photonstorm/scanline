// Records every input event the page receives, by frame, whoever produced it.
//
// The DevTools Protocol can inject input but cannot observe it, so recording happens here
// with capture-phase listeners (02-ARCHITECTURE.md, section 6). Wall-clock time is kept as
// metadata only; replay is by frame.
//
// A row's frame is the last frame completed when the event arrived (or the frame in
// progress, for an event dispatched inside one). The next frame is the first to see it.

import { currentFrame } from './clock/gate';
import { G, isWindow, nAddEventListener, nativeNow } from './natives';
import { expose } from './transport';

type Row = [frame: number, real: number, type: string, ...rest: Array<number | string>];

const LIMIT = 50000;
const rows: Row[] = [];

let dropped = 0;
let sequence = 0;

function push (row: Row): void
{
    rows.push(row);
    sequence++;

    if (rows.length > LIMIT)
    {
        rows.shift();
        dropped++;
    }
}

// Input that does not arrive as a DOM event (a gamepad's state) is recorded by whoever sees it.
export function recordInput (row: Row): void
{
    push(row);
}

function modifiers (event: KeyboardEvent | MouseEvent): number
{
    return (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
}

export function installInputRecorder (): void
{
    if (!isWindow)
    {
        return;
    }

    const listen = (type: string, handler: (event: any) => void): void =>
    {
        nAddEventListener.call(G, type, handler, { capture: true, passive: true });
    };

    const key = (event: KeyboardEvent): void =>
    {
        push([currentFrame(), nativeNow(), event.type, event.code, event.key, modifiers(event), event.repeat ? 1 : 0, event.isTrusted ? 1 : 0]);
    };

    const mouse = (event: MouseEvent, type: string = event.type): void =>
    {
        push([currentFrame(), nativeNow(), type, event.clientX, event.clientY, G.Math.max(0, event.button), event.buttons, modifiers(event), event.movementX, event.movementY, event.isTrusted ? 1 : 0]);
    };

    // The mouse as the browser delivers it is recorded from its pointer events, not its mouse
    // events, for two reasons. A pointer event says where the pointer is to a fraction of a
    // pixel, and a mouse event to a whole one: a page that reads pointer events, played again
    // from whole pixels, is given a pointer a quarter of a pixel from where it was. And a page
    // that cancels pointerdown is sent no mouse events at all until the button is let go.
    const pointer = (event: PointerEvent): void =>
    {
        if (!event.isTrusted || event.pointerType !== 'mouse')
        {
            return;
        }

        // A second button pressed or let go while one is held arrives as a move that names a button.
        const type = event.type === 'pointerdown'
            ? 'mousedown'
            : event.type === 'pointerup'
                ? 'mouseup'
                : event.button < 0 ? 'mousemove' : ((event.buttons & [1, 4, 2, 8, 16][event.button]) !== 0 ? 'mousedown' : 'mouseup');

        mouse(event, type);
    };

    // What is left to the mouse events: those a script made (the pointer-lock stand-in's moves).
    const made = (event: MouseEvent): void =>
    {
        if (!event.isTrusted)
        {
            mouse(event);
        }
    };

    const wheel = (event: WheelEvent): void =>
    {
        push([currentFrame(), nativeNow(), event.type, event.clientX, event.clientY, event.deltaX, event.deltaY, event.deltaMode, event.isTrusted ? 1 : 0]);
    };

    const touch = (event: TouchEvent): void =>
    {
        const points: number[] = [];

        for (const point of event.changedTouches as unknown as Touch[])
        {
            points.push(point.identifier, point.clientX, point.clientY);
        }

        push([currentFrame(), nativeNow(), event.type, event.isTrusted ? 1 : 0, ...points]);
    };

    listen('keydown', key);
    listen('keyup', key);
    listen('pointerdown', pointer);
    listen('pointerup', pointer);
    listen('pointermove', pointer);
    listen('mousedown', made);
    listen('mouseup', made);
    listen('mousemove', made);
    listen('wheel', wheel);
    listen('touchstart', touch);
    listen('touchmove', touch);
    listen('touchend', touch);
    listen('touchcancel', touch);
    listen('blur', () => push([currentFrame(), nativeNow(), 'blur']));
    listen('focus', () => push([currentFrame(), nativeNow(), 'focus']));

    // Rows after a sequence number. The host keeps the cursor.
    expose('input.log', (args: { since?: number; limit?: number }) =>
    {
        const first = sequence - rows.length;
        const from = G.Math.max(0, (args.since ?? 0) - first);
        const slice = rows.slice(from, from + (args.limit ?? 5000));

        return { next: first + from + slice.length, dropped, rows: slice };
    });
}
