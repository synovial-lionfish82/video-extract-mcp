# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm test                              # full suite; `pretest` runs the build first
npm run build                         # tsc -> dist/
npm run typecheck                     # build + strict pass (tsconfig.typecheck.json)
npm run preflight                     # verify ffmpeg / ffprobe / yt-dlp / tesseract
npm run matrix                        # acceptance matrix (see "Honesty" below)
npm run cli -- <url> [flags]          # CLI; builds first
```

Single test file or single test:

```bash
npm run build                         # REQUIRED first — see below
npx vitest run tests/captions.test.ts
npx vitest run tests/captions.test.ts -t "partial test name"
```

**`npx vitest run` does not build.** Only `npm test` does (via `pretest`). Nine test
files `vi.mock` and import from `../dist/`, so running them against a stale or
missing `dist/` gives results that have nothing to do with your edit. When
iterating on a single file, rebuild between changes.

Many tests self-skip via `describe.skipIf(!ready)` when the ~1.5 GB speech models
or system binaries are absent. A green run is not proof those paths ran — check
the skip count.

## Architecture

Four layers. Read them in this order; each one's responsibility is genuinely
distinct and the boundaries are load-bearing.

```
src/mcp.ts                  MCP surface: zod schemas + tool descriptions.
                            Handlers are ~3 lines. NO logic lives here.
src/agent/*Tool.ts          Agent layer: writes manifest/transcript/frames to
                            destinationPath, decides inline-vs-disk, never throws.
src/analyze.ts              Pipeline orchestrator: resolve -> trim -> normalize
                            -> transcript -> frames -> manifest.
src/{resolve,media,transcript,vision}/   Subsystems.
```

**`src/cli.ts` enters at `analyze.ts`, bypassing the agent layer entirely.** So the
CLI and the MCP tools are *not* the same code path — the disk-first output policy
and inline-transcript threshold are agent-layer behaviour the CLI does not get.
A bug in the CLI path can be invisible to every MCP test, and was: see the
`processing.warnings` note below.

The tool descriptions in `src/mcp.ts` are the agent-facing contract and are treated
as seriously as code. A description asserting behaviour the engine does not have is
a defect, not a doc nit.

## Invariants that break quietly if violated

**Staged memory, under 2 GB peak.** Speech recognition and vision embedding are
heavy models and must never be resident together. Each runs in its own worker
process (`transcript/asrWorker.ts`, `vision/embedWorker.ts`) that exits before the
next stage starts. Anything that lets two heavy stages overlap is a serious defect.

**Workers are resolved as siblings of the *running* module**, so they only exist in
compiled output — from `src/` under tsx the sibling is a `.ts` file and the spawn
misses. The failure is quiet: the stage degrades, and the only trace is a
`processing.warnings` entry, so the run still "succeeds" with every embedding
missing. Any entry point must run `dist/`.

**Degradation must stay visible.** An optional stage that fails and is skipped past
records a `processing.warnings` entry, so an empty transcript is distinguishable
from a video with no speech. A stage skipped *by design* (frame-mode short circuits)
is not a degradation and must not fabricate a warning.

**`src/types.ts` is the single source of truth** for shared types.

**No Python.** Node 26, ESM, TypeScript strict with `noUncheckedIndexedAccess`.

## Domain rules worth knowing before editing

**Transcript tiering:** any platform caption beats local speech recognition —
manual first, then automatic, *including machine-translated tracks*. Local ASR is
the no-captions fallback, never a preferred tier. This reverses an earlier
"accuracy bias" and was measured, not assumed; `chooseCaptionTier` carries the
numbers. Do not reintroduce a caller-facing choice here.

**Platform automatic captions use rolling cues** — each cue repeats the previous
one's trailing lines before appending. Parsed naively they inflate ~3x. Dedup runs
*during* parse (`parseVttCues` -> `dedupeRollingCues`), because joining cue lines
destroys the line structure that identifies duplicates.

**Clip timestamps re-base to zero.** A range-fetched file is a clip starting at 0,
not the original with a hole. `clipRelative` in `analyze.ts` tracks whether the
media has actually been re-based; the caption clamp is gated on it, not on
`opts.start`/`opts.end` alone. The `'even' + start === end` carve-out deliberately
skips the trim and stays in absolute time — tests pin this in both directions.

**Frame-mode short circuits (spec §8):** a single-frame request must not pay for
scene detection, quality filtering, OCR, embeddings, transcription, *or* the video
re-encode. `normalizeVideo()` runs only for `frames: 'key'`; the WAV is extracted
only when a transcript is actually needed.

## Testing expectations

The recurring defect in this codebase's history is **a test that passes identically
against broken code** — assertions reading values back out of the function's own
return value, or mocking the very machinery under test. When adding a test, mutate
the thing it guards and confirm it fails. Assert independently-constructed
expectations and key *absence* (`'duration' in r === false`) rather than falsiness,
since `toBe(0)` and `toBeFalsy()` pass against several real bugs here.

## Honesty

`docs/acceptance-matrix.md` reports **0 of 11 rows executed** because it needs real
URLs via `M_*` environment variables. The platform list is tested *code paths*, not
platforms anyone has watched succeed live. Do not let docs, comments, or tool
descriptions imply otherwise. `docs/follow-ups.md` records every deliberately
deferred item with its reasoning — check it before "discovering" a known gap.

## Reference

- `docs/superpowers/specs/` — design docs; the v2 spec governs the current agent surface
- `docs/follow-ups.md` — deferred work, with the reasoning that deferred it
- Env: `VIDEO_EXTRACT_MODELS_DIR`, `VIDEO_EXTRACT_WECHAT_COOKIE`
- WeChat resolution was **clean-room derived**; the well-known reference
  implementation is MIT + Commons Clause. Never consult it when extending that code.
