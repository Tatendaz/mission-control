# Feature: merge-when-clean template v5

**Branch:** security/merge-when-clean-v5
**Date:** 2026-10-25

## Summary
Replaces the v4 copy of `merge-when-clean.yml` (from #10) with the owner's
template v5.

## Motivation
GitHub runs `shell: bash` steps as `bash -e -o pipefail`. In v4, a
`grep ...; rc=$?` line exits the whole job when grep finds no match (exit 1),
so v4 crashed on every PR that was not held and merged nothing. v5 adds
`set +e` after `set -uo pipefail`.

## What changed
- `.github/workflows/merge-when-clean.yml`: template v5 (sha256 `1c493dd7…`), unchanged.
