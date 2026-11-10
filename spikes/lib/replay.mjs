// Captures a frame through the probe and runs it in a replay page, for the spikes and the
// probe's tests. The host does the same in Rust.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { repoRoot } from './serve.mjs';

// Captures the next frame of a paused page. Returns the capture as the probe sent it.
export async function captureFrame (session, { context, where } = {})
{
    await session.probe('pause', {}, where);

    const armed = await session.probe('capture.arm', { context }, where);

    await session.probe('step', { frames: 1 }, where);

    const taken = await session.probe('capture.take', { capture: armed.capture }, where);
    const blobs = [];

    for (let from = 0; from < taken.blobs;)
    {
        const part = await session.probe('capture.blobs', { capture: armed.capture, from }, where);

        blobs.push(...part.blobs);
        from = part.next;
    }

    await session.probe('capture.release', { capture: armed.capture }, where);

    // The frame's own final image, as the probe kept it.
    const original = await session.probe('image.grab', { context: armed.context }, where);

    return {
        ...taken,
        context: armed.context,
        blobData: blobs,
        data: JSON.parse(gunzipSync(Buffer.from(taken.body, 'base64')).toString('utf8')),
        original: { width: original.region.w, height: original.region.h, data: gunzipSync(Buffer.from(original.data, 'base64')) }
    };
}

// Opens a hidden page in the session's browser with the replay script in it.
export async function openReplay (session)
{
    const { browser } = session;
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank', hidden: true });
    const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
    const page = browser.session(sessionId);

    await page.send('Runtime.enable');
    await page.send('Runtime.evaluate', { expression: readFileSync(join(repoRoot, 'replay', 'dist', 'replay.js'), 'utf8') });

    const call = async (method, args = {}) =>
    {
        const reply = await page.send('Runtime.evaluate', {
            expression: `__scanlineReplay(${JSON.stringify(method)}, ${JSON.stringify(JSON.stringify(args))})`,
            awaitPromise: true,
            returnByValue: true
        });

        if (reply.exceptionDetails)
        {
            throw new Error(`replay.${method} threw: ${reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text}`);
        }

        const parsed = JSON.parse(reply.result.value);

        if (parsed.error)
        {
            throw new Error(`replay.${method}: ${parsed.error}`);
        }

        return parsed.ok;
    };

    const load = async (key, capture) =>
    {
        await call('load', { key, body: capture.body });

        // A few megabytes of blobs to a call.
        for (let from = 0; from < capture.blobData.length;)
        {
            let size = 0;
            let to = from;

            while (to < capture.blobData.length && (to === from || size + capture.blobData[to].length < 6e6))
            {
                size += capture.blobData[to].length;
                to++;
            }

            await call('blobs', { key, from, blobs: capture.blobData.slice(from, to) });
            from = to;
        }
    };

    const image = async (key, options = {}) =>
    {
        const result = await call('image', { key, ...options });

        return { ...result, data: gunzipSync(Buffer.from(result.data, 'base64')) };
    };

    return { call, load, image, close: () => browser.send('Target.closeTarget', { targetId }) };
}

// How two RGBA images of the same size differ.
export function compare (a, b)
{
    if (a.width !== b.width || a.height !== b.height)
    {
        return { sizes: `${a.width}x${a.height} against ${b.width}x${b.height}`, different: -1, max: 255 };
    }

    let different = 0;
    let max = 0;

    for (let i = 0; i < a.data.length; i += 4)
    {
        const delta = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]), Math.abs(a.data[i + 3] - b.data[i + 3]));

        if (delta > 0)
        {
            different++;
            max = Math.max(max, delta);
        }
    }

    return { different, max };
}
