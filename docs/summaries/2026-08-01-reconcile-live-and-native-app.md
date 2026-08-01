# Session: Dead board buttons, drift reconciliation, native Dock app

**Branch:** main
**Date:** 2026-08-01

## Prompts
1. "when I click the docker icon I dont see an active app dot below the icon
   in the dock. same thing for herdr plugin" — corrected mid-investigation to
   "when I click the mission control icon I dont see an active app dot below
   the icon in the dock" ("not docker").
2. "for mission control when I click the ram or terminal button nothing
   happens please fix make sure all buttons work and do as intended"
3. "say the word and I'll set that up, do it. reconcile and push and make sure
   I have the latest version installed"

## Steps taken
- Diagnosed the missing Dock dot: both Mission Control.app and Herdr.app were
  `LSUIElement` shell-script launchers — agent apps never get the indicator.
- Reproduced the 🐏 failure live: herdr returns `agent_pane_busy` instantly on
  a fresh pane's shell; the server's wrapper dropped stderr and reported
  "timeout"; failures were unlogged. Fixed with stderr parsing, retry with
  backoff, `root_pane` pane-id extraction, and failure logging.
- Fixed ❯ copy emitting `cd '~/…'` (unexpandable tilde): sweep now emits
  `absPath`, the button copies the quoted absolute path.
- Audited every other board control (sweep, theme, tabs, filters, sort,
  search, pin, trash/undo/restore) in the running browser — all working.
- Reconciled repo ↔ live deployment: live `server.js`/`sweep.js`/`scribe.js`/
  `make-icon.py` were strictly newer and became canonical; the board template
  adopted the live code while keeping demo data and generic footer.
- Added `/manifest.webmanifest` + `/icon.png` (installable PWA), then replaced
  the script launcher with a Swift/WKWebView app (`app/main.swift`) so the
  Dock tile shows the running dot; installed it to /Applications and verified
  `type="Foreground"`, single-instance reopen, and window title.
- Added `test/smoke.sh` (sandboxed server boot + endpoint checks) as the
  repo's first test, wrote these docs, and pushed through the pre-push gate.

## Decisions
- Kept the live instance running from ~/Projects/ideas/radar (launchd) rather
  than migrating the runtime into the repo — reconciled code instead.
- Chrome's "Install page as app" UI automation was blocked by macOS
  permissions after three approaches; chose a native WKWebView app instead,
  which is scriptable, verifiable, and keeps the same Dock tile path. The
  manifest stays, so the Chrome install remains a one-click manual option.
- Test style: a zero-dependency shell smoke test to match the project's
  zero-dependency philosophy, rather than introducing a test framework.
