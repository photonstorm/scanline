// A recording's frames as a video: VP8 in a WebM file.
//
// The browser's own encoder (WebCodecs) makes the frames; this file only puts them in a
// container. WebM is small enough to write by hand: a header, the track's description, and
// the frames in clusters, each element an ID, a length and its bytes.

type Bytes = Uint8Array;

function concat (parts: Bytes[]): Bytes
{
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));

    let at = 0;

    for (const part of parts)
    {
        out.set(part, at);
        at += part.length;
    }

    return out;
}

// A length as EBML writes one: the count of bytes is in the leading bits.
function length (size: number): Bytes
{
    for (let bytes = 1; bytes <= 8; bytes++)
    {
        if (size < 2 ** (7 * bytes) - 1)
        {
            const out = new Uint8Array(bytes);

            let left = size;

            for (let i = bytes - 1; i >= 0; i--)
            {
                out[i] = left % 256;
                left = Math.floor(left / 256);
            }

            out[0] |= 1 << (8 - bytes);

            return out;
        }
    }

    throw new Error('too large for a WebM element');
}

function element (id: number[], body: Bytes | Bytes[]): Bytes
{
    const payload = Array.isArray(body) ? concat(body) : body;

    return concat([new Uint8Array(id), length(payload.length), payload]);
}

function unsigned (value: number): Bytes
{
    const out: number[] = [];

    let left = value;

    do
    {
        out.unshift(left % 256);
        left = Math.floor(left / 256);
    }
    while (left > 0);

    return new Uint8Array(out);
}

function float (value: number): Bytes
{
    const out = new Uint8Array(8);

    new DataView(out.buffer).setFloat64(0, value);

    return out;
}

const text = (value: string): Bytes => new TextEncoder().encode(value);

export interface Chunk
{
    data: Bytes;
    key: boolean;
    ms: number;
}

// How the encoder turned colours into the video's own form, as the browser reports it.
// Written into the file so that a player turns them back the same way: left unsaid, a
// player guesses from the picture's size, and greens and reds come out shifted.
export interface Colour
{
    matrix?: string | null;
    primaries?: string | null;
    transfer?: string | null;
    fullRange?: boolean | null;
}

const MATRIX: Record<string, number> = { rgb: 0, bt709: 1, bt470bg: 5, smpte170m: 6 };
const PRIMARIES: Record<string, number> = { bt709: 1, bt470bg: 5, smpte170m: 6 };
const TRANSFER: Record<string, number> = { bt709: 1, smpte170m: 6, 'iec61966-2-1': 13 };

function colourElement (colour: Colour | null): Bytes[]
{
    if (!colour)
    {
        return [];
    }

    const parts: Bytes[] = [];

    if (colour.matrix && MATRIX[colour.matrix] !== undefined) { parts.push(element([0x55, 0xB1], unsigned(MATRIX[colour.matrix]))); }
    if (typeof colour.fullRange === 'boolean') { parts.push(element([0x55, 0xB9], unsigned(colour.fullRange ? 2 : 1))); }
    if (colour.transfer && TRANSFER[colour.transfer] !== undefined) { parts.push(element([0x55, 0xBA], unsigned(TRANSFER[colour.transfer]))); }
    if (colour.primaries && PRIMARIES[colour.primaries] !== undefined) { parts.push(element([0x55, 0xBB], unsigned(PRIMARIES[colour.primaries]))); }

    return parts.length ? [element([0x55, 0xB0], parts)] : [];
}

// The whole file: every chunk is in hand before it is written, so every length is known.
export function webm (chunks: Chunk[], width: number, height: number, durationMs: number, colour: Colour | null = null): Bytes
{
    const header = element([0x1A, 0x45, 0xDF, 0xA3], [
        element([0x42, 0x86], unsigned(1)),
        element([0x42, 0xF7], unsigned(1)),
        element([0x42, 0xF2], unsigned(4)),
        element([0x42, 0xF3], unsigned(8)),
        element([0x42, 0x82], text('webm')),
        element([0x42, 0x87], unsigned(2)),
        element([0x42, 0x85], unsigned(2))
    ]);

    const info = element([0x15, 0x49, 0xA9, 0x66], [
        // Times are in milliseconds.
        element([0x2A, 0xD7, 0xB1], unsigned(1_000_000)),
        element([0x4D, 0x80], text('Scanline')),
        element([0x57, 0x41], text('Scanline')),
        element([0x44, 0x89], float(durationMs))
    ]);

    const tracks = element([0x16, 0x54, 0xAE, 0x6B], element([0xAE], [
        element([0xD7], unsigned(1)),
        element([0x73, 0xC5], unsigned(1)),
        element([0x9C], unsigned(0)),
        element([0x86], text('V_VP8')),
        element([0x83], unsigned(1)),
        element([0xE0], [
            element([0xB0], unsigned(width)),
            element([0xBA], unsigned(height)),
            ...colourElement(colour)
        ])
    ]));

    // A cluster begins at each key frame, and before a frame's time is too far from its
    // cluster's to fit in the 16 bits a block has for it.
    const clusters: Bytes[] = [];

    let blocks: Bytes[] = [];
    let start = 0;

    const close = (): void =>
    {
        if (blocks.length)
        {
            clusters.push(element([0x1F, 0x43, 0xB6, 0x75], [element([0xE7], unsigned(start)), ...blocks]));
            blocks = [];
        }
    };

    for (const chunk of chunks)
    {
        const at = Math.round(chunk.ms);

        if (blocks.length === 0 || chunk.key || at - start > 30000)
        {
            close();
            start = at;
        }

        const head = new Uint8Array(4);

        head[0] = 0x81;
        new DataView(head.buffer).setInt16(1, at - start);
        head[3] = chunk.key ? 0x80 : 0;
        blocks.push(element([0xA3], [head, chunk.data]));
    }

    close();

    return concat([header, element([0x18, 0x53, 0x80, 0x67], [info, tracks, ...clusters])]);
}

// Takes frames as they are replayed and encodes them. `add` may be called from a loop
// that does not wait: the encoder keeps what it is given until `finish`.
export class Film
{
    encoder: any = null;
    chunks: Chunk[] = [];
    width = 0;
    height = 0;
    frames = 0;
    fps: number;
    edge: number;
    failed: string | null = null;
    colour: Colour | null = null;

    constructor (fps: number, edge: number)
    {
        this.fps = fps;
        this.edge = edge;
    }

    static supported (): boolean
    {
        return typeof (globalThis as any).VideoEncoder === 'function' && typeof (globalThis as any).VideoFrame === 'function';
    }

    // One frame: RGBA8, rows from the top. Made smaller by whole steps if its longest edge
    // is over the limit, and trimmed to even sizes, which the encoder's colour format needs.
    add (width: number, height: number, data: Uint8Array): void
    {
        const step = Math.max(1, Math.ceil(Math.max(width, height) / this.edge));
        const w = Math.max(2, Math.floor(width / step) & ~1);
        const h = Math.max(2, Math.floor(height / step) & ~1);

        if (this.encoder === null)
        {
            this.width = w;
            this.height = h;
            this.encoder = new (globalThis as any).VideoEncoder({
                output: (chunk: any, metadata: any) =>
                {
                    const space = metadata?.decoderConfig?.colorSpace;

                    if (space && this.colour === null)
                    {
                        this.colour = { matrix: space.matrix, primaries: space.primaries, transfer: space.transfer, fullRange: space.fullRange };
                    }

                    const bytes = new Uint8Array(chunk.byteLength);

                    chunk.copyTo(bytes);
                    this.chunks.push({ data: bytes, key: chunk.type === 'key', ms: chunk.timestamp / 1000 });
                },
                error: (error: any) => { this.failed = String(error?.message ?? error); }
            });

            this.encoder.configure({
                codec: 'vp8',
                width: w,
                height: h,
                framerate: this.fps,
                // Enough for flat game graphics to stay sharp.
                bitrate: Math.min(12_000_000, Math.max(400_000, Math.round(w * h * this.fps * 0.2)))
            });
        }

        // A recording whose canvas changed size part-way keeps the first size.
        if (w !== this.width || h !== this.height)
        {
            return;
        }

        const pixels = new Uint8Array(w * h * 4);

        for (let y = 0; y < h; y++)
        {
            if (step === 1)
            {
                pixels.set(data.subarray(y * width * 4, y * width * 4 + w * 4), y * w * 4);
                continue;
            }

            for (let x = 0; x < w; x++)
            {
                const from = ((y * step) * width + x * step) * 4;

                pixels.set(data.subarray(from, from + 4), (y * w + x) * 4);
            }
        }

        // Opaque: a canvas with transparent pixels would otherwise show as black.
        for (let i = 3; i < pixels.length; i += 4)
        {
            pixels[i] = 255;
        }

        const frame = new (globalThis as any).VideoFrame(pixels, { format: 'RGBA', codedWidth: w, codedHeight: h, timestamp: Math.round(this.frames * 1_000_000 / this.fps) });

        this.encoder.encode(frame, { keyFrame: this.frames % 60 === 0 });
        frame.close();
        this.frames++;
    }

    async finish (): Promise<Uint8Array>
    {
        if (this.encoder === null)
        {
            throw new Error('there were no frames to encode');
        }

        await this.encoder.flush();
        this.encoder.close();

        if (this.failed)
        {
            throw new Error(`the browser's encoder failed: ${this.failed}`);
        }

        this.chunks.sort((a, b) => a.ms - b.ms);

        return webm(this.chunks, this.width, this.height, this.frames * 1000 / this.fps, this.colour);
    }
}
