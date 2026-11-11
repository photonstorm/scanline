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

## Marking the frozen frame (milestone 4)

```bash
scanline launch http://127.0.0.1:8765/fixtures/bugs/b13.html
```

```bash
scanline request_human "Press Debug, then point at the glass"
```

Press F9 with the game focused, then:

- [ ] The strip reads "Frozen at frame N … Click the picture to point at something, drag to mark a box, or type a note", and has a text field with a Send button.
- [ ] A click on the frozen game leaves a small orange ring where you clicked. A drag leaves an orange box.
- [ ] Typing in the strip's field and pressing Enter (or Send) clears the field and the strip says the note was sent.

```bash
scanline events
```

- [ ] The list ends with one `annotation` for each: a point (`x`, `y`), a box (`x`, `y`, `w`, `h`) and the note, with coordinates that match where you pointed (canvas pixels from the top-left of the 480×360 picture).

```bash
scanline resume
```

- [ ] The ring or box disappears and the note field goes.

## A real gamepad (milestone 4)

With a gamepad plugged in (press a button on it once so the browser sees it):

```bash
scanline launch http://127.0.0.1:8765/fixtures/matrix/game.html --deterministic
```

- [ ] The left stick moves the green square.

```bash
scanline save_run
```

- [ ] The summary counts "gamepad changes".

```bash
scanline replay_run run_1
```

- [ ] The square ends where it was, and the fingerprints match.

## Pointer lock without the shim (milestone 4)

```bash
scanline launch http://127.0.0.1:8765/fixtures/matrix/mouselook.html
```

- [ ] Click the picture: the cursor disappears and moving the mouse slides the white bar. Escape gives the cursor back.
- [ ] F9 still freezes the page while the pointer is locked.

## Confirmed

- 11 November 2026: a real F9 press froze `b13.html`, 128 frames were kept, and `recording` named the four frames that flicker. (No strip existed then.)

## Not possible on this machine

- Windows: nothing has been run there, and the browser launch for Windows is not written.
- Pointer lock and fullscreen: `node spikes/s4-input.mjs --headed` checks them and has not been run. The pointer-lock shim (`--pointer_lock shim`) is tested; the browser's own lock is not.
- A Debug hotkey that works while another application has the keyboard: nothing registers one with the operating system. F9 works while the game's window or the strip has the keyboard.
