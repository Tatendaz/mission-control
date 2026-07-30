# Feature: CI smoke checks

**Branch:** ci/smoke-checks
**Date:** 2026-07-30

## Summary
A minimal GitHub Actions workflow that keeps the smoke paths healthy: the
three engine scripts must parse, and a dry sweep against the example config
and template must find every marker region.

## Motivation
The sweeper rewrites `board.html` in place between markers; a template or
engine change that breaks a marker pair would corrupt every new install's
board on first sweep. The dry run catches that class of bug before merge,
with no repos, `gh`, or session logs available in CI.

## What changed
- `.github/workflows/ci.yml`: `node --check` on `sweep.js` / `server.js` /
  `scribe.js`, then `node sweep.js --dry` against `config.example.json` and
  `board.template.html`.

## Notes
The dry run exercises the degraded paths on purpose (no git roots, no `gh`,
no Claude session dir) — the sweeper must tolerate all of them silently.
