// A policy: a function the agent writes, called once a frame with what the page says of
// itself, that answers with the input to give (04-AGENT-INTERFACE.md, `gfx_policy`). It is
// how an agent plays reactively ("jump when the obstacle is near") without a round trip
// of its own for every frame.
//
// The function runs here, in the page, so it can also read anything the page keeps on a
// global. It only decides: the host sends the input, as real input.

import { currentFrame } from './clock/gate';
import { clock } from './clock/clock';
import { plain } from './groups';
import { G } from './natives';
import { pageState } from './protocol';
import { expose } from './transport';

export function installPolicy (): void
{
    let source = '';
    let decide: ((state: unknown, info: Record<string, unknown>) => unknown) | null = null;
    let memory: Record<string, unknown> = {};

    expose('policy.step', (args: { source: string; reset?: boolean }) =>
    {
        if (args.source !== source || args.reset)
        {
            // Compiled once. The host has lifted the page's Content Security Policy for the probe.
            const made = new G.Function(`return (${args.source});`)();

            if (typeof made !== 'function')
            {
                throw new G.Error('The policy is not a function. Write it as an arrow function: s => ({keys_down: s.x < 100 ? ["ArrowRight"] : []}).');
            }

            source = args.source;
            decide = made;
            memory = {};
        }

        // `memory` is the policy's own, kept from frame to frame.
        const answer: any = decide!(pageState(), { frame: currentFrame(), time: clock.now(), memory });

        if (answer === null || answer === undefined || typeof answer !== 'object')
        {
            return { frame: currentFrame() };
        }

        return {
            frame: currentFrame(),
            keys_down: G.Array.isArray(answer.keys_down) ? answer.keys_down.slice(0, 16).map((key: unknown) => G.String(key)) : undefined,
            events: G.Array.isArray(answer.events) ? plain(answer.events.slice(0, 16)) : undefined,
            stop: answer.stop ? true : undefined,
            log: answer.log === undefined ? undefined : plain(answer.log)
        };
    });
}
