# Norma Agent Surface v2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the four-tool MCP surface with two tools — `resolve_video` (metadata by default, media on request) and `analyze_video` (which subsumes `get_frame` and `get_clip`) — while keeping the cheapest operations cheap.

**Architecture:** The engine underneath is unchanged. This adds a `frames` sampling mode and early-exit short-circuits to the orchestrator, expands captured platform metadata, introduces an artifact-writing layer that makes `destinationPath` the delivery mechanism, and rewrites the MCP layer against them.

**Tech Stack:** Node 26, TypeScript (ESM, strict), vitest, `@modelcontextprotocol/sdk`, `zod`, yt-dlp, ffmpeg.

**Spec:** `docs/superpowers/specs/2026-08-11-norma-agent-surface-v2-design.md`. Section references below (§N) point there.

## Global Constraints

Every task's requirements implicitly include this section.

- **No Python.** Node 26, ESM (`"type": "module"`), TypeScript strict with `noUncheckedIndexedAccess: true`.
- **`src/analyze.ts` must never import `sherpa-onnx-node` or `@huggingface/transformers`.** Only the driver modules that spawn workers. Violating this collapses the ~2 GB staged-memory architecture.
- **`destinationPath` is mandatory on both tools** (§3).
- **Verified fact — do not "fix" it:** the media is trimmed before normalization, so `probe()` returns the *clip's* duration and every stage after the trim is already clip-relative. Range-bounded selection needs no change (§2.2).
- **Verified fact:** `cosine([], x)` returns 0, identical to the no-embedding default, so an empty embedding array and an absent one behave identically in the selector.
- Commit after every task. Conventional messages (`feat:`, `fix:`, `test:`, `refactor:`).
- **Never `git add` anything under `.superpowers/`, `experiments/`, or `models/`.**
- A pre-commit guard **blocks staged content containing the OS username or any absolute home-directory path** (`/Users/...`). Build paths with `tmpdir()`/`join()`, never by hardcoding. This applies to committed source and docs; the guard rejects the commit outright rather than warning.
- Tests import worker-spawning code from `dist/`, not `src/` — worker scripts resolve paths relative to the importing module, so a `src/` import silently spawns nothing. `npm test` runs `pretest` (`tsc`) first.
- **Every new test must state what broken implementation it catches.** This project has repeatedly shipped tests that passed identically against broken code; all were caught in review.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/types.ts` | Add `FrameMode`, `VideoMetadata`, `Chapter`; extend `AnalyzeOptions`, `ResolveOptions`, `ResolvedMedia`, `Manifest` |
| `src/vision/even.ts` | **New.** Evenly-spaced frame sampling across a range (subsumes `get_clip`) |
| `src/analyze.ts` | `frames` mode dispatch + early-exit short-circuits |
| `src/resolve/ytdlp.ts` | Capture chapters/description/uploader/counts; optional comments |
| `src/agent/artifacts.ts` | **New.** Artifact naming, idempotent writes, description preview |
| `src/agent/resolveTool.ts` | **New.** `resolve_video` handler logic, independent of MCP |
| `src/agent/analyzeTool.ts` | **New.** `analyze_video` handler logic, independent of MCP |
| `src/mcp.ts` | Two tool registrations wrapping the two handlers |
| `src/primitives.ts` | Kept as internal implementation; MCP tools removed |

Handler logic lives outside `src/mcp.ts` so it is testable without an MCP client.

---

### Task 1: Types and options

**Files:**
- Modify: `src/types.ts`
- Test: `tests/typesV2.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type FrameMode = 'key' | 'even' | 'none'`
  - `interface Chapter { start: number; end: number; title: string }`
  - `interface VideoMetadata { title: string; creator: string | null; duration: number; chapters: Chapter[]; description: string | null; uploadDate: string | null; viewCount: number | null; commentCount: number | null }`
  - `resolveFrameMode(frames: FrameMode | undefined, maxFrames: number | undefined): FrameMode`
  - `AnalyzeOptions` gains `frames?: FrameMode`, `language?: string`, `destinationPath?: string`; keeps `start`, `end`, `maxFrames`, `transcript`, `preferredLanguage`, `outDir`; **`mode` is removed**
  - `ResolveOptions` gains `returnVideo?: boolean`, `comments?: boolean`
  - `ResolvedMedia` gains `metadata?: VideoMetadata`, `clipStart?: number`, `clipEnd?: number`
  - `Manifest['processing']` — `mode` removed, `frameMode: FrameMode` added

- [ ] **Step 1: Write the failing test**

```ts
// tests/typesV2.test.ts
import { describe, it, expect } from 'vitest';
import { resolveFrameMode } from '../src/types.js';

describe('resolveFrameMode', () => {
  it('defaults to key when nothing is specified', () => {
    expect(resolveFrameMode(undefined, undefined)).toBe('key');
  });
  it('treats maxFrames 0 as an alias for none (spec §2.2)', () => {
    expect(resolveFrameMode(undefined, 0)).toBe('none');
  });
  it('lets an explicit frames value win over a zero budget', () => {
    expect(resolveFrameMode('even', 0)).toBe('even');
  });
  it('passes explicit modes through', () => {
    expect(resolveFrameMode('even', 10)).toBe('even');
    expect(resolveFrameMode('none', 10)).toBe('none');
    expect(resolveFrameMode('key', 10)).toBe('key');
  });
  it('does not treat a negative budget as key', () => {
    expect(resolveFrameMode(undefined, -1)).toBe('none');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/typesV2.test.ts`
Expected: FAIL — `resolveFrameMode` is not exported.

- [ ] **Step 3: Implement in `src/types.ts`**

Add near the other option types:

```ts
export type FrameMode = 'key' | 'even' | 'none';

export interface Chapter { start: number; end: number; title: string; }

export interface VideoMetadata {
  title: string;
  creator: string | null;
  duration: number;
  chapters: Chapter[];
  description: string | null;
  uploadDate: string | null;
  viewCount: number | null;
  commentCount: number | null;
}

/**
 * Spec §2.2: `frames` is the documented control, but a zero (or negative)
 * budget means the same thing as 'none' and must not error -- an agent
 * reasoning about budgets may reach for the number before the enum.
 * An explicit mode always wins, so `frames:'even', maxFrames:0` stays
 * 'even' and is caught later by the range validation rather than silently
 * becoming a transcript-only call.
 */
export function resolveFrameMode(
  frames: FrameMode | undefined,
  maxFrames: number | undefined,
): FrameMode {
  if (frames !== undefined) return frames;
  if (maxFrames !== undefined && maxFrames <= 0) return 'none';
  return 'key';
}
```

Then amend the existing interfaces:

```ts
export interface AnalyzeOptions {
  start?: number; end?: number; maxFrames?: number; transcript?: boolean;
  frames?: FrameMode;
  /** Explicit override; outranks platform metadata (spec §4). */
  language?: string;
  preferredLanguage?: string;
  destinationPath?: string;
  outDir?: string;
}

export interface ResolveOptions {
  start?: number; end?: number; workDir: string;
  preferredLanguage?: string;
  /** Spec §2.1: metadata-only by default; media is the opt-in. */
  returnVideo?: boolean;
  /** Spec §2.1: can be very slow on popular videos. */
  comments?: boolean;
}
```

Add to `ResolvedMedia`:

```ts
  /** Platform metadata for resolve_video's inline result (spec §9). */
  metadata?: VideoMetadata;
  /** Applied range against the ORIGINAL video, when one was (spec §5.1). */
  clipStart?: number;
  clipEnd?: number;
```

In `Manifest['processing']`, replace `mode: AnalyzeMode;` with `frameMode: FrameMode;`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/typesV2.test.ts` → PASS (5 tests).
Then `npx tsc --noEmit` — this WILL report errors at every `mode:` site in `src/analyze.ts`, `src/manifest.ts`, `src/mcp.ts`. Leave them; Task 3 fixes them. Note the count in your report.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts tests/typesV2.test.ts
git commit -m "feat: add FrameMode, VideoMetadata and v2 options"
```

---

### Task 2: Evenly-spaced frame sampling

**Files:**
- Create: `src/vision/even.ts`
- Test: `tests/even.test.ts`

**Interfaces:**
- Consumes: `extractFrame`, `probe` from `src/media/ffmpeg.ts`; `Candidate` from `src/types.ts`.
- Produces: `evenTimestamps(start: number, end: number, count: number): number[]` and `sampleEven(video: string, start: number, end: number, count: number, outDir: string): Promise<Candidate[]>`

This is `get_clip`'s replacement. It must handle `start === end` (one instant), which the old fps-based path could not — dividing a zero-length window by a frame rate is undefined.

- [ ] **Step 1: Write the failing test**

```ts
// tests/even.test.ts
import { describe, it, expect } from 'vitest';
import { evenTimestamps } from '../src/vision/even.js';

describe('evenTimestamps', () => {
  it('returns exactly the requested count', () => {
    expect(evenTimestamps(0, 10, 5)).toHaveLength(5);
  });
  it('returns a single instant when start equals end', () => {
    expect(evenTimestamps(7, 7, 1)).toEqual([7]);
  });
  it('collapses to one sample when start equals end regardless of budget', () => {
    expect(evenTimestamps(7, 7, 20)).toEqual([7]);
  });
  it('spreads samples strictly inside the window, never at the exclusive end', () => {
    const ts = evenTimestamps(0, 10, 5);
    expect(ts[0]).toBeGreaterThanOrEqual(0);
    expect(Math.max(...ts)).toBeLessThan(10);
  });
  it('is evenly spaced', () => {
    const ts = evenTimestamps(0, 10, 5);
    const gaps = ts.slice(1).map((t, i) => t - ts[i]!);
    for (const g of gaps) expect(g).toBeCloseTo(gaps[0]!, 6);
  });
  it('yields 2fps for a 30s window with a 60 budget (spec §2.2)', () => {
    const ts = evenTimestamps(60, 90, 60);
    expect(ts).toHaveLength(60);
    expect(ts[1]! - ts[0]!).toBeCloseTo(0.5, 6);
  });
  it('returns nothing for a non-positive count', () => {
    expect(evenTimestamps(0, 10, 0)).toEqual([]);
  });
  it('never returns a negative timestamp', () => {
    expect(evenTimestamps(0, 1, 3).every((t) => t >= 0)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/even.test.ts` → FAIL, module not found.

- [ ] **Step 3: Implement `src/vision/even.ts`**

```ts
import { join } from 'node:path';
import type { Candidate } from '../types.js';
import { extractFrame } from '../media/ffmpeg.js';

/**
 * Evenly-spaced sample points across [start, end). Density is budget over
 * window, which is how `maxFrames` replaces the old `fps` parameter
 * (spec §2.2): 30s with a budget of 60 gives 0.5s spacing, i.e. 2fps.
 *
 * start === end means "one instant" and collapses to a single sample
 * whatever the budget -- the old fps-based path could not express this,
 * since a zero-length window has no meaningful frame rate.
 */
export function evenTimestamps(start: number, end: number, count: number): number[] {
  if (count <= 0) return [];
  if (end <= start) return [Math.max(0, start)];
  const step = (end - start) / count;
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(Math.max(0, start + i * step));
  return out;
}

export async function sampleEven(
  video: string, start: number, end: number, count: number, outDir: string,
): Promise<Candidate[]> {
  const stamps = evenTimestamps(start, end, count);
  const out: Candidate[] = [];
  for (const [i, timestamp] of stamps.entries()) {
    const imagePath = join(outDir, `even_${String(i).padStart(4, '0')}.jpg`);
    try {
      await extractFrame(video, timestamp, imagePath);
      out.push({ timestamp, sceneId: 0, imagePath, sceneSignificance: 0, quality: 1 });
    } catch { /* a frame at an unseekable point is skipped, not fatal */ }
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/even.test.ts` → PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/vision/even.ts tests/even.test.ts
git commit -m "feat: add evenly-spaced frame sampling"
```

---

### Task 3: Early-exit short-circuits in the orchestrator

**Files:**
- Modify: `src/analyze.ts`, `src/manifest.ts`
- Test: `tests/analyzeShortcircuit.integration.test.ts`

**Interfaces:**
- Consumes: `resolveFrameMode`, `FrameMode` (Task 1); `sampleEven` (Task 2).
- Produces: `analyzeVideo(url, opts)` honouring `frames`; `buildManifest` taking `frameMode` instead of `mode`.

**This is the load-bearing task.** Section §8: `start: 7, end: 7, maxFrames: 1` must be genuinely cheap — no scene detection, no quality filter, no OCR, no embedding model, no transcription. Those stages are unconditional today, so without this the "simplification" makes the cheapest call pay the full pipeline's cost.

- [ ] **Step 1: Write the failing test**

```ts
// tests/analyzeShortcircuit.integration.test.ts
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeTestVideo } from '../src/media/ffmpeg.js';

const embedSpy = vi.fn();
const asrSpy = vi.fn();
vi.mock('../dist/vision/embed.js', async (orig) => {
  const real = await orig<typeof import('../dist/vision/embed.js')>();
  return { ...real, embedImages: (...a: unknown[]) => { embedSpy(); return (real.embedImages as never)(...a); } };
});
vi.mock('../dist/transcript/asr.js', async (orig) => {
  const real = await orig<typeof import('../dist/transcript/asr.js')>();
  return { ...real, transcribeAudio: (...a: unknown[]) => { asrSpy(); return (real.transcribeAudio as never)(...a); } };
});

let video: string; let dir: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'norma-sc-'));
  video = await makeTestVideo(join(dir, 'v.mp4'), 9);
}, 120_000);

describe('early exits (spec §8)', () => {
  it('a single-frame request runs no model stage at all', async () => {
    embedSpy.mockClear(); asrSpy.mockClear();
    const { analyzeVideo } = await import('../dist/analyze.js');
    const m = await analyzeVideo(video, {
      start: 3, end: 3, maxFrames: 1, frames: 'even', transcript: false,
      outDir: join(dir, 'one'),
    });
    expect(m.source.status).toBe('ok');
    expect(m.frames).toHaveLength(1);
    expect(embedSpy).not.toHaveBeenCalled();
    expect(asrSpy).not.toHaveBeenCalled();
  }, 300_000);

  it('frames:none returns no frames and never embeds', async () => {
    embedSpy.mockClear();
    const { analyzeVideo } = await import('../dist/analyze.js');
    const m = await analyzeVideo(video, {
      frames: 'none', transcript: false, outDir: join(dir, 'none'),
    });
    expect(m.frames).toEqual([]);
    expect(m.processing.candidateFrames).toBe(0);
    expect(embedSpy).not.toHaveBeenCalled();
  }, 300_000);

  it('frames:even skips scene detection and embeddings but still returns frames', async () => {
    embedSpy.mockClear();
    const { analyzeVideo } = await import('../dist/analyze.js');
    const m = await analyzeVideo(video, {
      start: 1, end: 7, frames: 'even', maxFrames: 6, transcript: false,
      outDir: join(dir, 'even'),
    });
    expect(m.frames).toHaveLength(6);
    expect(embedSpy).not.toHaveBeenCalled();
  }, 300_000);

  it('frames:key still runs the full vision path', async () => {
    embedSpy.mockClear();
    const { analyzeVideo } = await import('../dist/analyze.js');
    const m = await analyzeVideo(video, {
      frames: 'key', maxFrames: 3, transcript: false, outDir: join(dir, 'key'),
    });
    expect(m.frames.length).toBeGreaterThan(0);
    expect(embedSpy).toHaveBeenCalled();
  }, 300_000);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run build && npx vitest run tests/analyzeShortcircuit.integration.test.ts`
Expected: FAIL — `frames` is ignored, so the embed spy fires on every case.

- [ ] **Step 3: Implement the dispatch in `src/analyze.ts`**

Replace the block from `// 5. Candidates` through `// 7. Select + align` with a mode dispatch. `frames: 'none'` returns before any vision work; `'even'` extracts only; `'key'` keeps the existing path verbatim.

```ts
  // 5-7. Frames -- mode dispatch (spec §8). 'none' and 'even' deliberately
  // skip scene detection, quality filtering, OCR and embeddings: a caller
  // asking for one frame at a timestamp must not pay for the full pipeline.
  const frameMode = resolveFrameMode(opts.frames, opts.maxFrames);
  let frames: SelectedFrame[] = [];
  let candidateCount = 0;

  if (frameMode === 'even') {
    const from = opts.start ?? 0;
    const to = opts.end ?? meta.duration;
    // Media is already trimmed to [start,end], so sample in clip time.
    const lo = opts.start !== undefined ? 0 : from;
    const hi = opts.end !== undefined ? meta.duration : to;
    const cands = await sampleEven(video, lo, hi, maxFrames, framesDir);
    candidateCount = cands.length;
    frames = cands.map((c) => ({
      timestamp: c.timestamp, sceneId: 0, image: c.imagePath,
      importance: 0, reasons: ['even_sample'],
      ocrContent: null, transcriptWindow: null, nearestSelectedSimilarity: 0,
    }));
  } else if (frameMode === 'key') {
    // ... existing candidate/quality/OCR/embed/select code unchanged ...
  }

  if (transcript && frames.length > 0) frames = attachTranscript(frames, transcript.segments);
```

Guard the transcript stage too, so `transcript: false` skips it (it already does via `opts.transcript !== false`; confirm and leave).

In `src/manifest.ts`, replace the `mode` parameter and field with `frameMode`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && npx vitest run tests/analyzeShortcircuit.integration.test.ts` → PASS (4 tests).
Then `npx vitest run` — fix fallout in `tests/analyze.integration.test.ts` and `tests/matrix.test.ts` where `mode` was asserted. Do NOT weaken an assertion to make it pass; update it to `frameMode`.

- [ ] **Step 5: Commit**

```bash
git add src/analyze.ts src/manifest.ts tests/analyzeShortcircuit.integration.test.ts
git commit -m "feat: dispatch frame modes and short-circuit cheap requests"
```

---

### Task 4: Capture platform metadata

**Files:**
- Modify: `src/resolve/ytdlp.ts`
- Test: `tests/ytdlpMetadata.test.ts`

**Interfaces:**
- Consumes: `VideoMetadata`, `Chapter` (Task 1).
- Produces: `toVideoMetadata(meta: YtDlpMeta): VideoMetadata`; `YtDlpMeta` gains `chapters`, `description`, `uploader`, `channel`, `upload_date`, `view_count`, `comment_count`; `ResolveOptions.comments` adds `--write-comments`.

Chapters are the highest-value field (§9): they let an agent read a chapter list and analyze only the section that matters, instead of the whole video.

- [ ] **Step 1: Write the failing test**

```ts
// tests/ytdlpMetadata.test.ts
import { describe, it, expect } from 'vitest';
import { toVideoMetadata } from '../src/resolve/ytdlp.js';

describe('toVideoMetadata', () => {
  it('maps chapters with start, end and title', () => {
    const m = toVideoMetadata({
      title: 'T', duration: 100,
      chapters: [{ start_time: 0, end_time: 12, title: 'Intro' },
                 { start_time: 12, end_time: 100, title: 'Demo' }],
    });
    expect(m.chapters).toEqual([
      { start: 0, end: 12, title: 'Intro' },
      { start: 12, end: 100, title: 'Demo' },
    ]);
  });
  it('yields an empty chapter list when the platform provides none', () => {
    expect(toVideoMetadata({ title: 'T' }).chapters).toEqual([]);
  });
  it('prefers uploader over channel for creator', () => {
    expect(toVideoMetadata({ uploader: 'U', channel: 'C' }).creator).toBe('U');
  });
  it('falls back to channel when uploader is absent', () => {
    expect(toVideoMetadata({ channel: 'C' }).creator).toBe('C');
  });
  it('returns null creator when neither is present', () => {
    expect(toVideoMetadata({}).creator).toBeNull();
  });
  it('keeps the full description (truncation belongs to the artifact layer)', () => {
    const long = 'x'.repeat(500);
    expect(toVideoMetadata({ description: long }).description).toHaveLength(500);
  });
  it('carries counts through and nulls them when absent', () => {
    expect(toVideoMetadata({ view_count: 5, comment_count: 2 }).viewCount).toBe(5);
    expect(toVideoMetadata({}).commentCount).toBeNull();
  });
  it('tolerates a malformed chapters value instead of throwing', () => {
    expect(toVideoMetadata({ chapters: 'nope' as never }).chapters).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/ytdlpMetadata.test.ts` → FAIL, `toVideoMetadata` not exported.

- [ ] **Step 3: Implement in `src/resolve/ytdlp.ts`**

Extend `YtDlpMeta`:

```ts
  chapters?: Array<{ start_time?: number; end_time?: number; title?: string }>;
  description?: string | null;
  uploader?: string | null;
  channel?: string | null;
  upload_date?: string | null;
  view_count?: number | null;
  comment_count?: number | null;
```

Add the mapper:

```ts
/** Spec §9. Chapters compose with range extraction: an agent reads them,
 *  then analyzes only the section that matters. */
export function toVideoMetadata(meta: YtDlpMeta): VideoMetadata {
  const raw = Array.isArray(meta.chapters) ? meta.chapters : [];
  return {
    title: meta.title ?? '',
    creator: meta.uploader ?? meta.channel ?? null,
    duration: meta.duration ?? 0,
    chapters: raw.map((c) => ({
      start: c.start_time ?? 0,
      end: c.end_time ?? 0,
      title: c.title ?? '',
    })),
    description: meta.description ?? null,
    uploadDate: meta.upload_date ?? null,
    viewCount: meta.view_count ?? null,
    commentCount: meta.comment_count ?? null,
  };
}
```

In `resolve()`, add `if (opts.comments) args.push('--write-comments');` alongside the other flags, and set `metadata: toVideoMetadata(meta)` on the returned `ResolvedMedia`. Also set `clipStart`/`clipEnd` to `opts.start`/`opts.end` when a range was requested (§5.1).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/ytdlpMetadata.test.ts` → PASS (8 tests). Then `npx vitest run tests/ytdlpCaptions.test.ts` to confirm no regression in the existing caption tests.

- [ ] **Step 5: Commit**

```bash
git add src/resolve/ytdlp.ts tests/ytdlpMetadata.test.ts
git commit -m "feat: capture chapters and richer platform metadata"
```

---

### Task 5: Artifact layer — naming, idempotency, preview

**Files:**
- Create: `src/agent/artifacts.ts`
- Test: `tests/artifacts.test.ts`

**Interfaces:**
- Consumes: `VideoMetadata`, `Manifest`, `Transcript` (Task 1).
- Produces:
  - `descriptionPreview(description: string | null, max?: number): string | null`
  - `mediaFileName(start?: number, end?: number, ext?: string): string`
  - `writeMetadata(dir: string, meta: unknown): string`
  - `writeTranscript(dir: string, t: Transcript): string`
  - `writeManifest(dir: string, m: Manifest): string`
  - `const PREVIEW_CHARS = 125`

Section §7: repeating a call is always safe; varying the range adds an artifact rather than destroying one.

- [ ] **Step 1: Write the failing test**

```ts
// tests/artifacts.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { descriptionPreview, mediaFileName, writeMetadata, PREVIEW_CHARS } from '../src/agent/artifacts.js';

describe('descriptionPreview', () => {
  it('returns null for a null description', () => {
    expect(descriptionPreview(null)).toBeNull();
  });
  it('returns a short description unchanged and unmarked', () => {
    expect(descriptionPreview('short')).toBe('short');
  });
  it('truncates a long description to the preview budget', () => {
    const p = descriptionPreview('y'.repeat(400))!;
    expect(p.length).toBeLessThanOrEqual(PREVIEW_CHARS + 1);
  });
  it('marks a truncated preview so the agent knows more exists', () => {
    expect(descriptionPreview('y'.repeat(400))!.endsWith('…')).toBe(true);
  });
  it('collapses newlines so the preview stays one line', () => {
    expect(descriptionPreview('a\n\nb')).toBe('a b');
  });
});

describe('mediaFileName (spec §7: range is part of identity)', () => {
  it('names a full fetch distinctly from a clip', () => {
    expect(mediaFileName()).not.toBe(mediaFileName(12, 20));
  });
  it('gives the same name for the same range, so a repeat overwrites', () => {
    expect(mediaFileName(12, 20)).toBe(mediaFileName(12, 20));
  });
  it('gives different names for different ranges, so both can coexist', () => {
    expect(mediaFileName(12, 20)).not.toBe(mediaFileName(12, 30));
  });
  it('produces no path separators', () => {
    expect(mediaFileName(1.5, 2.5)).not.toContain('/');
  });
});

describe('writeMetadata', () => {
  it('replaces an existing metadata file rather than duplicating it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'norma-art-'));
    const p1 = writeMetadata(dir, { a: 1 });
    const p2 = writeMetadata(dir, { a: 2 });
    expect(p2).toBe(p1);
    expect(JSON.parse(readFileSync(p1, 'utf8')).a).toBe(2);
  });
  it('creates the directory when it does not exist', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'norma-art-')), 'nested', 'deep');
    const p = writeMetadata(dir, { a: 1 });
    expect(existsSync(p)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/artifacts.test.ts` → FAIL, module not found.

- [ ] **Step 3: Implement `src/agent/artifacts.ts`**

```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Manifest, Transcript } from '../types.js';

/** Spec §2.1: the search-snippet-sized opening, not the whole description. */
export const PREVIEW_CHARS = 125;

export function descriptionPreview(description: string | null, max = PREVIEW_CHARS): string | null {
  if (description === null) return null;
  const flat = description.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max).trimEnd()}…`;
}

const tag = (n: number): string => String(Math.round(n * 100) / 100).replace('.', '_');

/**
 * Spec §7: a clip and a full fetch are different artifacts and must not
 * silently overwrite each other; re-fetching the SAME range must overwrite
 * in place so repeating a call is safe.
 */
export function mediaFileName(start?: number, end?: number, ext = 'mp4'): string {
  if (start === undefined || end === undefined) return `source.${ext}`;
  return `source_${tag(start)}-${tag(end)}.${ext}`;
}

function writeJson(dir: string, name: string, value: unknown): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(value, null, 2));
  return p;
}

/** Metadata describes the source video, not a clip: single file, always replaced. */
export function writeMetadata(dir: string, meta: unknown): string {
  return writeJson(dir, 'metadata.json', meta);
}

export function writeTranscript(dir: string, t: Transcript): string {
  return writeJson(dir, 'transcript.json', t);
}

export function writeManifest(dir: string, m: Manifest): string {
  return writeJson(dir, 'manifest.json', m);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/artifacts.test.ts` → PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add src/agent/artifacts.ts tests/artifacts.test.ts
git commit -m "feat: add artifact naming, idempotent writes and description preview"
```

---

### Task 6: `resolve_video` handler

**Files:**
- Create: `src/agent/resolveTool.ts`
- Test: `tests/resolveTool.test.ts`

**Interfaces:**
- Consumes: `resolve` (`src/resolve/index.ts`); artifacts (Task 5); `VideoMetadata` (Task 1).
- Produces: `resolveVideoTool(args: { url: string; destinationPath: string; returnVideo?: boolean; start?: number; end?: number; comments?: boolean }): Promise<ResolveToolResult>`

`ResolveToolResult` on success: `{ status, platform, title, creator, duration, chapters, descriptionPreview, commentCount, metadataPath, videoPath?, clipStart?, clipEnd?, nextSteps?, note? }`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/resolveTool.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const resolveMock = vi.fn();
vi.mock('../src/resolve/index.js', () => ({ resolve: (...a: unknown[]) => resolveMock(...a) }));
const { resolveVideoTool } = await import('../src/agent/resolveTool.js');
afterEach(() => resolveMock.mockReset());

const ok = (over: Record<string, unknown> = {}) => ({
  status: 'ok', filePath: '/x/source.mp4', platform: 'youtube', title: 'T',
  duration: 100, resolvedBy: 'ytdlp', captions: { manual: null, auto: null },
  languageHint: null, rangeApplied: false,
  metadata: {
    title: 'T', creator: 'C', duration: 100,
    chapters: [{ start: 0, end: 12, title: 'Intro' }],
    description: 'z'.repeat(400), uploadDate: null, viewCount: 9, commentCount: 3,
  },
  ...over,
});

describe('resolveVideoTool', () => {
  it('does not fetch media by default (spec §2.1)', async () => {
    resolveMock.mockResolvedValue(ok());
    const dir = mkdtempSync(join(tmpdir(), 'norma-rt-'));
    const r = await resolveVideoTool({ url: 'https://x/v', destinationPath: dir });
    expect(resolveMock.mock.calls[0]![1]).toMatchObject({ returnVideo: false });
    expect(r.videoPath).toBeUndefined();
  });

  it('tells the agent both ways forward when it withheld the media', async () => {
    resolveMock.mockResolvedValue(ok());
    const dir = mkdtempSync(join(tmpdir(), 'norma-rt-'));
    const r = await resolveVideoTool({ url: 'https://x/v', destinationPath: dir });
    expect(r.nextSteps).toMatch(/returnVideo/);
    expect(r.nextSteps).toMatch(/analyze_video/);
  });

  it('omits next-steps guidance once the media has been fetched', async () => {
    resolveMock.mockResolvedValue(ok());
    const dir = mkdtempSync(join(tmpdir(), 'norma-rt-'));
    const r = await resolveVideoTool({ url: 'https://x/v', destinationPath: dir, returnVideo: true });
    expect(r.nextSteps).toBeUndefined();
  });

  it('surfaces title, creator, duration and chapters inline', async () => {
    resolveMock.mockResolvedValue(ok());
    const dir = mkdtempSync(join(tmpdir(), 'norma-rt-'));
    const r = await resolveVideoTool({ url: 'https://x/v', destinationPath: dir });
    expect(r.title).toBe('T');
    expect(r.creator).toBe('C');
    expect(r.duration).toBe(100);
    expect(r.chapters).toEqual([{ start: 0, end: 12, title: 'Intro' }]);
  });

  it('sends only a preview inline and the full description to the file', async () => {
    resolveMock.mockResolvedValue(ok());
    const dir = mkdtempSync(join(tmpdir(), 'norma-rt-'));
    const r = await resolveVideoTool({ url: 'https://x/v', destinationPath: dir });
    expect(r.descriptionPreview!.length).toBeLessThanOrEqual(126);
    const saved = JSON.parse(readFileSync(r.metadataPath, 'utf8'));
    expect(saved.description).toHaveLength(400);
  });

  it('never returns comments inline, only their count (spec §2.1)', async () => {
    resolveMock.mockResolvedValue(ok());
    const dir = mkdtempSync(join(tmpdir(), 'norma-rt-'));
    const r = await resolveVideoTool({ url: 'https://x/v', destinationPath: dir, comments: true });
    expect(r.commentCount).toBe(3);
    expect(JSON.stringify(r)).not.toContain('"comments"');
  });

  it('warns that a clipped file starts at zero (spec §5.1)', async () => {
    resolveMock.mockResolvedValue(ok({ clipStart: 724, clipEnd: 1200 }));
    const dir = mkdtempSync(join(tmpdir(), 'norma-rt-'));
    const r = await resolveVideoTool({
      url: 'https://x/v', destinationPath: dir, returnVideo: true, start: 724, end: 1200,
    });
    expect(r.note).toMatch(/starts at 0|begins at zero/i);
    expect(r.note).toContain('724');
  });

  it('returns a failure shape without throwing', async () => {
    resolveMock.mockResolvedValue({ status: 'unsupported', reason: 'drm_protected', message: 'DRM' });
    const dir = mkdtempSync(join(tmpdir(), 'norma-rt-'));
    const r = await resolveVideoTool({ url: 'https://x/v', destinationPath: dir });
    expect(r.status).toBe('unsupported');
    expect(r.videoPath).toBeUndefined();
  });

  it('writes metadata even on the metadata-only path', async () => {
    resolveMock.mockResolvedValue(ok());
    const dir = mkdtempSync(join(tmpdir(), 'norma-rt-'));
    const r = await resolveVideoTool({ url: 'https://x/v', destinationPath: dir });
    expect(existsSync(r.metadataPath)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/resolveTool.test.ts` → FAIL, module not found.

- [ ] **Step 3: Implement `src/agent/resolveTool.ts`**

```ts
import { mkdirSync, renameSync, copyFileSync, existsSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Chapter } from '../types.js';
import { resolve } from '../resolve/index.js';
import { descriptionPreview, mediaFileName, writeMetadata } from './artifacts.js';

export interface ResolveToolResult {
  status: string;
  reason?: string;
  platform?: string;
  title?: string;
  creator?: string | null;
  duration?: number;
  chapters?: Chapter[];
  descriptionPreview?: string | null;
  commentCount?: number | null;
  metadataPath: string;
  videoPath?: string;
  clipStart?: number;
  clipEnd?: number;
  nextSteps?: string;
  note?: string;
}

export interface ResolveToolArgs {
  url: string;
  destinationPath: string;
  returnVideo?: boolean;
  start?: number;
  end?: number;
  comments?: boolean;
}

export async function resolveVideoTool(args: ResolveToolArgs): Promise<ResolveToolResult> {
  const returnVideo = args.returnVideo ?? false;
  mkdirSync(args.destinationPath, { recursive: true });

  const workDir = mkdtempSync(join(tmpdir(), 'norma-res-'));
  const r = await resolve(args.url, {
    workDir,
    returnVideo,
    comments: args.comments ?? false,
    start: returnVideo ? args.start : undefined,
    end: returnVideo ? args.end : undefined,
  });

  if (r.status !== 'ok') {
    // Failure still writes what little we know, so the shape is stable.
    const metadataPath = writeMetadata(args.destinationPath, r);
    return { status: r.status, reason: r.message, metadataPath };
  }

  const metadataPath = writeMetadata(args.destinationPath, {
    url: args.url, platform: r.platform, resolvedBy: r.resolvedBy,
    clipStart: r.clipStart, clipEnd: r.clipEnd,
    captions: r.captions, languageHint: r.languageHint,
    ...(r.metadata ?? {}),
  });

  let videoPath: string | undefined;
  if (returnVideo && existsSync(r.filePath)) {
    // Range is part of artifact identity (spec §7): a clip and a full fetch
    // coexist; re-fetching the SAME range overwrites in place.
    videoPath = join(args.destinationPath, mediaFileName(r.clipStart, r.clipEnd));
    try { renameSync(r.filePath, videoPath); }
    catch { copyFileSync(r.filePath, videoPath); }
  }

  const clipped = r.clipStart !== undefined && r.clipEnd !== undefined;
  return {
    status: 'ok',
    platform: r.platform,
    title: r.metadata?.title ?? r.title,
    creator: r.metadata?.creator ?? null,
    duration: r.metadata?.duration ?? r.duration,
    chapters: r.metadata?.chapters ?? [],
    descriptionPreview: descriptionPreview(r.metadata?.description ?? null),
    commentCount: r.metadata?.commentCount ?? null,
    metadataPath,
    ...(videoPath ? { videoPath } : {}),
    ...(clipped ? { clipStart: r.clipStart, clipEnd: r.clipEnd } : {}),
    ...(returnVideo ? {} : {
      nextSteps:
        'Media was not downloaded. To fetch it, call resolve_video again with '
        + 'returnVideo: true (optionally with start/end to fetch only a section). '
        + 'To go straight to analysis, call analyze_video with this same URL.',
    }),
    ...(clipped && videoPath ? {
      note:
        `The saved file is a clip and STARTS AT 0 -- it covers ${r.clipStart}s to `
        + `${r.clipEnd}s of the original. Timestamps passed to analyze_video against `
        + `this file are relative to the clip, so add ${r.clipStart} to convert back to `
        + 'original-video time. Passing the original URL instead keeps original timestamps.',
    } : {}),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/resolveTool.test.ts` → PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/agent/resolveTool.ts tests/resolveTool.test.ts
git commit -m "feat: add resolve_video handler with metadata-first behaviour"
```

---

### Task 7: `analyze_video` handler

**Files:**
- Create: `src/agent/analyzeTool.ts`
- Test: `tests/analyzeTool.test.ts`

**Interfaces:**
- Consumes: `analyzeVideo` (Task 3); artifacts (Task 5).
- Produces: `analyzeVideoTool(args: { pathOrUrl: string; destinationPath: string; start?: number; end?: number; frames?: FrameMode; maxFrames?: number; transcript?: boolean; language?: string }): Promise<AnalyzeToolResult>`

`AnalyzeToolResult`: `{ status, title, duration, frameCount, framePaths, transcriptPath?, transcript?, manifestPath, videoPath?, warnings }`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/analyzeTool.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const analyzeMock = vi.fn();
vi.mock('../src/analyze.js', () => ({ analyzeVideo: (...a: unknown[]) => analyzeMock(...a) }));
const { analyzeVideoTool } = await import('../src/agent/analyzeTool.js');
afterEach(() => analyzeMock.mockReset());

const manifest = (over: Record<string, unknown> = {}) => ({
  source: { url: 'u', platform: 'p', title: 'T', duration: 10, resolvedBy: 'ytdlp', status: 'ok', filePath: '/x/work.mp4' },
  transcript: { language: 'en', source: 'asr', segments: [{ start: 0, end: 1, text: 'hi' }] },
  frames: [{ timestamp: 1, sceneId: 0, image: '/x/f1.jpg', importance: 0.5, reasons: [], ocrContent: null, transcriptWindow: null, nearestSelectedSimilarity: 0 }],
  processing: { selectedFrames: 1, candidateFrames: 3, peakRssMb: 100, selectorVersion: '1', frameMode: 'key', warnings: [] },
  ...over,
});

describe('analyzeVideoTool', () => {
  it('always writes the transcript to disk, even when returning it inline', async () => {
    analyzeMock.mockResolvedValue(manifest());
    const dir = mkdtempSync(join(tmpdir(), 'norma-at-'));
    const r = await analyzeVideoTool({ pathOrUrl: 'https://x/v', destinationPath: dir });
    expect(existsSync(r.transcriptPath!)).toBe(true);
    expect(r.transcript).toBeDefined();
  });

  it('writes the transcript but omits it inline when it is long', async () => {
    const segments = Array.from({ length: 800 }, (_, i) => ({ start: i, end: i + 1, text: `line ${i}` }));
    analyzeMock.mockResolvedValue(manifest({ transcript: { language: 'en', source: 'asr', segments } }));
    const dir = mkdtempSync(join(tmpdir(), 'norma-at-'));
    const r = await analyzeVideoTool({ pathOrUrl: 'https://x/v', destinationPath: dir });
    expect(existsSync(r.transcriptPath!)).toBe(true);
    expect(r.transcript).toBeUndefined();
    expect(JSON.parse(readFileSync(r.transcriptPath!, 'utf8')).segments).toHaveLength(800);
  });

  it('always writes the manifest and returns its path', async () => {
    analyzeMock.mockResolvedValue(manifest());
    const dir = mkdtempSync(join(tmpdir(), 'norma-at-'));
    const r = await analyzeVideoTool({ pathOrUrl: 'https://x/v', destinationPath: dir });
    expect(existsSync(r.manifestPath)).toBe(true);
  });

  it('passes destinationPath down so the video lands there (spec §2.2)', async () => {
    analyzeMock.mockResolvedValue(manifest());
    const dir = mkdtempSync(join(tmpdir(), 'norma-at-'));
    await analyzeVideoTool({ pathOrUrl: 'https://x/v', destinationPath: dir });
    expect(analyzeMock.mock.calls[0]![1]).toMatchObject({ destinationPath: dir });
  });

  it('forwards language as the explicit override (spec §4)', async () => {
    analyzeMock.mockResolvedValue(manifest());
    const dir = mkdtempSync(join(tmpdir(), 'norma-at-'));
    await analyzeVideoTool({ pathOrUrl: 'https://x/v', destinationPath: dir, language: 'ja' });
    expect(analyzeMock.mock.calls[0]![1]).toMatchObject({ preferredLanguage: 'ja' });
  });

  it('surfaces a failure manifest without throwing', async () => {
    analyzeMock.mockResolvedValue(manifest({
      source: { url: 'u', platform: 'unknown', title: '', duration: 0, resolvedBy: 'none', status: 'unsupported', reason: 'drm_protected' },
      transcript: null, frames: [],
    }));
    const dir = mkdtempSync(join(tmpdir(), 'norma-at-'));
    const r = await analyzeVideoTool({ pathOrUrl: 'https://x/v', destinationPath: dir });
    expect(r.status).toBe('unsupported');
    expect(r.frameCount).toBe(0);
  });

  it('reports degradation warnings so silent failure is visible', async () => {
    analyzeMock.mockResolvedValue(manifest({
      processing: { selectedFrames: 1, candidateFrames: 3, peakRssMb: 100, selectorVersion: '1', frameMode: 'key', warnings: ['ocr unavailable'] },
    }));
    const dir = mkdtempSync(join(tmpdir(), 'norma-at-'));
    const r = await analyzeVideoTool({ pathOrUrl: 'https://x/v', destinationPath: dir });
    expect(r.warnings).toEqual(['ocr unavailable']);
  });

  it('omits transcriptPath entirely when no transcript was produced', async () => {
    analyzeMock.mockResolvedValue(manifest({ transcript: null }));
    const dir = mkdtempSync(join(tmpdir(), 'norma-at-'));
    const r = await analyzeVideoTool({ pathOrUrl: 'https://x/v', destinationPath: dir });
    expect(r.transcriptPath).toBeUndefined();
  });

  it('does not copy a local source into destinationPath (spec §2.1)', async () => {
    // A clip the agent already placed must not be duplicated: videoPath
    // points at the existing file, and no copy of it appears alongside
    // the manifest. Catches an implementation that copies unconditionally.
    const src = mkdtempSync(join(tmpdir(), 'norma-src-'));
    const local = join(src, 'clip.mp4');
    writeFileSync(local, 'not-real-video');
    analyzeMock.mockResolvedValue(manifest({
      source: { url: local, platform: 'local', title: 'T', duration: 10, resolvedBy: 'direct', status: 'ok', filePath: local },
    }));
    const dir = mkdtempSync(join(tmpdir(), 'norma-at-'));
    const r = await analyzeVideoTool({ pathOrUrl: local, destinationPath: dir });
    expect(r.videoPath).toBe(local);
    expect(readdirSync(dir).filter((f) => f.endsWith('.mp4'))).toEqual([]);
  });
});
```

Add `writeFileSync` and `readdirSync` to the `node:fs` import at the top of this test file.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/analyzeTool.test.ts` → FAIL, module not found.

- [ ] **Step 3: Implement `src/agent/analyzeTool.ts`**

```ts
import { mkdirSync } from 'node:fs';
import type { FrameMode, Transcript } from '../types.js';
import { analyzeVideo } from '../analyze.js';
import { writeManifest, writeTranscript } from './artifacts.js';

/** Above this, the transcript goes to disk only -- a long transcript is
 *  exactly the payload destinationPath exists to keep out of context. */
export const INLINE_TRANSCRIPT_MAX_CHARS = 8000;

export interface AnalyzeToolResult {
  status: string;
  reason?: string;
  title: string;
  duration: number;
  frameCount: number;
  framePaths: string[];
  transcript?: Transcript;
  transcriptPath?: string;
  manifestPath: string;
  videoPath?: string;
  warnings: string[];
}

export interface AnalyzeToolArgs {
  pathOrUrl: string;
  destinationPath: string;
  start?: number;
  end?: number;
  frames?: FrameMode;
  maxFrames?: number;
  transcript?: boolean;
  language?: string;
}

function transcriptChars(t: Transcript): number {
  return t.segments.reduce((n, s) => n + s.text.length, 0);
}

export async function analyzeVideoTool(args: AnalyzeToolArgs): Promise<AnalyzeToolResult> {
  mkdirSync(args.destinationPath, { recursive: true });

  const m = await analyzeVideo(args.pathOrUrl, {
    start: args.start,
    end: args.end,
    frames: args.frames,
    maxFrames: args.maxFrames,
    transcript: args.transcript,
    // Spec §4: an explicit language is the override; it outranks metadata.
    preferredLanguage: args.language,
    destinationPath: args.destinationPath,
    outDir: args.destinationPath,
  });

  const manifestPath = writeManifest(args.destinationPath, m);

  // Spec §3: the transcript is ALWAYS written, and additionally returned
  // inline only when short enough to be worth the context.
  let transcriptPath: string | undefined;
  let inline: Transcript | undefined;
  if (m.transcript) {
    transcriptPath = writeTranscript(args.destinationPath, m.transcript);
    if (transcriptChars(m.transcript) <= INLINE_TRANSCRIPT_MAX_CHARS) inline = m.transcript;
  }

  return {
    status: m.source.status,
    ...(m.source.reason ? { reason: m.source.reason } : {}),
    title: m.source.title,
    duration: m.source.duration,
    frameCount: m.frames.length,
    framePaths: m.frames.map((f) => f.image),
    ...(inline ? { transcript: inline } : {}),
    ...(transcriptPath ? { transcriptPath } : {}),
    manifestPath,
    ...(m.source.filePath ? { videoPath: m.source.filePath } : {}),
    warnings: m.processing.warnings,
  };
}
```

Note `destinationPath` is passed through **as well as** `outDir` — `AnalyzeOptions` carries both (Task 1), and the Step 1 test asserts the former reaches `analyzeVideo`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/analyzeTool.test.ts` → PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/agent/analyzeTool.ts tests/analyzeTool.test.ts
git commit -m "feat: add analyze_video handler with disk-first output"
```

---

### Task 8: Rewrite the MCP surface

**Files:**
- Modify: `src/mcp.ts`, `tests/mcp.test.ts`
- Test: `tests/mcp.test.ts`

**Interfaces:**
- Consumes: `resolveVideoTool` (Task 6), `analyzeVideoTool` (Task 7).
- Produces: `TOOL_NAMES = ['resolve_video', 'analyze_video']`; `buildServer()` unchanged in signature.

The descriptions are the agent-facing contract and carry as much weight as the code. They must state: the platforms genuinely exercised and that others may or may not work (§6); that a range may not apply and yields the full video; that `resolve_video` still downloads media when `returnVideo` is true; that a clipped file starts at zero (§5.1); and the comments cost. `analyze_video`'s description must **not** market itself as a download tool — `filePath` appears once, as an output useful for follow-up calls.

- [ ] **Step 1: Write the failing test**

```ts
// add to tests/mcp.test.ts
import { describe, it, expect } from 'vitest';
import { buildServer, TOOL_NAMES } from '../src/mcp.js';

describe('v2 surface', () => {
  it('exposes exactly two tools', () => {
    expect([...TOOL_NAMES].sort()).toEqual(['analyze_video', 'resolve_video']);
  });
  it('no longer exposes get_frame or get_clip', () => {
    expect(TOOL_NAMES).not.toContain('get_frame');
    expect(TOOL_NAMES).not.toContain('get_clip');
  });
  it('builds without throwing', () => {
    expect(() => buildServer()).not.toThrow();
  });
});
```

Then, using the in-memory client already used by this file's existing tests, assert: `analyze_video` rejects a call missing `destinationPath`; `resolve_video` rejects a call missing `destinationPath`; `analyze_video` accepts `frames: 'even'` and rejects `frames: 'dense'`.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/mcp.test.ts` → FAIL: four tools are still registered.

- [ ] **Step 3: Rewrite `src/mcp.ts`**

Keep the existing imports of `McpServer`, `StdioServerTransport`, `z` and `isMainModule`. Replace the four registrations with these two, and delete the `analyzeVideo`/`getFrame`/`getClip`/`resolve` imports in favour of the two handlers.

```ts
import { resolveVideoTool } from './agent/resolveTool.js';
import { analyzeVideoTool } from './agent/analyzeTool.js';

export const TOOL_NAMES = ['resolve_video', 'analyze_video'] as const;

const PLATFORMS =
  'Known-working sources: YouTube, TikTok, Facebook and Reels, X/Twitter, Instagram, '
  + 'Twitch, Vimeo, Reddit, WeChat Channels, and direct .mp4/.m3u8 URLs. Many other '
  + 'sites work through generic extraction; some will not, and those return a clear '
  + 'failure status rather than throwing.';

export function buildServer(): McpServer {
  const server = new McpServer(
    { name: 'norma-video', version: '2.0.0' },
    {
      instructions:
        'Video extraction for AI agents, in two tools. resolve_video looks a video up '
        + 'and, by default, returns only its metadata -- title, creator, duration and '
        + 'chapters -- without downloading anything heavy; pass returnVideo: true when '
        + 'you actually want the media file. analyze_video does the real work: transcript '
        + 'plus important, deduplicated keyframes. Both write their output to a directory '
        + 'you choose (destinationPath), returning a compact summary plus file paths '
        + 'rather than dumping everything into the conversation. A good habit on a long '
        + 'video is to call resolve_video first, read the chapter list, then call '
        + 'analyze_video with start/end covering only the chapter that matters -- for '
        + 'supported sources that downloads just that section instead of the whole video.',
    },
  );

  server.registerTool(
    'resolve_video',
    {
      title: 'Resolve video (metadata, optionally the file)',
      description:
        'Looks up a video and writes what it finds to destinationPath. By DEFAULT it '
        + 'returns metadata only and does NOT download the media: title, creator, '
        + 'duration, chapter list (when the platform provides one), a short description '
        + 'preview, and a path to the full metadata file. That is the cheap way to decide '
        + 'what to do next. Set returnVideo: true to also download the media file -- that '
        + 'is a real download and takes real time. With returnVideo: true you may also '
        + 'pass start/end to fetch only a section; for supported sources only that section '
        + 'is downloaded, and a fetched clip STARTS AT 0 rather than at the original '
        + 'timestamp (the result says so, and gives the offset). Use this tool when you '
        + 'only need to know what a video is, or when you want the video file itself '
        + 'without any analysis. ' + PLATFORMS + ' Comments are off by default and can be '
        + 'slow to fetch on popular videos; when enabled they are written to the metadata '
        + 'file, never returned inline.',
      inputSchema: {
        url: z.string().describe('Page or direct video URL.'),
        destinationPath: z.string().describe('Directory to write metadata (and the video, if requested) into. Created if missing. Re-running the same call overwrites in place.'),
        returnVideo: z.boolean().optional().default(false).describe('Download the media file as well as its metadata. Default false -- metadata only.'),
        start: z.number().optional().describe('Start second of the section to fetch. Only meaningful with returnVideo: true.'),
        end: z.number().optional().describe('End second of the section to fetch. Only meaningful with returnVideo: true.'),
        comments: z.boolean().optional().default(false).describe('Also fetch comments into the metadata file. Off by default: can be very slow on popular videos.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      const r = await resolveVideoTool(args);
      return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
    },
  );

  server.registerTool(
    'analyze_video',
    {
      title: 'Analyze video',
      description:
        'Given a video URL or a local video file, returns its transcript and a small set '
        + 'of important, deduplicated keyframes -- not every frame, just the ones that '
        + 'carry information (scene changes, on-screen text, visual novelty). Output is '
        + 'written to destinationPath: a manifest, the transcript, and the frame images; '
        + 'the reply is a summary plus those paths, with the transcript included inline '
        + 'when it is short. Use start/end to analyze only part of a video -- for '
        + 'supported sources only that section is downloaded, and the transcript covers '
        + 'just that section. frames controls how frames are chosen: "key" (default) picks '
        + 'the most informative ones, "even" samples the range uniformly (maxFrames over '
        + 'the window sets the density, so 60 frames across 30 seconds is 2 per second), '
        + 'and "none" returns no frames at all, which is how you ask for a transcript '
        + 'alone. For a single exact frame, set start and end to the same second with '
        + 'frames: "even" and maxFrames: 1. On failure this returns a result whose status '
        + 'is not "ok" with a readable reason, rather than throwing -- always check status '
        + 'first. Check warnings too: any optional stage that failed and was skipped past '
        + '(on-screen text, image analysis, speech recognition) records an entry there, so '
        + 'an empty transcript can be told apart from a video that simply has no speech. '
        + 'The result also carries videoPath, the local file it worked from, which you can '
        + 'pass straight back in to inspect another moment without re-downloading. '
        + PLATFORMS,
      inputSchema: {
        pathOrUrl: z.string().describe('A video URL, or a path to a video file already on this machine. Both are accepted.'),
        destinationPath: z.string().describe('Directory to write the manifest, transcript and frames into. Created if missing.'),
        start: z.number().optional().describe('Start second of the range to analyze. Provide with end; either alone is ignored. Note that if pathOrUrl is a clip previously fetched with a range, times are relative to that clip, which starts at 0.'),
        end: z.number().optional().describe('End second of the range. Set equal to start for a single instant.'),
        frames: z.enum(['key', 'even', 'none']).optional().default('key').describe('"key": the most informative frames, deduplicated. "even": uniform sampling across the range. "none": no frames (transcript only).'),
        maxFrames: z.number().optional().default(35).describe('Maximum frames to return. With frames "even" this sets density across the range. 0 means the same as frames: "none".'),
        transcript: z.boolean().optional().default(true).describe('Produce a transcript. Set false to skip transcription entirely when you only want frames.'),
        language: z.string().optional().describe('Language hint such as "zh", "ja" or "en". Usually inferred from the platform; supply it when the source carries no language metadata or the guess is wrong.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      const r = await analyzeVideoTool(args);
      return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
    },
  );

  return server;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/mcp.test.ts` → PASS. Then `npx vitest run` — the whole suite must be green.

- [ ] **Step 5: Commit**

```bash
git add src/mcp.ts tests/mcp.test.ts
git commit -m "feat: collapse the MCP surface to resolve_video and analyze_video"
```

---

### Task 9: Sweep and documentation

**Files:**
- Modify: `src/primitives.ts` (comment only), `scripts/matrix.ts`, `docs/acceptance-matrix.md`, `README.md` if present
- Test: existing suite

**Interfaces:**
- Consumes: everything above.
- Produces: no new exports.

- [ ] **Step 1: Confirm nothing references removed options**

Run: `grep -rn "mode:" src/ scripts/ tests/ | grep -v frameMode` and `grep -rn "getClip\|getFrame" src/ scripts/`.
`getFrame`/`getClip` may remain in `src/primitives.ts` as internal helpers, but must no longer be reachable from `src/mcp.ts`. Record what you found.

- [ ] **Step 2: Update the matrix runner**

`scripts/matrix.ts` passes `AnalyzeOptions`; remove any `mode` usage and set `destinationPath` per case. Keep the honest skip reporting intact.

- [ ] **Step 3: Note the internal-only status of the primitives**

Add a comment at the top of `src/primitives.ts` recording that `getFrame`/`getClip` are no longer exposed as MCP tools and are retained as internal helpers, so a future reader does not delete them as dead code or re-expose them.

- [ ] **Step 4: Run the full suite and typecheck**

Run: `npx vitest run` → all green.
Run: `npm run typecheck` → clean.
Run: `npm run matrix` → still reports honestly, still exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/primitives.ts scripts/matrix.ts docs/acceptance-matrix.md
git commit -m "refactor: sweep v1 surface remnants and update the matrix"
```

---

## Deferred

Byte-range fetching for direct/WeChat sources; chapter-name matching in range requests; everything already recorded in `docs/follow-ups.md`.
