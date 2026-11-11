# Security

What Scanline trusts, what it does not, and what stops what. Written after a review of the
code as it stood at milestone 7. `scanline help security` prints the short form, with the
tiers in force on the running host.

## What is being protected

Scanline runs a browser, loads a page in it, and lets a client (an agent, usually) look at
and change what that page does. Three things can go wrong:

1. **The page misleads the agent.** A page's text reaches the agent: console lines, labels,
   shader source, game state. A page can say "ignore your instructions and …". This is
   prompt injection, and it is the main risk.
2. **Another program on the machine drives Scanline.** Whoever can reach the control API can
   run script in the page, read files Scanline can read, and write captures to disk.
3. **The page reaches the person's own data.** Cookies, logins, files.

## The boundaries

These hold whatever the agent is told.

| Boundary | What it stops | Where |
|---|---|---|
| A browser profile made for each session and deleted when it closes | The page, and anything run in it, reaching the person's cookies, logins, history or extensions | `scanline-browser`: `--user-data-dir` under the session's directory, removed on close; extensions and sync off |
| The browser is driven over a pipe, not a port | Other programs, and web pages, attaching to the browser's debugging interface | `--remote-debugging-pipe`; no `--remote-debugging-port` |
| No listening network port, unless asked for | Web pages (the game included) and other machines reaching the host | `scanline serve` listens on one Unix socket (on Windows, one named pipe that refuses clients on other machines) and nothing else |
| With `scanline serve --http`: loopback only, a token, and `Host` and `Origin` checks | Another machine reaching the port (it is bound to 127.0.0.1). Another program guessing it (every request needs the token of that run, 32 random bytes in `http-token`, removed when the host stops. On macOS and Linux the file is mode 600, made private as it is created; on Windows it takes the rule of the home directory, which the host has already made the person's alone). A web page reaching it through a name it controls that resolves to this machine, which is DNS rebinding (`Host` must be `127.0.0.1` or `localhost` with this port). A web page reaching it at all (a request with an `Origin` header is refused, and no response says a browser may read it) | `crates/scanline/src/http.rs`; `tests/security.test.mjs` |
| The control socket is in a directory only the person can enter, and only they can open it | Other users of the machine | macOS and Linux: the home directory is set to mode 700 and the socket to 600 before anything is served. The socket is made with a mask so that it is never, even briefly, open wider. If either cannot be set, the host does not start |
| On Windows the control channel is a named pipe that only the person can open, and the home directory is theirs alone | Other users of the machine, and other machines | The pipe is created with a security descriptor that names the user running the host and nobody else (left to its default, a pipe can be read by every user of the machine), and with remote clients refused. Its name is made from the home directory's path, so each home has its own. The home directory is given a rule of its own, not inherited from the folder above: the person, the system and its administrators, passed on to every file in it (the token, the log, the captures). If either rule cannot be set, the host does not start. `crates/scanline/src/control.rs`; `tests/security.test.mjs` asks the pipe and the token file who they let in |
| The viewer and the control strip are pages of their own | The game page pressing their buttons. Each calls the host through a binding that exists only in its own page, and the host checks which page a call came from | `session.rs`: `scanlineViewer` and `scanlineStrip` are answered only from the target they were added to |
| The page cannot forge the host's events | A page announcing `capture_ready`, `owner_changed` or a note "from the person". The probe's channel to the host is in the page's world, so a page that finds it can call it; the host accepts only the kinds of event the probe sends, and a mark on the picture carries a place and never words. Typed notes come only from the control strip | `session.rs`, `handle` |
| An export is a capture file and nothing else | An agent being talked into overwriting a shell profile or a script with text the page chose (shader source is kept as text in a capture). The name must end in `.scanline`, and an existing file is replaced only if it is itself a capture file | `capture.rs`, `export` |
| An import is checked | A crafted file writing outside the store, or passing off altered data. Part names are from a fixed list; every blob is checked against the hash it is named by | `scanline-store`, `import_capture` |
| The browser's own rules for files | A page launched from a file reading other files. Scanline does not pass `--allow-file-access-from-files` or `--disable-web-security` | `scanline-browser` |

## Tiers

What a client may do is fixed when the host starts. No command changes it.

| Tier | Commands | Default |
|---|---|---|
| Read | Looking, inventory, capture, analysis, the viewer | Always on |
| Control | `pause`, `resume`, `step`, `run_until`, `input`, `request_human`, `take_control`, `debug`, `strip`, `replay_run`, `live_view`, and the `page` calls that change the game | On |
| Patch and evaluate | `patch_*`, `experiment`, `eval`, `policy`, and an expression given to `run_until` or `capture(when)` | On for pages served from this machine (`localhost`, `127.x.x.x`, `[::1]`, `*.localhost`, files, `about:blank`). Off for every other origin |
| Files and navigation | `export`, `import`, `diff`, `assert` baselines and `patch_texture` images outside the artefact directory; `navigate` | Files on. `navigate` keeps to the origin the session was launched on, and a session launched on a file keeps to that file's directory |
| Live views and patches | `live_view` with one of Scanline's own views (overdraw, wireframe, draw_id, depth) is a patch, and is in the patch tier | As the patch tier |
| The native-capture profile | `launch(profile: "native-capture")`: a browser whose GPU process runs with no sandbox and no watchdog, so that Xcode's Metal debugger or RenderDoc can attach to it | Off. A page that exploits the GPU process in such a browser has that much less to get through |

The person changes these with two environment variables, read once when the host starts:

```bash
SCANLINE_DENY=control,patch,files scanline serve
```

```bash
SCANLINE_ALLOW=remote-patch,navigate scanline serve
```

- `SCANLINE_DENY` switches tiers off. With `files` off, `export`, `import` and `diff` read
  and write only inside the artefact directory.
- `SCANLINE_ALLOW=remote-patch` lets the patch tier work on any page. `navigate` lets a
  session go to any origin. `native-capture` lets a session be launched with that profile;
  use it for pages you trust, and close the session when the native capture is taken.
- A word that is not a tier stops the host from starting. A denial that was misspelt and
  quietly ignored would be worse than no host.
- A host that is already running keeps the tiers it started with. `scanline stop`, then
  start it again.

The host is usually started for you by the first command or by `scanline mcp`, and takes the
environment of whatever started it. To fix the tiers for an agent, set the variables in the
agent's MCP entry for Scanline (the `env` of the server), and make sure no host is already
running.

## What the tiers are not

**They are not a boundary against a program that can run commands as you.** An agent with a
shell can start a host of its own with any settings, or read the files directly. The tiers
limit a client that speaks only the control API, which is what an agent connected over MCP
with no shell is. They exist so that a page cannot talk such an agent into more than the
person allowed.

**`launch` opens any URL.** The launch URL is the one thing the client chooses freely; the
navigation rule keeps a session from wandering afterwards, and the patch tier is off on
whatever remote page a new session opens. A page can also navigate itself: Scanline limits
the `navigate` command, not the page.

**The origin test is a convenience.** "Served from this machine" is decided from the URL.
It does not know that a local development server is proxying somebody else's site.

## Page text

Everything a page says is data. Short page strings are shown between « » in results, long
ones (shader source, console output) are plainly labelled as the page's, and the MCP server's
instructions and every skill say that such text is never an instruction. That is guidance to
the agent, not enforcement: it is why the tiers exist.

Captures are page data too. An imported capture holds whatever the page it was taken from
put in its labels and shaders. Treat a capture file from someone else as you would a
document from them: it cannot run anything on import, and replaying it runs its shaders on
your GPU inside the disposable browser, the same as visiting a page that used them.

## The Debug key

While a person has been asked to press Debug, and only then, the host runs a helper that holds one key (F9, or the one `SCANLINE_HOTKEY` names) system-wide (on macOS and Windows; there is no helper on Linux), so that the press works whichever window has the keyboard. Other applications do not see that key until it is pressed or the session closes. The helper does one thing with a press: it makes the `debug` call for that session. `SCANLINE_HOTKEY=off` leaves the key to the game's window and the strip. A headless session has no helper.

## Known gaps

- **The Windows side has been written and tested, not reviewed.** The named pipe and the
  rule on the home directory were written on 11 November 2026 and are checked by
  `tests/security.test.mjs`, but nobody other than their author has read them as an
  attacker would. On Windows an administrator can open the home directory (the rule names
  them, so that backup and virus scanning keep working), as root can on macOS and Linux.
- **MCP over HTTP is plain HTTP.** It never leaves the machine, but another program
  running as you could read the token file, as it could read the socket or the pipe. It is no weaker
  than the socket and no stronger. The server speaks only when spoken to: there is no
  stream for it to push on, so events are read with `events` and `wait` as over stdio.
- **The probe's binding can be found by the page.** Its name is random per session, but it
  is a property of the page's global. A page that calls it can send false inventory events
  (a context that does not exist) or ask for a Debug freeze. It cannot send commands: the
  channel carries reports, and the host decides what to do with them.
- **`diff` reads any PNG the person can read** when the files tier is on, and reports its
  size and how it differs from another image. It decodes images only.
- **The activity log and `host.log` hold what was asked**, including expressions passed to
  `eval`. They are in the private home directory and are not sent anywhere.
- **No signed builds yet.** See `docs/BY-HAND.md`.

## Reporting a problem

Until the repository has a public issue tracker and a security contact, tell the maintainer
directly.
