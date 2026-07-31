# Feature: Reliable herdr launches, a real Dock app, and one canonical codebase

**Branch:** main
**Date:** 2026-08-01

## Summary
Fixes the two dead board buttons (🐏 launch and ❯ copy), reconciles the repo
with the live deployment so both run identical code, and replaces the
fire-and-exit Dock launcher with a real resident app that shows macOS's
running-indicator dot.

## Motivation
Clicking 🐏 looked like nothing happened: herdr rejects `agent start` on a
freshly created pane (`agent_pane_busy`, returned instantly), the server
swallowed herdr's stderr into a fake "timeout", and failures were never
logged. The ❯ button copied `cd '~/…' && claude`, and a tilde inside single
quotes never expands. Separately, the repo and the live instance had drifted
in both directions, and the old Dock "app" was an `LSUIElement` shell script
that exits immediately — macOS never shows a Dock dot for it.

## What changed
- `server.js`: parse herdr's stderr error JSON; retry `agent start` with
  backoff while a fresh pane's shell boots; read the pane id from
  `tab create`'s `root_pane`; log every launch failure; serve
  `/manifest.webmanifest` and `/icon.png` so the board is an installable PWA.
- `sweep.js`: emit `absPath` per project; board copy commands use it
  (quoted), keeping the tilde path for display only.
- `board.template.html`: reconciled with the live board's hardening (escaping,
  clipboard fallback, corrupt-localStorage guards, safe URLs) while keeping
  the template's demo data; adds the manifest link.
- `scribe.js` / `make-icon.py`: adopted the live copies (write locking, atomic
  renames, input validation).
- `app/`: `main.swift` + rebuilt `build-app.sh` — Mission Control.app is now a
  Swift/WKWebView app: Dock dot while running, single-instance reopen,
  external links open in the default browser, and it kickstarts the launchd
  service if the board is unreachable.
- `test/smoke.sh`: first test in the repo — boots the server in a sandbox and
  checks board/health/manifest/icon/launch/guard responses.

## Notes
- The Dock app requires Xcode's `swiftc` to build; the launchd service still
  owns keeping the server alive.
- The PWA manifest also allows Chrome's File → Install for a Chrome-rendered
  app window, as an alternative to the native app.
