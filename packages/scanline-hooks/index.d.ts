/** True when the page is running inside Scanline. Do not draw differently because of it. */
export const active: boolean;

/** The protocol version of the debugger, or 0 outside it. */
export const version: number;

/** Names a WebGL or WebGPU object. For WebGPU it also sets the object's label if that is empty. */
export function label (object: object, name: string): void;

/** Runs `body` with every draw inside it in a named group. Groups nest. Returns what `body` returns. */
export function group<T> (name: string, body: () => T): T;

/** Opens a named group. Close it with pop(). */
export function push (name: string): void;

/** Closes the innermost open group. */
export function pop (): void;

export interface EntityInfo
{
    type?: string;
    name?: string;
    id?: string | number;
    path?: string;
    [more: string]: unknown;
}

/** Says that the draws in the current group belong to a game object. */
export function entity (reference: object | null, info: EntityInfo): void;

/** A point on the timeline, such as "level loaded". The debugger can run until it. */
export function mark (name: string, data?: unknown): void;

export const frame: {
    /** Explicit frame markers, for loops not driven by requestAnimationFrame. */
    begin (): void;
    end (): void;
};

export interface TimeControls
{
    pause? (): void;
    resume? (): void;
    step? (frames?: number): void;
    setScale? (scale: number): void;
}

export const time: {
    /** The engine's own time control, for the debugger to call. */
    provide (controls: TimeControls): void;

    /**
     * In a deterministic session, calls `apply` at once with the seed and the fixed step,
     * and returns them. Otherwise returns null and calls nothing.
     */
    deterministic (apply?: (facts: { seed: number; fixedDt: number }) => void): { seed: number; fixedDt: number } | null;
};

export const checkpoint: {
    /** `save()` returns the game's state as plain data; `restore(state)` puts it back. */
    provide (pair: { save (): unknown; restore (state: any): void }): void;
};

export const state: {
    /** `from()` returns a small plain object describing the game. Keep it under about 1 KB. */
    provide (from: () => unknown): void;

    /** Names and units for the fields of the state. */
    describe (schema: Record<string, unknown>): void;
};

export interface View
{
    id: string;
    label?: string;
    description?: string;
    set (on: boolean): void;
}

export const views: {
    /** A debug view the engine can draw itself: normals, collision shapes, a shadow cascade overlay. */
    register (view: View): void;
};

export interface Control
{
    id: string;
    label?: string;
    type: 'number' | 'boolean' | 'enum' | 'color' | 'vector';
    min?: number;
    max?: number;
    options?: unknown[];
    get (): unknown;
    set (value: any): void;
}

export const controls: {
    /** A number, switch or choice the debugger may read and set: exposure, a bias, a quality level. */
    register (control: Control): void;
};

export const uniforms: {
    /** Says which uniforms of a program or pipeline are safe and meaningful to override. */
    expose (program: object, names?: string[] | Record<string, { min?: number; max?: number }>): void;
};

export interface PassDescription
{
    name: string;
    purpose?: string;
    targets?: string | string[];
}

export const passes: {
    /** The frame's passes in order, in plain words. */
    describe (list: PassDescription[]): void;
};

export interface WatchRule
{
    /** finite: not NaN or ±∞. defined: not undefined or null. range: within min and max. type: of this typeof. changes: differs from the frame before. steady: does not. */
    rule: 'finite' | 'defined' | 'range' | 'type' | 'changes' | 'steady';
    /** The property it applies to. Default: every property. */
    prop?: string;
    min?: number;
    max?: number;
    type?: string;
    /** Stop the game on the frame this rule breaks. */
    break?: boolean;
}

export interface WatchOptions
{
    /** Dotted paths to read, such as 'body.velocity.x'. Default: every own number, boolean and string. */
    props?: string[];
    /** How far into nested objects, 1 to 3. Default 1. */
    depth?: number;
    /** Default: numbers stay finite. */
    rules?: Array<WatchRule | WatchRule['rule']>;
    /** Every rule stops the game on the frame it breaks. */
    break?: boolean;
}

/** Scanline reads the object's properties as each frame ends, checks them against rules and keeps the last 600 frames. A name used again replaces the object and keeps its history. */
export const watch: {
    (name: string, object: object, options?: WatchOptions): void;
    /** A 2D sprite: x, y, rotation, scale, alpha, visible, its frame and velocity, as it has them. */
    sprite (name: string, sprite: object, options?: WatchOptions): void;
    /** A 3D object: position, rotation, scale, visible. */
    object3d (name: string, object: object, options?: WatchOptions): void;
};

export function unwatch (name: string): void;

declare const all: {
    active: typeof active; version: typeof version; label: typeof label; group: typeof group; push: typeof push; pop: typeof pop;
    entity: typeof entity; mark: typeof mark; frame: typeof frame; time: typeof time; checkpoint: typeof checkpoint;
    state: typeof state; views: typeof views; controls: typeof controls; uniforms: typeof uniforms; passes: typeof passes;
    watch: typeof watch; unwatch: typeof unwatch;
};

export default all;
