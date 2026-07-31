# Feature: engine hardening

**Branch:** ci/smoke-checks
**Date:** 2026-07-31

## Summary
A full adversarial review of the engine (sweeper, server, scribe, board
front-end, packaging) and the fixes for everything it confirmed. The headline
items: the board could be corrupted or turned into an XSS vector by ordinary
git metadata, and the local server could be crashed or driven by any web page
the user happened to visit.

## Motivation
Every string the sweeper collects — commit subjects, branch names, PR and issue
titles, session prompts — is attacker-influenced in the ordinary case (a
dependency PR, a shared repo, a pasted prompt). Those strings were reaching an
inline `<script>` payload and `innerHTML` unescaped. Separately, the server
exposes `/api/launch`, which starts an agent with tool access, so its exposure
to cross-site requests matters more than a typical localhost tool's.

## What changed

**Server (`server.js`)**
- A request for `//` threw inside an async handler before the try/catch and
  terminated the process (unhandled rejection). URL parsing is now guarded and
  returns 400; process-level handlers log instead of dying silently.
- Added a same-site gate on `/api/*`: loopback `Host` (defeats DNS rebinding,
  applied to every route), plus `Sec-Fetch-Site` and `Origin` checks so a
  hostile page cannot POST `/api/launch` or `/api/sweep`, or burst `/api/live`.
  Non-browser clients (curl, the standup skill) are unaffected, and loading the
  board itself is deliberately exempt from the site check so links, bookmarks
  and the Dock app still work.
- All subprocess calls are async; `ensureHerdr` could previously block the event
  loop for up to ~80 seconds, stalling every other request and the schedulers.
- `liveAgents()` is single-flight and the board read is async; the status
  watcher re-arms on error instead of throwing; oversize bodies get a 413.

**Sweeper (`sweep.js`)**
- Data embedded in the inline script is escaped: a commit subject containing a
  closing script tag used to end the element and blank the board, and one
  containing a sweep marker corrupted the file on the *next* run. `region()`
  now searches after the start marker and refuses to write a body carrying a
  marker.
- Hazard titles are escaped (they carry branch names).
- `for-each-ref` records are split on `\x01`: a branch name containing `|`
  shifted every later field, which made unpushed work look clean.
- `sessionsDir` is tilde-expanded — with the shipped example config, session
  freshness silently did nothing.
- Sessions map by the transcript's own recorded cwd, so `~/code/acme-app` work
  no longer counts toward a project at `~/code/acme`.
- PRs key on `owner/repo`, so someone else's `cli` PR stops landing on your
  `cli` card; `ghRepo` accepts either shape; duplicate rows are de-duped.
- `--json` no longer writes the cache; neither read-only mode touches disk.
- stdout is flushed instead of truncated at the pipe buffer by `process.exit`.
- Nested-clone exclusion actually works; credential-bearing remote URLs
  normalize to the same key as clean ones; the newest unpushed branch is named,
  not the alphabetically first; backups are second-precision.
- Binaries fall back to `PATH` when the configured path is missing (Intel vs
  Apple Silicon Homebrew), with a warning.

**Board front-end (`board.template.html`)**
- `esc()` escapes quotes and angle brackets and tolerates missing fields; every
  interpolation of swept data now goes through it, including the card details
  body and the recency tooltip (which decoded its own escaping via `innerHTML`
  and is now built with `textContent`).
- Inbox links are scheme-checked.
- Corrupt `localStorage` degrades one feature instead of killing the board: pins,
  tombstones, sort mode and the seen-snapshot are all shape-validated.
- Search from any view lands on the Board tab (it previously did nothing while
  Trash was active); no-match empty state covers the Inbox tab; Esc clears the
  search from anywhere.
- Card hue is keyed on project id, so adding a project no longer repaints the
  rest of the board.
- Clipboard failures (insecure origin, denied permission) surface a message
  instead of throwing; a failed sweep reports instead of hanging the button;
  a background auto-reload is skipped when a search, toast or armed button is
  in flight.

**Scribe (`scribe.js`)**
- Satellite roots are tilde-expanded and paths are realpath-normalized, so
  worktree/satellite sessions are recorded and trailing slashes stop mattering.
- Status writes are atomic (temp + rename) — the server watches that directory
  and could read a half-written file.
- Ids are sanitized before use as filenames; a corrupt status file is preserved
  as `.bad` instead of silently discarding session history; malformed transcript
  blocks are skipped instead of dropping the session.

**Packaging / CI**
- CI also parses the board template's inline script and the two macOS scripts.
- `build-app.sh` fails loudly without node, falls back to PATH at runtime, and
  handles a config without a port.
- `make-icon.py` reports missing Pillow, bad usage, tiny images and blank
  renders instead of raising internal errors.

## Notes
Verified with a hostile fixture repo whose branch name and commit subject carry
a closing script tag, a sweep marker and an `onerror` payload: the board still
parses after four consecutive sweeps, the payload round-trips as literal text,
and a headless DOM check confirms no element is injected. The server fixes were
tested against the actual request shapes (`GET //`, cross-site POST, rebinding
Host) with the board and curl still working.
