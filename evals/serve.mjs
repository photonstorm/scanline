// Serves the fixtures on a fixed loopback port, for an evaluation run.
//
//   node evals/serve.mjs [port]

import { serve } from '../spikes/lib/serve.mjs';

const server = await serve({ port: Number(process.argv[2] ?? 8765) });

console.log(`Fixtures at ${server.origin}/fixtures/`);
