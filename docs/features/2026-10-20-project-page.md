# Feature: GitHub Pages project page

**Branch:** feat/project-page
**Date:** 2026-10-20

## Summary
Adds a static project page under `docs/`, served by GitHub Pages at
https://tatendaz.github.io/mission-control/.

## Motivation
The repo had no page to link from the owner's site or from social posts. The
other project pages on tatendaz.github.io (claude-usage, yapui) serve from
`main:/docs`; this one matches their layout, theme tokens, and light/dark
toggle so the pages read as one set.

## What changed
- `docs/index.html`: the page. A one-line summary, the README screenshot,
  who it is for, feature tiles, how it works, the README install block verbatim,
  an honest status list, and a "Built by" footer. System light/dark default
  plus a toggle that shares the `cu-theme` preference key with claude-usage,
  so one choice applies across the project pages on the same host.
- `docs/index.md`: Markdown twin, linked with `rel="alternate"`.
- `docs/404.html`: not-found page for paths under `/mission-control/`.
- `docs/social-preview.png`: 1280x640 Open Graph image.
- `docs/.nojekyll`: serve files as they are, so `index.md` is not turned into
  a second `index.html`.

## Notes
- Content comes only from the README, `config.example.json`, the CI workflow,
  and `docs/roadmap.md`. The screenshot shows the example config (acme-app,
  build-log, ...), not anyone's real projects.
- The install block keeps the README's comment text exactly, including its
  dash, so the two never drift apart.
- Pages is switched on after merge with `source = main:/docs`.
