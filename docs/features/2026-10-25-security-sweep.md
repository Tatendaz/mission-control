# Feature: Pin CI actions to commit SHAs

**Branch:** security/sweep-2026-10-25
**Date:** 2026-10-25

## Summary
`ci.yml` now pins `actions/checkout` and `actions/setup-node` to full commit
SHAs instead of the moving `v4` tags.

## Motivation
A tag can be moved to new code at any time; a SHA cannot. Supply-chain worms
in 2026 spread by retagging actions and packages, and `zizmor` rated both
references high. The rest of the 2026-10-25 security sweep found nothing to
fix here: `server.js` already checks the Host header, rejects cross-site
requests, and calls every subprocess without a shell; `scribe.js` sanitises
the status file name; the board escapes every value before `innerHTML`.

## What changed
- `actions/checkout@v4` -> `@34e1148... # v4.3.1`
- `actions/setup-node@v4` -> `@49933ea... # v4.4.0`

## Notes
No behaviour change. The pinned versions are the same majors the tags pointed at.
