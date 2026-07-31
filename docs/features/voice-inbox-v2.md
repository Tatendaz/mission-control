# Feature: voice inbox v2 spec and roadmap

**Branch:** docs/voice-inbox-v2
**Date:** 2026-07-31

## Summary
Docs-only. Adds the accepted design for voice inbox v2 (offline audio capture
on watch/iPhone, LAN-only transfer, local transcription on the Mac via
FluidAudio, transcript filed as a GitHub issue), plus a project roadmap that
carries it, and cross-links from the README and the v1 watch-inbox doc.

## Motivation
v1 transcribes on the watch with Apple's dictation stack: 9.0% word error rate
on clean speech against 2.5% for Parakeet v3 running locally on the Mac, and
no offline queue at all. The spec fixes both by making capture dumb audio plus
a queue and moving all transcription to the Mac that already runs Mission
Control. Everything stays local except the single GitHub hop; audio never
leaves the user's machines.

## What changed
- `docs/voice-inbox-v2.md`: the full spec. Six-leg architecture with a Mermaid
  diagram, phase 1 (buy Just Press Record, build listener + transcriber +
  filer), phase 2 (native capture app), security model for the LAN ingest
  endpoint, alternatives considered, config sketch, open questions.
- `docs/roadmap.md`: new roadmap; voice inbox v2 is the headline item.
- `README.md`: roadmap section and a successor pointer in the watch-inbox
  bullet.
- `docs/watch-inbox.md`: closing paragraph now points at the v2 spec instead
  of paid third-party upgrades.

## Notes
No code changes; `voice.js`, the `voiceInbox` config block, and the ingest
port are design, not implementation. The design was researched against Apple's
documented platform limits (no headless Shortcuts recording, WatchConnectivity
timing owned by the system); those claims carry source links in the spec.
Tailscale is the default ingest transport so the bearer token never crosses a
wire unencrypted; plain LAN HTTP is the documented fallback with its tradeoff
stated. Port 8770 was chosen to stay clear of 8765 (server) and 8766
(html-preview relay fallback).
