// Spike S4: does input injected through the protocol behave like real input?
// (06-BUILD-PLAN.md, section 3.)

import { open, sleep } from './lib/session.mjs';
import { serve } from './lib/serve.mjs';

setTimeout(() => { console.error('S4 timed out'); process.exit(3); }, 60000).unref();

const headless = !process.argv.includes('--headed');
const server = await serve();

// Start with autoplay locked, as a normal browser has it, so user activation can be seen to matter.
const session = await open({ url: server.url('fixtures/spikes/s4.html'), headless, args: ['--autoplay-policy=document-user-activation-required'] });
const { page } = session;

session.browser.replyTimeoutMs = 4000;

const take = async () => JSON.parse(await session.evaluate('JSON.stringify(window.s4.splice(0))'));
const state = async () => JSON.parse(await session.evaluate('JSON.stringify(window.s4state())'));
const mouse = (type, x, y, extra = {}) => page.send('Input.dispatchMouseEvent', { type, x, y, button: 'none', ...extra }).catch((error) =>
{
    throw new Error(`${type} at ${x},${y} ${JSON.stringify(extra)}: ${error.message}`);
});
const click = async (x, y) =>
{
    await mouse('mousePressed', x, y, { button: 'left', buttons: 1, clickCount: 1 });
    await mouse('mouseReleased', x, y, { button: 'left', buttons: 0, clickCount: 1 });
};
// No nativeVirtualKeyCode. Sending one (with the Windows code as its value) left the next
// mouse event unacknowledged on macOS, Chrome 157, whenever the key event carried no text.
const key = (type, k, code, vk, extra = {}) => page.send('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: vk, ...extra });

const results = {}; const mark = (label) => process.env.SCANLINE_DEBUG && console.error("[s4]", label);

mark('1.');
// 1. Keyboard.
results.before = await state();

await key('rawKeyDown', 'ArrowRight', 'ArrowRight', 39);
await key('rawKeyDown', 'ArrowRight', 'ArrowRight', 39, { autoRepeat: true });
await key('keyUp', 'ArrowRight', 'ArrowRight', 39);
await key('keyDown', 'a', 'KeyA', 65, { text: 'a' });
await key('keyUp', 'a', 'KeyA', 65);

results.keys = await take();

mark('2.');
// 2. Mouse movement: are movementX and movementY derived from successive positions?
await mouse('mouseMoved', 100, 100);
await mouse('mouseMoved', 130, 110);
await mouse('mouseMoved', 125, 150);

results.moves = (await take()).filter((event) => event.type === 'mousemove');

mark('3.');
// 3. Wheel and touch.
await mouse('mouseWheel', 120, 120, { deltaX: 0, deltaY: 120 });

await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 50, y: 60, id: 1 }, { x: 150, y: 160, id: 2 }] });
await page.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 55, y: 65, id: 1 }, { x: 140, y: 150, id: 2 }] });
await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

results.wheelAndTouch = (await take()).filter((event) => event.type === 'wheel' || event.type.startsWith('touch'));

mark('4.');
// 4. User activation: audio, pointer lock, fullscreen, each from an injected click.
const gesture = async (want) =>
{
    await session.evaluate(`window.s4want = ${JSON.stringify(want)}; window.s4result = null;`);
    await click(200, 150);
    await sleep(400);

    return { result: await session.evaluate('window.s4result'), state: await state() };
};

results.audio = await gesture('audio');
results.lock = await gesture('lock');

await take();

mark('5.');
// 5. Movement under pointer lock: positions stop meaning anything; are deltas still delivered?
await mouse('mouseMoved', 210, 150);
await mouse('mouseMoved', 260, 150);
await mouse('mouseMoved', 260, 190);
await mouse('mouseMoved', 300, 190, { movementX: 7, movementY: -3 }).catch((error) => { results.lockedExplicitDeltaError = error.message; });

results.lockedMoves = (await take()).filter((event) => event.type === 'mousemove');

await session.evaluate('document.exitPointerLock()');
await sleep(200);

mark('fullscreen');
results.fullscreen = await gesture('fullscreen');

await session.evaluate('document.fullscreenElement && document.exitFullscreen()').catch(() => undefined);
await sleep(300);
await take();

mark('6.');
// 6. Input.setIgnoreInputEvents(true): are injected events dropped too?
await page.send('Input.setIgnoreInputEvents', { ignore: true });
await key('rawKeyDown', 'b', 'KeyB', 66);
await key('keyUp', 'b', 'KeyB', 66);
await mouse('mouseMoved', 20, 20);
await sleep(200);

results.whileIgnoring = await take();

await page.send('Input.setIgnoreInputEvents', { ignore: false });
await key('rawKeyDown', 'c', 'KeyC', 67);
await key('keyUp', 'c', 'KeyC', 67);
await sleep(100);

results.afterIgnoring = await take();

mark('7.');
// 7. The probe's recorder saw the same events.
const recorded = await session.probe('input.log', {});

results.recorder = { rows: recorded.rows.length, types: [...new Set(recorded.rows.map((row) => row[2]))] };

console.log(JSON.stringify(results, null, 1).replace(/\n\s+(?=[^\n]*[\]}],?\n)/g, ' '));

const all = [...results.keys, ...results.moves, ...results.wheelAndTouch, ...results.lockedMoves];

console.log('\nSummary');
console.log('  every injected event trusted:', all.every((event) => event.trusted));
console.log('  keydown is user activation:', results.keys.find((event) => event.type === 'keydown')?.active);
console.log('  audio resumed by injected click:', results.before.audio, '->', results.audio.state.audio);
console.log('  pointer lock from injected click:', results.lock.result, results.lock.state.locked);
console.log('  fullscreen from injected click:', results.fullscreen.result, results.fullscreen.state.fullscreen);
console.log('  deltas without lock:', results.moves.map((event) => [event.dx, event.dy]).join(' | '));
console.log('  deltas under lock:', results.lockedMoves.map((event) => [event.dx, event.dy]).join(' | '));
console.log('  events delivered while ignoring:', results.whileIgnoring.length, '; after:', results.afterIgnoring.length);

await session.close();
await server.close();
