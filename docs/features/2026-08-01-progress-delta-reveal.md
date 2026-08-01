# Feature: progress delta engine and sweep reveal

**Branch:** feat/progress-delta-reveal
**Date:** 2026-08-01

## Summary
The board now renders what moved today, not just the current state. Each sweep
diffs itself against the previous one, detects wins from git/GitHub/session
ground truth, and the board shows them: a "Today" strip with count-up stats and
a win ledger, per-card delta chips, a four-sided all-clear ring on each git
tile, a 12-week activity strip per card, and a short reveal ceremony when the
Sweep button is clicked after a productive day.

## Motivation
A sweep after nine pushed commits looked identical to a sweep after a nap.
Every signal the board emitted was loss-framed (dirty, unpushed, stale,
hazard), and research on progress and motivation says setbacks weigh 2 to 3
times more than equivalent progress, so the board was a net demotivator on any
day when nothing was on fire. The fix is to compute wins from the same ground
truth the hazards come from and put them first. Design decisions that came out
of the research: no streaks, no XP or points, no guilt copy, celebrations
budgeted and rare, and every celebrated fact traceable to git, GitHub, or
session logs.

## What changed
- `sweep.js` gains a delta engine: per-project metrics (dirty, ahead, days
  idle, open-PR set, commits today, pushed today via remote refs, sessions
  today, 12-week intensity) appended to a new `history.jsonl` (one line per
  sweep, trimmed at 4000 lines). Each sweep diffs the previous line into wins:
  PR merged (vanished PRs get a `gh pr view` state check, capped at 8 per
  sweep), hazard
  cleared, unpushed work banked, tree cleaned, comeback after 21+ idle days,
  PR opened. Wins fold per local day so scribe-triggered sweeps accumulate
  instead of resetting the story.
- A `DELTA` const rides the existing `SWEEP:DATA` region; `BOARD.md` gains a
  `## Today` section; the sweep summary line reports wins.
- Board template: a Today strip (stats, ledger, N of M repos all-clear, at
  most one delight fact), per-card chips that persist until midnight, a
  four-arc all-clear ring tracing the tile outline (top tree clean, right
  pushed, bottom no PR waiting past 30 days, left no satellite clone ahead;
  gaps centered on the corners), a 12-week intensity strip per card, and the
  reveal ceremony (80ms beat, staggered count-ups, card cascade capped at 4
  per second, at most one celebration and only for a merged PR, a comeback, or
  the first-ever all-clear, click to skip, `prefers-reduced-motion` collapses
  everything to instant state). The ceremony only plays on the reload right
  after the Sweep button, flagged via sessionStorage.
- Tone fixes: `paused Nd` is no longer a warn flag (parked is a choice), the
  empty hazard list reads as the reward state, and a quiet day gets calm copy
  instead of nothing.
- On ringed tiles, resting agent dots (idle/done) are suppressed; working and
  blocked dots still show, nesting in the ring's top-right corner gap.
- Removed the superseded "changed since your last visit" note (`chgNote`), its
  CSS, and its `radar-seen-v1` localStorage snapshot.

## Notes
- `history.jsonl` is generated data (gitignored alongside `data.json`); the
  delta engine degrades to a no-win first sweep when it is absent, and `--dry`
  / `--json` runs never write it.
- Aggregate shelf cards get no activity strip: they catch orphan sessions from
  unregistered directories, and an activity sparkline on a "nothing happens
  here" card reads as a bug.
- The board-level all-clear holds itself to the ring standard (every repo
  clean, pushed, satellite-free, no stale PR), not just "no hazard crossed a
  threshold"; the first-ever all-clear is the one bespoke celebration.
- Follow-on (not in this PR): evening recap and Monday review views fed from
  `history.jsonl`.
