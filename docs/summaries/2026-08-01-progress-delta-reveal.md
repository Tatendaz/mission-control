# Session: progress delta engine and sweep reveal

**Branch:** feat/progress-delta-reveal
**Date:** 2026-08-01

## Prompts

1. "New feature — we need some way to motivate the user, probably need to do
   some research on this with subagents. As I do and fix stuff that I saw on
   cards I have no way to tell that I have made good progress today. We need
   some visual UI/UX things that show progress: if I click sweep I should get
   some sort of dopamine hit from progress being shown. Think of things the
   board can do to motivate a user to do stuff."
2. "implement the full feature"
3. "poo UI please fix — either have it square or round, not both round with
   square inside. Do a couple of passes through the whole app and fix any UI
   inconsistencies" (screenshot of the ring circle clashing with the square
   tile)
4. "the green notification circle is now clashing with the progress lines
   outlines, and can we make the space between lines be at the corner of the
   square and not half way on the side of a square side. I think the
   notification circle should not be there entirely when progress starts, no?"
5. "use 4 sides not 3. It currently looks weird with 3"
6. "can you make the gap between lines smaller and the line can start to curve
   around the corner. Keep the gap centered in the corner though"
7. "looks good create a PR"

## Steps taken
- Three research subagents: gamification patterns in shipping products
  (Duolingo, GitHub graph, Apple rings, Strava, Todoist, game-feel timing),
  behavioral science (progress principle, endowed progress, goal gradient,
  streak harm, self-determination theory, peak-end), and a line-level codebase
  map. Synthesized into a design spec and a clickable mockup of the sweep
  reveal, both delivered as files.
- Implemented the delta engine in `sweep.js` (metrics, `history.jsonl`, win
  taxonomy, per-day fold, DELTA in the data region, BOARD.md Today section)
  and the board layer in `board.template.html` (Today strip, chips, rings,
  week strips, reveal ceremony, quiet-day copy).
- Sandbox-tested end to end with two throwaway git repos plus a stubbed `gh`
  reporting a merged PR: verified wins, chips, rings, week strips, both
  themes, ceremony gating, and that `--dry` writes nothing.
- Ported to the live board (repo and live engine files had converged; board
  HTML edits applied outside the sweep markers) and re-swept live.
- UI passes from the screenshots: ring became a rounded rect tracing the tile,
  then four equal arcs (one signal per side) with gaps centered on the
  corners and arcs curving around them (gap constant G, final value 7);
  resting agent dots suppressed on ringed tiles; ring semantics tightened
  (satellite clone gets its own side); aggregate cards lost their misleading
  activity strips; dead `chgNote` code removed.

## Decisions
- Render the delta, not the state: the day is the emotional unit, so wins fold
  per local day across the many scribe-triggered sweeps.
- No streaks, no XP, no scores: GitHub removed its own streak counter, and the
  self-gamification literature (Habitica study, Deci meta-analysis) shows
  token rewards undermine intrinsic motivation while informational feedback
  strengthens it. Everything shown is a true sentence about the work.
- Celebration budget: confetti only for a merged PR or the first-ever
  all-clear board; at most one celebration per sweep; roughly two delight
  facts per week.
- "Pushed today" reads from remote-reachable commits with today's commit date
  rather than ahead-count arithmetic, trading a rare undercount (old commits
  pushed today surface as a banked win instead) for zero false positives.
- Working/blocked agent dots stay visible on ringed tiles (live signals);
  only resting dots are suppressed.
