# Session: voice inbox v2 spec and roadmap

**Branch:** docs/voice-inbox-v2
**Date:** 2026-07-31

## Prompts

1. "Does https://github.com/altic-dev/FluidVoice have an API or CLI? I have
   Fluid installed on my computer, so could I offload audio conversion to text
   from voice notes I record on my Apple Watch or iPhone to my local Mac?"
2. "Can you spec out this feature for Apple Watch and iPhone using FluidAudio?
   The current setup where I try to use Siri and then it goes to GitHub has
   incorrect text conversion because the model used to convert is really bad.
   Maybe we need to transfer the audio from the iPhone or Apple Watch to macOS
   to do the conversion and then upload to GitHub to create an issue. Spec it
   out and draw the architecture; create an architecture diagram so I can see
   how it looks visually, and add it as a PR to the Mission Control repo as a
   future feature implementation, part of the roadmap. The full ethos: keep
   everything local except the GitHub part. Audio capture and conversion happen
   locally. If you are not on the same network, it stores those audio files
   until you are finally on the same network with your Mac, and then it
   synchronizes automatically. Suggest a better process if you have one;
   research with sub-agents if needed."

## Steps taken

- Inspected the installed FluidVoice.app (v1.6.6): no CLI, API, or URL scheme;
  its engine is FluidAudio, whose Parakeet models already sit in
  `~/Library/Application Support/FluidAudio/Models/`.
- Ran three research agents: (1) watch/iPhone → Mac local transport and
  offline queueing under iOS/watchOS background limits, (2) FluidAudio CLI and
  API specifics from a clone of the repo, (3) prior art for voice → local ASR
  → notes/GitHub pipelines.
- Wrote `docs/voice-inbox-v2.md` (spec with Mermaid architecture),
  `docs/roadmap.md`, README and watch-inbox cross-links; rendered a standalone
  SVG of the architecture for review.
- Ran the CI smoke steps locally; opened this PR stacked on `ci/smoke-checks`
  because branch protection requires the `smoke` check, which only exists on
  that unmerged branch.

## Decisions

- Phase 1 buys capture (Just Press Record: offline watch recording,
  WatchConnectivity transfer, Files-visible local folder) instead of building
  a watch app; a custom app is phase 2, gated on real friction.
- FluidAudio `fluidaudiocli` as the transcriber: reads .m4a natively, shares
  models and the custom vocabulary with FluidVoice, ~190x realtime. `yap`
  noted as the non-Apple-Silicon alternate.
- Rejected for the default path: Voice Memos (automatic cross-device sync is
  iCloud-dependent; it records locally and exports manually, but offers no
  automatic LAN or encrypted-overlay queue, and its Group Container is
  fragile), Whisper Memos (cloud ASR), Shortcuts-only capture (cannot
  record audio headlessly; cannot record on watchOS at all), Syncthing as
  transport (1 to 2 h/day background ceiling).
- Ingest endpoint is a separate token-gated listener on port 8770; the main
  server stays loopback-only because `/api/launch` executes commands.
  Tailscale is the default transport (token never unencrypted on a wire);
  plain home-LAN HTTP stays documented as a no-dependency fallback with its
  tradeoff stated in the spec (token and audio readable by anyone sniffing
  that LAN; wrong choice on shared networks). A CodeRabbit CLI review
  round tightened the spec: spool quota, SHA-256 idempotent filing, failed/
  in the hazard rule, fixed audio directory, platform-limit source links.
