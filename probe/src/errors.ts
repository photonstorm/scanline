// Uncaught errors and rejections, tied to the frame they happened in.
//
// Console messages and browser-side GPU warnings reach the host through the protocol; the
// host asks the probe which frame a timestamp fell in. Errors are also noted here so that
// "run until an error" can stop on the frame that raised one.

import { currentFrame, frameOfThrow, noteError } from './clock/gate';
import { G, nAddEventListener } from './natives';
import { expose } from './transport';

interface Noted
{
    frame: number;
    kind: 'error' | 'rejection' | 'gpu';
    message: string;
    where: string;
}

const LIMIT = 200;
const noted: Noted[] = [];

let total = 0;

function text (value: unknown, limit: number): string
{
    let out: string;

    try
    {
        out = G.String(value);
    }
    catch
    {
        out = '(unprintable)';
    }

    return out.length > limit ? out.slice(0, limit) + '…' : out;
}

function note (kind: Noted['kind'], message: unknown, where: string, error?: unknown): void
{
    total++;
    noted.push({ frame: frameOfThrow(error) ?? currentFrame(), kind, message: text(message, 500), where: text(where, 200) });

    if (noted.length > LIMIT)
    {
        noted.shift();
    }

    noteError();
}

export function noteGpuError (message: unknown): void
{
    note('gpu', message, '');
}

export function installErrors (): void
{
    nAddEventListener.call(G, 'error', (event: ErrorEvent) =>
    {
        // Resource load failures also arrive here in the capture phase, with no message.
        if (event.message !== undefined)
        {
            note('error', event.message, `${event.filename ?? ''}:${event.lineno ?? 0}:${event.colno ?? 0}`, event.error);
        }
    }, true);

    nAddEventListener.call(G, 'unhandledrejection', (event: PromiseRejectionEvent) =>
    {
        note('rejection', (event.reason && (event.reason.stack || event.reason.message)) ?? event.reason, '');
    }, true);

    expose('errors', (args: { since?: number }) =>
    {
        const first = total - noted.length;
        const from = G.Math.max(0, (args.since ?? 0) - first);

        return { total, next: total, errors: noted.slice(from) };
    });
}
