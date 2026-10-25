# Session: Pin CI actions to commit SHAs

**Branch:** security/sweep-2026-10-25
**Date:** 2026-10-25

## Prompts
1. "You are worker sec-w4 in the 2026-10-25 security sweep. Read BRIEF.md
   and follow it exactly."
2. "Pick old, safe versions, never latest."

## Steps taken
- IOC grep, commit-author review, deploy keys, webhooks, secret names,
  branch protection, Dependabot alerts: nothing unexpected.
- gitleaks (one hit: the `TKEY` localStorage key name, a false positive),
  osv-scanner (no package manifests), actionlint, zizmor.
- Security read of server.js, scribe.js, sweep.js, the board template and the
  Swift wrapper: no exploitable finding.
- Pinned the two actions; `node --test test/*.test.js` passes (6/6).

## Decisions
- Left `node-version: 22` as is: setup-node resolves it to the newest 22.x,
  which includes the brotli fix (22.23.4).
