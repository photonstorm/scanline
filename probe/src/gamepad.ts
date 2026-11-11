// Virtual gamepads (02-ARCHITECTURE.md, section 6). No browser has gamepad automation, so
// the probe stands in front of navigator.getGamepads: a pad the host sets is returned to
// the page as if it were plugged in, with connect and disconnect events, and a real pad
// in the person's hands is passed through. Either way its state is recorded by frame with
// the rest of the input, so a run with a gamepad in it can be played again.
//
// A virtual pad is an object shaped like a Gamepad and inheriting from Gamepad.prototype.
// Its events are made with `new Event`, so they report isTrusted false: the one difference
// a page could see.

import { currentFrame, onFrameBegin } from './clock/gate';
import { config } from './config';
import { recordInput } from './input';
import { patch } from './masquerade';
import { declare } from './mods';
import { G, isWindow, nDefineProperty, nativeNow, nStringify } from './natives';
import { expose } from './transport';

const SLOTS = 4;
const BUTTONS = 17;
const AXES = 4;

interface Pad
{
    index: number;
    id: string;
    connected: boolean;
    buttons: number[];
    axes: number[];
    timestamp: number;
}

const pads: Array<Pad | null> = [null, null, null, null];

let nativeGetGamepads: ((this: Navigator) => Array<Gamepad | null>) | null = null;
let installed = false;

// What the page is handed: a snapshot, as getGamepads gives.
function present (pad: Pad): unknown
{
    const button = (value: number): unknown =>
    {
        const proto = G.GamepadButton?.prototype ?? G.Object.prototype;

        return G.Object.create(proto, {
            pressed: { value: value > 0.5, enumerable: true },
            touched: { value: value > 0, enumerable: true },
            value: { value, enumerable: true }
        });
    };

    return G.Object.create(G.Gamepad?.prototype ?? G.Object.prototype, {
        id: { value: pad.id, enumerable: true },
        index: { value: pad.index, enumerable: true },
        connected: { value: pad.connected, enumerable: true },
        mapping: { value: 'standard', enumerable: true },
        timestamp: { value: pad.timestamp, enumerable: true },
        axes: { value: G.Object.freeze(pad.axes.slice()), enumerable: true },
        buttons: { value: G.Object.freeze(pad.buttons.map(button)), enumerable: true },
        vibrationActuator: { value: null, enumerable: true },
        hapticActuators: { value: G.Object.freeze([]), enumerable: true }
    });
}

function announce (type: string, pad: Pad): void
{
    try
    {
        const event = new G.Event(type);

        nDefineProperty(event, 'gamepad', { value: present(pad), enumerable: true });
        G.dispatchEvent(event);
    }
    catch
    {
        // A page that polls sees the pad all the same.
    }
}

function row (pad: Pad): void
{
    recordInput([currentFrame(), nativeNow(), 'gamepad', pad.index, pad.connected ? 1 : 0, nStringify({ id: pad.id, buttons: pad.buttons, axes: pad.axes })]);
}

function install (): void
{
    if (installed || !isWindow || !G.navigator || config.unmodified)
    {
        return;
    }

    installed = true;

    nativeGetGamepads = patch(G.navigator, 'getGamepads', (native) => function getGamepads (this: Navigator): Array<unknown>
    {
        const real = native.call(this) as Array<Gamepad | null>;
        const out: unknown[] = [];

        for (let slot = 0; slot < G.Math.max(SLOTS, real.length); slot++)
        {
            const pad = pads[slot];

            out.push(pad && pad.connected ? present(pad) : (real[slot] ?? null));
        }

        return out;
    }) as typeof nativeGetGamepads;

    declare({
        id: 'gamepad-shim',
        what: 'navigator.getGamepads is wrapped: a gamepad the debugger sets is returned as if it were plugged in, and its connect and disconnect events are not trusted events',
        why: 'No browser can automate a gamepad; this lets the agent hold a stick or press a button, and records a real pad for replay',
        optional: true,
        active: () => pads.some((pad) => pad !== null)
    });

    // A real pad in the person's hands, sampled as each frame begins and recorded when it changes.
    const seen: string[] = [];

    onFrameBegin(() =>
    {
        if (!nativeGetGamepads)
        {
            return;
        }

        let real: Array<Gamepad | null>;

        try
        {
            real = nativeGetGamepads.call(G.navigator);
        }
        catch
        {
            return;
        }

        for (let slot = 0; slot < real.length; slot++)
        {
            const pad = real[slot];

            if (pads[slot]?.connected)
            {
                continue;
            }

            const state = pad ? nStringify({ id: pad.id, buttons: pad.buttons.map((button) => button.value), axes: G.Array.from(pad.axes) }) : '';

            if (state !== (seen[slot] ?? ''))
            {
                seen[slot] = state;
                recordInput([currentFrame(), nativeNow(), 'gamepad', slot, pad ? 1 : 0, state || '{}']);
            }
        }
    });
}

export function installGamepads (): void
{
    if (!isWindow)
    {
        return;
    }

    install();

    expose('gamepad.set', (args: { index?: number; id?: string; connected?: boolean; buttons?: Record<string, number | boolean> | Array<number | boolean>; axes?: number[] }) =>
    {
        if (config.unmodified)
        {
            throw new G.Error('This session is unmodified, so there is no virtual gamepad: the page\'s getGamepads is its own.');
        }

        const index = args.index ?? 0;

        if (!G.Number.isInteger(index) || index < 0 || index >= SLOTS)
        {
            throw new G.Error(`A gamepad's index is 0 to ${SLOTS - 1}.`);
        }

        let pad = pads[index];
        const was = Boolean(pad?.connected);

        if (!pad)
        {
            pad = { index, id: 'Scanline Virtual Gamepad (STANDARD GAMEPAD)', connected: false, buttons: new G.Array(BUTTONS).fill(0), axes: new G.Array(AXES).fill(0), timestamp: 0 };
            pads[index] = pad;
        }

        if (typeof args.id === 'string')
        {
            pad.id = args.id.slice(0, 120);
        }

        const entries: Array<[string, number | boolean]> = G.Array.isArray(args.buttons)
            ? (args.buttons as Array<number | boolean>).map((value, at) => [G.String(at), value])
            : G.Object.entries(args.buttons ?? {});

        for (const [name, value] of entries)
        {
            const at = G.Number(name);

            if (!G.Number.isInteger(at) || at < 0 || at >= 64)
            {
                throw new G.Error(`Buttons are numbered from 0; "${name}" is not one. In the standard layout 0 is the bottom face button, 12 to 15 the d-pad, 9 Start.`);
            }

            while (pad.buttons.length <= at)
            {
                pad.buttons.push(0);
            }

            pad.buttons[at] = typeof value === 'boolean' ? (value ? 1 : 0) : G.Math.max(0, G.Math.min(1, G.Number(value) || 0));
        }

        const axes: number[] = args.axes && G.Array.isArray(args.axes) ? args.axes : [];

        if (axes.length > 0)
        {
            axes.forEach((value, at) =>
            {
                if (at < 16)
                {
                    while (pad!.axes.length <= at)
                    {
                        pad!.axes.push(0);
                    }

                    pad!.axes[at] = G.Math.max(-1, G.Math.min(1, G.Number(value) || 0));
                }
            });
        }

        // Setting anything plugs the pad in, unless it is being unplugged.
        pad.connected = args.connected ?? true;
        pad.timestamp = G.performance.now();
        row(pad);

        if (pad.connected && !was)
        {
            announce('gamepadconnected', pad);
        }
        else if (!pad.connected && was)
        {
            announce('gamepaddisconnected', pad);
        }

        return { index, id: pad.id, connected: pad.connected, buttons: pad.buttons, axes: pad.axes, frame: currentFrame() };
    });

    expose('gamepad.state', () => ({ pads: pads.filter((pad) => pad !== null) }));
}
