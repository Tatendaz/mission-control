# Session: merge-when-clean template v6

**Branch:** security/merge-when-clean-v5
**Date:** 2026-10-25

## Prompts
1. "templates/merge-when-clean.yml is now v5. Repos already merged with v4: a
   follow-up PR now, since v4 never merges anything."

## Steps taken
- Checked the template hash (`af7e7bd9…`) and the new `set +e` line; copied it unchanged.
- `actionlint` and `zizmor`: clean. `node --test test/*.test.js`: pass.
