# Feature: Dependabot cooldown, zizmor CI job, least-privilege auto-merge

**Branch:** security/hardening-2026-10-25
**Date:** 2026-10-25

## Summary
Adds a Dependabot config for workflow actions with a 7-day cooldown, a
`zizmor` workflow that fails on high-severity findings, and the owner's
merge-when-clean job. The auto-merge
workflow now grants write access only to its job.

## Motivation
Phase 2 of the 2026-10-25 security sweep. The action SHAs pinned in #9
need a bot to keep them current, but new releases are where 2026's
supply-chain worms landed, so updates wait 7 days. zizmor in CI stops a
future workflow change from reintroducing the problems the sweep fixed.

## What changed
- `.github/dependabot.yml` (new): `github-actions`, monthly, `cooldown.default-days: 7`,
  `open-pull-requests-limit: 3`, one group for minor + patch.
- `.github/workflows/zizmor.yml` (new): `zizmorcore/zizmor-action` v0.7.1 (SHA-pinned),
  zizmor 1.31.1, `min-severity: high`, no SARIF upload.
- `.github/workflows/merge-when-clean.yml` (new, owner's template, unchanged):
  merges Dependabot PRs and the owner's `security/*` or `automerge` PRs once CI
  is green, a real review ran and 0 threads are open.
- `dependabot-auto-merge.yml`: deleted. It merged Dependabot patch/minor PRs
  on green CI with no review, which bypassed merge-when-clean's review gate.
  merge-when-clean.yml now merges Dependabot PRs after CI and a real review.

## Notes
No package manager here (Node standard library only), so no package-manager cooldown applies.
Security updates ignore the Dependabot cooldown by design.
