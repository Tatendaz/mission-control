# Session: Stale card sources — why the board stopped updating

**Branch:** fix/stale-card-sources
**Date:** 2026-08-04

## Prompts
1. "I noticed that sometimes items in cards are not updating. for example i
   updated yapui but i see no change. highlighted with red rectangle. but also
   go through other cards and check github and conversations why it didnt
   update and fix it and let me know what was the problem." (with a screenshot
   of the yapui card showing "UNPUSHED BRANCH DOCS/README-SLIM" and next step
   "Merge PR #8")
2. "additionally I also want information in the other tabs to update if its
   not already doing so, info in hazards, overview etc"

## Steps taken
- Diagnosed against the live radar: the sweep HAD run minutes before the
  screenshot; the data sources themselves were stale, not the sweep schedule.
- Found three causes: (1) `localOnly` counted any no-upstream branch as
  unpushed — yapui's `docs/readme-slim` merged via PR #6 and its remote side
  was deleted, leaving a permanent false flag; (2) next steps come from a
  static `config.json` list the scribe never updates — "Merge PR #8" survived
  its own merge by five days; (3) seven of twelve registry repos' local
  default branches were behind origin (work lands via GitHub-side merges),
  and the sweeper only reads local state.
- Fixed all three in `sweep.js` (containment filter, budgeted+cached PR/issue
  state pruning, behind-origin flag from one viewer-wide GraphQL call).
- Made `sweep.js` requirable; added `test/engine.test.js` (git fixtures +
  stubbed lookups) and wired it into CI.
- Validated end to end in a scratchpad sandbox against the real config: yapui
  card healed, ftapp/cusage/pups pruned correctly, QBT hazard renamed to the
  genuinely unpushed branch, un-rescued figure 6 → 5.

## Decisions
- Prune only on positive terminal evidence; unknown keeps the step (stale
  beats silently wrong).
- Behind-origin is a neutral flag, not a warning — nothing is at risk.
- One viewer-wide repositories query instead of per-repo lookups, so a single
  renamed repo cannot cost the sweep its GitHub data.
- PR/issue states cached in `.prstate.json`: MERGED forever (a merge never
  un-happens), CLOSED for 7 days and then revalidated, because issues and PRs
  reopen; OPEN ages out in 6 h, failed lookups in 24 h with a 2-failure
  circuit breaker. The live open-PR list is consulted before the cache, so a
  reopened PR of the user's own surfaces immediately either way.
- A step naming two different repos resolves to neither (kept as-is): there
  is no right pairing of its refs to repos, and guessing could prune a live
  step.
