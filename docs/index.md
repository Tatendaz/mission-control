# Mission Control

**A project board that builds itself from your git checkouts, pull requests, and Claude Code sessions.** For solo developers running more projects than they can keep in their head. There is nothing to update by hand, so the board stays true.

[View on GitHub](https://github.com/Tatendaz/mission-control) [Install](#install)

![The Mission Control board, generated from the example config that ships in the repo](https://tatendaz.github.io/mission-control/screenshot.png)

## Who it is for

You work on several projects at once, some of them in more than one clone. You lose track of which checkout holds the newest work, which pull requests are still open, and what the last Claude Code session on a project actually did.

Mission Control answers those questions from data your tools already write. Any board you have to maintain by hand goes stale within a week; this one is regenerated on every sweep.

## What it does

- **Sweeps instead of asking you to type.** `sweep.js` scans every checkout under your roots for freshness, dirty files, unpushed commits, and satellite clones that hold newer work than the main one. It adds your open PRs from `gh`, the latest Claude Code session per project, and open issues from an inbox repo.
- **Launches Claude from a card.** Hover a card and press the ram. The local server opens a [herdr](https://herdr.dev) workspace for that project, starts Claude in a fresh pane, and hands it a prompt built from the card. Dots on each card show that workspace's agent state: working, blocked, or done.
- **One card per workstream.** Views for Overview, Hazards, Recency, and PRs. Pin, search, and sort. Deleted cards stay deleted across sweeps.
- **Refreshes when a session ends.** A Claude Code `SessionEnd` hook records what the session did, the server re-sweeps, and open boards reload. A daily sweep and a Sweep button cover the rest.
- **Ideas from your wrist.** An Apple Watch Shortcut files dictated ideas as GitHub issues in a private inbox repo. They show up in the Inbox tab.

## How it works

Three small scripts over data you already produce.

- **Observe: `sweep.js`.** Reads git, `gh`, and Claude Code session logs, then rewrites only the marker-delimited regions of `board.html`. Styling, interactions, and your hand-written notes are left alone. It also writes a terminal `BOARD.md` and `data.json`.
- **Intend: `scribe.js`.** Runs on Claude Code's `SessionEnd` hook and writes `status/<project>.json`: the session's prompts, files touched, and a summary. The sweeper folds that into the cards; the server treats it as a sign that work happened.
- **Act: `server.js`.** Serves the board on `127.0.0.1` only and exposes `/api/sweep` and `/api/launch`. Launch drives herdr: create the workspace if it is missing, open a new tab, start `claude`, send the prompt.

## Install

Needs macOS, Node 18+, `git`, and [`gh`](https://cli.github.com) signed in. Optional: [herdr](https://herdr.dev) for card launches, an Apple Watch for the inbox.

```sh
git clone https://github.com/Tatendaz/mission-control
cd mission-control
cp config.example.json config.json     # then edit: roots, projects, paths
cp board.template.html board.html
node sweep.js                          # first sweep — board.html goes live
node server.js                         # http://localhost:8765
```

Then describe your world in `config.json`: the directories to scan, one entry per project card, your GitHub user, and the inbox repo. The [README](https://github.com/Tatendaz/mission-control#install) covers the config keys, running the server under launchd, the Dock app, and the scribe hook.

## Status

- **No tagged releases.** Install from the `main` branch.
- **macOS only.** The install steps, the launchd setup, and the Dock app all assume a Mac.
- **CI is smoke-level.** It checks that the engine and the board's inline script parse, runs the engine unit tests, and runs a dry sweep against the example config.
- **Next on the [roadmap](https://github.com/Tatendaz/mission-control/blob/main/docs/roadmap.md):** voice inbox v2, which records audio offline and transcribes it on your Mac. It is specced, not built.
- **Keep the server on loopback.** `/api/launch` runs commands, so it binds to `127.0.0.1` and must never be exposed on another interface.
- **Not affiliated with herdr.** The integration drives the public `herdr` CLI. Without herdr, everything works except the launch button.

---

**Built by Tatenda Zhou.** [tatendaz.github.io](https://tatendaz.github.io/) · [Follow on X](https://x.com/realtatendazhou) · [LinkedIn](https://www.linkedin.com/in/tatendazhou)

Need help making AI coding agents reliable? [tatendaz@me.com](mailto:tatendaz@me.com?subject=AI%20coding%20agents%20(via%20Mission%20Control))

MIT licensed. Source on [GitHub](https://github.com/Tatendaz/mission-control). [llms.txt](https://tatendaz.github.io/llms.txt)
