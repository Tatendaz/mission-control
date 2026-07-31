# Roadmap

What is planned for Mission Control, in order. Items graduate to the README
when they ship; specs live next to this file.

## Next: voice inbox v2, local transcription

The watch inbox stops transcribing on the watch. Audio is recorded offline on
the watch or phone, moves to the Mac over the local network when both are on
it, is transcribed by [FluidAudio](https://github.com/FluidInference/FluidAudio)
(Parakeet v3, CoreML, on-disk models) and filed as a GitHub issue; the audio
itself never leaves the Mac. Motivation: watch dictation benchmarks at 9.0%
word error rate clean and 16.3% noisy, versus 2.5% for the Mac-side model on
the same corpus, and v1 has no offline queue.

Full spec with architecture diagram: [voice-inbox-v2.md](voice-inbox-v2.md).

- **Phase 1** buys capture (Just Press Record), adds one iPhone Shortcuts
  automation, and builds three small pieces in this repo: a token-gated LAN
  ingest listener, a transcription worker over `fluidaudiocli`, and a filer
  that runs `gh issue create`. The board's Inbox tab needs no changes.
- **Phase 2** replaces the bought capture app with a native watchOS + iOS pair
  when phase 1 friction justifies it: queue-depth complication, capture-time
  intent tags, background uploads, optional Tailscale delivery from any
  network.
- **Phase 2.5** routes by spoken prefix: "issue ..." to the inbox, a project
  name to that project's backlog.

## Under consideration

- A quick-wins view: the sweeper already finds stranded work (satellite clones
  ahead of their primaries, unpushed commits); a view that turns those into a
  ranked 30-minute list.
- `engine: "yap"` as a documented alternate transcriber for Macs without Apple
  Silicon, using macOS 26's SpeechAnalyzer via the `yap` CLI.
