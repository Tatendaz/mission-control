# Feature: Stop cards narrating an old world

**Branch:** fix/stale-card-sources
**Date:** 2026-08-04

## Summary
Three staleness fixes for the sweep engine. Cards (and the Hazards/Overview
tabs fed by the same scan) kept repeating finished work and phantom warnings
whenever reality moved on GitHub instead of in the local checkout.

## Motivation
Work increasingly lands remotely — PRs merged from the web, cloud agents,
other machines — while the sweeper reads local ground truth. Observed on the
live board: a card telling the user to merge a PR that merged five days
earlier, an "unpushed branch" warning for a branch whose PR had merged and
whose remote side was deleted, and last-commit dates behind origin on seven of
twelve repos. A board that repeats done work teaches its owner to ignore it.

## What changed
- **Merged local branches are no longer "unpushed".** `scanRepo` now keeps a
  no-upstream branch in `localOnly` only while its tip holds commits absent
  from every remote ref (`git rev-list --max-count=1 <branch> --not
  --remotes`, capped at 16 containment checks per repo). Leftover branches
  from merged PRs stop flagging the card, stop inflating the un-rescued
  figure, stop mis-naming hazards, and stop breaking the all-clear ring.
- **Next steps that reference finished PRs/issues are pruned.** Steps naming
  `PR #N` / `PRs #6 and #7` / `issue #N` (own repo, or another registry
  project mentioned in the step) are checked against the open-PR list, then a
  budgeted `gh` lookup (≤8 per sweep, 2-failure circuit breaker). Answers
  persist in `.prstate.json`: MERGED forever (it never un-happens), CLOSED
  for 7 days before revalidation (issues and PRs reopen), so steady state
  costs zero calls. Steps are dropped only on positive evidence that every
  referenced item is merged/closed; unknown — including a step that names
  two different repos — keeps the step.
- **A card whose checkout is behind GitHub says so.** One extra viewer-wide
  GraphQL call fetches each repo's default-branch head; when that commit is
  absent locally (never fetched) or absent from the local branch of the same
  name (fetched, not merged), the card gets a neutral `behind origin/<branch>
  — pull to refresh` flag. Neutral by design: nothing is at risk, the view is
  just stale. Cached in `.cache.json` for offline sweeps.
- `sweep.js` is now requirable (config load is lazy, `main()` runs only under
  `require.main`) and exports its pure helpers for `test/engine.test.js`.
- CI runs the new unit tests and asserts `--dry` also writes no
  `.prstate.json`.

## Notes
- The containment filter judges against remote refs on disk, so it is only as
  fresh as the last fetch; the behind-origin flag covers the never-fetched
  case. The two fixes are deliberately paired.
- Pruning drops a whole step when all its refs are terminal — a compound step
  ("Land PRs #6 and #7, then tag v1.1.1") disappears with its tail. Accepted:
  the win system already celebrates the merge, and a stale imperative is worse
  than a lost reminder.
- `--dry` / `--json` stay fully read-only: no state lookups, no cache writes.
