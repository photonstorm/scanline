// A static file server for the fixtures, on a loopback port chosen by the OS.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json',
    '.wasm': 'application/wasm',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.css': 'text/css'
};

export function serve ({ root = repoRoot, headers = {}, port = 0 } = {})
{
    let counter = 0;

    const server = createServer(async (request, response) =>
    {
        const path = decodeURIComponent(new URL(request.url, 'http://x').pathname);

        if (path === '/favicon.ico')
        {
            // Browsers ask for one unprompted. A 404 would show up as an error in every session.
            response.writeHead(204).end();

            return;
        }

        // An answer that differs every time it is asked for, and takes a moment: what a
        // run has to keep if it is to be played again exactly.
        if (path === '/__counter')
        {
            const value = ++counter;

            setTimeout(() =>
            {
                response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
                response.end(JSON.stringify({ value, at: Date.now() }));
            }, 40);

            return;
        }

        const file = normalize(join(root, path));

        if (file !== root && !file.startsWith(root + sep))
        {
            response.writeHead(403).end();

            return;
        }

        try
        {
            const body = await readFile(file);

            response.writeHead(200, {
                'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
                'Cache-Control': 'no-store',
                ...headers
            });
            response.end(body);
        }
        catch
        {
            response.writeHead(404).end('Not found');
        }
    });

    return new Promise((done) =>
    {
        server.listen(port, '127.0.0.1', () =>
        {
            const { port } = server.address();

            done({
                port,
                origin: `http://127.0.0.1:${port}`,
                url: (path) => `http://127.0.0.1:${port}/${path.replace(/^\//, '')}`,
                close: () => new Promise((closed) =>
                {
                    server.closeAllConnections();
                    server.close(closed);
                })
            });
        });
    });
}
