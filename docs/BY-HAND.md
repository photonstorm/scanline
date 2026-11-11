# What has not been tried by hand

Scanline is built and tested with no window on screen. These are the things only a person at the machine can confirm. Each says what to do and what should happen. Tick them off, or note what went wrong, and the list shrinks.

Set-up, from the repository:

```bash
export PATH="$PWD/target/debug:$PATH"
```

```bash
node evals/serve.mjs 8765
```

## The control strip (milestone 4)

```bash
scanline launch http://127.0.0.1:8765/fixtures/bugs/b13.html
```

```bash
scanline request_human "Watch the glass panel, then press Debug"
```

- [ ] A small dark window appears directly under the game's window, about as wide as it, with no tabs. It reads "You are driving", the instruction, a red REC light and a frame number that counts up.
- [ ] The game's window still has the keyboard: F9 freezes the picture without clicking on the game first.
- [ ] The strip's Debug button does the same as F9. Pause stops the picture and turns into Resume; Step moves one frame while paused.
- [ ] After a press the strip reads "Nobody is driving" and "Frozen at frame N. The agent has this frame and the M before it."
- [ ] Does it matter that the strip stays where it was when the game's window is moved?

## Keeping your input out (milestone 4)

```bash
scanline launch http://127.0.0.1:8765/fixtures/matrix/game.html --strip
```

- [ ] The arrow keys move the green square and a click throws sparks.

```bash
scanline take_control
```

```bash
scanline resume
```

- [ ] The strip reads "The agent is driving". The arrow keys and clicks now do nothing in the game. F9 still freezes it.

```bash
scanline take_control --release
```

- [ ] The keys and clicks work again.

## Confirmed

- 11 November 2026: a real F9 press froze `b13.html`, 128 frames were kept, and `recording` named the four frames that flicker. (No strip existed then.)

## Not possible on this machine

- Windows: nothing has been run there, and the browser launch for Windows is not written.
- Pointer lock and fullscreen: `node spikes/s4-input.mjs --headed` checks them and has not been run.
