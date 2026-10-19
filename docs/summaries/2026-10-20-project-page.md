# Session: GitHub Pages project page

**Branch:** feat/project-page
**Date:** 2026-10-20

## Prompts
1. "Build GitHub Pages project pages for TWO public repos: Tatendaz/mission-control
   and Tatendaz/herdr-launcher, and turn Pages on for each." The brief asked for
   pages modeled on the claude-usage and yapui pages, content taken only from the
   repo, light and dark mode, a footer with links to the owner's site, X,
   LinkedIn and email, and no screenshots that show private data.

## Steps taken
- Read the claude-usage and yapui `docs/` pages and the live claude-usage page.
- Read this repo's README, `config.example.json`, CI workflow, roadmap, and
  `docs/screenshot.png` (the example config, no private data).
- Wrote `docs/index.html`, `docs/index.md`, `docs/404.html`,
  `docs/.nojekyll`, and rendered `docs/social-preview.png` with headless
  Chrome.
- Checked the page in light and dark mode at desktop and 390 px widths.

## Decisions
- Reused claude-usage's tokens and structure rather than a new look, so the
  project pages read as one family.
- Kept the README install block byte-for-byte, comment included.
- Status section lists what the repo shows: no tagged releases, macOS only,
  smoke-level CI, voice inbox v2 specced but not built.
