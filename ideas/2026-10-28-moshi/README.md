# Moshi local voice trial

- Date: 2026-10-28 (trial: 2026-10-27)
- Status: `gestopt` (stopped)

## Purpose

Explore an isolated, local English speech conversation using Kyutai's Q4 Moshiko model on Apple Silicon through MLX. This was a standalone preview, not a replacement for Ultimate's voice interface: no agent bridge, tool calls, user transcription or fallback speech service.

## Why stopped?

The user explicitly cancelled the experiment before any human audio trial or shipping approval, and later requested removal of the remaining Moshi work and installations. Nothing shipped, landed on `main`, or became a stable, user-approved trial. Archiving these findings does not authorize restarting it.

## What was tried

- A separate Python environment and pinned model cache, approximately 5.2 GiB in total; no system-Python installation was intended.
- `moshi_mlx` source at `e6a55d2722a65870ef52a6c9f6ecfc0e90f38362`, MLX 0.26.5, `rustymimi` 0.4.1, Python 3.12. Model: `kyutai/moshiko-mlx-q4`, revision `18e4df760a34d5977a34517d7d1580e07acbb2f1`.
- A browser Opus encoder, authenticated same-origin WebSocket tunnel, loopback-only Q4/Mimi runtime, decoder and Web Audio playback. The source included an authenticated extension-upgrade hook, a trial surface, bounded lifecycle handling and focused tests.
- One model process at a time, a four-minute server lease, a 30-second first-connection limit and a shared budget of 12 unfinished audio frames. Stop, disconnect and navigation released owned resources.
- Synthetic silence and a synthetic browser microphone only. No result below establishes human conversation quality, the user's microphone/speakers, interruption feel or remote mouth-to-ear latency.

## Measurements and failures

| Probe | Observed result | Limit of the evidence |
| --- | --- | --- |
| Offline Q4/Mimi smoke | 16 seconds of synthetic input processed in 13.4024 seconds; real-time factor 0.83765; frame p50/p95 66.46/70.29 ms | Not sustained browser throughput or speech latency |
| Loopback Opus/WebSocket smoke | 20 seconds of synthetic input; first decoded PCM after 158.5 ms; clean model exit on close | First decoded audio is not first meaningful speech |
| Early browser pass | 926 ms warm start; 120 decoded playback buffers; mute/unmute, Stop, navigation and denied-permission cleanup checked | A short successful pass did not prove stability |
| Longer synthetic runs | Failed after 49.10 and 27.20 seconds with `QueueFull`; maximum scheduling gaps 1,213 and 2,167 ms | One probe saw a 2.081-second ingress pause followed by 26 messages in under 1 ms; the responsible layer was not identified |
| Loopback control | Also overflowed; inference steps 80.67–84.51 ms and queue depth 10–12 | The problem was not proven to be remote transport alone |
| Later sequential run | Failed after 224.22 seconds, 5,580 buffers, `QueueFull`; encode + generation + decode/send took 81–84 ms per 80-ms frame | Direct evidence of insufficient sustained sequential throughput in that run |

A separate preview also stopped responding after document/HMR activity. Sampling found the main thread in fsevents dispatch, Set iteration and string matching. A later healthy inspection saw a trust-file lock event and many filtered Chokidar listeners; neither observation identifies the cause of the historical hang. A warmed-cache restart responding again was not proof of a fix.

## Repairs and what they actually proved

- **Abort startup with Stop:** sharing the session AbortSignal removed an unnecessary failed Start request during intentional cancellation. Pending microphone permission and late-arriving tracks were handled explicitly.
- **Bounded codec/model overlap:** one serialized codec worker overlapped one serialized model worker, while retaining a single 12-frame admission budget across all stages. A no-network 600-frame proof processed 48 seconds of synthetic input in 28.638 seconds, about 47–48 ms/frame. This did not by itself prove browser stability.
- **No Python bytecode in watched source:** the new pipeline helper generated a `__pycache__` file during an observed reload/cancellation. Starting Python with `-B` prevented that write in the repeat. This does not explain the older pre-helper fsevents hangs.
- **One repaired synthetic run reached the lease:** 5,994 playback buffers, 239.858 seconds after first playback, maximum scheduling gap 222.4 ms; tracks ended, AudioContexts closed and model phase off. No JavaScript/console errors were observed. The server intentionally destroyed the tunnel at its 240-second cap, yielding WebSocket 1006 and an incorrect red generic outcome. A deadline-reporting repair was committed, but its final lifecycle/visual repeat was not established before cancellation.
- Historical focused checks passed (23 tests), and the upgrade-hook worker ran its then-current unit suite. There was no final combined shipping gate, independent review, human trial or release approval. These are historical receipts, not checks rerun for this archive.

## Useful lessons

1. Measure sustained end-to-end throughput, including encode/decode and transport, not just a short inference smoke. An 80-ms frame cannot sustain 81–84 ms of sequential work.
2. Keep one total in-flight budget when overlapping stages; multiplying per-stage queues hides backpressure rather than fixing it.
3. Preserve the first failure and distinguish burst delivery, sustained overload and host unresponsiveness. Correlation with a watcher event is not a cause diagnosis.
4. Keep generated Python files outside watched extension source. Verify final tracks, contexts and server phase after cleanup, not just an intermediate snapshot.
5. Use the installed full browser for synthetic-microphone tests when the separate headless shell lacks support. Synthetic success still cannot stand in for a human audio trial.
6. An intentional deadline needs a distinct outcome rather than a generic connection failure. A committed repair is not a verified user experience.

## Removal and retained material

The earlier cancellation stopped the owned runtime/preview and removed the original trial worktrees. The follow-up inspection found an additional inactive, clean scratch-preview source worktree and three temporary Moshi diagnostic/helper files. Cleanup removed that checkout and the five local trial/worker branch refs. The inactive preview state home and temporary helpers were moved out of their old locations to system Trash, with historical databases intact. Shared Python, uv, Node, unrelated caches, the existing voice interface and unrelated previews were not removed.

Installed-package inventories, trial/cache path searches, process/listener checks and launchd/installer-receipt searches found no remaining identifiable Moshi installation in the inspected locations. The system-wide login/background-item inventory could not be completed: macOS denied the required administrator authorization in the noninteractive session. The original external environment and weights were already absent from their active trial location. The previously recorded recoverable Trash folder was also absent at this inspection; its subsequent disposition is unknown. This is not a claim of physical disk erasure or that every historical byte has disappeared.

This entry retains the purpose, pins, measurements, failure evidence, bounded-pipeline and watcher lessons, and source/conversation breadcrumbs. It does **not** retain an executable source snapshot, model weights, environments, binaries, audio, private logs or databases. Removing local source refs can make the commits below unreachable; commit IDs are provenance, not a promise that source remains retrievable. Git objects/reflogs and conversation history are not rewritten or purged. Historical preview databases are left intact, not treated as an installed model runtime.

## Source references

These are local historical commit IDs, not necessarily available in the public repository after cleanup:

- Initial trial and source integration: `ba3cef3ec82489acd588d7898bc69ce66f9bffa7`.
- Upgrade-hook worker: `288ff2658cf8407fc7c48c3590df9477b1caaf0c` (integrated as `76be19fe11a8cdee11f58b6b9a82748d7244e3c7`).
- Browser worker: `7544d6e61705c89169dd79afbb4f1d2f2c28952e` (integrated as `794a00896aec7230e36ab0cff1d6e3746d5aa420`).
- Isolated surface: `6650afe6b4881271d69f9de299f55b5b5f733558`.
- Earlier trial evidence: `52353906d763018133b3a8170834e670c6b3a737`; diagnostic privacy: `81d985fea7d260c15496cca22fc4b3ba9b4a86de`.
- Bounded pipeline: `2c6659a63679c3eed2f9e44bc16e39525f8f8f2a`; bytecode prevention: `067077a07bb0fba66ca35372a1cd14e85d2b0337`.
- Deadline reporting: `151760c3ec32724a99d38766927b15b8cc61911b` (not final human/visual proof).
- Final evidence document: `12e3b59614577709e010f619c385e44c5a2fd782`, `.ultimate/extensions/moshi-voice/TRIAL.md`.
- Local conversations: #30002/35828 (original evidence handoff), #31509 (upgrade hook), #31926 (browser), #33491 (surface), #36058 (continuation and cancellation), #36992 (pipeline), #58653 (removal/archive). Conversation history is not published by these references.

## Screenshots and privacy review

No screenshots included: they add little to the measured failure/repair record and could expose private trial context. This note was reviewed for secrets, personal names, private conversation quotations, machine paths/addresses and private logs; none are included. Only sanitized Markdown is archived. Upstream source attribution: Kyutai Moshi MLX/web code MIT, Rust Apache-2.0; model weights CC-BY-4.0. No upstream code or weights are redistributed here.
