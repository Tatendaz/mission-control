# Session: Dependabot cooldown, zizmor CI job, merge-when-clean

**Branch:** security/hardening-2026-10-25
**Date:** 2026-10-25

## Prompts
1. "After you finish the sweep for all your repos and write your _done file,
   do NOT stop. Read HARDENING.md and do it for each of your repos."
2. "HARDENING.md changed: add the merge-when-clean job; do NOT add
   dependabot[bot] to CodeRabbit ignore lists, remove it if you already did."

## Steps taken
- Confirmed each key in the official schemas before use: Dependabot
  (`cooldown.default-days`, `open-pull-requests-limit`, `groups.update-types`)
  and CodeRabbit (`inheritance`, `reviews.auto_review.ignore_usernames`).
- Checked zizmor-action v0.7.1 inputs and that it exits with zizmor's code.
- Ran `actionlint` and `zizmor` (workflows + dependabot config) locally: clean.

## Decisions
- zizmor-action v0.7.1 and zizmor 1.31.1 (both 2026-10-15), not the newer
  v0.8.0 / 1.32.0rc1, to respect the 7-day cooldown.
- `advanced-security: false`: the job fails on findings instead of uploading SARIF.
- Removed the `.coderabbit.yaml` I first added (its only purpose was the
  Dependabot ignore, which the owner reversed).
