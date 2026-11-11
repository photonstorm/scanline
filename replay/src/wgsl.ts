// Reading a WGSL module's declarations.
//
// WebGPU gives a page no way to ask what a shader declares, so the analysis reads the
// source itself. This is not a compiler: it finds the declarations at the top of a module
// (structs, resource variables, functions, aliases, constants) and leaves function bodies
// as lists of the names they mention. That is enough to:
//
//   - name the members of a uniform buffer and say where each sits (the layout rules are
//     fixed by the language);
//   - say which resource variables an entry point can reach, which is what the browser
//     builds an 'auto' pipeline layout from;
//   - write a second entry point that calls a page's own and then changes what it returns.
//
// Anything it cannot read makes `scan` throw, and the caller goes without.

export interface Attribute
{
    name: string;
    args: string[];     // each argument's text
    start: number;      // of '@', in the source
    end: number;        // just past the attribute
}

export interface Member
{
    name: string;
    type: string;
    attributes: Attribute[];
}

export interface Struct
{
    name: string;
    members: Member[];
}

export interface Param
{
    name: string;
    type: string;
    attributes: Attribute[];
}

export interface Fn
{
    name: string;
    stage: 'vertex' | 'fragment' | 'compute' | null;
    attributes: Attribute[];
    params: Param[];
    paramsText: string;                 // between the parentheses, as written
    returnType: string | null;
    returnAttributes: Attribute[];
    returnText: string;                 // '-> …' as written, or ''
    uses: Set<string>;                  // every name its body mentions
}

export interface Global
{
    name: string;
    type: string;
    space: string;      // uniform, storage, handle (textures and samplers), private…
    access: string;     // read, read_write, or ''
    group: number | null;
    binding: number | null;
}

export interface Module
{
    source: string;
    structs: Map<string, Struct>;
    functions: Map<string, Fn>;
    globals: Map<string, Global>;
    aliases: Map<string, string>;
    constants: Map<string, number>;
}

interface Token
{
    text: string;
    kind: 'word' | 'number' | 'mark';
    start: number;
    end: number;
}

function tokens (source: string): Token[]
{
    const out: Token[] = [];
    const length = source.length;

    let at = 0;

    while (at < length)
    {
        const char = source[at];

        if (char === ' ' || char === '\n' || char === '\t' || char === '\r')
        {
            at++;
            continue;
        }

        if (char === '/' && source[at + 1] === '/')
        {
            while (at < length && source[at] !== '\n')
            {
                at++;
            }

            continue;
        }

        if (char === '/' && source[at + 1] === '*')
        {
            // Block comments nest.
            let depth = 1;

            at += 2;

            while (at < length && depth > 0)
            {
                if (source[at] === '/' && source[at + 1] === '*')
                {
                    depth++;
                    at += 2;
                }
                else if (source[at] === '*' && source[at + 1] === '/')
                {
                    depth--;
                    at += 2;
                }
                else
                {
                    at++;
                }
            }

            continue;
        }

        const start = at;

        if (/[\p{L}_]/u.test(char))
        {
            while (at < length && /[\p{L}\p{N}_]/u.test(source[at]))
            {
                at++;
            }

            out.push({ text: source.slice(start, at), kind: 'word', start, end: at });
            continue;
        }

        if (/[0-9]/.test(char) || (char === '.' && /[0-9]/.test(source[at + 1] ?? '')))
        {
            // Loose: digits, hex, exponents and suffixes all run together, which is all a
            // declaration needs of a number.
            const hex = /^0[xX]/.test(source.slice(at, at + 2));

            while (at < length && /[0-9a-zA-Z_.]/.test(source[at]))
            {
                const exponent = hex ? /[pP]/.test(source[at]) : /[eE]/.test(source[at]);

                at++;

                // An exponent's sign belongs to the number.
                if (exponent && (source[at] === '+' || source[at] === '-'))
                {
                    at++;
                }
            }

            out.push({ text: source.slice(start, at), kind: 'number', start, end: at });
            continue;
        }

        if (char === '-' && source[at + 1] === '>')
        {
            at += 2;
            out.push({ text: '->', kind: 'mark', start, end: at });
            continue;
        }

        at++;
        out.push({ text: char, kind: 'mark', start, end: at });
    }

    return out;
}

const OPEN: Record<string, string> = { '(': ')', '[': ']', '{': '}' };

class Reader
{
    source: string;
    list: Token[];
    at = 0;

    constructor (source: string)
    {
        this.source = source;
        this.list = tokens(source);
    }

    get done (): boolean
    {
        return this.at >= this.list.length;
    }

    peek (ahead = 0): Token | undefined
    {
        return this.list[this.at + ahead];
    }

    is (text: string): boolean
    {
        return this.list[this.at]?.text === text;
    }

    next (): Token
    {
        const token = this.list[this.at++];

        if (!token)
        {
            throw new Error('the shader ends in the middle of a declaration');
        }

        return token;
    }

    expect (text: string): Token
    {
        const token = this.next();

        if (token.text !== text)
        {
            throw new Error(`expected "${text}" and found "${token.text}"`);
        }

        return token;
    }

    // Past a bracketed run, from its opening bracket. Returns the tokens inside.
    group (): Token[]
    {
        const open = this.next();
        const close = OPEN[open.text];
        const inside: Token[] = [];

        let depth = 1;

        while (depth > 0)
        {
            const token = this.next();

            if (token.text === open.text)
            {
                depth++;
            }
            else if (token.text === close)
            {
                depth--;
            }

            if (depth > 0)
            {
                inside.push(token);
            }
        }

        return inside;
    }

    // A template list, from its '<'. Returns the text inside.
    template (): string
    {
        const open = this.expect('<');

        let depth = 1;
        let last = open;

        while (depth > 0)
        {
            last = this.next();

            if (last.text === '<')
            {
                depth++;
            }
            else if (last.text === '>')
            {
                depth--;
            }
            else if (OPEN[last.text])
            {
                this.at--;
                this.group();
            }
        }

        return this.source.slice(open.end, last.start).trim();
    }

    attributes (): Attribute[]
    {
        const out: Attribute[] = [];

        while (this.is('@'))
        {
            const start = this.next().start;
            const name = this.next();

            let end = name.end;
            const args: string[] = [];

            if (this.is('('))
            {
                const from = this.peek()!.end;
                const inside = this.group();

                end = this.list[this.at - 1].end;

                // Split at the commas that are not inside anything.
                let depth = 0;
                let part = from;

                for (const token of inside)
                {
                    if (OPEN[token.text])
                    {
                        depth++;
                    }
                    else if (token.text === ')' || token.text === ']' || token.text === '}')
                    {
                        depth--;
                    }
                    else if (token.text === ',' && depth === 0)
                    {
                        args.push(this.source.slice(part, token.start).trim());
                        part = token.end;
                    }
                }

                const rest = this.source.slice(part, end - 1).trim();

                if (rest)
                {
                    args.push(rest);
                }
            }

            out.push({ name: name.text, args, start, end });
        }

        return out;
    }

    // A type, up to whatever follows it: a name and, perhaps, a template list.
    type (): string
    {
        const name = this.next();

        if (name.kind !== 'word')
        {
            throw new Error(`expected a type and found "${name.text}"`);
        }

        if (!this.is('<'))
        {
            return name.text;
        }

        return `${name.text}<${this.template()}>`;
    }

    // To just past the next ';' that is not inside anything.
    statement (): void
    {
        for (;;)
        {
            const token = this.peek();

            if (!token)
            {
                return;
            }

            if (OPEN[token.text])
            {
                this.group();
            }
            else
            {
                this.at++;

                if (token.text === ';')
                {
                    return;
                }
            }
        }
    }
}

function integer (text: string, constants: Map<string, number>): number | null
{
    const plain = text.trim().replace(/[iu]$/, '');

    if (/^(0[xX][0-9a-fA-F]+|[0-9]+)$/.test(plain))
    {
        return Number(plain);
    }

    return constants.get(text.trim()) ?? null;
}

export function scan (source: string): Module
{
    const reader = new Reader(source);
    const module: Module = { source, structs: new Map(), functions: new Map(), globals: new Map(), aliases: new Map(), constants: new Map() };

    while (!reader.done)
    {
        const attributes = reader.attributes();
        const token = reader.next();

        switch (token.text)
        {
            case ';':
                break;

            case 'struct':
            {
                const struct: Struct = { name: reader.next().text, members: [] };

                reader.expect('{');

                while (!reader.is('}'))
                {
                    const memberAttributes = reader.attributes();
                    const name = reader.next().text;

                    reader.expect(':');
                    struct.members.push({ name, type: reader.type(), attributes: memberAttributes });

                    if (reader.is(','))
                    {
                        reader.next();
                    }
                }

                reader.expect('}');
                module.structs.set(struct.name, struct);
                break;
            }

            case 'fn':
            {
                const name = reader.next().text;
                const open = reader.expect('(');
                const params: Param[] = [];

                while (!reader.is(')'))
                {
                    const paramAttributes = reader.attributes();
                    const param = reader.next().text;

                    reader.expect(':');
                    params.push({ name: param, type: reader.type(), attributes: paramAttributes });

                    if (reader.is(','))
                    {
                        reader.next();
                    }
                }

                const close = reader.expect(')');

                let returnType: string | null = null;
                let returnAttributes: Attribute[] = [];
                let returnText = '';

                if (reader.is('->'))
                {
                    const arrow = reader.next();

                    returnAttributes = reader.attributes();
                    returnType = reader.type();
                    returnText = source.slice(arrow.start, reader.list[reader.at - 1].end);
                }

                // Attributes may sit before the body too.
                reader.attributes();

                const uses = new Set<string>();

                for (const inside of reader.group())
                {
                    if (inside.kind === 'word')
                    {
                        uses.add(inside.text);
                    }
                }

                const stage = attributes.find((attribute) => attribute.name === 'vertex' || attribute.name === 'fragment' || attribute.name === 'compute');

                module.functions.set(name, {
                    name,
                    stage: (stage?.name as Fn['stage']) ?? null,
                    attributes,
                    params,
                    paramsText: source.slice(open.end, close.start),
                    returnType,
                    returnAttributes,
                    returnText,
                    uses
                });
                break;
            }

            case 'var':
            {
                let space = '';
                let access = '';

                if (reader.is('<'))
                {
                    const parts = reader.template().split(',').map((part) => part.trim());

                    space = parts[0] ?? '';
                    access = parts[1] ?? '';
                }

                const name = reader.next().text;

                let type = '';

                if (reader.is(':'))
                {
                    reader.next();
                    type = reader.type();
                }

                reader.statement();

                const group = attributes.find((attribute) => attribute.name === 'group');
                const binding = attributes.find((attribute) => attribute.name === 'binding');

                module.globals.set(name, {
                    name,
                    type,
                    // A texture or sampler is declared with no address space.
                    space: space || (group ? 'handle' : 'private'),
                    access,
                    group: group ? integer(group.args[0] ?? '', module.constants) : null,
                    binding: binding ? integer(binding.args[0] ?? '', module.constants) : null
                });
                break;
            }

            case 'alias':
            {
                const name = reader.next().text;

                reader.expect('=');
                module.aliases.set(name, reader.type());
                reader.statement();
                break;
            }

            case 'const':
            {
                const name = reader.next().text;

                if (reader.is(':'))
                {
                    reader.next();
                    reader.type();
                }

                if (reader.is('='))
                {
                    reader.next();

                    const value = reader.peek();

                    if (value && reader.peek(1)?.text === ';')
                    {
                        const number = integer(value.text, module.constants);

                        if (number !== null)
                        {
                            module.constants.set(name, number);
                        }
                    }
                }

                reader.statement();
                break;
            }

            case 'override':
            case 'enable':
            case 'requires':
            case 'diagnostic':
            case 'const_assert':
                reader.statement();
                break;

            default:
                throw new Error(`"${token.text}" is not a declaration this reader knows`);
        }
    }

    return module;
}

// The entry point of a stage: the one named, or the only one there is.
export function entryPoint (module: Module, stage: 'vertex' | 'fragment' | 'compute', name?: string | null): Fn | null
{
    if (name)
    {
        const found = module.functions.get(name);

        return found && found.stage === stage ? found : null;
    }

    const all = [...module.functions.values()].filter((fn) => fn.stage === stage);

    return all.length === 1 ? all[0] : null;
}

// The resource variables a function can reach, through any function it calls.
// A local that shares a global's name is taken for the global: that errs towards more.
export function reachable (module: Module, fn: Fn): Global[]
{
    const seen = new Set<string>([fn.name]);
    const queue = [fn];
    const found = new Map<string, Global>();

    while (queue.length)
    {
        const current = queue.pop()!;

        for (const name of current.uses)
        {
            const global = module.globals.get(name);

            if (global && global.group !== null && global.binding !== null)
            {
                found.set(name, global);
            }

            const called = module.functions.get(name);

            if (called && !seen.has(name))
            {
                seen.add(name);
                queue.push(called);
            }
        }
    }

    return [...found.values()];
}

// ---- Layout ----

export interface Leaf
{
    name: string;
    type: string;
    offset: number;
    scalar: 'f32' | 'i32' | 'u32' | 'f16';
    columns: number;    // 1 for a scalar or a vector
    rows: number;       // components in each column
    stride: number;     // bytes from one column to the next
}

interface Shape
{
    size: number;
    align: number;
    leaves: (base: number, name: string, out: Leaf[], budget: { left: number }) => void;
}

const SCALARS: Record<string, [Leaf['scalar'], number]> = { f32: ['f32', 4], i32: ['i32', 4], u32: ['u32', 4], f16: ['f16', 2] };
const SUFFIX: Record<string, string> = { f: 'f32', i: 'i32', u: 'u32', h: 'f16' };

function roundUp (to: number, value: number): number
{
    return Math.ceil(value / to) * to;
}

// Splits "a<b, c<d>>" into its name and its arguments.
function parts (type: string): [string, string[]]
{
    const open = type.indexOf('<');

    if (open < 0)
    {
        return [type.trim(), []];
    }

    const args: string[] = [];
    const inside = type.slice(open + 1, type.lastIndexOf('>'));

    let depth = 0;
    let from = 0;

    for (let i = 0; i < inside.length; i++)
    {
        if (inside[i] === '<')
        {
            depth++;
        }
        else if (inside[i] === '>')
        {
            depth--;
        }
        else if (inside[i] === ',' && depth === 0)
        {
            args.push(inside.slice(from, i).trim());
            from = i + 1;
        }
    }

    args.push(inside.slice(from).trim());

    return [type.slice(0, open).trim(), args];
}

// How many elements of an array are listed by name before the rest are left out.
const ELEMENTS = 4;

function shapeOf (module: Module, type: string, depth = 0): Shape
{
    if (depth > 16)
    {
        throw new Error(`the type ${type} refers to itself`);
    }

    const alias = module.aliases.get(type);

    if (alias)
    {
        return shapeOf(module, alias, depth + 1);
    }

    const [name, args] = parts(type);

    if (SCALARS[name] && args.length === 0)
    {
        const [scalar, size] = SCALARS[name];

        return {
            size,
            align: size,
            leaves: (base, label, out, budget) =>
            {
                if (budget.left-- > 0)
                {
                    out.push({ name: label, type, offset: base, scalar, columns: 1, rows: 1, stride: size });
                }
            }
        };
    }

    if (name === 'atomic' && args.length === 1)
    {
        return shapeOf(module, args[0], depth + 1);
    }

    const vector = /^vec([234])([fiuh]?)$/.exec(name);

    if (vector)
    {
        const n = Number(vector[1]);
        const [scalar, size] = SCALARS[vector[2] ? SUFFIX[vector[2]] : (args[0] ?? '')] ?? [];

        if (!scalar)
        {
            throw new Error(`${type} is not a vector this reader knows`);
        }

        return {
            size: n * size,
            align: (n === 3 ? 4 : n) * size,
            leaves: (base, label, out, budget) =>
            {
                if (budget.left-- > 0)
                {
                    out.push({ name: label, type, offset: base, scalar, columns: 1, rows: n, stride: n * size });
                }
            }
        };
    }

    const matrix = /^mat([234])x([234])([fh]?)$/.exec(name);

    if (matrix)
    {
        const columns = Number(matrix[1]);
        const rows = Number(matrix[2]);
        const [scalar, size] = SCALARS[matrix[3] ? SUFFIX[matrix[3]] : (args[0] ?? '')] ?? [];

        if (!scalar)
        {
            throw new Error(`${type} is not a matrix this reader knows`);
        }

        const align = (rows === 3 ? 4 : rows) * size;
        const stride = roundUp(align, rows * size);

        return {
            size: columns * stride,
            align,
            leaves: (base, label, out, budget) =>
            {
                if (budget.left-- > 0)
                {
                    out.push({ name: label, type, offset: base, scalar, columns, rows, stride });
                }
            }
        };
    }

    if (name === 'array')
    {
        const element = shapeOf(module, args[0] ?? '', depth + 1);
        const stride = roundUp(element.align, element.size);
        const count = args.length > 1 ? integer(args[1], module.constants) : 0;

        if (count === null)
        {
            throw new Error(`the length of ${type} is not a plain number`);
        }

        return {
            // An array with no length takes whatever is left of its buffer.
            size: count * stride,
            align: element.align,
            leaves: (base, label, out, budget) =>
            {
                const shown = count === 0 ? ELEMENTS : Math.min(count, ELEMENTS);

                for (let i = 0; i < shown; i++)
                {
                    element.leaves(base + i * stride, `${label}[${i}]`, out, budget);
                }
            }
        };
    }

    const struct = module.structs.get(name);

    if (struct && args.length === 0)
    {
        const placed: Array<{ member: Member; shape: Shape; offset: number }> = [];

        let offset = 0;
        let align = 1;

        for (const member of struct.members)
        {
            const shape = shapeOf(module, member.type, depth + 1);
            const forcedAlign = member.attributes.find((attribute) => attribute.name === 'align');
            const forcedSize = member.attributes.find((attribute) => attribute.name === 'size');
            const memberAlign = (forcedAlign ? integer(forcedAlign.args[0] ?? '', module.constants) : null) ?? shape.align;
            const memberSize = (forcedSize ? integer(forcedSize.args[0] ?? '', module.constants) : null) ?? shape.size;

            offset = roundUp(memberAlign, offset);
            placed.push({ member, shape, offset });
            offset += memberSize;
            align = Math.max(align, memberAlign);
        }

        return {
            size: roundUp(align, offset),
            align,
            leaves: (base, label, out, budget) =>
            {
                for (const entry of placed)
                {
                    entry.shape.leaves(base + entry.offset, label ? `${label}.${entry.member.name}` : entry.member.name, out, budget);
                }
            }
        };
    }

    throw new Error(`${type} is not a type that can sit in a buffer`);
}

// Every value in a buffer variable, by name, with where it sits: at most `most` of them.
export function layout (module: Module, global: Global, most = 64): { size: number; leaves: Leaf[]; more: boolean }
{
    const shape = shapeOf(module, global.type);
    const leaves: Leaf[] = [];
    const budget = { left: most };

    shape.leaves(0, global.name, leaves, budget);

    return { size: shape.size, leaves, more: budget.left < 0 };
}

function halfToFloat (half: number): number
{
    const exponent = (half >> 10) & 0x1F;
    const fraction = half & 0x3FF;
    const sign = half & 0x8000 ? -1 : 1;

    if (exponent === 0)
    {
        return sign * 2 ** -14 * (fraction / 1024);
    }

    if (exponent === 31)
    {
        return fraction ? NaN : sign * Infinity;
    }

    return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

// The numbers of one value, read from the bytes of its buffer. Null when it runs past them.
export function valuesOf (leaf: Leaf, bytes: Uint8Array): number[] | null
{
    const size = leaf.scalar === 'f16' ? 2 : 4;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const out: number[] = [];

    for (let column = 0; column < leaf.columns; column++)
    {
        for (let row = 0; row < leaf.rows; row++)
        {
            const at = leaf.offset + column * leaf.stride + row * size;

            if (at + size > bytes.byteLength)
            {
                return null;
            }

            switch (leaf.scalar)
            {
                case 'f32': out.push(view.getFloat32(at, true)); break;
                case 'i32': out.push(view.getInt32(at, true)); break;
                case 'u32': out.push(view.getUint32(at, true)); break;
                case 'f16': out.push(halfToFloat(view.getUint16(at, true))); break;
            }
        }
    }

    return out;
}

// ---- Writing a second entry point ----

function blank (source: string, ranges: Array<{ start: number; end: number }>): string
{
    let out = source;

    for (const range of ranges)
    {
        out = out.slice(0, range.start) + ' '.repeat(range.end - range.start) + out.slice(range.end);
    }

    return out;
}

// The source with an entry point turned into an ordinary function: its stage and the
// attributes of its parameters and of what it returns are taken away.
function demoted (module: Module, fn: Fn): string
{
    const stage = fn.attributes.filter((attribute) => attribute.name === fn.stage || attribute.name === 'workgroup_size');

    return blank(module.source, [...stage, ...fn.params.flatMap((param) => param.attributes), ...fn.returnAttributes]);
}

// The member of a struct that carries an attribute with a given first argument.
function memberWith (module: Module, type: string | null, attribute: string, arg: string): Member | null
{
    const struct = type ? module.structs.get(module.aliases.get(type) ?? type) : undefined;

    return struct?.members.find((member) => member.attributes.some((found) => found.name === attribute && found.args[0]?.replace(/[iu]$/, '') === arg)) ?? null;
}

// A constructor for a float type of up to four components, from four numbers.
function construct (module: Module, type: string, value: number[]): string | null
{
    const resolved = module.aliases.get(type) ?? type;
    const [name, args] = parts(resolved);
    const vector = /^vec([234])([fh]?)$/.exec(name);
    const float = (n: number): string => (Number.isInteger(n) ? `${n}.0` : String(n));

    if ((name === 'f32' || name === 'f16') && args.length === 0)
    {
        return `${resolved}(${float(value[0])})`;
    }

    if (vector && (vector[2] || args[0] === 'f32' || args[0] === 'f16'))
    {
        return `${resolved}(${value.slice(0, Number(vector[1])).map(float).join(', ')})`;
    }

    return null;
}

export const FRAGMENT_ENTRY = 'scanline_fragment';
export const VERTEX_ENTRY = 'scanline_vertex';
export const POSITIONS_ENTRY = 'scanline_positions';

// A module whose fragment entry point `scanline_fragment` runs the page's own (so the
// same fragments are discarded and the same resources are used) and then writes `value`
// to one colour output in place of what the page's wrote. Null when the page's entry
// point has no such output.
export function fragmentWriting (module: Module, fn: Fn, location: number, value: number[]): string | null
{
    if (!fn.returnType)
    {
        return null;
    }

    const direct = fn.returnAttributes.find((attribute) => attribute.name === 'location' && Number(attribute.args[0]?.replace(/[iu]$/, '')) === location);
    const member = direct ? null : memberWith(module, fn.returnType, 'location', String(location));
    const made = construct(module, direct ? fn.returnType : (member?.type ?? ''), value);

    if (!made)
    {
        return null;
    }

    return `${demoted(module, fn)}

@fragment fn ${FRAGMENT_ENTRY} (${fn.paramsText}) ${fn.returnText}
{
    var scanline_out = ${fn.name}(${fn.params.map((param) => param.name).join(', ')});

    scanline_out${member ? `.${member.name}` : ''} = ${made};

    return scanline_out;
}
`;
}

// A module with two more entry points. `scanline_vertex` runs the page's vertex entry
// point and puts each vertex on a pixel of its own, numbered from `base` across rows of
// `width`, carrying the clip-space position the page's shader gave it.
// `scanline_positions` writes that position out. Drawn as points to a float target, the
// target then holds what the vertex shader made of every vertex.
export function vertexPositions (module: Module, fn: Fn, base: number, width: number, height: number): string | null
{
    const direct = fn.returnAttributes.some((attribute) => attribute.name === 'builtin' && attribute.args[0] === 'position');
    const member = direct ? null : memberWith(module, fn.returnType, 'builtin', 'position');

    if (!direct && !member)
    {
        return null;
    }

    // The vertex's number: the page's own input for it if it has one, for a builtin can be
    // asked for only once.
    let index = '';
    let extra = '';

    for (const param of fn.params)
    {
        if (param.attributes.some((attribute) => attribute.name === 'builtin' && attribute.args[0] === 'vertex_index'))
        {
            index = param.name;
        }

        const inside = memberWith(module, param.type, 'builtin', 'vertex_index');

        if (inside)
        {
            index = `${param.name}.${inside.name}`;
        }
    }

    const given = fn.paramsText.trim().replace(/,\s*$/, '');

    if (!index)
    {
        index = 'scanline_index';
        extra = `${given ? ', ' : ''}@builtin(vertex_index) scanline_index: u32`;
    }

    return `${demoted(module, fn)}

struct ScanlinePlaced
{
    @builtin(position) at: vec4f,
    @location(0) clip: vec4f
}

@vertex fn ${VERTEX_ENTRY} (${given}${extra}) -> ScanlinePlaced
{
    let scanline_made = ${fn.name}(${fn.params.map((param) => param.name).join(', ')});
    let scanline_slot = u32(${index}) - ${base}u;

    var scanline_out: ScanlinePlaced;

    scanline_out.at = vec4f(
        (f32(scanline_slot % ${width}u) + 0.5) / ${width}.0 * 2.0 - 1.0,
        1.0 - (f32(scanline_slot / ${width}u) + 0.5) / ${height}.0 * 2.0,
        0.0,
        1.0
    );
    scanline_out.clip = scanline_made${member ? `.${member.name}` : ''};

    return scanline_out;
}

@fragment fn ${POSITIONS_ENTRY} (scanline_in: ScanlinePlaced) -> @location(0) vec4f
{
    return scanline_in.clip;
}
`;
}

// The names a vertex entry point gives its inputs, by location.
export function inputNames (module: Module, fn: Fn): Map<number, { name: string; type: string }>
{
    const out = new Map<number, { name: string; type: string }>();
    const locationOf = (attributes: Attribute[]): number | null =>
    {
        const found = attributes.find((attribute) => attribute.name === 'location');

        return found ? integer(found.args[0] ?? '', module.constants) : null;
    };

    for (const param of fn.params)
    {
        const location = locationOf(param.attributes);

        if (location !== null)
        {
            out.set(location, { name: param.name, type: param.type });
            continue;
        }

        for (const member of module.structs.get(module.aliases.get(param.type) ?? param.type)?.members ?? [])
        {
            const inside = locationOf(member.attributes);

            if (inside !== null)
            {
                out.set(inside, { name: member.name, type: member.type });
            }
        }
    }

    return out;
}
