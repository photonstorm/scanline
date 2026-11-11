// The image a texture stand-in is made from, as the host sends it: RGBA, rows from the top.

import { G } from './natives';

export function imageOf (args: any): { width: number; height: number; pixels: Uint8Array }
{
    const width = G.Number(args.width) | 0;
    const height = G.Number(args.height) | 0;
    const text: string = G.atob(G.String(args.pixels ?? ''));
    const pixels = new G.Uint8Array(text.length) as Uint8Array;

    for (let i = 0; i < text.length; i++)
    {
        pixels[i] = text.charCodeAt(i);
    }

    if (width < 1 || height < 1 || pixels.length !== width * height * 4)
    {
        throw new G.Error('The image for a texture stand-in did not arrive whole.');
    }

    return { width, height, pixels };
}
