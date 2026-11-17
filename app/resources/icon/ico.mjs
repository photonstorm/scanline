// Makes the Windows icon, resources/windows/Scanline.ico, from the Mac's AppIcon.icns: the
// PNG pictures the .icns holds (32, 64, 128 and 256 pixels square), as an .ico keeps them,
// with nothing redrawn. Run after make.sh has remade AppIcon.icns:
//
//   node app/resources/icon/ico.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const icns = readFileSync(join(here, '..', 'AppIcon.icns'));
const pictures = new Map();

// An .icns is "icns", its length, then entries of a four-letter type, a length and the data.
for (let at = 8; at < icns.length;)
{
    const length = icns.readUInt32BE(at + 4);
    const data = icns.subarray(at + 8, at + length);

    if (data.length > 24 && data.readUInt32BE(0) === 0x89504e47)
    {
        const width = data.readUInt32BE(16);

        if (width <= 256 && width === data.readUInt32BE(20))
        {
            pictures.set(width, data);
        }
    }

    at += length;
}

const sizes = [...pictures.keys()].sort((a, b) => a - b);
const header = Buffer.alloc(6 + 16 * sizes.length);

// An .ico is a header, one sixteen-byte entry for each picture, then the pictures.
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);

let offset = header.length;

sizes.forEach((size, i) =>
{
    const entry = 6 + 16 * i;
    const data = pictures.get(size);

    // 0 means 256.
    header.writeUInt8(size % 256, entry);
    header.writeUInt8(size % 256, entry + 1);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(data.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += data.length;
});

const out = join(here, '..', 'windows', 'Scanline.ico');

writeFileSync(out, Buffer.concat([header, ...sizes.map((size) => pictures.get(size))]));
console.log(`Wrote ${out}: ${sizes.join(', ')} pixels square`);
