// Private references to the platform functions the probe relies on, taken before any page
// script runs. The page may replace any of these later; the probe keeps working.

export type Fn = (...args: any[]) => any;

export const G: any = globalThis;

export const isWindow: boolean = typeof G.document !== 'undefined' && typeof G.Window !== 'undefined';

const perf: Performance = G.performance;
const perfNow: () => number = G.Performance.prototype.now;

export const NativeDate: DateConstructor = G.Date;
const dateNow = NativeDate.now;

export const nativeNow = (): number => perfNow.call(perf);
export const nativeDateNow = (): number => dateNow();

export const nSetTimeout: Fn = G.setTimeout.bind(G);
export const nClearTimeout: Fn = G.clearTimeout.bind(G);

// requestAnimationFrame is missing in shared and service workers.
const raf: Fn | undefined = G.requestAnimationFrame;
const caf: Fn | undefined = G.cancelAnimationFrame;

export const hasRaf = typeof raf === 'function';
export const nRequestFrame: Fn = hasRaf ? raf!.bind(G) : () => 0;
export const nCancelFrame: Fn = hasRaf ? caf!.bind(G) : () => undefined;

export const nStringify: (value: unknown) => string = G.JSON.stringify.bind(G.JSON);
export const nParse: (text: string) => any = G.JSON.parse.bind(G.JSON);

export const nDefineProperty = G.Object.defineProperty;
export const nGetOwnPropertyDescriptor = G.Object.getOwnPropertyDescriptor;
export const nGetPrototypeOf = G.Object.getPrototypeOf;
export const nGetOwnPropertyNames = G.Object.getOwnPropertyNames;

export const nIndirectEval: (source: string) => unknown = G.eval;
export const NativeFunction: FunctionConstructor = G.Function;

export const nAddEventListener: Fn = G.EventTarget.prototype.addEventListener;
export const nBtoa: (data: string) => string = G.btoa.bind(G);
export const nFromCharCode: (...codes: number[]) => string = G.String.fromCharCode;

// A task with no minimum delay. Nested setTimeout(0) is clamped to 4 ms by the browser,
// which would slow the timer drain; a MessageChannel is not.
const taskQueue: Array<() => void> = [];
const taskChannel: MessageChannel = new G.MessageChannel();

taskChannel.port1.onmessage = () =>
{
    const task = taskQueue.shift();

    if (task)
    {
        task();
    }
};

// The probe's own ports: a page's messages may be held while the clock is frozen, and
// these never are.
export const ownPorts = new G.WeakSet([taskChannel.port1, taskChannel.port2]) as WeakSet<object>;

export function nextTask (task: () => void): void
{
    taskQueue.push(task);
    taskChannel.port2.postMessage(0);
}
