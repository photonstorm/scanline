// A film: a recording made by stepping, for sharing.
//
// Every frame the page is stepped through is taken from the canvas as it ends, scaled to
// the size asked for, and encoded as H.264 with a time stamp of exactly n/60 s: however
// long a frame took to draw or to encode, the film plays at the game's own pace. Between
// two frames the page's audio contexts are let run for exactly one frame's time
// (audio.ts), and what they play is heard through a tap on each and encoded as AAC. The
// host puts the two into an MP4 (crates/scanline-core/src/mp4.rs).
//
// The encoders are the browser's (WebCodecs). The film is kept here, in the page, until
// the host asks for it in pieces: a minute at 12 Mbit/s is about 90 MB.

import { beginAudioSteps, stepAudioTo } from './audio';
import { currentFrame, isLoading, onFrameEnd, setFrameGap } from './clock/gate';
import { contextById } from './contexts';
import { G, nSetTimeout, ownPorts } from './natives';
import { base64 } from './readback';
import { listenable, listenTo, stopListening } from './sound';
import { emit, expose } from './transport';

interface Chunk
{
    data: Uint8Array;
    key: boolean;
}

interface Ear
{
    node: any;
    // What it has heard and the film has not yet taken, left and right.
    heard: Float32Array[][];
    // Sample frames taken into the film so far.
    taken: number;
}

interface Film
{
    // What is filmed: the canvas, taken here as each frame ends; or the page as composited,
    // which the host takes after each frame and hands in (film.picture).
    page: boolean;
    pictures: number;
    canvas: any;
    width: number;
    height: number;
    // Where the canvas is drawn in the film's picture, when their shapes differ.
    place: { x: number; y: number; w: number; h: number };
    scaler: any;
    pen: any;
    fps: number;
    frames: number;
    video: any;
    videoChunks: Chunk[];
    videoConfig: { description: string | null; codec: string; colour: unknown };
    wantSound: boolean;
    audio: any;
    audioChunks: Chunk[];
    audioConfig: { description: string | null; codec: string };
    rate: number;
    // Sample frames given to the sound encoder, and the first packet's time stamp (µs).
    samples: number;
    firstPacket: number | null;
    ears: Map<string, Ear>;
    notes: string[];
    error: string | null;
    stuck: boolean;
    // The frame the last picture was of: the hook that takes one also runs when a timer draws.
    last: number;
}

let film: Film | null = null;
let finished: Film | null = null;

// The module a tap runs in the audio thread: it passes on, a block at a time, what reaches it.
const TAP = `registerProcessor('scanline-film-tap', class extends AudioWorkletProcessor {
    process (inputs) {
        const input = inputs[0];

        if (input && input[0]) {
            this.port.postMessage([input[0].slice(0), (input[1] || input[0]).slice(0)]);
        }

        return true;
    }
});`;

const tapped = new G.WeakSet() as WeakSet<object>;

function note (text: string): void
{
    if (film && !film.notes.includes(text) && film.notes.length < 12)
    {
        film.notes.push(text);
    }
}

// Puts an ear on every context that plays, as each appears.
async function listen (now: Film): Promise<void>
{
    for (const { id, context, tap } of listenable())
    {
        if (now.ears.has(id))
        {
            continue;
        }

        const ear: Ear = { node: null, heard: [], taken: 0 };

        now.ears.set(id, ear);

        if (now.rate === 0)
        {
            now.rate = context.sampleRate;
        }
        else if (context.sampleRate !== now.rate)
        {
            note(`A second audio context plays at ${context.sampleRate} Hz where the first plays at ${now.rate}: only the first is in the film.`);

            continue;
        }

        try
        {
            if (!context.audioWorklet)
            {
                throw new G.Error('this page is not a secure context, so it has no AudioWorklet');
            }

            if (!tapped.has(context))
            {
                const url = G.URL.createObjectURL(new G.Blob([TAP], { type: 'text/javascript' }));

                await context.audioWorklet.addModule(url);
                G.URL.revokeObjectURL(url);
                tapped.add(context);
            }

            const node = new G.AudioWorkletNode(context, 'scanline-film-tap', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit' });

            // The probe's own channel: not one of the page's, whose messages are held while the clock is.
            ownPorts.add(node.port);
            node.port.onmessage = (event: MessageEvent) =>
            {
                ear.heard.push(event.data as Float32Array[]);
            };

            ear.node = node;
            listenTo(tap, node);
        }
        catch (error: any)
        {
            note(`The sound of an audio context could not be heard (${G.String(error?.message ?? error)}), so it is not in the film.`);
        }
    }
}

// Takes what each ear has heard up to `wanted` sample frames of film, mixes it, and gives
// it to the encoder. An ear that has heard less (its context was not playing) is silent
// for the difference: the film's sound is as long as its pictures.
function takeSound (now: Film, wanted: number): void
{
    const count = wanted - now.samples;

    if (count <= 0 || now.audio === null)
    {
        return;
    }

    const mixed = new G.Float32Array(count * 2) as Float32Array;

    for (const ear of now.ears.values())
    {
        let filled = 0;

        while (filled < count && ear.heard.length > 0)
        {
            const [left, right] = ear.heard[0];
            const use = G.Math.min(left.length, count - filled);

            for (let i = 0; i < use; i++)
            {
                mixed[filled + i] += left[i];
                mixed[count + filled + i] += right[i];
            }

            filled += use;

            if (use === left.length)
            {
                ear.heard.shift();
            }
            else
            {
                ear.heard[0] = [left.subarray(use), right.subarray(use)];
            }
        }

        ear.taken += count;
    }

    const data = new G.AudioData({
        format: 'f32-planar',
        sampleRate: now.rate,
        numberOfFrames: count,
        numberOfChannels: 2,
        timestamp: G.Math.round(now.samples * 1e6 / now.rate),
        data: mixed
    });

    now.audio.encode(data);
    data.close();
    now.samples = wanted;
}

function startSound (now: Film): void
{
    if (now.audio !== null || now.rate === 0 || !now.wantSound)
    {
        return;
    }

    if (typeof G.AudioEncoder !== 'function')
    {
        note('This browser has no sound encoder for pages (WebCodecs AudioEncoder), so the film is silent.');
        now.wantSound = false;

        return;
    }

    now.audio = new G.AudioEncoder({
        output: (chunk: any, metadata: any) =>
        {
            const data = new G.Uint8Array(chunk.byteLength);

            chunk.copyTo(data);
            now.audioChunks.push({ data, key: true });

            if (now.firstPacket === null)
            {
                now.firstPacket = chunk.timestamp;
            }

            const described = metadata?.decoderConfig?.description;

            if (described && now.audioConfig.description === null)
            {
                now.audioConfig.description = base64(new G.Uint8Array(described.buffer ?? described, described.byteOffset ?? 0, described.byteLength));
            }
        },
        error: (error: any) =>
        {
            note(`The sound encoder failed (${G.String(error?.message ?? error)}), so the film's sound stops there.`);
            now.wantSound = false;
        }
    });

    now.audio.configure({ codec: 'mp4a.40.2', sampleRate: now.rate, numberOfChannels: 2, bitrate: 192000 });
    now.audioConfig.codec = 'mp4a.40.2';
}

// A picture (the canvas as it stands, or one the host handed in) goes to the encoder as the
// film's next.
function encodePicture (now: Film, picture: any): void
{
    let source = picture;

    if (now.scaler !== null)
    {
        const { x, y, w, h } = now.place;

        now.pen.fillStyle = '#000';
        now.pen.fillRect(0, 0, now.width, now.height);
        now.pen.drawImage(picture, x, y, w, h);
        source = now.scaler;
    }

    const frame = new G.VideoFrame(source, { timestamp: G.Math.round(now.pictures * 1e6 / now.fps), duration: G.Math.round(1e6 / now.fps), alpha: 'discard' });

    // A frame a player can start from once a second.
    now.video.encode(frame, { keyFrame: now.pictures % now.fps === 0 });
    frame.close();
    now.pictures++;
}

// A frame has ended: its picture, as the canvas holds it now, goes to the encoder.
function takePicture (now: Film): void
{
    now.frames++;

    if (now.page)
    {
        return;
    }

    try
    {
        encodePicture(now, now.canvas);
    }
    catch (error: any)
    {
        now.error = `A frame could not be taken from the canvas: ${G.String(error?.message ?? error)}`;
    }
}

// The page as composited, from the host, for the frame just stepped.
async function pagePicture (args: { data: string; type: string }): Promise<Record<string, unknown>>
{
    const now = film;

    if (now === null || !now.page)
    {
        throw new G.Error('No film of the page is being made.');
    }

    const text = G.atob(args.data);
    const bytes = new G.Uint8Array(text.length) as Uint8Array;

    for (let i = 0; i < text.length; i++)
    {
        bytes[i] = text.charCodeAt(i);
    }

    const bitmap = await G.createImageBitmap(new G.Blob([bytes], { type: args.type }));

    try
    {
        encodePicture(now, bitmap);
    }
    finally
    {
        bitmap.close();
    }

    return { pictures: now.pictures };
}

// Between two frames: a frame's worth of sound, and the encoder given time to keep up.
async function gap (): Promise<void>
{
    const now = film;

    if (now === null || now.error !== null)
    {
        return;
    }

    try
    {
        if (now.wantSound)
        {
            await listen(now);

            const stuck = await stepAudioTo(now.frames / now.fps, G.Math.max(0, now.frames - 1) / now.fps);

            if (stuck > 0 && !now.stuck)
            {
                now.stuck = true;
                note('An audio context is suspended by the page itself (it is waiting for a click, or the game has paused its sound), so it is silent in the film for as long as it stays so.');
            }

            startSound(now);

            // What the worklets heard arrives as messages: give them a turn to land.
            await new G.Promise((resolve: () => void) => nSetTimeout(resolve, 0));

            if (now.rate > 0)
            {
                takeSound(now, G.Math.floor(now.frames * now.rate / now.fps));
            }
        }

        // An encoder that falls behind is waited for, so that the film is never short of memory.
        while (now.video.encodeQueueSize > 8 && now.error === null)
        {
            await new G.Promise((resolve: () => void) => nSetTimeout(resolve, 2));
        }
    }
    catch (error: any)
    {
        note(`The film's sound could not be kept up (${G.String(error?.message ?? error)}).`);
    }
}

// An even number no larger than this: H.264 pictures are whole blocks of two.
const even = (value: number): number => G.Math.max(2, G.Math.floor(value / 2) * 2);

async function start (args: { context: number; page?: { width: number; height: number }; width?: number; height?: number; max_edge?: number; bitrate?: number; sound?: boolean; fps?: number }): Promise<Record<string, unknown>>
{
    if (film !== null)
    {
        throw new G.Error('A film is already being made. film(action: "stop") ends it.');
    }

    if (typeof G.VideoEncoder !== 'function' || typeof G.VideoFrame !== 'function')
    {
        throw new G.Error('This browser has no video encoder for pages (WebCodecs VideoEncoder), so no film can be made.');
    }

    const info = args.page ? null : contextById(args.context);

    if (!args.page && (!info || !info.canvas || info.offscreen))
    {
        throw new G.Error('A film is made from a canvas in the page. This context has none (it draws offscreen, or in a worker). source: "page" films the page as composited instead.');
    }

    // What is filmed, and its size: the canvas, or the page as the host will hand it in.
    const canvas = args.page ?? info!.canvas;
    const fps = args.fps ?? 60;

    // The size: as asked; or the canvas's own, no longer than max_edge along its longer side.
    let width = canvas.width;
    let height = canvas.height;

    if (args.width && args.height)
    {
        width = args.width;
        height = args.height;
    }
    else if (args.width || args.height)
    {
        const scale = args.width ? args.width / canvas.width : args.height! / canvas.height;

        width = canvas.width * scale;
        height = canvas.height * scale;
    }
    else
    {
        const scale = G.Math.min(1, (args.max_edge ?? 1920) / G.Math.max(canvas.width, canvas.height));

        width = canvas.width * scale;
        height = canvas.height * scale;
    }

    width = even(G.Math.round(width));
    height = even(G.Math.round(height));

    // The canvas fits inside, in proportion, with black where the shapes differ.
    const fit = G.Math.min(width / canvas.width, height / canvas.height);
    const place = { w: G.Math.round(canvas.width * fit), h: G.Math.round(canvas.height * fit), x: 0, y: 0 };

    place.x = G.Math.floor((width - place.w) / 2);
    place.y = G.Math.floor((height - place.h) / 2);

    // A picture that is only an odd pixel larger than the film is cut, not squeezed.
    if (canvas.width - width >= 0 && canvas.width - width <= 1 && canvas.height - height >= 0 && canvas.height - height <= 1)
    {
        G.Object.assign(place, { x: 0, y: 0, w: canvas.width, h: canvas.height });
    }

    const same = width === canvas.width && height === canvas.height;
    const scaler = same ? null : new G.OffscreenCanvas(width, height);
    const pen = scaler ? scaler.getContext('2d', { alpha: false }) : null;

    if (pen)
    {
        pen.imageSmoothingEnabled = true;
        pen.imageSmoothingQuality = 'high';
    }

    // A tenth of a bit for each pixel of each frame, which is generous for a game's flat
    // colours; within what a site will take.
    const bitrate = args.bitrate ?? G.Math.round(G.Math.min(25e6, G.Math.max(3e6, width * height * fps * 0.1)));

    // High profile, at the lowest level that holds this many pixels a second.
    const blocks = G.Math.ceil(width / 16) * G.Math.ceil(height / 16);
    const level = blocks * fps <= 245760 && blocks <= 8192 ? '28' : (blocks * fps <= 522240 && blocks <= 8704 ? '2A' : (blocks * fps <= 983040 && blocks <= 36864 ? '33' : '34'));
    const made: Film = {
        page: Boolean(args.page),
        pictures: 0,
        canvas, width, height, place, scaler, pen, fps,
        frames: 0,
        video: null,
        videoChunks: [],
        videoConfig: { description: null, codec: `avc1.6400${level}`, colour: null },
        wantSound: args.sound !== false,
        audio: null,
        audioChunks: [],
        audioConfig: { description: null, codec: '' },
        rate: 0,
        samples: 0,
        firstPacket: null,
        ears: new G.Map(),
        notes: [],
        error: null,
        stuck: false,
        last: currentFrame()
    };

    const config = { codec: made.videoConfig.codec, width, height, framerate: fps, bitrate, bitrateMode: 'variable', latencyMode: 'quality', avc: { format: 'avc' } };
    const supported = await G.VideoEncoder.isConfigSupported(config);

    if (!supported.supported)
    {
        throw new G.Error(`This browser cannot encode H.264 at ${width}×${height} and ${fps} frames a second. Ask for a smaller film (max_edge, or width and height).`);
    }

    made.video = new G.VideoEncoder({
        output: (chunk: any, metadata: any) =>
        {
            const data = new G.Uint8Array(chunk.byteLength);

            chunk.copyTo(data);
            made.videoChunks.push({ data, key: chunk.type === 'key' });

            const described = metadata?.decoderConfig?.description;

            if (described && made.videoConfig.description === null)
            {
                made.videoConfig.description = base64(new G.Uint8Array(described.buffer ?? described, described.byteOffset ?? 0, described.byteLength));
                made.videoConfig.colour = metadata.decoderConfig.colorSpace ? { ...metadata.decoderConfig.colorSpace.toJSON?.() } : null;
            }
        },
        error: (error: any) =>
        {
            made.error = `The video encoder failed: ${G.String(error?.message ?? error)}`;
            emit('probe-fault', { where: 'film', message: made.error });
        }
    });

    made.video.configure(config);

    film = made;
    finished = null;
    beginAudioSteps();
    setFrameGap(gap);

    if (made.wantSound)
    {
        await listen(made);
    }

    return { width, height, fps, bitrate, codec: made.videoConfig.codec, canvas: { width: canvas.width, height: canvas.height }, scaled: !same, sound: made.wantSound, contexts: made.ears.size, page: made.page };
}

async function stop (): Promise<Record<string, unknown>>
{
    const now = film;

    if (now === null)
    {
        throw new G.Error('No film is being made. film(action: "start") begins one.');
    }

    film = null;
    setFrameGap(null);

    for (const ear of now.ears.values())
    {
        if (ear.node)
        {
            stopListening(ear.node);
        }
    }

    try
    {
        await now.video.flush();
        now.video.close();
    }
    catch (error: any)
    {
        now.error ??= `The video encoder could not finish: ${G.String(error?.message ?? error)}`;
    }

    if (now.audio !== null)
    {
        try
        {
            // The last of the sound, up to the last frame's end.
            takeSound(now, G.Math.floor(now.frames * now.rate / now.fps));
            await now.audio.flush();
            now.audio.close();
        }
        catch (error: any)
        {
            note(`The sound encoder could not finish (${G.String(error?.message ?? error)}).`);
        }
    }

    finished = now;

    const bytes = (chunks: Chunk[]): number => chunks.reduce((sum, chunk) => sum + chunk.data.length, 0);

    return {
        frames: now.page ? now.pictures : now.frames,
        width: now.width,
        height: now.height,
        fps: now.fps,
        error: now.error,
        notes: now.notes,
        video: { packets: now.videoChunks.length, bytes: bytes(now.videoChunks), codec: now.videoConfig.codec, description: now.videoConfig.description, colour: now.videoConfig.colour },
        audio: now.audioChunks.length > 0
            ? { packets: now.audioChunks.length, bytes: bytes(now.audioChunks), codec: now.audioConfig.codec, description: now.audioConfig.description, rate: now.rate, channels: 2, samples: now.samples, first: now.firstPacket, contexts: now.ears.size }
            : null
    };
}

export function installFilm (): void
{
    // The frame's picture, in the task that drew it: before the browser presents and clears it.
    onFrameEnd(() =>
    {
        if (film !== null && film.error === null && !isLoading() && currentFrame() !== film.last)
        {
            film.last = currentFrame();
            takePicture(film);
        }
    });

    expose('film.start', (args) => start(args));
    expose('film.picture', (args) => pagePicture(args));
    expose('film.stop', () => stop());
    expose('film.state', () => (film === null ? { filming: false } : { filming: true, frames: film.frames, width: film.width, height: film.height, error: film.error, queued: film.video.encodeQueueSize }));

    // The film, a few megabytes at a time: each packet's size and whether it is a key frame,
    // and their bytes end to end.
    expose('film.read', (args: { track: 'video' | 'audio'; from: number; budget?: number }) =>
    {
        const chunks = finished === null ? [] : (args.track === 'video' ? finished.videoChunks : finished.audioChunks);
        const budget = args.budget ?? 4_000_000;
        const sizes: number[][] = [];

        let total = 0;
        let to = args.from;

        while (to < chunks.length && (to === args.from || total + chunks[to].data.length <= budget))
        {
            sizes.push([chunks[to].data.length, chunks[to].key ? 1 : 0]);
            total += chunks[to].data.length;
            to++;
        }

        const joined = new G.Uint8Array(total) as Uint8Array;

        let at = 0;

        for (let index = args.from; index < to; index++)
        {
            joined.set(chunks[index].data, at);
            at += chunks[index].data.length;
        }

        return { packets: sizes, data: base64(joined), next: to < chunks.length ? to : null };
    });

    // The film is let go of once the host has it.
    expose('film.forget', () =>
    {
        finished = null;
    });
}
