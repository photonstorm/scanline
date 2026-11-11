// Generates probe/src/hooks/generated.ts: one wrapper per method of the WebGL and WebGPU
// interfaces, from the published interface definitions (@webref/idl) and method-table.mjs.
//
//   node probe/tools/gen-hooks.mjs          write the file
//   node probe/tools/gen-hooks.mjs --check  fail if the file on disk is out of date

import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GL, GL_EXTENSIONS, GPU } from './method-table.mjs';

const require = createRequire(import.meta.url);
const idl = require('@webref/idl');
const idlVersion = require('@webref/idl/package.json').version;

const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, '..', 'src', 'hooks', 'generated.ts');

const parsed = await idl.parseAll();

// Every definition from the files we use, with partials and mixins resolved by name.
function collect (files)
{
    const interfaces = new Map();
    const mixins = new Map();
    const includes = [];

    for (const file of files)
    {
        for (const def of parsed[file] ?? [])
        {
            if (def.type === 'interface')
            {
                const members = interfaces.get(def.name) ?? [];

                members.push(...def.members);
                interfaces.set(def.name, members);
            }
            else if (def.type === 'interface mixin')
            {
                const members = mixins.get(def.name) ?? [];

                members.push(...def.members);
                mixins.set(def.name, members);
            }
            else if (def.type === 'includes')
            {
                includes.push(def);
            }
        }
    }

    return { interfaces, mixins, includes };
}

// The operations of an interface after mixins: name -> { length, max }.
// `length` is what Function.length reports natively: the fewest required arguments of any overload.
function operations ({ interfaces, mixins, includes }, name)
{
    const members = [...(interfaces.get(name) ?? [])];

    for (const inc of includes)
    {
        if (inc.target === name)
        {
            members.push(...(mixins.get(inc.includes) ?? []));
        }
    }

    const ops = new Map();

    for (const member of members)
    {
        if (member.type !== 'operation' || !member.name || member.special === 'static')
        {
            continue;
        }

        const required = member.arguments.filter((arg) => !arg.optional && !arg.variadic).length;
        const max = member.arguments.length;
        const op = ops.get(member.name);

        if (op)
        {
            op.length = Math.min(op.length, required);
            op.max = Math.max(op.max, max);
        }
        else
        {
            ops.set(member.name, { length: required, max });
        }
    }

    return ops;
}

const glDefs = collect(['webgl1', 'webgl2']);
const gpuDefs = collect(['webgpu']);

// Every method the table says has a hand-written handler. The probe checks at start-up
// that each one exists.
const handled = new Set();

const methodNames = [];
const methodIds = new Map();

function methodId (qualified)
{
    if (!methodIds.has(qualified))
    {
        methodIds.set(qualified, methodNames.length);
        methodNames.push(qualified);
    }

    return methodIds.get(qualified);
}

function params (count)
{
    return Array.from({ length: count }, (_, i) => `a${i}: any`).join(', ');
}

function args (count)
{
    return Array.from({ length: count }, (_, i) => `a${i}`).join(', ');
}

// One wrapper factory. `family` picks how the record for `this` is found.
function wrapper (family, qualified, name, op, entry = {})
{
    const id = methodId(qualified);
    const all = args(op.max);

    if (entry.intercept || entry.post)
    {
        handled.add(qualified);
    }

    const sig = `this: any${op.max ? ', ' + params(op.max) : ''}`;
    const tail = op.max ? ', ' + all : '';

    if (entry.intercept)
    {
        return `(N, H, h) => function ${name} (${sig}) { return h(this, N, arguments); }`;
    }

    const lookup = {
        gl: 'H.ctx(this)',
        ext: 'H.ext(this)',
        gpu: 'H.gpu'
    }[family];

    const body = [];

    body.push('if (H.off) { return N.apply(this, arguments as any); }');
    body.push(`const c = ${lookup};`);

    if (entry.draw)
    {
        // A live patch may drop the draw, or change state around it and put it back after.
        body.push(`if (c.gate !== null && c.gate(c, this, ${id}) === false) { c.calls++; return undefined; }`);
        body.push('const r = N.apply(this, arguments as any);');
        body.push('if (c.after !== null) { c.after(c, this); }');
    }
    else
    {
        if (entry.before)
        {
            body.push(`if (c.before !== null) { c.before(c, this${op.max ? ', a0' : ''}); }`);
        }

        body.push('const r = N.apply(this, arguments as any);');
    }

    body.push('c.calls++;');

    if (entry.draw)
    {
        const { mode = null, count = null, instances = null, multi } = entry.draw;
        const pick = (index) => (index === null || index === undefined ? '-1' : `a${index}`);

        if (multi !== undefined)
        {
            body.push(`H.multiDraw(c, ${pick(mode)}, a${multi});`);
        }
        else
        {
            body.push(`H.draw(c, ${pick(mode)}, ${pick(count)}, ${pick(instances)});`);
        }
    }

    if (entry.count)
    {
        body.push(`c.${entry.count}++;`);
    }

    if (entry.post)
    {
        body.push(`h(c, this, r${tail});`);
    }

    body.push(`if (c.rec !== null) { c.rec(c, ${id}, this, r, arguments.length${tail}); }`);
    body.push('return r;');

    return `(N, H, h) => function ${name} (${sig}) { ${body.join(' ')} }`;
}

function table (family, ifaceName, ops, entries, prefix)
{
    const lines = [];

    for (const name of [...ops.keys()].sort())
    {
        const qualified = `${prefix}.${name}`;

        lines.push(`        ${name}: ${wrapper(family, qualified, name, ops.get(name), entries[name])},`);
    }

    for (const name of Object.keys(entries))
    {
        if (!ops.has(name))
        {
            throw new Error(`method-table.mjs lists ${ifaceName}.${name}, which is not in the interface definitions`);
        }
    }

    return lines.join('\n');
}

const sections = [];
const counters = new Set(['calls', 'draws', 'instances', 'vertices', 'triangles', 'passes']);

function noteCounters (entries)
{
    for (const entry of Object.values(entries))
    {
        if (entry.count)
        {
            counters.add(entry.count);
        }
    }
}

// WebGL 1 and WebGL 2 contexts. Their prototypes are separate objects with separate native
// functions, so each gets its own wrappers; a method on both shares one method ID.
for (const iface of ['WebGLRenderingContext', 'WebGL2RenderingContext'])
{
    const ops = operations(glDefs, iface);
    const entries = Object.fromEntries(Object.entries(GL).filter(([name]) => ops.has(name)));

    noteCounters(entries);
    sections.push(`    ${iface}: {\n${table('gl', iface, ops, entries, 'gl')}\n    },`);
}

for (const name of Object.keys(GL))
{
    if (!operations(glDefs, 'WebGLRenderingContext').has(name) && !operations(glDefs, 'WebGL2RenderingContext').has(name))
    {
        throw new Error(`method-table.mjs lists gl.${name}, which is not in the interface definitions`);
    }
}

const extensionSections = [];

for (const [extName, entries] of Object.entries(GL_EXTENSIONS))
{
    const defs = collect([extName]);
    const ops = operations(defs, extName);

    if (ops.size === 0)
    {
        throw new Error(`Extension ${extName} has no operations in the interface definitions`);
    }

    noteCounters(entries);
    extensionSections.push(`    ${extName}: {\n${table('ext', extName, ops, entries, extName)}\n    },`);
}

const gpuSections = [];

for (const [iface, entries] of Object.entries(GPU))
{
    const ops = operations(gpuDefs, iface);

    if (ops.size === 0)
    {
        throw new Error(`${iface} has no operations in the interface definitions`);
    }

    noteCounters(entries);
    gpuSections.push(`    ${iface}: {\n${table('gpu', iface, ops, entries, iface)}\n    },`);
}

const source = `// GENERATED by probe/tools/gen-hooks.mjs from @webref/idl ${idlVersion} and method-table.mjs.
// Do not edit. Run \`npm run gen:hooks\` after changing either.

/* eslint-disable */

import type { Hub } from './hub';

type Fn = (...args: any[]) => any;

export type Factory = (N: Fn, H: Hub, h: Fn) => Fn;

export const IDL_VERSION = ${JSON.stringify(idlVersion)};

// Method IDs, as recorded in command streams. An ID is an index into this list.
export const METHOD_NAMES: readonly string[] = ${JSON.stringify(methodNames)};

// Methods that need a hand-written handler, by the key the handler is registered under.
export const HANDLED: readonly string[] = ${JSON.stringify([...handled])};

// Per-frame counters every record carries.
export const COUNTERS = ${JSON.stringify([...counters])} as const;

export const GL_WRAPPERS: Record<string, Record<string, Factory>> = {
${sections.join('\n')}
};

export const GL_EXTENSION_WRAPPERS: Record<string, Record<string, Factory>> = {
${extensionSections.join('\n')}
};

export const GPU_WRAPPERS: Record<string, Record<string, Factory>> = {
${gpuSections.join('\n')}
};
`;

// ---- Tags ----
//
// A tag attaches a private record to a platform object (see probe/src/tag.ts). Every tag
// made by one factory function would share one piece of code, and so one inline cache,
// which then sees textures, buffers, programs and contexts and becomes slow. Writing a
// class per kind keeps each cache to one type of object. Spike S9 measured the difference.
const TAGS = [
    'context', 'extension', 'glTexture', 'glBuffer', 'glShader', 'glProgram', 'glFramebuffer',
    'glRenderbuffer', 'glSampler', 'vertexArrayState', 'uniformLocation', 'gpuView', 'gpuDevice', 'gpuEncoder'
];

const tagsPath = join(here, '..', 'src', 'tags.generated.ts');

const tagsSource = `// GENERATED by probe/tools/gen-hooks.mjs. Do not edit.
//
// One class per kind of tagged object, so each has its own inline caches. See tag.ts.

/* eslint-disable */

import type { Tag } from './tag';

const Base = function (this: unknown, target: object): object
{
    return target;
} as unknown as new (target: object) => object;

${TAGS.map((name) => `class Tag_${name} extends Base
{
    #value: any;

    constructor (target: object, value: any)
    {
        super(target);

        this.#value = value;
    }

    static get (target: any): any
    {
        return #value in target ? target.#value : undefined;
    }

    static set (target: any, value: any): void
    {
        if (#value in target)
        {
            target.#value = value;
        }
        else
        {
            new Tag_${name}(target, value);
        }
    }
}

export const ${name}Tag: Tag<any> = Tag_${name};
`).join('\n')}`;

if (process.argv.includes('--check'))
{
    const currentTags = existsSync(tagsPath) ? readFileSync(tagsPath, 'utf8') : '';

    if (currentTags !== tagsSource)
    {
        console.error('probe/src/tags.generated.ts is out of date. Run `npm run gen:hooks`.');
        process.exit(1);
    }
}
else
{
    writeFileSync(tagsPath, tagsSource);
}

if (process.argv.includes('--check'))
{
    const current = existsSync(outPath) ? readFileSync(outPath, 'utf8') : '';

    if (current !== source)
    {
        console.error('probe/src/hooks/generated.ts is out of date. Run `npm run gen:hooks`.');
        process.exit(1);
    }

    console.log('probe/src/hooks/generated.ts is up to date.');
}
else
{
    writeFileSync(outPath, source);
    console.log(`Wrote ${methodNames.length} method wrappers to probe/src/hooks/generated.ts`);
}
