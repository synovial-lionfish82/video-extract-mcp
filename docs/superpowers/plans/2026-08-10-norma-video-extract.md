# Norma Universal Video Extraction — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a proof-of-concept Node/TypeScript engine that turns any video URL into a timestamped transcript plus a small set of important, deduplicated, transcript-aligned keyframes, returned as a JSON manifest for an AI agent.

**Architecture:** A single-runtime TypeScript library. A resolver layer (yt-dlp / direct / WeChat) yields a local media file; FFmpeg normalizes it to a 720p working video plus 16 kHz mono audio; two *sequential, short-lived worker processes* (ASR, then vision) do the heavy model work so they are never co-resident; a pure-logic selector picks frames using iterative diversity-aware scoring; results are aligned and emitted as a manifest.

**Tech Stack:** Node 26 (ESM, TypeScript), vitest, `sherpa-onnx-node` (Silero VAD + Whisper + SenseVoice), `@huggingface/transformers` (SigLIP ONNX), `sharp`, `@modelcontextprotocol/sdk`, and the CLI binaries `ffmpeg`/`ffprobe`/`yt-dlp`/`tesseract`.

**Spec:** `docs/superpowers/specs/2026-08-10-norma-video-extract-design.md`. Section references below (§N) point there.

## Global Constraints

Every task's requirements implicitly include this section.

- **No Python. Anywhere.** Single-runtime TypeScript/Node is a hard product principle (§3). If a task seems to need Python, stop and raise it.
- **Node 26 / darwin-arm64**, ESM (`"type": "module"`), TypeScript strict mode.
- **Heavy models are NEVER co-resident.** ASR (sherpa-onnx) and vision (SigLIP) run in separate child processes that exit before the next starts (§4). Never `import` both in the orchestrator.
- **Target <2 GB peak RSS for the complete tool**, measured — not assumed (§4, §20).
- **SigLIP must be loaded as `SiglipVisionModel` + `AutoProcessor`, reading `pooler_output` (768 dims).** VERIFIED TRAP: `pipeline('image-feature-extraction', ...)` silently returns **raw pixel values (150528 dims)**, not embeddings — a selector built on it would dedupe on pixels and appear to work. Never use the pipeline helper for embeddings.
- **Verified environment facts** (probed 2026-08-10, do not re-litigate): `sherpa-onnx-node@1.13.4` loads on Node 26/arm64 and exports `Vad`, `OfflineRecognizer`, `SpokenLanguageIdentification`; `@huggingface/transformers@4.2.0` + `Xenova/siglip-base-patch16-224` (dtype `q8`) yields 768-dim embeddings at ~28 ms/frame, ~442 MB RSS; `ffmpeg 8.0.1` has the `scdet` filter.
- **Secrets are never logged or written to the manifest** (WeChat cookie especially).
- **Do NOT touch `experiments/wechat-clean-room/`** — a parallel agent owns that directory. `src/resolve/wechat.ts` in this plan is a thin adapter with a stub, designed so that agent's module can be swapped in later.
- **Commit after every task.** Conventional commit messages (`feat:`, `test:`, `chore:`).

---

## File Structure

| File | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `vitest.config.ts` | Project config, scripts, strict TS |
| `scripts/preflight.ts` | Verify/upgrade external binaries + models |
| `scripts/fetch-models.sh` | Download sherpa-onnx VAD/ASR models |
| `src/types.ts` | All shared types (single source of truth) |
| `src/util/run.ts` | Subprocess helper (exec + stream) |
| `src/util/rss.ts` | Peak-RSS sampler across self + children |
| `src/media/ffmpeg.ts` | probe, normalize (720p + 16 kHz), trim, extract frames |
| `src/media/scenes.ts` | `SceneDetector` interface + `FFmpegSceneDetector` |
| `src/media/candidates.ts` | Scene boundaries + heartbeat → candidate timestamps |
| `src/resolve/index.ts` | Resolver registry + dispatch order |
| `src/resolve/direct.ts` | `DirectMediaResolver` |
| `src/resolve/ytdlp.ts` | `YtDlpResolver` (+ range download, caption tiers) |
| `src/resolve/wechat.ts` | `WeChatHeadlessResolver` adapter (stub for now) |
| `src/transcript/captions.ts` | VTT parsing + caption tier selection |
| `src/transcript/routing.ts` | Pure ASR engine routing decision |
| `src/transcript/asr.ts` | Driver: spawns ASR worker, returns transcript |
| `src/transcript/asrWorker.ts` | **Worker process**: sherpa-onnx VAD + Whisper/SenseVoice |
| `src/vision/quality.ts` | Blur / black / white rejection (sharp) |
| `src/vision/ocr.ts` | tesseract + subtitle-region classification |
| `src/vision/embed.ts` | Driver: spawns vision worker, returns embeddings |
| `src/vision/embedWorker.ts` | **Worker process**: SigLIP embeddings |
| `src/vision/select.ts` | **The differentiator**: iterative diversity-aware selector (pure) |
| `src/align.ts` | Frame ↔ transcript windowing (pure) |
| `src/manifest.ts` | Assemble final manifest |
| `src/analyze.ts` | `analyzeVideo()` orchestrator (staged workers) |
| `src/cli.ts` | CLI entry |
| `src/mcp.ts` | MCP server + power primitives |
| `scripts/matrix.ts` | Acceptance matrix runner |

Pure-logic modules (`select.ts`, `align.ts`, `routing.ts`, `captions.ts`, `quality.ts` thresholds, subtitle classification) are unit-tested. Network/binary paths are proven by the acceptance matrix (§20).

---

### Task 1: Project scaffold and environment preflight

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore` (exists — extend), `scripts/preflight.ts`
- Test: `tests/preflight.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `checkBinary(name: string, minVersion?: string): Promise<BinaryStatus>` where `BinaryStatus = { name: string; present: boolean; version: string | null; ok: boolean; note?: string }`.

- [ ] **Step 1: Initialize the Node project**

Run from the project root (the directory containing `docs/`):

```bash
npm init -y
npm pkg set type=module name=norma-video main=dist/index.js
npm install sherpa-onnx-node@1.13.4 @huggingface/transformers@4.2.0 sharp@0.35.3 @modelcontextprotocol/sdk@1.30.0
npm install -D typescript@5 vitest@3 @types/node tsx
```

- [ ] **Step 2: Add `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "resolveJsonModule": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Add `vitest.config.ts` and npm scripts**

```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/**/*.test.ts'], testTimeout: 30_000 } });
```

```bash
npm pkg set scripts.test="vitest run" scripts.build="tsc" \
  scripts.preflight="tsx scripts/preflight.ts" scripts.cli="tsx src/cli.ts"
```

- [ ] **Step 4: Write the failing test**

```ts
// tests/preflight.test.ts
import { describe, it, expect } from 'vitest';
import { checkBinary, parseVersion } from '../scripts/preflight.js';

describe('preflight', () => {
  it('parses a yt-dlp style date version', () => {
    expect(parseVersion('2026.07.04')).toBe('2026.07.04');
  });
  it('reports a missing binary as not ok', async () => {
    const s = await checkBinary('definitely-not-a-real-binary-xyz');
    expect(s.present).toBe(false);
    expect(s.ok).toBe(false);
  });
  it('finds ffmpeg', async () => {
    const s = await checkBinary('ffmpeg');
    expect(s.present).toBe(true);
  });
});
```

- [ ] **Step 5: Run it to make sure it fails**

Run: `npx vitest run tests/preflight.test.ts`
Expected: FAIL — cannot resolve `../scripts/preflight.js`.

- [ ] **Step 6: Implement `scripts/preflight.ts`**

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const pexec = promisify(execFile);

export interface BinaryStatus {
  name: string; present: boolean; version: string | null; ok: boolean; note?: string;
}

export function parseVersion(raw: string): string {
  const m = raw.match(/\d+(?:\.\d+)+/);
  return m ? m[0] : raw.trim();
}

export async function checkBinary(name: string, versionArg = '--version'): Promise<BinaryStatus> {
  try {
    const { stdout } = await pexec(name, [versionArg]);
    return { name, present: true, version: parseVersion(stdout), ok: true };
  } catch {
    return { name, present: false, version: null, ok: false, note: 'not found on PATH' };
  }
}

const REQUIRED = ['ffmpeg', 'ffprobe', 'yt-dlp', 'tesseract'];

export async function main(): Promise<void> {
  const results = await Promise.all(REQUIRED.map((b) => checkBinary(b)));
  for (const r of results) console.log(`${r.ok ? 'OK  ' : 'MISS'} ${r.name} ${r.version ?? ''}`);

  // yt-dlp staleness: releases are date-versioned; anything older than ~3 months
  // routinely fails on current YouTube.
  const ytdlp = results.find((r) => r.name === 'yt-dlp');
  if (ytdlp?.version && ytdlp.version < '2026.06.00') {
    console.warn(`\nyt-dlp ${ytdlp.version} is stale -> run: brew upgrade yt-dlp`);
  }

  const { stdout: langs } = await pexec('tesseract', ['--list-langs']).catch(() => ({ stdout: '' }));
  if (!langs.includes('chi_sim')) {
    console.warn('tesseract lacks chi_sim (needed for WeChat OCR) -> run: brew install tesseract-lang');
  }
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) void main();
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run tests/preflight.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 8: Fix the two environment gaps preflight reports**

The installed yt-dlp is `2025.12.08`; latest is `2026.07.04` (~7 months stale — it will fail on current YouTube). Tesseract has only `eng`/`osd`/`snum`, so WeChat/Chinese OCR is impossible until language data is installed.

```bash
brew upgrade yt-dlp
brew install tesseract-lang
npm run preflight   # must now print OK for all four and no warnings
yt-dlp --version    # expect >= 2026.07.04
tesseract --list-langs | grep chi_sim
```

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts scripts/preflight.ts tests/preflight.test.ts
git commit -m "chore: scaffold Node/TS project and environment preflight"
```

---

### Task 2: Shared types and subprocess utility

**Files:**
- Create: `src/types.ts`, `src/util/run.ts`
- Test: `tests/run.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: all shared types below, plus `run(cmd: string, args: string[], opts?: RunOpts): Promise<{ stdout: string; stderr: string; code: number }>`.

- [ ] **Step 1: Write `src/types.ts`**

```ts
export type ResolveStatus =
  | 'ok' | 'auth_required' | 'auth_expired' | 'needs_interaction'
  | 'unsupported' | 'not_found' | 'extractor_failed';

export type UnsupportedReason = 'drm_protected' | 'unsupported_link' | 'extractor_unsupported';

export interface ResolvedMedia {
  status: 'ok';
  filePath: string;
  platform: string;
  title: string;
  duration: number;
  resolvedBy: 'ytdlp' | 'direct' | 'wechat';
  captions: { manual: string | null; auto: string | null };
  languageHint: string | null;
  /** True when the resolver already trimmed to the requested range. */
  rangeApplied: boolean;
}

export interface ResolveFailure {
  status: Exclude<ResolveStatus, 'ok'>;
  reason?: UnsupportedReason | string;
  message: string;
  resolvedBy?: string;
}

export type ResolveResult = ResolvedMedia | ResolveFailure;

export interface ResolveOptions { start?: number; end?: number; workDir: string; }

export interface VideoResolver {
  readonly name: string;
  canResolve(url: string): boolean;
  resolve(url: string, opts: ResolveOptions): Promise<ResolveResult>;
}

export interface TranscriptSegment { start: number; end: number; text: string; }
export type TranscriptSource = 'manual' | 'auto' | 'asr';
export interface Transcript {
  language: string; source: TranscriptSource; segments: TranscriptSegment[];
}

export interface Candidate {
  timestamp: number;
  sceneId: number;
  imagePath: string;
  /** Set by scene detector: how strong the boundary was, 0..1. 0 for heartbeat frames. */
  sceneSignificance: number;
  quality: number;               // 0..1, from src/vision/quality.ts
  embedding?: number[];          // 768-dim, normalized
  ocrContent?: string;           // persistent-region text only
  ocrSubtitle?: string;          // caption-band text (discounted)
  textNovelty?: number;          // 0..1, computed subtitle-aware
}

export interface SelectedFrame {
  timestamp: number;
  sceneId: number;
  image: string;
  importance: number;
  reasons: string[];
  ocrContent: string | null;
  transcriptWindow: string | null;
  nearestSelectedSimilarity: number;
}

export interface Manifest {
  source: {
    url: string; platform: string; title: string; duration: number;
    resolvedBy: string; status: ResolveStatus; reason?: string;
  };
  transcript: Transcript | null;
  frames: SelectedFrame[];
  processing: {
    selectedFrames: number; candidateFrames: number;
    peakRssMb: number; selectorVersion: string; mode: AnalyzeMode;
  };
}

export type AnalyzeMode = 'fast' | 'accurate';

export interface AnalyzeOptions {
  start?: number; end?: number; maxFrames?: number; transcript?: boolean;
  preferredLanguage?: string; mode?: AnalyzeMode; outDir?: string;
}
```

- [ ] **Step 2: Write the failing test**

```ts
// tests/run.test.ts
import { describe, it, expect } from 'vitest';
import { run } from '../src/util/run.js';

describe('run', () => {
  it('captures stdout and a zero exit code', async () => {
    const r = await run('echo', ['hello']);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('hello');
  });
  it('does not throw on non-zero exit; reports the code', async () => {
    const r = await run('sh', ['-c', 'exit 3']);
    expect(r.code).toBe(3);
  });
});
```

- [ ] **Step 3: Run it to make sure it fails**

Run: `npx vitest run tests/run.test.ts`
Expected: FAIL — cannot resolve `../src/util/run.js`.

- [ ] **Step 4: Implement `src/util/run.ts`**

```ts
import { spawn } from 'node:child_process';

export interface RunOpts { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; }

export async function run(
  cmd: string, args: string[], opts: RunOpts = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env });
    let stdout = '', stderr = '';
    const timer = opts.timeoutMs
      ? setTimeout(() => { child.kill('SIGKILL'); }, opts.timeoutMs)
      : null;
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (e) => { if (timer) clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? -1 });
    });
  });
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/run.test.ts` → Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/util/run.ts tests/run.test.ts
git commit -m "feat: add shared types and subprocess helper"
```

---

### Task 3: FFmpeg media layer (probe, normalize, trim, frame extraction)

**Files:**
- Create: `src/media/ffmpeg.ts`
- Test: `tests/ffmpeg.test.ts`

**Interfaces:**
- Consumes: `run` (Task 2).
- Produces:
  - `probe(file: string): Promise<{ duration: number; width: number; height: number; fps: number }>`
  - `normalize(input: string, workDir: string): Promise<{ video: string; audio: string }>`
  - `trim(input: string, start: number, end: number, out: string): Promise<string>`
  - `extractFrame(video: string, timestamp: number, out: string): Promise<string>`
  - `makeTestVideo(out: string, seconds?: number): Promise<string>` (test fixture generator)

- [ ] **Step 1: Write the failing test**

```ts
// tests/ffmpeg.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probe, normalize, trim, extractFrame, makeTestVideo } from '../src/media/ffmpeg.js';

let dir: string, sample: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'norma-'));
  sample = await makeTestVideo(join(dir, 'sample.mp4'), 6);
}, 60_000);

describe('ffmpeg layer', () => {
  it('probes duration and dimensions', async () => {
    const p = await probe(sample);
    expect(p.duration).toBeGreaterThan(5);
    expect(p.width).toBe(640);
    expect(p.fps).toBeGreaterThan(0);
  });
  it('normalizes to a 720p-capped video plus 16kHz mono wav', async () => {
    const { video, audio } = await normalize(sample, dir);
    expect(existsSync(video)).toBe(true);
    expect(existsSync(audio)).toBe(true);
    expect((await probe(video)).height).toBeLessThanOrEqual(720);
  });
  it('trims to the requested range', async () => {
    const out = await trim(sample, 1, 3, join(dir, 'clip.mp4'));
    const p = await probe(out);
    expect(p.duration).toBeGreaterThan(1.5);
    expect(p.duration).toBeLessThan(2.6);
  });
  it('extracts a single frame at a timestamp', async () => {
    const out = await extractFrame(sample, 2.5, join(dir, 'f.jpg'));
    expect(existsSync(out)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/ffmpeg.test.ts` → Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/media/ffmpeg.ts`**

```ts
import { join } from 'node:path';
import { run } from '../util/run.js';

export async function probe(file: string) {
  const { stdout, code } = await run('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'format=duration:stream=width,height,r_frame_rate',
    '-of', 'json', file,
  ]);
  if (code !== 0) throw new Error(`ffprobe failed for ${file}`);
  const j = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: Array<{ width?: number; height?: number; r_frame_rate?: string }>;
  };
  const s = j.streams?.[0] ?? {};
  const [num, den] = (s.r_frame_rate ?? '0/1').split('/').map(Number);
  return {
    duration: Number(j.format?.duration ?? 0),
    width: s.width ?? 0,
    height: s.height ?? 0,
    fps: den ? (num ?? 0) / den : 0,
  };
}

/** 720p working video + 16 kHz mono wav. Platform differences end here (spec §8). */
export async function normalize(input: string, workDir: string) {
  const video = join(workDir, 'work.mp4');
  const audio = join(workDir, 'work.wav');
  const v = await run('ffmpeg', [
    '-y', '-i', input,
    '-vf', "scale='min(1280,iw)':'min(720,ih)':force_original_aspect_ratio=decrease",
    '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', video,
  ]);
  if (v.code !== 0) throw new Error(`normalize(video) failed: ${v.stderr.slice(-400)}`);
  // Audio may legitimately be absent (silent video) — tolerate failure.
  await run('ffmpeg', ['-y', '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', audio]);
  return { video, audio };
}

export async function trim(input: string, start: number, end: number, out: string) {
  const r = await run('ffmpeg', [
    '-y', '-ss', String(start), '-to', String(end), '-i', input,
    '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', out,
  ]);
  if (r.code !== 0) throw new Error(`trim failed: ${r.stderr.slice(-400)}`);
  return out;
}

export async function extractFrame(video: string, timestamp: number, out: string) {
  const r = await run('ffmpeg', ['-y', '-ss', String(timestamp), '-i', video, '-frames:v', '1', '-q:v', '3', out]);
  if (r.code !== 0) throw new Error(`extractFrame failed at ${timestamp}: ${r.stderr.slice(-400)}`);
  return out;
}

/** Synthetic fixture: shot changes at 2s and 4s so scene detection has real boundaries. */
export async function makeTestVideo(out: string, seconds = 6) {
  const per = Math.max(1, Math.floor(seconds / 3));
  const r = await run('ffmpeg', [
    '-y',
    '-f', 'lavfi', '-i', `color=c=red:s=640x360:d=${per}`,
    '-f', 'lavfi', '-i', `color=c=blue:s=640x360:d=${per}`,
    '-f', 'lavfi', '-i', `color=c=green:s=640x360:d=${per}`,
    '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]',
    '-map', '[v]', '-r', '25', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out,
  ]);
  if (r.code !== 0) throw new Error(`makeTestVideo failed: ${r.stderr.slice(-400)}`);
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/ffmpeg.test.ts` → Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/media/ffmpeg.ts tests/ffmpeg.test.ts
git commit -m "feat: add ffmpeg probe/normalize/trim/frame extraction"
```

---

### Task 4: Caption parsing and tier selection

**Files:**
- Create: `src/transcript/captions.ts`
- Test: `tests/captions.test.ts`

**Interfaces:**
- Consumes: `TranscriptSegment`, `Transcript`, `AnalyzeMode` (Task 2).
- Produces:
  - `parseVtt(vtt: string): TranscriptSegment[]`
  - `chooseCaptionTier(c: { manual: string | null; auto: string | null }, mode: AnalyzeMode): 'manual' | 'auto' | 'asr'`

Implements spec §9: manual captions always win; auto captions are trusted only in `fast` mode; otherwise fall through to ASR.

- [ ] **Step 1: Write the failing test**

```ts
// tests/captions.test.ts
import { describe, it, expect } from 'vitest';
import { parseVtt, chooseCaptionTier } from '../src/transcript/captions.js';

const VTT = `WEBVTT

00:00:01.000 --> 00:00:04.200
Hello there

00:00:04.500 --> 00:00:06.000
<c>Second</c> line
`;

describe('parseVtt', () => {
  it('parses cues into timestamped segments', () => {
    const s = parseVtt(VTT);
    expect(s).toHaveLength(2);
    expect(s[0]).toEqual({ start: 1, end: 4.2, text: 'Hello there' });
  });
  it('strips inline cue tags', () => {
    expect(parseVtt(VTT)[1]!.text).toBe('Second line');
  });
  it('ignores malformed cues rather than throwing', () => {
    expect(parseVtt('WEBVTT\n\ngarbage\n')).toEqual([]);
  });
});

describe('chooseCaptionTier', () => {
  it('always prefers manual captions', () => {
    expect(chooseCaptionTier({ manual: 'a.vtt', auto: 'b.vtt' }, 'accurate')).toBe('manual');
    expect(chooseCaptionTier({ manual: 'a.vtt', auto: null }, 'fast')).toBe('manual');
  });
  it('uses auto captions only in fast mode', () => {
    expect(chooseCaptionTier({ manual: null, auto: 'b.vtt' }, 'fast')).toBe('auto');
    expect(chooseCaptionTier({ manual: null, auto: 'b.vtt' }, 'accurate')).toBe('asr');
  });
  it('falls back to asr when nothing exists', () => {
    expect(chooseCaptionTier({ manual: null, auto: null }, 'fast')).toBe('asr');
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/captions.test.ts` → Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/transcript/captions.ts`**

```ts
import type { TranscriptSegment, AnalyzeMode } from '../types.js';

const CUE = /(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[.,](\d{3})/;

function toSeconds(h: string, m: string, s: string, ms: string): number {
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
}

export function parseVtt(vtt: string): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  for (const block of vtt.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/).filter((l) => l.trim() !== '');
    const idx = lines.findIndex((l) => CUE.test(l));
    if (idx === -1) continue;
    const m = CUE.exec(lines[idx]!);
    if (!m) continue;
    const text = lines.slice(idx + 1)
      .join(' ')
      .replace(/<[^>]+>/g, '')      // inline cue tags
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) continue;
    out.push({
      start: toSeconds(m[1]!, m[2]!, m[3]!, m[4]!),
      end: toSeconds(m[5]!, m[6]!, m[7]!, m[8]!),
      text,
    });
  }
  return out;
}

/** Spec §9: accuracy-biased. Auto captions are only trusted in fast mode. */
export function chooseCaptionTier(
  captions: { manual: string | null; auto: string | null },
  mode: AnalyzeMode,
): 'manual' | 'auto' | 'asr' {
  if (captions.manual) return 'manual';
  if (captions.auto && mode === 'fast') return 'auto';
  return 'asr';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/captions.test.ts` → Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/transcript/captions.ts tests/captions.test.ts
git commit -m "feat: add VTT parsing and caption tier selection"
```

---

### Task 5: Resolver layer (direct + yt-dlp) and failure taxonomy

**Files:**
- Create: `src/resolve/direct.ts`, `src/resolve/ytdlp.ts`, `src/resolve/wechat.ts`, `src/resolve/index.ts`
- Test: `tests/resolve.test.ts`

**Interfaces:**
- Consumes: `VideoResolver`, `ResolveResult`, `ResolvedMedia`, `ResolveFailure`, `ResolveOptions` (Task 2); `run` (Task 2); `probe` (Task 3).
- Produces:
  - `classifyYtDlpError(stderr: string): ResolveFailure`
  - `pickResolver(url: string, resolvers?: VideoResolver[]): VideoResolver | null`
  - `resolve(url: string, opts: ResolveOptions): Promise<ResolveResult>`
  - Classes `DirectMediaResolver`, `YtDlpResolver`, `WeChatHeadlessResolver`.

Implements spec §6 (dispatch order + failure taxonomy) and §18 (range download as optimization with verified fallback).

- [ ] **Step 1: Write the failing test**

```ts
// tests/resolve.test.ts
import { describe, it, expect } from 'vitest';
import { classifyYtDlpError, pickResolver } from '../src/resolve/index.js';
import { DirectMediaResolver } from '../src/resolve/direct.js';
import { YtDlpResolver } from '../src/resolve/ytdlp.js';
import { WeChatHeadlessResolver } from '../src/resolve/wechat.js';

describe('classifyYtDlpError', () => {
  it('maps DRM messages to unsupported/drm_protected', () => {
    const f = classifyYtDlpError('ERROR: This video is DRM protected');
    expect(f.status).toBe('unsupported');
    expect(f.reason).toBe('drm_protected');
  });
  it('maps login walls to auth_required', () => {
    expect(classifyYtDlpError('ERROR: Sign in to confirm your age').status).toBe('auth_required');
    expect(classifyYtDlpError('ERROR: Private video. Please sign in').status).toBe('auth_required');
  });
  it('maps removed videos to not_found', () => {
    expect(classifyYtDlpError('ERROR: Video unavailable').status).toBe('not_found');
  });
  it('defaults to extractor_failed', () => {
    expect(classifyYtDlpError('ERROR: some new breakage').status).toBe('extractor_failed');
  });
});

describe('pickResolver dispatch order (spec §6)', () => {
  it('routes a bare .mp4 URL to the direct resolver', () => {
    expect(pickResolver('https://example.com/a/b.mp4')?.name).toBe('direct');
  });
  it('routes an HLS manifest to the direct resolver', () => {
    expect(pickResolver('https://example.com/stream.m3u8')?.name).toBe('direct');
  });
  it('routes a WeChat share link to the wechat resolver', () => {
    expect(pickResolver('https://weixin.qq.com/sph/Axv548mzBF')?.name).toBe('wechat');
  });
  it('routes everything else to yt-dlp', () => {
    expect(pickResolver('https://www.youtube.com/watch?v=abc')?.name).toBe('ytdlp');
    expect(pickResolver('https://www.tiktok.com/@x/video/123')?.name).toBe('ytdlp');
    expect(pickResolver('https://some-unknown-site.example/watch/9')?.name).toBe('ytdlp');
  });
});

describe('resolver canResolve predicates', () => {
  it('direct only claims media-ish URLs', () => {
    const d = new DirectMediaResolver();
    expect(d.canResolve('https://x.com/v.mp4')).toBe(true);
    expect(d.canResolve('https://youtube.com/watch?v=1')).toBe(false);
  });
  it('wechat claims weixin/channels hosts', () => {
    const w = new WeChatHeadlessResolver();
    expect(w.canResolve('https://weixin.qq.com/sph/abc')).toBe(true);
    expect(w.canResolve('https://channels.weixin.qq.com/web/pages/feed?x=1')).toBe(true);
    expect(w.canResolve('https://youtube.com/watch?v=1')).toBe(false);
  });
  it('ytdlp claims any http(s) URL as the catch-all', () => {
    expect(new YtDlpResolver().canResolve('https://anything.example/x')).toBe(true);
  });
});

describe('WeChatHeadlessResolver without credentials', () => {
  it('returns auth_required rather than throwing', async () => {
    const w = new WeChatHeadlessResolver();
    const r = await w.resolve('https://weixin.qq.com/sph/abc', { workDir: '/tmp' });
    expect(r.status).toBe('auth_required');
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/resolve.test.ts` → Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `src/resolve/direct.ts`**

```ts
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import type { VideoResolver, ResolveOptions, ResolveResult } from '../types.js';
import { probe } from '../media/ffmpeg.js';

const MEDIA_EXT = /\.(mp4|m4v|mov|mkv|webm|m3u8|mpd|ts)(\?|#|$)/i;

export class DirectMediaResolver implements VideoResolver {
  readonly name = 'direct';
  canResolve(url: string): boolean { return MEDIA_EXT.test(url); }

  async resolve(url: string, opts: ResolveOptions): Promise<ResolveResult> {
    const out = join(opts.workDir, 'source.mp4');
    try {
      // HLS/DASH manifests must be muxed by ffmpeg, not byte-copied.
      if (/\.(m3u8|mpd)(\?|#|$)/i.test(url)) {
        const { run } = await import('../util/run.js');
        const r = await run('ffmpeg', ['-y', '-i', url, '-c', 'copy', out]);
        if (r.code !== 0) {
          return { status: 'extractor_failed', message: `ffmpeg could not fetch stream: ${r.stderr.slice(-300)}` };
        }
      } else {
        const res = await fetch(url);
        if (res.status === 401 || res.status === 403) {
          return { status: 'auth_required', message: `HTTP ${res.status} fetching media` };
        }
        if (res.status === 404) return { status: 'not_found', message: 'HTTP 404' };
        if (!res.ok || !res.body) {
          return { status: 'extractor_failed', message: `HTTP ${res.status}` };
        }
        await pipeline(Readable.fromWeb(res.body as never), createWriteStream(out));
      }
      const p = await probe(out);
      return {
        status: 'ok', filePath: out, platform: 'direct',
        title: url.split('/').pop() ?? 'video', duration: p.duration,
        resolvedBy: 'direct', captions: { manual: null, auto: null },
        languageHint: null, rangeApplied: false,
      };
    } catch (e) {
      return { status: 'extractor_failed', message: (e as Error).message };
    }
  }
}
```

- [ ] **Step 4: Implement `src/resolve/ytdlp.ts`**

```ts
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { VideoResolver, ResolveOptions, ResolveResult, ResolveFailure } from '../types.js';
import { run } from '../util/run.js';
import { probe } from '../media/ffmpeg.js';

export function classifyYtDlpError(stderr: string): ResolveFailure {
  const s = stderr.toLowerCase();
  if (/drm|widevine|protected by drm/.test(s)) {
    return { status: 'unsupported', reason: 'drm_protected', message: 'DRM-protected media', resolvedBy: 'ytdlp' };
  }
  if (/sign in|log in|login required|private video|members-only|age.?restricted|cookies/.test(s)) {
    return { status: 'auth_required', message: 'Authentication required', resolvedBy: 'ytdlp' };
  }
  if (/video unavailable|not available|has been removed|does not exist|404/.test(s)) {
    return { status: 'not_found', message: 'Media not found', resolvedBy: 'ytdlp' };
  }
  if (/unsupported url|no video formats|no suitable extractor/.test(s)) {
    return { status: 'unsupported', reason: 'extractor_unsupported', message: 'No extractor for this URL', resolvedBy: 'ytdlp' };
  }
  return { status: 'extractor_failed', message: stderr.slice(-300).trim() || 'yt-dlp failed', resolvedBy: 'ytdlp' };
}

function findCaption(dir: string, auto: boolean): string | null {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith('.vtt'));
  // yt-dlp writes auto-captions as *.<lang>.vtt too; distinguish by our own subdirs.
  const hit = files.find((f) => (auto ? f.includes('.auto.') : !f.includes('.auto.')));
  return hit ? join(dir, hit) : null;
}

export class YtDlpResolver implements VideoResolver {
  readonly name = 'ytdlp';
  canResolve(url: string): boolean { return /^https?:\/\//i.test(url); }

  async resolve(url: string, opts: ResolveOptions): Promise<ResolveResult> {
    const out = join(opts.workDir, 'source.%(ext)s');
    const args = [
      '--no-playlist', '--no-warnings',
      '-f', 'bv*[height<=1080]+ba/b[height<=1080]/b',
      '--merge-output-format', 'mp4',
      '--write-subs', '--write-auto-subs', '--sub-format', 'vtt', '--sub-langs', 'all,-live_chat',
      '--print-json', '--no-simulate',
      '-o', out,
    ];

    // Range download is an OPTIMIZATION, never a guarantee (spec §18).
    const wantsRange = opts.start !== undefined && opts.end !== undefined;
    if (wantsRange) {
      args.push('--download-sections', `*${opts.start}-${opts.end}`, '--force-keyframes-at-cuts');
    }

    const r = await run('yt-dlp', [...args, url], { timeoutMs: 15 * 60_000 });
    if (r.code !== 0) return classifyYtDlpError(r.stderr);

    let meta: { title?: string; extractor?: string; language?: string; duration?: number } = {};
    const lastJson = r.stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop();
    if (lastJson) { try { meta = JSON.parse(lastJson); } catch { /* metadata is optional */ } }

    const produced = readdirSync(opts.workDir).find((f) => /^source\.(mp4|mkv|webm|m4v)$/.test(f));
    if (!produced) return { status: 'extractor_failed', message: 'yt-dlp produced no media file', resolvedBy: 'ytdlp' };
    const filePath = join(opts.workDir, produced);
    const p = await probe(filePath);

    // VERIFY the range actually applied; caller falls back to ffmpeg trim if not.
    let rangeApplied = false;
    if (wantsRange) {
      const expected = opts.end! - opts.start!;
      rangeApplied = Math.abs(p.duration - expected) <= Math.max(1.5, expected * 0.15);
    }

    return {
      status: 'ok', filePath, platform: meta.extractor ?? 'unknown',
      title: meta.title ?? 'video', duration: p.duration, resolvedBy: 'ytdlp',
      captions: { manual: findCaption(opts.workDir, false), auto: findCaption(opts.workDir, true) },
      languageHint: meta.language ?? null,
      rangeApplied,
    };
  }
}
```

- [ ] **Step 5: Implement `src/resolve/wechat.ts` (adapter + stub)**

This is a **thin adapter only**. The parallel clean-room agent owns `experiments/wechat-clean-room/`; when its module is validated, swap the body of `resolveViaCleanRoom`. Do not implement the protocol here.

```ts
import type { VideoResolver, ResolveOptions, ResolveResult } from '../types.js';

/** Internal states from spec §7.1, mapped to the external taxonomy in §6. */
export type WeChatState = 'ready' | 'auth_required' | 'auth_expired' | 'unsupported_link' | 'resolved';

const WECHAT_HOST = /(^|\.)(weixin\.qq\.com|channels\.weixin\.qq\.com)$/i;

export function getCredential(): string | null {
  // Injected only; never hardcoded, never logged (spec §7.2).
  return process.env.NORMA_WECHAT_COOKIE?.trim() || null;
}

export class WeChatHeadlessResolver implements VideoResolver {
  readonly name = 'wechat';

  canResolve(url: string): boolean {
    try { return WECHAT_HOST.test(new URL(url).hostname); } catch { return false; }
  }

  async resolve(url: string, _opts: ResolveOptions): Promise<ResolveResult> {
    const cookie = getCredential();
    if (!cookie) {
      return {
        status: 'auth_required',
        message: 'WeChat extraction not activated. Run the one-time activation to store a session credential.',
        resolvedBy: 'wechat',
      };
    }
    // Swap in experiments/wechat-clean-room/src/wechatResolver.ts once validated.
    return {
      status: 'needs_interaction',
      message: 'Headless WeChat resolver not yet wired; clean-room implementation pending validation.',
      resolvedBy: 'wechat',
    };
  }
}
```

- [ ] **Step 6: Implement `src/resolve/index.ts`**

```ts
import type { VideoResolver, ResolveOptions, ResolveResult } from '../types.js';
import { DirectMediaResolver } from './direct.js';
import { YtDlpResolver } from './ytdlp.js';
import { WeChatHeadlessResolver } from './wechat.js';

export { classifyYtDlpError } from './ytdlp.js';

/** Dispatch order matters: direct -> wechat -> yt-dlp catch-all (spec §6). */
export const DEFAULT_RESOLVERS: VideoResolver[] = [
  new DirectMediaResolver(),
  new WeChatHeadlessResolver(),
  new YtDlpResolver(),
];

export function pickResolver(url: string, resolvers = DEFAULT_RESOLVERS): VideoResolver | null {
  return resolvers.find((r) => r.canResolve(url)) ?? null;
}

export async function resolve(url: string, opts: ResolveOptions): Promise<ResolveResult> {
  const r = pickResolver(url);
  if (!r) return { status: 'unsupported', reason: 'extractor_unsupported', message: `No resolver for ${url}` };
  return r.resolve(url, opts);
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run tests/resolve.test.ts` → Expected: PASS (13 tests).

- [ ] **Step 8: Commit**

```bash
git add src/resolve tests/resolve.test.ts
git commit -m "feat: add resolver layer with failure taxonomy and WeChat adapter stub"
```

---

### Task 6: Scene detection and candidate generation

**Files:**
- Create: `src/media/scenes.ts`, `src/media/candidates.ts`
- Test: `tests/scenes.test.ts`, `tests/candidates.test.ts`

**Interfaces:**
- Consumes: `run` (Task 2), `probe`/`extractFrame`/`makeTestVideo` (Task 3), `Candidate` (Task 2).
- Produces:
  - `interface SceneBoundary { time: number; score: number }`
  - `interface SceneDetector { detect(video: string): Promise<SceneBoundary[]> }`
  - `class FFmpegSceneDetector implements SceneDetector` (ctor takes `threshold = 0.4`)
  - `parseScdetOutput(stderr: string): SceneBoundary[]`
  - `planCandidates(duration: number, boundaries: SceneBoundary[], opts?: { heartbeatSec?: number; postBoundaryOffsetMs?: number }): Array<{ timestamp: number; sceneId: number; sceneSignificance: number }>`
  - `extractCandidates(video: string, plan: ReturnType<typeof planCandidates>, outDir: string): Promise<Candidate[]>`

Implements spec §10 (interface + post-boundary offset) and §11 (heartbeat, default 5 s).

- [ ] **Step 1: Write the failing tests**

```ts
// tests/candidates.test.ts
import { describe, it, expect } from 'vitest';
import { planCandidates } from '../src/media/candidates.js';

describe('planCandidates', () => {
  it('samples ~350ms AFTER a boundary, not the transition frame itself (spec §10)', () => {
    const plan = planCandidates(60, [{ time: 10, score: 0.9 }], { heartbeatSec: 1000 });
    const fromScene = plan.find((p) => p.sceneSignificance > 0)!;
    expect(fromScene.timestamp).toBeGreaterThan(10.2);
    expect(fromScene.timestamp).toBeLessThan(10.6);
  });
  it('adds heartbeat candidates so static scenes are still sampled (spec §11)', () => {
    const plan = planCandidates(30, [], { heartbeatSec: 5 });
    expect(plan.length).toBeGreaterThanOrEqual(5);
    expect(plan.every((p) => p.sceneSignificance === 0)).toBe(true);
  });
  it('assigns increasing scene ids across boundaries', () => {
    const plan = planCandidates(60, [{ time: 10, score: 0.8 }, { time: 20, score: 0.8 }], { heartbeatSec: 1000 });
    const ids = plan.map((p) => p.sceneId);
    expect(Math.max(...ids)).toBeGreaterThanOrEqual(2);
  });
  it('never emits a timestamp beyond the duration', () => {
    const plan = planCandidates(12, [{ time: 11.9, score: 0.9 }], { heartbeatSec: 5 });
    expect(plan.every((p) => p.timestamp <= 12)).toBe(true);
  });
  it('deduplicates near-identical timestamps from scene+heartbeat overlap', () => {
    const plan = planCandidates(30, [{ time: 5, score: 0.9 }], { heartbeatSec: 5 });
    const times = plan.map((p) => p.timestamp);
    const unique = new Set(times.map((t) => t.toFixed(1)));
    expect(unique.size).toBe(times.length);
  });
  it('returns candidates in ascending time order', () => {
    const plan = planCandidates(40, [{ time: 30, score: 0.9 }, { time: 8, score: 0.7 }], { heartbeatSec: 5 });
    const t = plan.map((p) => p.timestamp);
    expect([...t].sort((a, b) => a - b)).toEqual(t);
  });
});
```

```ts
// tests/scenes.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseScdetOutput, FFmpegSceneDetector } from '../src/media/scenes.js';
import { makeTestVideo } from '../src/media/ffmpeg.js';

describe('parseScdetOutput', () => {
  it('extracts time and score from scdet lavfi lines', () => {
    const s = `[scdet @ 0x1] lavfi.scd.score: 12.700, lavfi.scd.time: 2.000
[scdet @ 0x1] lavfi.scd.score: 30.100, lavfi.scd.time: 4.000`;
    const b = parseScdetOutput(s);
    expect(b).toHaveLength(2);
    expect(b[0]!.time).toBeCloseTo(2, 1);
    expect(b[1]!.score).toBeGreaterThan(b[0]!.score);
  });
  it('returns an empty array when no scenes are detected', () => {
    expect(parseScdetOutput('no matches here')).toEqual([]);
  });
});

describe('FFmpegSceneDetector', () => {
  it('detects the two hard cuts in the synthetic fixture', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'norma-scene-'));
    const v = await makeTestVideo(join(dir, 's.mp4'), 6);
    const b = await new FFmpegSceneDetector().detect(v);
    expect(b.length).toBeGreaterThanOrEqual(2);
  }, 60_000);
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx vitest run tests/scenes.test.ts tests/candidates.test.ts` → Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `src/media/scenes.ts`**

```ts
import { run } from '../util/run.js';

export interface SceneBoundary { time: number; score: number; }

export interface SceneDetector {
  readonly name: string;
  detect(video: string): Promise<SceneBoundary[]>;
}

const SCORE_RE = /lavfi\.scd\.score:\s*([\d.]+)/;
const TIME_RE = /lavfi\.scd\.time:\s*([\d.]+)/;

export function parseScdetOutput(stderr: string): SceneBoundary[] {
  const out: SceneBoundary[] = [];
  for (const line of stderr.split(/\r?\n/)) {
    const t = TIME_RE.exec(line);
    if (!t) continue;
    const s = SCORE_RE.exec(line);
    out.push({ time: Number(t[1]), score: s ? Number(s[1]) / 100 : 0.5 });
  }
  return out;
}

/**
 * Behind the SceneDetector interface so PySceneDetect/TransNetV2 can be
 * benchmarked against it later without touching callers (spec §10).
 */
export class FFmpegSceneDetector implements SceneDetector {
  readonly name = 'ffmpeg-scdet';
  constructor(private readonly threshold = 8) {}

  async detect(video: string): Promise<SceneBoundary[]> {
    const r = await run('ffmpeg', [
      '-i', video, '-vf', `scdet=threshold=${this.threshold}`,
      '-f', 'null', '-',
    ], { timeoutMs: 10 * 60_000 });
    return parseScdetOutput(r.stderr);
  }
}
```

- [ ] **Step 4: Implement `src/media/candidates.ts`**

```ts
import { join } from 'node:path';
import type { Candidate } from '../types.js';
import type { SceneBoundary } from './scenes.js';
import { extractFrame } from './ffmpeg.js';

export interface CandidatePlanItem { timestamp: number; sceneId: number; sceneSignificance: number; }

/**
 * Scene boundaries (sampled slightly AFTER the cut, spec §10) plus periodic
 * heartbeat frames so changes inside a static shot are still caught (spec §11).
 */
export function planCandidates(
  duration: number,
  boundaries: SceneBoundary[],
  opts: { heartbeatSec?: number; postBoundaryOffsetMs?: number } = {},
): CandidatePlanItem[] {
  const heartbeatSec = opts.heartbeatSec ?? 5;
  const offset = (opts.postBoundaryOffsetMs ?? 350) / 1000;
  const items: CandidatePlanItem[] = [];

  const sorted = [...boundaries].sort((a, b) => a.time - b.time);
  sorted.forEach((b, i) => {
    const t = Math.min(b.time + offset, duration);
    if (t <= duration) items.push({ timestamp: t, sceneId: i + 1, sceneSignificance: Math.min(1, b.score) });
  });

  const sceneIdAt = (t: number): number => {
    let id = 0;
    for (let i = 0; i < sorted.length; i++) if (t >= sorted[i]!.time) id = i + 1;
    return id;
  };
  for (let t = 0; t <= duration; t += heartbeatSec) {
    items.push({ timestamp: t, sceneId: sceneIdAt(t), sceneSignificance: 0 });
  }

  items.sort((a, b) => a.timestamp - b.timestamp);
  // Drop near-duplicates (scene sample and heartbeat can collide); keep the
  // scene-derived one because it carries significance.
  const kept: CandidatePlanItem[] = [];
  for (const it of items) {
    const prev = kept[kept.length - 1];
    if (prev && Math.abs(prev.timestamp - it.timestamp) < 0.5) {
      if (it.sceneSignificance > prev.sceneSignificance) kept[kept.length - 1] = it;
      continue;
    }
    kept.push(it);
  }
  return kept;
}

export async function extractCandidates(
  video: string, plan: CandidatePlanItem[], outDir: string,
): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (const [i, item] of plan.entries()) {
    const imagePath = join(outDir, `cand_${String(i).padStart(4, '0')}.jpg`);
    try {
      await extractFrame(video, item.timestamp, imagePath);
      out.push({ ...item, imagePath, quality: 1 });
    } catch { /* a frame at a bad seek point is skipped, not fatal */ }
  }
  return out;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/scenes.test.ts tests/candidates.test.ts` → Expected: PASS (9 tests).

- [ ] **Step 6: Commit**

```bash
git add src/media/scenes.ts src/media/candidates.ts tests/scenes.test.ts tests/candidates.test.ts
git commit -m "feat: add scene detection interface and candidate generation"
```

---

### Task 7: Quality filtering

**Files:**
- Create: `src/vision/quality.ts`
- Test: `tests/quality.test.ts`

**Interfaces:**
- Consumes: `Candidate` (Task 2), `sharp`.
- Produces:
  - `laplacianVariance(gray: Uint8Array, w: number, h: number): number`
  - `scoreQuality(imagePath: string): Promise<{ quality: number; blur: number; brightness: number; reject: boolean; reason?: string }>`
  - `filterCandidates(cands: Candidate[]): Promise<Candidate[]>`

Implements spec §12 — cheap rejection *before* any model runs.

- [ ] **Step 1: Write the failing test**

```ts
// tests/quality.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import sharp from 'sharp';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { laplacianVariance, scoreQuality } from '../src/vision/quality.js';

let dir: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'norma-q-'));
  await sharp({ create: { width: 64, height: 64, channels: 3, background: '#000000' } })
    .jpeg().toFile(join(dir, 'black.jpg'));
  await sharp({ create: { width: 64, height: 64, channels: 3, background: '#ffffff' } })
    .jpeg().toFile(join(dir, 'white.jpg'));
  // Sharp checkerboard: high edge energy.
  const px = Buffer.alloc(64 * 64 * 3);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    const v = ((x >> 3) + (y >> 3)) % 2 ? 255 : 0;
    const i = (y * 64 + x) * 3;
    px[i] = px[i + 1] = px[i + 2] = v;
  }
  await sharp(px, { raw: { width: 64, height: 64, channels: 3 } }).jpeg().toFile(join(dir, 'detail.jpg'));
});

describe('laplacianVariance', () => {
  it('is ~0 for a flat image', () => {
    expect(laplacianVariance(new Uint8Array(64 * 64).fill(128), 64, 64)).toBeLessThan(1);
  });
  it('is high for an edgy image', () => {
    const g = new Uint8Array(64 * 64);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) g[y * 64 + x] = ((x >> 3) + (y >> 3)) % 2 ? 255 : 0;
    expect(laplacianVariance(g, 64, 64)).toBeGreaterThan(100);
  });
});

describe('scoreQuality', () => {
  it('rejects an all-black frame', async () => {
    const r = await scoreQuality(join(dir, 'black.jpg'));
    expect(r.reject).toBe(true);
    expect(r.reason).toBe('too_dark');
  });
  it('rejects an all-white frame', async () => {
    const r = await scoreQuality(join(dir, 'white.jpg'));
    expect(r.reject).toBe(true);
    expect(r.reason).toBe('too_bright');
  });
  it('keeps a detailed frame and scores it above zero', async () => {
    const r = await scoreQuality(join(dir, 'detail.jpg'));
    expect(r.reject).toBe(false);
    expect(r.quality).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/quality.test.ts` → Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/vision/quality.ts`**

```ts
import sharp from 'sharp';
import type { Candidate } from '../types.js';

export function laplacianVariance(gray: Uint8Array, w: number, h: number): number {
  const vals: number[] = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const v = -4 * gray[i]! + gray[i - 1]! + gray[i + 1]! + gray[i - w]! + gray[i + w]!;
      vals.push(v);
    }
  }
  if (vals.length === 0) return 0;
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  return vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
}

const BLUR_FLOOR = 8;      // variance below this reads as blur/fade
const DARK_FLOOR = 12;     // mean luma
const BRIGHT_CEIL = 243;

export async function scoreQuality(imagePath: string) {
  const img = sharp(imagePath).grayscale();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const gray = new Uint8Array(data.buffer, data.byteOffset, data.length);
  const brightness = gray.reduce((a, b) => a + b, 0) / gray.length;
  const blur = laplacianVariance(gray, info.width, info.height);

  if (brightness < DARK_FLOOR) return { quality: 0, blur, brightness, reject: true, reason: 'too_dark' };
  if (brightness > BRIGHT_CEIL) return { quality: 0, blur, brightness, reject: true, reason: 'too_bright' };
  if (blur < BLUR_FLOOR) return { quality: 0, blur, brightness, reject: true, reason: 'blurry' };

  // Saturating map so ordinary frames land mid-range rather than all at 1.0.
  const quality = Math.min(1, Math.log10(1 + blur) / 3);
  return { quality, blur, brightness, reject: false };
}

export async function filterCandidates(cands: Candidate[]): Promise<Candidate[]> {
  const kept: Candidate[] = [];
  for (const c of cands) {
    try {
      const q = await scoreQuality(c.imagePath);
      if (!q.reject) kept.push({ ...c, quality: q.quality });
    } catch { /* unreadable frame is dropped */ }
  }
  return kept;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/quality.test.ts` → Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/vision/quality.ts tests/quality.test.ts
git commit -m "feat: add cheap pre-embedding quality filter"
```

---

### Task 8: Subtitle-aware OCR and text novelty

**Files:**
- Create: `src/vision/ocr.ts`
- Test: `tests/ocr.test.ts`

**Interfaces:**
- Consumes: `Candidate` (Task 2), `run` (Task 2), `sharp`.
- Produces:
  - `classifyTextRegion(box: { top: number; height: number }, frameHeight: number): 'caption_band' | 'content'`
  - `normalizeText(s: string): string`
  - `textDelta(a: string, b: string): number`
  - `computeTextNovelty(cands: Candidate[]): Candidate[]`
  - `ocrFrame(imagePath: string, langs?: string): Promise<{ content: string; subtitle: string }>`

Implements spec §13 — the crucial rule that a burned-in subtitle change must **not** rescue a visually redundant frame, while a slide/code/chart change must.

- [ ] **Step 1: Write the failing test**

```ts
// tests/ocr.test.ts
import { describe, it, expect } from 'vitest';
import { classifyTextRegion, normalizeText, textDelta, computeTextNovelty } from '../src/vision/ocr.js';
import type { Candidate } from '../src/types.js';

const cand = (over: Partial<Candidate>): Candidate => ({
  timestamp: 0, sceneId: 0, imagePath: 'x.jpg', sceneSignificance: 0, quality: 1, ...over,
});

describe('classifyTextRegion', () => {
  it('treats the lower third as a caption band', () => {
    expect(classifyTextRegion({ top: 640, height: 40 }, 720)).toBe('caption_band');
  });
  it('treats the upper edge as a caption band', () => {
    expect(classifyTextRegion({ top: 10, height: 30 }, 720)).toBe('caption_band');
  });
  it('treats the middle as content', () => {
    expect(classifyTextRegion({ top: 300, height: 40 }, 720)).toBe('content');
  });
});

describe('textDelta', () => {
  it('is 0 for identical text', () => expect(textDelta('total = 0', 'total = 0')).toBe(0));
  it('is 1 when text appears from nothing', () => expect(textDelta('', 'Revenue: $12M')).toBe(1));
  it('is high for a changed value', () => {
    expect(textDelta('Revenue: $12M', 'Revenue: $27M')).toBeGreaterThan(0.2);
  });
  it('ignores whitespace and case noise', () => {
    expect(textDelta('Total = 0', 'total   =  0')).toBe(0);
  });
});

describe('computeTextNovelty (spec §13)', () => {
  it('gives HIGH novelty when persistent content text changes', () => {
    const out = computeTextNovelty([
      cand({ timestamp: 0, ocrContent: 'total = 0', ocrSubtitle: '' }),
      cand({ timestamp: 5, ocrContent: 'total = calculate_total(items)', ocrSubtitle: '' }),
    ]);
    expect(out[1]!.textNovelty!).toBeGreaterThan(0.3);
  });

  it('gives LOW novelty when only the subtitle overlay changes', () => {
    const out = computeTextNovelty([
      cand({ timestamp: 0, ocrContent: 'same slide', ocrSubtitle: 'and then I said' }),
      cand({ timestamp: 5, ocrContent: 'same slide', ocrSubtitle: 'something completely different' }),
    ]);
    expect(out[1]!.textNovelty!).toBeLessThan(0.15);
  });

  it('ranks a content change above a subtitle change', () => {
    const [, subtitleOnly] = computeTextNovelty([
      cand({ timestamp: 0, ocrContent: 'slide', ocrSubtitle: 'a' }),
      cand({ timestamp: 5, ocrContent: 'slide', ocrSubtitle: 'totally new words here' }),
    ]);
    const [, contentChange] = computeTextNovelty([
      cand({ timestamp: 0, ocrContent: 'slide one', ocrSubtitle: 'a' }),
      cand({ timestamp: 5, ocrContent: 'slide two entirely', ocrSubtitle: 'a' }),
    ]);
    expect(contentChange!.textNovelty!).toBeGreaterThan(subtitleOnly!.textNovelty!);
  });

  it('gives the first candidate zero novelty (nothing to compare against)', () => {
    const out = computeTextNovelty([cand({ ocrContent: 'hello', ocrSubtitle: '' })]);
    expect(out[0]!.textNovelty).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/ocr.test.ts` → Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/vision/ocr.ts`**

```ts
import sharp from 'sharp';
import { run } from '../util/run.js';
import type { Candidate } from '../types.js';

/** Burned-in captions live in the top/bottom bands; real content lives in the middle. */
export function classifyTextRegion(
  box: { top: number; height: number }, frameHeight: number,
): 'caption_band' | 'content' {
  const center = box.top + box.height / 2;
  const r = center / frameHeight;
  return r > 0.78 || r < 0.12 ? 'caption_band' : 'content';
}

export function normalizeText(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Token-level Jaccard distance: robust to OCR jitter, sensitive to real edits. */
export function textDelta(a: string, b: string): number {
  const A = new Set(normalizeText(a).split(' ').filter(Boolean));
  const B = new Set(normalizeText(b).split(' ').filter(Boolean));
  if (A.size === 0 && B.size === 0) return 0;
  if (A.size === 0 || B.size === 0) return 1;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const union = A.size + B.size - inter;
  return 1 - inter / union;
}

const SUBTITLE_DISCOUNT = 0.1;   // spec §13: overlays must not rescue redundant frames

export function computeTextNovelty(cands: Candidate[]): Candidate[] {
  return cands.map((c, i) => {
    if (i === 0) return { ...c, textNovelty: 0 };
    const prev = cands[i - 1]!;
    const contentDelta = textDelta(prev.ocrContent ?? '', c.ocrContent ?? '');
    const subtitleDelta = textDelta(prev.ocrSubtitle ?? '', c.ocrSubtitle ?? '');
    const novelty = Math.min(1, contentDelta + SUBTITLE_DISCOUNT * subtitleDelta);
    return { ...c, textNovelty: novelty };
  });
}

/** Splits the frame into caption bands vs content and OCRs them separately. */
export async function ocrFrame(imagePath: string, langs = 'eng') {
  const meta = await sharp(imagePath).metadata();
  const w = meta.width ?? 0, h = meta.height ?? 0;
  if (!w || !h) return { content: '', subtitle: '' };

  const contentTop = Math.floor(h * 0.12);
  const contentH = Math.max(1, Math.floor(h * 0.66));

  // tesseract reads a file more reliably than stdin across builds; write temp crops.
  const contentBuf = await sharp(imagePath).extract({ left: 0, top: contentTop, width: w, height: contentH }).png().toBuffer();
  const bottomTop = Math.floor(h * 0.78);
  const bottomBuf = await sharp(imagePath)
    .extract({ left: 0, top: bottomTop, width: w, height: Math.max(1, h - bottomTop) }).png().toBuffer();

  const [content, subtitle] = await Promise.all([
    ocrBuffer(contentBuf, langs), ocrBuffer(bottomBuf, langs),
  ]);
  return { content, subtitle };
}

async function ocrBuffer(buf: Buffer, langs: string): Promise<string> {
  const { writeFile, unlink } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const p = join(tmpdir(), `norma-ocr-${process.pid}-${Math.random().toString(36).slice(2)}.png`);
  await writeFile(p, buf);
  try {
    const { stdout } = await run('tesseract', [p, 'stdout', '-l', langs], { timeoutMs: 30_000 });
    return stdout.replace(/\s+/g, ' ').trim();
  } catch { return ''; }
  finally { await unlink(p).catch(() => {}); }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/ocr.test.ts` → Expected: PASS (11 tests).
Then `npx tsc --noEmit` to confirm the module typechecks.

- [ ] **Step 5: Commit**

```bash
git add src/vision/ocr.ts tests/ocr.test.ts
git commit -m "feat: add subtitle-aware OCR text novelty"
```

---

### Task 9: The iterative diversity-aware selector (the differentiator)

**Files:**
- Create: `src/vision/select.ts`
- Test: `tests/select.test.ts`

**Interfaces:**
- Consumes: `Candidate`, `SelectedFrame` (Task 2).
- Produces:
  - `cosine(a: number[], b: number[]): number`
  - `intrinsicImportance(c: Candidate): number`
  - `selectFrames(cands: Candidate[], maxFrames: number, duration: number, opts?: SelectorOpts): SelectedFrame[]`
  - `const SELECTOR_VERSION = '1'`

Implements spec §15. This is the component the whole PoC exists to prove — test it hardest. Pure logic, no I/O.

- [ ] **Step 1: Write the failing test**

```ts
// tests/select.test.ts
import { describe, it, expect } from 'vitest';
import { cosine, intrinsicImportance, selectFrames } from '../src/vision/select.js';
import type { Candidate } from '../src/types.js';

const v = (n: number[]): number[] => {
  const m = Math.hypot(...n);
  return n.map((x) => x / m);
};
const cand = (o: Partial<Candidate> & { timestamp: number }): Candidate => ({
  sceneId: 0, imagePath: `f${o.timestamp}.jpg`, sceneSignificance: 0,
  quality: 0.5, textNovelty: 0, embedding: v([1, 0, 0]), ...o,
});

describe('cosine', () => {
  it('is 1 for identical vectors', () => expect(cosine(v([1, 2, 3]), v([1, 2, 3]))).toBeCloseTo(1, 5));
  it('is 0 for orthogonal vectors', () => expect(cosine(v([1, 0]), v([0, 1]))).toBeCloseTo(0, 5));
});

describe('intrinsicImportance', () => {
  it('rises with scene significance', () => {
    const lo = intrinsicImportance(cand({ timestamp: 0, sceneSignificance: 0 }));
    const hi = intrinsicImportance(cand({ timestamp: 0, sceneSignificance: 1 }));
    expect(hi).toBeGreaterThan(lo);
  });
  it('rises with text novelty', () => {
    const lo = intrinsicImportance(cand({ timestamp: 0, textNovelty: 0 }));
    const hi = intrinsicImportance(cand({ timestamp: 0, textNovelty: 1 }));
    expect(hi).toBeGreaterThan(lo);
  });
  it('stays within 0..1', () => {
    const max = intrinsicImportance(cand({ timestamp: 0, sceneSignificance: 1, textNovelty: 1, quality: 1 }));
    expect(max).toBeLessThanOrEqual(1);
    expect(max).toBeGreaterThanOrEqual(0);
  });
});

describe('selectFrames', () => {
  it('respects the maxFrames budget', () => {
    const cands = Array.from({ length: 50 }, (_, i) => cand({ timestamp: i }));
    expect(selectFrames(cands, 10, 50)).toHaveLength(10);
  });

  it('returns everything when the budget exceeds the candidate count', () => {
    const cands = [cand({ timestamp: 0 }), cand({ timestamp: 5 })];
    expect(selectFrames(cands, 40, 10)).toHaveLength(2);
  });

  it('picks the most intrinsically important frame first', () => {
    const cands = [
      cand({ timestamp: 1, sceneSignificance: 0.1 }),
      cand({ timestamp: 2, sceneSignificance: 0.95, textNovelty: 0.9 }),
      cand({ timestamp: 3, sceneSignificance: 0.1 }),
    ];
    expect(selectFrames(cands, 1, 10)[0]!.timestamp).toBe(2);
  });

  it('AVOIDS a near-duplicate of an already-selected frame', () => {
    const shared = v([1, 0, 0]);
    const cands = [
      cand({ timestamp: 1, sceneSignificance: 0.9, embedding: shared }),
      cand({ timestamp: 2, sceneSignificance: 0.85, embedding: shared }),      // near-duplicate
      cand({ timestamp: 3, sceneSignificance: 0.5, embedding: v([0, 1, 0]) }), // distinct
    ];
    const picked = selectFrames(cands, 2, 10).map((f) => f.timestamp);
    expect(picked).toContain(1);
    expect(picked).toContain(3);
    expect(picked).not.toContain(2);
  });

  it('spreads picks across the timeline instead of clustering (spec §15)', () => {
    // 15 juicy candidates in the first minute, 5 dull ones spread over the next hour.
    const hot = Array.from({ length: 15 }, (_, i) =>
      cand({ timestamp: i * 4, sceneSignificance: 0.9, embedding: v([1, i * 0.01 + 0.01, 0]) }));
    const cold = Array.from({ length: 5 }, (_, i) =>
      cand({ timestamp: 600 + i * 600, sceneSignificance: 0.2, embedding: v([0, 0, i + 1]) }));
    const picked = selectFrames([...hot, ...cold], 6, 3600);
    const late = picked.filter((f) => f.timestamp > 300);
    expect(late.length).toBeGreaterThanOrEqual(2);
  });

  it('rescues a visually-identical frame whose CONTENT text changed (spec §22/§24)', () => {
    const same = v([1, 0, 0]);
    const cands = [
      cand({ timestamp: 1, sceneSignificance: 0.5, embedding: same, textNovelty: 0 }),
      cand({ timestamp: 2, sceneSignificance: 0, embedding: same, textNovelty: 0.95 }), // code line changed
      cand({ timestamp: 3, sceneSignificance: 0, embedding: same, textNovelty: 0 }),
    ];
    const picked = selectFrames(cands, 2, 10).map((f) => f.timestamp);
    expect(picked).toContain(2);
  });

  it('records human-readable reasons for each pick', () => {
    const picked = selectFrames([cand({ timestamp: 1, sceneSignificance: 0.9, textNovelty: 0.9 })], 1, 10);
    expect(picked[0]!.reasons).toContain('new_scene');
    expect(picked[0]!.reasons).toContain('new_text');
  });

  it('returns frames sorted by timestamp', () => {
    const cands = Array.from({ length: 20 }, (_, i) =>
      cand({ timestamp: (20 - i) * 3, embedding: v([i + 1, 1, 0]) }));
    const t = selectFrames(cands, 8, 60).map((f) => f.timestamp);
    expect([...t].sort((a, b) => a - b)).toEqual(t);
  });

  it('is deterministic across runs', () => {
    const cands = Array.from({ length: 30 }, (_, i) =>
      cand({ timestamp: i * 2, sceneSignificance: (i % 5) / 5, embedding: v([i + 1, (i % 7) + 1, 1]) }));
    expect(selectFrames(cands, 7, 60)).toEqual(selectFrames(cands, 7, 60));
  });

  it('handles candidates with no embeddings without crashing', () => {
    const cands = [cand({ timestamp: 1, embedding: undefined }), cand({ timestamp: 2, embedding: undefined })];
    expect(selectFrames(cands, 2, 10)).toHaveLength(2);
  });

  it('returns an empty array for no candidates', () => {
    expect(selectFrames([], 10, 60)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/select.test.ts` → Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/vision/select.ts`**

```ts
import type { Candidate, SelectedFrame } from '../types.js';

export const SELECTOR_VERSION = '1';

export interface SelectorOpts {
  wScene?: number; wText?: number; wQuality?: number;
  coverageWeight?: number; similarityWeight?: number;
}

export function cosine(a: number[], b: number[]): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!;
  return s;
}

/**
 * Intrinsic (context-free) importance. Semantic novelty is folded in via
 * sceneSignificance and textNovelty; the diversity term in selectFrames
 * handles redundancy dynamically (spec §15).
 */
export function intrinsicImportance(c: Candidate, o: SelectorOpts = {}): number {
  const wScene = o.wScene ?? 0.35;
  const wText = o.wText ?? 0.35;
  const wQuality = o.wQuality ?? 0.30;
  const v = wScene * c.sceneSignificance + wText * (c.textNovelty ?? 0) + wQuality * c.quality;
  return Math.max(0, Math.min(1, v));
}

function reasonsFor(c: Candidate, maxSim: number): string[] {
  const r: string[] = [];
  if (c.sceneSignificance > 0.3) r.push('new_scene');
  if ((c.textNovelty ?? 0) > 0.3) r.push('new_text');
  if (maxSim < 0.7) r.push('semantic_change');
  if (c.quality > 0.6) r.push('high_quality');
  if (r.length === 0) r.push('temporal_coverage');
  return r;
}

/**
 * Maximal-marginal-relevance style greedy selection (spec §15):
 *   score = intrinsic + coverageBonus - similarityToSelected
 * Re-scored after every pick, so 15 interesting frames in one minute cannot
 * crowd out the rest of a long video.
 */
export function selectFrames(
  cands: Candidate[], maxFrames: number, duration: number, o: SelectorOpts = {},
): SelectedFrame[] {
  if (cands.length === 0 || maxFrames <= 0) return [];
  const coverageWeight = o.coverageWeight ?? 0.5;
  const similarityWeight = o.similarityWeight ?? 0.6;
  const span = duration > 0 ? duration : Math.max(1, ...cands.map((c) => c.timestamp));

  const pool = [...cands];
  const picked: Array<{ c: Candidate; maxSim: number }> = [];

  while (picked.length < maxFrames && pool.length > 0) {
    let bestIdx = 0, bestScore = -Infinity, bestSim = 0;

    for (let i = 0; i < pool.length; i++) {
      const c = pool[i]!;

      let maxSim = 0;
      if (c.embedding) {
        for (const p of picked) {
          if (!p.c.embedding) continue;
          maxSim = Math.max(maxSim, cosine(c.embedding, p.c.embedding));
        }
      }

      // Coverage: distance to the nearest already-picked timestamp, normalized.
      // With nothing picked yet this is 1, so intrinsic importance decides.
      let coverage = 1;
      if (picked.length > 0) {
        const nearest = Math.min(...picked.map((p) => Math.abs(p.c.timestamp - c.timestamp)));
        coverage = Math.min(1, nearest / (span / Math.max(1, maxFrames)));
      }

      const score = intrinsicImportance(c, o)
        + coverageWeight * coverage
        - similarityWeight * maxSim;

      // Ties broken by earlier timestamp for determinism.
      if (score > bestScore || (score === bestScore && c.timestamp < pool[bestIdx]!.timestamp)) {
        bestScore = score; bestIdx = i; bestSim = maxSim;
      }
    }

    const chosen = pool.splice(bestIdx, 1)[0]!;
    picked.push({ c: chosen, maxSim: bestSim });
  }

  return picked
    .map(({ c, maxSim }) => ({
      timestamp: c.timestamp,
      sceneId: c.sceneId,
      image: c.imagePath,
      importance: Number(intrinsicImportance(c, o).toFixed(4)),
      reasons: reasonsFor(c, maxSim),
      ocrContent: c.ocrContent ?? null,
      transcriptWindow: null,      // filled by src/align.ts
      nearestSelectedSimilarity: Number(maxSim.toFixed(4)),
    }))
    .sort((a, b) => a.timestamp - b.timestamp);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/select.test.ts` → Expected: PASS (16 tests).

If the "spreads picks across the timeline" or "rescues content text change" tests fail, tune `coverageWeight` / `wText` — **do not weaken the tests.** They encode the spec's core claims.

- [ ] **Step 5: Commit**

```bash
git add src/vision/select.ts tests/select.test.ts
git commit -m "feat: add iterative diversity-aware frame selector"
```

---

### Task 10: Frame–transcript alignment

**Files:**
- Create: `src/align.ts`
- Test: `tests/align.test.ts`

**Interfaces:**
- Consumes: `SelectedFrame`, `TranscriptSegment` (Task 2).
- Produces: `attachTranscript(frames: SelectedFrame[], segments: TranscriptSegment[], windowSec?: number): SelectedFrame[]`

Implements spec §16 — segments overlapping `[t − Δ, t + Δ]`, Δ default 4 s.

- [ ] **Step 1: Write the failing test**

```ts
// tests/align.test.ts
import { describe, it, expect } from 'vitest';
import { attachTranscript } from '../src/align.js';
import type { SelectedFrame, TranscriptSegment } from '../src/types.js';

const frame = (timestamp: number): SelectedFrame => ({
  timestamp, sceneId: 0, image: 'f.jpg', importance: 0.5, reasons: [],
  ocrContent: null, transcriptWindow: null, nearestSelectedSimilarity: 0,
});
const segs: TranscriptSegment[] = [
  { start: 0, end: 3, text: 'intro words' },
  { start: 10, end: 13, text: 'middle words' },
  { start: 30, end: 33, text: 'later words' },
];

describe('attachTranscript', () => {
  it('attaches segments overlapping the +/-4s window', () => {
    const out = attachTranscript([frame(11)], segs);
    expect(out[0]!.transcriptWindow).toBe('middle words');
  });
  it('includes a segment that merely overlaps the window edge', () => {
    const out = attachTranscript([frame(6.5)], segs);   // window 2.5..10.5 overlaps seg 0 and 1
    expect(out[0]!.transcriptWindow).toContain('intro words');
    expect(out[0]!.transcriptWindow).toContain('middle words');
  });
  it('is null when no speech is near the frame', () => {
    expect(attachTranscript([frame(20)], segs)[0]!.transcriptWindow).toBeNull();
  });
  it('respects a custom window', () => {
    expect(attachTranscript([frame(20)], segs, 12)[0]!.transcriptWindow).toContain('later words');
  });
  it('is null when there is no transcript at all', () => {
    expect(attachTranscript([frame(5)], [])[0]!.transcriptWindow).toBeNull();
  });
  it('does not mutate the input frames', () => {
    const f = [frame(11)];
    attachTranscript(f, segs);
    expect(f[0]!.transcriptWindow).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/align.test.ts` → Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/align.ts`**

```ts
import type { SelectedFrame, TranscriptSegment } from './types.js';

/** Spec §16: what was visible AND what was being said at that moment. */
export function attachTranscript(
  frames: SelectedFrame[], segments: TranscriptSegment[], windowSec = 4,
): SelectedFrame[] {
  return frames.map((f) => {
    const lo = f.timestamp - windowSec;
    const hi = f.timestamp + windowSec;
    const text = segments
      .filter((s) => s.end >= lo && s.start <= hi)   // any overlap counts
      .map((s) => s.text)
      .join(' ')
      .trim();
    return { ...f, transcriptWindow: text.length > 0 ? text : null };
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/align.test.ts` → Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/align.ts tests/align.test.ts
git commit -m "feat: align selected frames with transcript windows"
```

---

### Task 11: ASR routing and the ASR worker process

**Files:**
- Create: `src/transcript/routing.ts`, `src/transcript/asrWorker.ts`, `src/transcript/asr.ts`, `scripts/fetch-models.sh`
- Test: `tests/routing.test.ts`, `tests/asr.integration.test.ts`

**Interfaces:**
- Consumes: `Transcript`, `TranscriptSegment` (Task 2); `run` (Task 2).
- Produces:
  - `chooseAsrEngine(input: { preferredLanguage?: string; languageHint?: string | null }): 'sensevoice' | 'whisper'`
  - `transcribeAudio(wav: string, opts: { engine?: 'sensevoice' | 'whisper'; modelsDir?: string }): Promise<Transcript>` (spawns the worker)
  - Worker CLI contract: `node dist/transcript/asrWorker.js <wav> <engine> <modelsDir>` → prints one JSON `Transcript` to stdout.

Implements spec §9 routing (explicit language list, no "CJK-heavy" vagueness) and §4/§19 (worker exits before vision starts).

- [ ] **Step 1: Write the failing routing test**

```ts
// tests/routing.test.ts
import { describe, it, expect } from 'vitest';
import { chooseAsrEngine } from '../src/transcript/routing.js';

describe('chooseAsrEngine (spec §9)', () => {
  it.each(['zh', 'yue', 'ja', 'ko'])('routes %s to SenseVoice', (lang) => {
    expect(chooseAsrEngine({ preferredLanguage: lang })).toBe('sensevoice');
  });
  it('normalizes locale tags like zh-CN and ZH_hant', () => {
    expect(chooseAsrEngine({ preferredLanguage: 'zh-CN' })).toBe('sensevoice');
    expect(chooseAsrEngine({ preferredLanguage: 'ZH_hant' })).toBe('sensevoice');
  });
  it('routes English and unknown languages to Whisper', () => {
    expect(chooseAsrEngine({ preferredLanguage: 'en' })).toBe('whisper');
    expect(chooseAsrEngine({ preferredLanguage: 'sw' })).toBe('whisper');
  });
  it('defaults to Whisper when nothing is known', () => {
    expect(chooseAsrEngine({})).toBe('whisper');
  });
  it('prefers the explicit preferredLanguage over platform metadata', () => {
    expect(chooseAsrEngine({ preferredLanguage: 'en', languageHint: 'zh' })).toBe('whisper');
  });
  it('falls back to platform metadata when no preference is given', () => {
    expect(chooseAsrEngine({ languageHint: 'ja' })).toBe('sensevoice');
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/routing.test.ts` → Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/transcript/routing.ts`**

```ts
export type AsrEngine = 'sensevoice' | 'whisper';

/** Spec §9: an explicit language set, not a vague "CJK-heavy" heuristic. */
const SENSEVOICE_LANGS = new Set(['zh', 'yue', 'ja', 'ko']);

function baseLang(tag: string | null | undefined): string | null {
  if (!tag) return null;
  return tag.toLowerCase().split(/[-_]/)[0] ?? null;
}

export function chooseAsrEngine(
  input: { preferredLanguage?: string; languageHint?: string | null },
): AsrEngine {
  const lang = baseLang(input.preferredLanguage) ?? baseLang(input.languageHint);
  return lang && SENSEVOICE_LANGS.has(lang) ? 'sensevoice' : 'whisper';
}
```

- [ ] **Step 4: Write `scripts/fetch-models.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
BASE="https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models"
DIR="${1:-models}"
mkdir -p "$DIR" && cd "$DIR"

[ -f silero_vad.onnx ] || curl -L -O "$BASE/silero_vad.onnx"

if [ ! -d sherpa-onnx-whisper-small ]; then
  curl -L -O "$BASE/sherpa-onnx-whisper-small.tar.bz2"
  tar xjf sherpa-onnx-whisper-small.tar.bz2 && rm sherpa-onnx-whisper-small.tar.bz2
fi

SV="sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09"
if [ ! -d "$SV" ]; then
  curl -L -O "$BASE/$SV.tar.bz2"
  tar xjf "$SV.tar.bz2" && rm "$SV.tar.bz2"
fi
echo "models ready in $DIR"
```

Run it: `chmod +x scripts/fetch-models.sh && ./scripts/fetch-models.sh models`

- [ ] **Step 5: Implement `src/transcript/asrWorker.ts`**

This file is the ONLY place `sherpa-onnx-node` is imported. It runs as a child process and exits, releasing model memory (spec §4).

```ts
import { join } from 'node:path';
import sherpa from 'sherpa-onnx-node';
import type { Transcript, TranscriptSegment } from '../types.js';

const SENSEVOICE_DIR = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09';
const WHISPER_DIR = 'sherpa-onnx-whisper-small';

function buildRecognizer(engine: string, modelsDir: string) {
  if (engine === 'sensevoice') {
    return new sherpa.OfflineRecognizer({
      modelConfig: {
        senseVoice: { model: join(modelsDir, SENSEVOICE_DIR, 'model.int8.onnx'), useInverseTextNormalization: 1 },
        tokens: join(modelsDir, SENSEVOICE_DIR, 'tokens.txt'),
        numThreads: 2, provider: 'cpu', debug: 0,
      },
    });
  }
  return new sherpa.OfflineRecognizer({
    modelConfig: {
      whisper: {
        encoder: join(modelsDir, WHISPER_DIR, 'small-encoder.int8.onnx'),
        decoder: join(modelsDir, WHISPER_DIR, 'small-decoder.int8.onnx'),
      },
      tokens: join(modelsDir, WHISPER_DIR, 'small-tokens.txt'),
      numThreads: 2, provider: 'cpu', debug: 0,
    },
  });
}

async function main(): Promise<void> {
  const [wav, engine = 'whisper', modelsDir = 'models'] = process.argv.slice(2);
  if (!wav) throw new Error('usage: asrWorker <wav> <engine> <modelsDir>');

  const wave = sherpa.readWave(wav);
  const vad = new sherpa.Vad({
    sileroVad: {
      model: join(modelsDir, 'silero_vad.onnx'),
      threshold: 0.5, minSilenceDuration: 0.5, minSpeechDuration: 0.25, maxSpeechDuration: 20,
    },
    sampleRate: wave.sampleRate, numThreads: 1, debug: 0,
  }, 60);

  const recognizer = buildRecognizer(engine, modelsDir);
  const segments: TranscriptSegment[] = [];
  const window = 512;

  // VAD first: only speech regions reach ASR (spec §9/report §10).
  for (let i = 0; i + window < wave.samples.length; i += window) {
    vad.acceptWaveform(wave.samples.subarray(i, i + window));
    while (!vad.isEmpty()) {
      const seg = vad.front();
      vad.pop();
      const stream = recognizer.createStream();
      stream.acceptWaveform({ samples: seg.samples, sampleRate: wave.sampleRate });
      recognizer.decode(stream);
      const text = recognizer.getResult(stream).text.trim();
      if (text) {
        const start = seg.start / wave.sampleRate;
        segments.push({ start, end: start + seg.samples.length / wave.sampleRate, text });
      }
    }
  }
  vad.flush();
  while (!vad.isEmpty()) {
    const seg = vad.front(); vad.pop();
    const stream = recognizer.createStream();
    stream.acceptWaveform({ samples: seg.samples, sampleRate: wave.sampleRate });
    recognizer.decode(stream);
    const text = recognizer.getResult(stream).text.trim();
    if (text) {
      const start = seg.start / wave.sampleRate;
      segments.push({ start, end: start + seg.samples.length / wave.sampleRate, text });
    }
  }

  const transcript: Transcript = {
    language: engine === 'sensevoice' ? 'zh' : 'auto',
    source: 'asr',
    segments,
  };
  process.stdout.write(JSON.stringify(transcript));
}

void main().catch((e) => { process.stderr.write(String(e)); process.exit(1); });
```

- [ ] **Step 6: Implement `src/transcript/asr.ts` (driver — never imports sherpa)**

```ts
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { run } from '../util/run.js';
import type { Transcript } from '../types.js';
import type { AsrEngine } from './routing.js';

export async function transcribeAudio(
  wav: string, opts: { engine?: AsrEngine; modelsDir?: string } = {},
): Promise<Transcript> {
  const here = dirname(fileURLToPath(import.meta.url));
  const worker = join(here, 'asrWorker.js');
  const engine = opts.engine ?? 'whisper';
  const modelsDir = opts.modelsDir ?? 'models';

  // Separate process so model memory is fully released on exit (spec §4).
  const r = await run(process.execPath, [worker, wav, engine, modelsDir], { timeoutMs: 30 * 60_000 });
  if (r.code !== 0) throw new Error(`ASR worker failed: ${r.stderr.slice(-400)}`);
  return JSON.parse(r.stdout) as Transcript;
}
```

- [ ] **Step 7: Write the ASR integration test**

```ts
// tests/asr.integration.test.ts
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';

const ready = existsSync('models/silero_vad.onnx') && existsSync('dist/transcript/asrWorker.js');

describe.skipIf(!ready)('ASR worker (integration)', () => {
  it('transcribes a short wav and exits cleanly', async () => {
    const { transcribeAudio } = await import('../dist/transcript/asr.js');
    const t = await transcribeAudio('tests/fixtures/speech.wav', { engine: 'whisper' });
    expect(t.source).toBe('asr');
    expect(Array.isArray(t.segments)).toBe(true);
  }, 300_000);
});
```

Create the fixture with a spoken sample you already have, or synthesize one:
`say -o tests/fixtures/speech.aiff "the quick brown fox jumps over the lazy dog" && ffmpeg -y -i tests/fixtures/speech.aiff -ac 1 -ar 16000 tests/fixtures/speech.wav`

- [ ] **Step 8: Build and run**

Run: `npm run build && npx vitest run tests/routing.test.ts tests/asr.integration.test.ts`
Expected: routing PASSes (6 tests); the integration test runs if models are present, and prints real transcript segments.

- [ ] **Step 9: Commit**

```bash
git add src/transcript scripts/fetch-models.sh tests/routing.test.ts tests/asr.integration.test.ts
git commit -m "feat: add ASR routing and staged sherpa-onnx worker"
```

---

### Task 12: SigLIP embedding worker

**Files:**
- Create: `src/vision/embedWorker.ts`, `src/vision/embed.ts`
- Test: `tests/embed.integration.test.ts`

**Interfaces:**
- Consumes: `Candidate` (Task 2); `run` (Task 2).
- Produces:
  - `embedImages(paths: string[]): Promise<number[][]>` (spawns worker; 768-dim normalized vectors)
  - Worker CLI contract: `node dist/vision/embedWorker.js <jsonPathsFile>` → prints `number[][]` JSON to stdout.

**CRITICAL:** use `SiglipVisionModel` + `pooler_output`. `pipeline('image-feature-extraction')` returns raw pixels (150528 dims) — verified trap, see Global Constraints.

- [ ] **Step 1: Implement `src/vision/embedWorker.ts`**

Only place `@huggingface/transformers` is imported; runs as a child process and exits (spec §4).

```ts
import { readFileSync } from 'node:fs';
import { SiglipVisionModel, AutoProcessor, RawImage } from '@huggingface/transformers';

const MODEL_ID = 'Xenova/siglip-base-patch16-224';

async function main(): Promise<void> {
  const listFile = process.argv[2];
  if (!listFile) throw new Error('usage: embedWorker <jsonPathsFile>');
  const paths = JSON.parse(readFileSync(listFile, 'utf8')) as string[];

  const processor = await AutoProcessor.from_pretrained(MODEL_ID);
  // MUST be the vision tower: the feature-extraction pipeline returns raw pixels.
  const model = await SiglipVisionModel.from_pretrained(MODEL_ID, { dtype: 'q8' });

  const out: number[][] = [];
  for (const p of paths) {
    try {
      const inputs = await processor(await RawImage.read(p));
      const res = await model(inputs);
      const tensor = res.pooler_output ?? res.last_hidden_state;
      const v = Array.from(tensor.data as Float32Array);
      const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
      out.push(v.map((x) => x / norm));
    } catch {
      out.push([]);   // keep index alignment with the input list
    }
  }
  process.stdout.write(JSON.stringify(out));
}

void main().catch((e) => { process.stderr.write(String(e)); process.exit(1); });
```

- [ ] **Step 2: Implement `src/vision/embed.ts` (driver — never imports transformers)**

```ts
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../util/run.js';

export async function embedImages(paths: string[]): Promise<number[][]> {
  if (paths.length === 0) return [];
  const here = dirname(fileURLToPath(import.meta.url));
  const worker = join(here, 'embedWorker.js');
  const dir = mkdtempSync(join(tmpdir(), 'norma-embed-'));
  const listFile = join(dir, 'paths.json');
  writeFileSync(listFile, JSON.stringify(paths));

  const r = await run(process.execPath, [worker, listFile], { timeoutMs: 20 * 60_000 });
  if (r.code !== 0) throw new Error(`embed worker failed: ${r.stderr.slice(-400)}`);
  return JSON.parse(r.stdout) as number[][];
}
```

- [ ] **Step 3: Write the integration test**

```ts
// tests/embed.integration.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

const ready = existsSync('dist/vision/embedWorker.js');
let red: string, blue: string, red2: string;

beforeAll(async () => {
  const d = mkdtempSync(join(tmpdir(), 'norma-emb-'));
  red = join(d, 'red.jpg'); blue = join(d, 'blue.jpg'); red2 = join(d, 'red2.jpg');
  await sharp({ create: { width: 224, height: 224, channels: 3, background: '#cc2222' } }).jpeg().toFile(red);
  await sharp({ create: { width: 224, height: 224, channels: 3, background: '#cc2222' } }).jpeg().toFile(red2);
  await sharp({ create: { width: 224, height: 224, channels: 3, background: '#2222cc' } }).jpeg().toFile(blue);
});

describe.skipIf(!ready)('SigLIP embed worker (integration)', () => {
  it('returns 768-dim normalized vectors, NOT raw pixels', async () => {
    const { embedImages } = await import('../dist/vision/embed.js');
    const [a] = await embedImages([red]);
    expect(a!.length).toBe(768);                       // 150528 would mean raw pixels
    expect(Math.hypot(...a!)).toBeCloseTo(1, 3);
  }, 600_000);

  it('scores identical images higher than different ones', async () => {
    const { embedImages } = await import('../dist/vision/embed.js');
    const { cosine } = await import('../dist/vision/select.js');
    const [a, b, c] = await embedImages([red, red2, blue]);
    expect(cosine(a!, b!)).toBeGreaterThan(cosine(a!, c!));
  }, 600_000);
});
```

- [ ] **Step 4: Build and run**

Run: `npm run build && npx vitest run tests/embed.integration.test.ts`
Expected: PASS — the first test is the trap guard; if it reports 150528 the wrong API is in use.

- [ ] **Step 5: Commit**

```bash
git add src/vision/embed.ts src/vision/embedWorker.ts tests/embed.integration.test.ts
git commit -m "feat: add staged SigLIP embedding worker"
```

---

### Task 13: Peak RSS measurement

**Files:**
- Create: `src/util/rss.ts`
- Test: `tests/rss.test.ts`

**Interfaces:**
- Consumes: `run` (Task 2).
- Produces: `class PeakRssTracker { start(): void; stop(): number }` reporting peak MB across this process and its descendants.

Implements spec §4/§20 — the memory budget must be measured, not assumed.

- [ ] **Step 1: Write the failing test**

```ts
// tests/rss.test.ts
import { describe, it, expect } from 'vitest';
import { PeakRssTracker } from '../src/util/rss.js';

describe('PeakRssTracker', () => {
  it('reports a plausible non-zero peak in MB', async () => {
    const t = new PeakRssTracker(20);
    t.start();
    const junk = new Array(2_000_000).fill(7);   // force some allocation
    await new Promise((r) => setTimeout(r, 120));
    const peak = t.stop();
    expect(junk.length).toBe(2_000_000);
    expect(peak).toBeGreaterThan(10);
    expect(peak).toBeLessThan(20_000);
  });
  it('stop() is safe without start()', () => {
    expect(new PeakRssTracker().stop()).toBeGreaterThanOrEqual(0);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/rss.test.ts` → Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/util/rss.ts`**

```ts
import { execSync } from 'node:child_process';

/**
 * Samples this process tree's RSS. The tool's peak is driven by the
 * short-lived ASR/vision workers, so sampling must span their lifetimes.
 */
export class PeakRssTracker {
  private timer: NodeJS.Timeout | null = null;
  private peakBytes = 0;

  constructor(private readonly intervalMs = 250) {}

  private sample(): void {
    this.peakBytes = Math.max(this.peakBytes, process.memoryUsage().rss);
    try {
      // Include descendants: `ps` RSS is in KB on macOS.
      const out = execSync(`ps -o rss= -g ${process.pid} 2>/dev/null || true`, { encoding: 'utf8' });
      const total = out.split('\n').map((l) => Number(l.trim())).filter((n) => Number.isFinite(n) && n > 0)
        .reduce((a, b) => a + b, 0) * 1024;
      this.peakBytes = Math.max(this.peakBytes, total);
    } catch { /* sampling children is best-effort */ }
  }

  start(): void {
    this.sample();
    this.timer = setInterval(() => this.sample(), this.intervalMs);
    this.timer.unref?.();
  }

  /** @returns peak RSS in MB */
  stop(): number {
    this.sample();
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    return Math.round(this.peakBytes / 1048576);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/rss.test.ts` → Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/util/rss.ts tests/rss.test.ts
git commit -m "feat: measure peak RSS across the process tree"
```

---

### Task 14: Orchestrator — `analyzeVideo()`

**Files:**
- Create: `src/analyze.ts`, `src/manifest.ts`, `src/index.ts`
- Test: `tests/analyze.integration.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–13.
- Produces:
  - `analyzeVideo(url: string, opts?: AnalyzeOptions): Promise<Manifest>`
  - `buildManifest(parts): Manifest`

Implements spec §3 (data flow), §4/§19 (staged workers), §18 (range fallback).

- [ ] **Step 1: Implement `src/manifest.ts`**

```ts
import type { Manifest, SelectedFrame, Transcript, AnalyzeMode, ResolveStatus } from './types.js';
import { SELECTOR_VERSION } from './vision/select.js';

export function buildManifest(p: {
  url: string; platform: string; title: string; duration: number; resolvedBy: string;
  status: ResolveStatus; reason?: string;
  transcript: Transcript | null; frames: SelectedFrame[];
  candidateCount: number; peakRssMb: number; mode: AnalyzeMode;
}): Manifest {
  return {
    source: {
      url: p.url, platform: p.platform, title: p.title, duration: p.duration,
      resolvedBy: p.resolvedBy, status: p.status, ...(p.reason ? { reason: p.reason } : {}),
    },
    transcript: p.transcript,
    frames: p.frames,
    processing: {
      selectedFrames: p.frames.length,
      candidateFrames: p.candidateCount,
      peakRssMb: p.peakRssMb,
      selectorVersion: SELECTOR_VERSION,
      mode: p.mode,
    },
  };
}
```

- [ ] **Step 2: Implement `src/analyze.ts`**

```ts
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AnalyzeOptions, Manifest, Transcript, Candidate } from './types.js';
import { resolve } from './resolve/index.js';
import { probe, normalize, trim } from './media/ffmpeg.js';
import { FFmpegSceneDetector } from './media/scenes.js';
import { planCandidates, extractCandidates } from './media/candidates.js';
import { filterCandidates } from './vision/quality.js';
import { ocrFrame, computeTextNovelty } from './vision/ocr.js';
import { embedImages } from './vision/embed.js';
import { selectFrames } from './vision/select.js';
import { attachTranscript } from './align.js';
import { parseVtt, chooseCaptionTier } from './transcript/captions.js';
import { chooseAsrEngine } from './transcript/routing.js';
import { transcribeAudio } from './transcript/asr.js';
import { buildManifest } from './manifest.js';
import { PeakRssTracker } from './util/rss.js';

export async function analyzeVideo(url: string, opts: AnalyzeOptions = {}): Promise<Manifest> {
  const mode = opts.mode ?? 'accurate';
  const maxFrames = opts.maxFrames ?? 35;
  const rss = new PeakRssTracker();
  rss.start();

  const workDir = opts.outDir ?? mkdtempSync(join(tmpdir(), 'norma-'));
  mkdirSync(workDir, { recursive: true });
  const framesDir = join(workDir, 'frames');
  mkdirSync(framesDir, { recursive: true });

  // 1. Resolve
  const res = await resolve(url, { start: opts.start, end: opts.end, workDir });
  if (res.status !== 'ok') {
    return buildManifest({
      url, platform: 'unknown', title: '', duration: 0, resolvedBy: res.resolvedBy ?? 'none',
      status: res.status, reason: typeof res.reason === 'string' ? res.reason : res.message,
      transcript: null, frames: [], candidateCount: 0, peakRssMb: rss.stop(), mode,
    });
  }

  // 2. Apply the range if the resolver could not (spec §18: optimization, not guarantee)
  let media = res.filePath;
  if (opts.start !== undefined && opts.end !== undefined && !res.rangeApplied) {
    media = await trim(media, opts.start, opts.end, join(workDir, 'clip.mp4'));
  }

  // 3. Normalize
  const { video, audio } = await normalize(media, workDir);
  const meta = await probe(video);

  // 4. Transcript — STAGE 1 (ASR worker runs and exits before any vision work)
  let transcript: Transcript | null = null;
  if (opts.transcript !== false) {
    const tier = chooseCaptionTier(res.captions, mode);
    if (tier !== 'asr') {
      const file = tier === 'manual' ? res.captions.manual! : res.captions.auto!;
      if (existsSync(file)) {
        transcript = { language: res.languageHint ?? 'unknown', source: tier, segments: parseVtt(readFileSync(file, 'utf8')) };
      }
    }
    if (!transcript && existsSync(audio)) {
      const engine = chooseAsrEngine({ preferredLanguage: opts.preferredLanguage, languageHint: res.languageHint });
      transcript = await transcribeAudio(audio, { engine }).catch(() => null);
    }
  }

  // 5. Candidates -> quality filter -> OCR
  const boundaries = await new FFmpegSceneDetector().detect(video);
  const plan = planCandidates(meta.duration, boundaries);
  let cands: Candidate[] = await extractCandidates(video, plan, framesDir);
  const candidateCount = cands.length;
  cands = await filterCandidates(cands);

  const langs = chooseAsrEngine({ preferredLanguage: opts.preferredLanguage, languageHint: res.languageHint }) === 'sensevoice'
    ? 'chi_sim+eng' : 'eng';
  for (const c of cands) {
    const { content, subtitle } = await ocrFrame(c.imagePath, langs).catch(() => ({ content: '', subtitle: '' }));
    c.ocrContent = content; c.ocrSubtitle = subtitle;
  }
  cands = computeTextNovelty(cands);

  // 6. Embeddings — STAGE 2 (vision worker; ASR already exited)
  const vectors = await embedImages(cands.map((c) => c.imagePath)).catch(() => [] as number[][]);
  cands.forEach((c, i) => { const v = vectors[i]; if (v && v.length) c.embedding = v; });

  // 7. Select + align
  let frames = selectFrames(cands, maxFrames, meta.duration);
  if (transcript) frames = attachTranscript(frames, transcript.segments);

  return buildManifest({
    url, platform: res.platform, title: res.title, duration: meta.duration,
    resolvedBy: res.resolvedBy, status: 'ok',
    transcript, frames, candidateCount, peakRssMb: rss.stop(), mode,
  });
}
```

- [ ] **Step 3: Implement `src/index.ts`**

```ts
export { analyzeVideo } from './analyze.js';
export { resolve, pickResolver } from './resolve/index.js';
export { selectFrames, cosine, SELECTOR_VERSION } from './vision/select.js';
export { attachTranscript } from './align.js';
export type * from './types.js';
```

- [ ] **Step 4: Write the integration test**

```ts
// tests/analyze.integration.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeVideo } from '../src/analyze.js';
import { makeTestVideo } from '../src/media/ffmpeg.js';

describe('analyzeVideo (local file, end to end)', () => {
  it('produces a manifest with frames from a local synthetic video', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'norma-e2e-'));
    const v = await makeTestVideo(join(dir, 'v.mp4'), 9);
    const m = await analyzeVideo(`file://${v}`.replace('file://', ''), {
      maxFrames: 4, transcript: false, outDir: join(dir, 'out'),
    });
    expect(m.source.status).toBe('ok');
    expect(m.frames.length).toBeGreaterThan(0);
    expect(m.frames.length).toBeLessThanOrEqual(4);
    expect(m.processing.peakRssMb).toBeGreaterThan(0);
    expect(existsSync(m.frames[0]!.image)).toBe(true);
  }, 900_000);

  it('returns a clean failure manifest for an unresolvable URL', async () => {
    const m = await analyzeVideo('https://example.invalid/nope', { transcript: false });
    expect(m.source.status).not.toBe('ok');
    expect(m.frames).toEqual([]);
  }, 300_000);
});
```

Note: `DirectMediaResolver` currently requires a media extension. Add a local-path branch at the top of `resolve()` in `src/resolve/index.ts` so bare filesystem paths work:

```ts
import { existsSync } from 'node:fs';
// inside resolve(), before pickResolver:
if (!/^https?:\/\//i.test(url) && existsSync(url)) {
  const { probe } = await import('../media/ffmpeg.js');
  const p = await probe(url);
  return {
    status: 'ok', filePath: url, platform: 'local', title: url.split('/').pop() ?? 'video',
    duration: p.duration, resolvedBy: 'direct', captions: { manual: null, auto: null },
    languageHint: null, rangeApplied: false,
  };
}
```

- [ ] **Step 5: Run the test**

Run: `npm run build && npx vitest run tests/analyze.integration.test.ts`
Expected: PASS (2 tests). Inspect the printed `peakRssMb`.

- [ ] **Step 6: Commit**

```bash
git add src/analyze.ts src/manifest.ts src/index.ts src/resolve/index.ts tests/analyze.integration.test.ts
git commit -m "feat: add analyzeVideo orchestrator with staged workers"
```

---

### Task 15: CLI and power primitives

**Files:**
- Create: `src/cli.ts`, `src/primitives.ts`
- Test: `tests/primitives.test.ts`

**Interfaces:**
- Consumes: `analyzeVideo` (Task 14); `extractFrame`, `trim`, `probe` (Task 3); `resolve` (Task 5).
- Produces:
  - `parseArgs(argv: string[]): { url: string; opts: AnalyzeOptions }`
  - `getFrame(source: string, timestamp: number, outDir?: string): Promise<string>`
  - `getClip(source: string, start: number, end: number, fps: number, outDir?: string): Promise<string[]>`

Implements spec §18 — coarse-to-fine inspection.

- [ ] **Step 1: Write the failing test**

```ts
// tests/primitives.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from '../src/cli.js';
import { getFrame, getClip } from '../src/primitives.js';
import { makeTestVideo } from '../src/media/ffmpeg.js';

describe('parseArgs', () => {
  it('parses a url with a time range and frame budget', () => {
    const { url, opts } = parseArgs(['https://x.test/v', '--start', '23', '--end', '60', '--max-frames', '12']);
    expect(url).toBe('https://x.test/v');
    expect(opts.start).toBe(23);
    expect(opts.end).toBe(60);
    expect(opts.maxFrames).toBe(12);
  });
  it('defaults mode to accurate and supports --fast', () => {
    expect(parseArgs(['u']).opts.mode).toBe('accurate');
    expect(parseArgs(['u', '--fast']).opts.mode).toBe('fast');
  });
  it('supports --no-transcript', () => {
    expect(parseArgs(['u', '--no-transcript']).opts.transcript).toBe(false);
  });
});

describe('power primitives', () => {
  let video: string, dir: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'norma-prim-'));
    video = await makeTestVideo(join(dir, 'v.mp4'), 9);
  }, 60_000);

  it('getFrame writes a single frame', async () => {
    const p = await getFrame(video, 3, dir);
    expect(existsSync(p)).toBe(true);
  }, 60_000);

  it('getClip returns several frames at the requested fps', async () => {
    const frames = await getClip(video, 2, 5, 2, dir);
    expect(frames.length).toBeGreaterThanOrEqual(4);
    expect(frames.every((f) => existsSync(f))).toBe(true);
  }, 120_000);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/primitives.test.ts` → Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `src/primitives.ts`**

```ts
import { mkdtempSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from './util/run.js';
import { extractFrame } from './media/ffmpeg.js';

export async function getFrame(source: string, timestamp: number, outDir?: string): Promise<string> {
  const dir = outDir ?? mkdtempSync(join(tmpdir(), 'norma-frame-'));
  mkdirSync(dir, { recursive: true });
  return extractFrame(source, timestamp, join(dir, `frame_${timestamp.toFixed(2)}.jpg`));
}

/** Dense sampling of a narrow window — the coarse-to-fine second pass (spec §18). */
export async function getClip(
  source: string, start: number, end: number, fps = 2, outDir?: string,
): Promise<string[]> {
  const dir = outDir ?? mkdtempSync(join(tmpdir(), 'norma-clip-'));
  mkdirSync(dir, { recursive: true });
  const prefix = `clip_${start}_${end}_`;
  const r = await run('ffmpeg', [
    '-y', '-ss', String(start), '-to', String(end), '-i', source,
    '-vf', `fps=${fps}`, '-q:v', '3', join(dir, `${prefix}%04d.jpg`),
  ], { timeoutMs: 5 * 60_000 });
  if (r.code !== 0) throw new Error(`getClip failed: ${r.stderr.slice(-300)}`);
  return readdirSync(dir).filter((f) => f.startsWith(prefix)).sort().map((f) => join(dir, f));
}
```

- [ ] **Step 4: Implement `src/cli.ts`**

```ts
import { writeFileSync } from 'node:fs';
import type { AnalyzeOptions } from './types.js';
import { analyzeVideo } from './analyze.js';

export function parseArgs(argv: string[]): { url: string; opts: AnalyzeOptions } {
  const url = argv[0] ?? '';
  const opts: AnalyzeOptions = { mode: 'accurate' };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => argv[++i] ?? '';
    if (a === '--start') opts.start = Number(next());
    else if (a === '--end') opts.end = Number(next());
    else if (a === '--max-frames') opts.maxFrames = Number(next());
    else if (a === '--lang') opts.preferredLanguage = next();
    else if (a === '--out') opts.outDir = next();
    else if (a === '--fast') opts.mode = 'fast';
    else if (a === '--no-transcript') opts.transcript = false;
  }
  return { url, opts };
}

async function main(): Promise<void> {
  const { url, opts } = parseArgs(process.argv.slice(2));
  if (!url) {
    console.error('usage: norma <url> [--start S --end E] [--max-frames N] [--lang zh] [--fast] [--no-transcript] [--out DIR]');
    process.exit(1);
  }
  const manifest = await analyzeVideo(url, opts);
  const json = JSON.stringify(manifest, null, 2);
  if (opts.outDir) writeFileSync(`${opts.outDir}/manifest.json`, json);
  console.log(json);
}

if (import.meta.url === `file://${process.argv[1]}`) void main();
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/primitives.test.ts` → Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts src/primitives.ts tests/primitives.test.ts
git commit -m "feat: add CLI and coarse-to-fine power primitives"
```

---

### Task 16: MCP server

**Files:**
- Create: `src/mcp.ts`
- Test: `tests/mcp.test.ts`

**Interfaces:**
- Consumes: `analyzeVideo` (Task 14), `getFrame`/`getClip` (Task 15), `resolve` (Task 5), `transcribeAudio` (Task 11).
- Produces: `buildServer(): McpServer` exposing `analyze_video`, `resolve_video`, `get_frame`, `get_clip`.

Implements spec §18.

- [ ] **Step 1: Write the failing test**

```ts
// tests/mcp.test.ts
import { describe, it, expect } from 'vitest';
import { buildServer, TOOL_NAMES } from '../src/mcp.js';

describe('MCP server', () => {
  it('exposes the documented tool names', () => {
    expect(TOOL_NAMES).toContain('analyze_video');
    expect(TOOL_NAMES).toContain('get_frame');
    expect(TOOL_NAMES).toContain('get_clip');
    expect(TOOL_NAMES).toContain('resolve_video');
  });
  it('builds without throwing', () => {
    expect(() => buildServer()).not.toThrow();
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/mcp.test.ts` → Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/mcp.ts`**

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { analyzeVideo } from './analyze.js';
import { getFrame, getClip } from './primitives.js';
import { resolve } from './resolve/index.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const TOOL_NAMES = ['analyze_video', 'resolve_video', 'get_frame', 'get_clip'] as const;

export function buildServer(): McpServer {
  const server = new McpServer({ name: 'norma-video', version: '0.1.0' });

  server.tool(
    'analyze_video',
    'Extract a video from any URL and return a transcript plus important, deduplicated keyframes.',
    {
      url: z.string().describe('Page or direct video URL'),
      start: z.number().optional().describe('Start second of the range to analyze'),
      end: z.number().optional().describe('End second of the range to analyze'),
      maxFrames: z.number().optional().default(35),
      preferredLanguage: z.string().optional().describe('BCP-47ish hint, e.g. zh, ja, en'),
      mode: z.enum(['fast', 'accurate']).optional().default('accurate'),
    },
    async (args) => {
      const m = await analyzeVideo(args.url, args);
      return { content: [{ type: 'text', text: JSON.stringify(m, null, 2) }] };
    },
  );

  server.tool(
    'resolve_video',
    'Check whether a URL can be extracted, without downloading the whole pipeline.',
    { url: z.string() },
    async ({ url }) => {
      const r = await resolve(url, { workDir: mkdtempSync(join(tmpdir(), 'norma-res-')) });
      return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
    },
  );

  server.tool(
    'get_frame',
    'Extract one frame at a timestamp from an already-downloaded video file.',
    { source: z.string(), timestamp: z.number() },
    async ({ source, timestamp }) => {
      const p = await getFrame(source, timestamp);
      return { content: [{ type: 'text', text: p }] };
    },
  );

  server.tool(
    'get_clip',
    'Densely sample frames in a narrow window for a closer second look.',
    { source: z.string(), start: z.number(), end: z.number(), fps: z.number().optional().default(2) },
    async ({ source, start, end, fps }) => {
      const frames = await getClip(source, start, end, fps);
      return { content: [{ type: 'text', text: JSON.stringify(frames, null, 2) }] };
    },
  );

  return server;
}

async function main(): Promise<void> {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
}

if (import.meta.url === `file://${process.argv[1]}`) void main();
```

Install zod if the SDK does not already provide it: `npm install zod`

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/mcp.test.ts` → Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/mcp.ts tests/mcp.test.ts package.json
git commit -m "feat: expose analyze_video and primitives over MCP"
```

---

### Task 17: Acceptance matrix runner

**Files:**
- Create: `scripts/matrix.ts`, `docs/acceptance-matrix.md`
- Modify: `package.json` (add `matrix` script)

**Interfaces:**
- Consumes: `analyzeVideo` (Task 14).
- Produces: `runMatrix(cases: MatrixCase[]): Promise<MatrixResult[]>`; writes `docs/acceptance-matrix.md`.

Implements spec §20 — this **is** the acceptance test for network-touching behavior.

- [ ] **Step 1: Implement `scripts/matrix.ts`**

```ts
import { writeFileSync } from 'node:fs';
import { analyzeVideo } from '../src/analyze.js';
import type { AnalyzeOptions, ResolveStatus } from '../src/types.js';

interface MatrixCase {
  name: string; url: string; opts?: AnalyzeOptions;
  expectStatus: ResolveStatus; proves: string;
}

// Fill in concrete URLs before the first run; keep one case per spec §20 row.
const CASES: MatrixCase[] = [
  { name: 'youtube-manual-captions', url: process.env.M_YT_MANUAL ?? '', expectStatus: 'ok', proves: 'caption tier 1 + alignment' },
  { name: 'youtube-no-captions', url: process.env.M_YT_NOCAP ?? '', expectStatus: 'ok', proves: 'VAD -> Whisper ASR' },
  { name: 'tiktok-burned-in-subs', url: process.env.M_TIKTOK ?? '', expectStatus: 'ok', proves: 'subtitle-aware OCR does not over-select' },
  { name: 'facebook-reel', url: process.env.M_FACEBOOK ?? '', expectStatus: 'ok', proves: 'Facebook extraction' },
  { name: 'login-walled', url: process.env.M_AUTH ?? '', expectStatus: 'auth_required', proves: 'clean auth_required' },
  { name: 'direct-mp4', url: process.env.M_MP4 ?? '', expectStatus: 'ok', proves: 'DirectMediaResolver' },
  { name: 'generic-embed', url: process.env.M_EMBED ?? '', expectStatus: 'ok', proves: 'yt-dlp generic extraction' },
  { name: 'wechat-share', url: process.env.M_WECHAT ?? '', expectStatus: 'ok', proves: 'headless WeChat + SenseVoice' },
  { name: 'chinese-video', url: process.env.M_ZH ?? '', opts: { preferredLanguage: 'zh' }, expectStatus: 'ok', proves: 'SenseVoice routing' },
  { name: 'drm-page', url: process.env.M_DRM ?? '', expectStatus: 'unsupported', proves: 'clean unsupported/drm_protected' },
  { name: 'range-23-60', url: process.env.M_YT_MANUAL ?? '', opts: { start: 23, end: 60 }, expectStatus: 'ok', proves: 'range slice + fallback' },
];

export async function runMatrix(cases = CASES) {
  const rows: string[] = [
    '| Case | Proves | Status | Expected | Frames | Cands | Transcript | Peak RSS (MB) | Pass |',
    '|---|---|---|---|---:|---:|---|---:|:--:|',
  ];
  for (const c of cases) {
    if (!c.url) { rows.push(`| ${c.name} | ${c.proves} | _skipped: no URL_ | ${c.expectStatus} | - | - | - | - | - |`); continue; }
    let status = 'error', frames = 0, cands = 0, src = '-', rssMb = 0;
    try {
      const m = await analyzeVideo(c.url, { maxFrames: 20, ...c.opts });
      status = m.source.status; frames = m.frames.length; cands = m.processing.candidateFrames;
      src = m.transcript?.source ?? 'none'; rssMb = m.processing.peakRssMb;
    } catch (e) { status = `threw: ${(e as Error).message.slice(0, 60)}`; }
    const pass = status === c.expectStatus ? 'YES' : 'NO';
    rows.push(`| ${c.name} | ${c.proves} | ${status} | ${c.expectStatus} | ${frames} | ${cands} | ${src} | ${rssMb} | ${pass} |`);
    console.log(`${pass === 'YES' ? 'PASS' : 'FAIL'} ${c.name} -> ${status} (peak ${rssMb} MB)`);
  }
  const doc = `# Acceptance Matrix\n\nGenerated by \`npm run matrix\`. Spec §20.\n\n${rows.join('\n')}\n\n` +
    `Memory target: peak RSS should trend below 2048 MB for the complete tool (spec §4).\n`;
  writeFileSync('docs/acceptance-matrix.md', doc);
  return rows;
}

if (import.meta.url === `file://${process.argv[1]}`) void runMatrix();
```

- [ ] **Step 2: Add the npm script**

```bash
npm pkg set scripts.matrix="tsx scripts/matrix.ts"
```

- [ ] **Step 3: Populate URLs and run the matrix**

Set the `M_*` environment variables to concrete URLs (one per spec §20 row), then:

```bash
npm run build
M_YT_MANUAL="..." M_YT_NOCAP="..." M_TIKTOK="..." M_FACEBOOK="..." \
M_AUTH="..." M_MP4="..." M_EMBED="..." M_ZH="..." M_DRM="..." npm run matrix
```

Expected: `docs/acceptance-matrix.md` is written; every non-skipped row shows `YES`. Investigate any `NO` before declaring the PoC complete. The WeChat row stays skipped until the clean-room resolver is validated.

- [ ] **Step 4: Run the full unit suite**

Run: `npm test`
Expected: all unit tests pass (Tasks 1–16). Do not claim completion on a red suite.

- [ ] **Step 5: Commit**

```bash
git add scripts/matrix.ts docs/acceptance-matrix.md package.json
git commit -m "test: add acceptance matrix runner and results"
```

---

## Deferred / follow-up (not in this plan)

- **WeChat clean-room resolver** — owned by the parallel agent in `experiments/wechat-clean-room/`. When validated, replace the body of `resolveViaCleanRoom` in `src/resolve/wechat.ts` and un-skip the matrix row.
- **WeChat one-time activation UX** (Keychain storage, browser-assisted login, expiry probe) — spec §7.2.
- **Commercial licensing decision** for WeChat (independent reimplementation vs. licensing) — spec §7.4.
- **Detector benchmarking**: PySceneDetect / TransNetV2 against `FFmpegSceneDetector` — spec §22.2.
- **Spoken language identification** — `sherpa-onnx` exports `SpokenLanguageIdentification`; adopt only if benchmarks justify it over metadata routing (spec §9).
- **ASR vs auto-caption diffing** to flag low-confidence spans — spec §9.
