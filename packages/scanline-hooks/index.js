// scanline-hooks: the Scanline page protocol, safe to call anywhere.
//
// Inside Scanline these forward to the `__scanline` global. Anywhere else they do nothing
// (group still runs its function), so call sites need no checks. The global is the
// contract; this file is a convenience.

const dbg = globalThis.__scanline;
const nothing = () => undefined;

/** True when the page is running inside Scanline. Do not draw differently because of it. */
export const active = dbg !== undefined;

/** The protocol version of the debugger, or 0. */
export const version = dbg ? dbg.version : 0;

export const label = dbg ? (object, name) => dbg.label(object, name) : nothing;
export const group = dbg ? (name, body) => dbg.group(name, body) : (name, body) => body();
export const push = dbg ? (name) => dbg.push(name) : nothing;
export const pop = dbg ? () => dbg.pop() : nothing;
export const entity = dbg ? (reference, info) => dbg.entity(reference, info) : nothing;
export const mark = dbg ? (name, data) => dbg.mark(name, data) : nothing;

export const frame = {
    begin: dbg ? () => dbg.frame.begin() : nothing,
    end: dbg ? () => dbg.frame.end() : nothing
};

export const time = {
    provide: dbg ? (controls) => dbg.time.provide(controls) : nothing,
    deterministic: dbg ? (apply) => dbg.time.deterministic(apply) ?? null : () => null
};

export const checkpoint = { provide: dbg ? (pair) => dbg.checkpoint.provide(pair) : nothing };

export const state = {
    provide: dbg ? (from) => dbg.state.provide(from) : nothing,
    describe: dbg ? (schema) => dbg.state.describe(schema) : nothing
};

export const views = { register: dbg ? (view) => dbg.views.register(view) : nothing };
export const controls = { register: dbg ? (control) => dbg.controls.register(control) : nothing };
export const uniforms = { expose: dbg ? (program, names) => dbg.uniforms.expose(program, names) : nothing };
export const passes = { describe: dbg ? (list) => dbg.passes.describe(list) : nothing };

// Watches: Scanline reads the object's properties as each frame ends and checks them against
// rules (numbers stay finite unless told otherwise). Options: { props, depth, rules, break }.
export const watch = Object.assign(dbg ? (name, object, options) => dbg.watch(name, object, options) : nothing, {
    sprite: dbg ? (name, sprite, options) => dbg.watch.sprite(name, sprite, options) : nothing,
    object3d: dbg ? (name, object, options) => dbg.watch.object3d(name, object, options) : nothing
});
export const unwatch = dbg ? (name) => dbg.unwatch(name) : nothing;

export default { active, version, label, group, push, pop, entity, mark, frame, time, checkpoint, state, views, controls, uniforms, passes, watch, unwatch };
