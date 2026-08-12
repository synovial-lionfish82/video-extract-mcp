import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeTestVideo } from '../src/media/ffmpeg.js';

const embedSpy = vi.fn();
const asrSpy = vi.fn();
vi.mock('../dist/vision/embed.js', async (orig) => {
  const real = await orig<typeof import('../dist/vision/embed.js')>();
  // Calling through with a spread `unknown[]` needs an escape-hatch cast.
  // `never` (as literally given in the task brief) has no call signature at
  // all -- vitest's type-stripped execution and the root tsconfig (tests/
  // excluded) never notice, but `npm run typecheck` strict-checks tests/ and
  // fails on it. `any` is callable and is what was clearly intended.
  return { ...real, embedImages: (...a: unknown[]) => { embedSpy(); return (real.embedImages as any)(...a); } };
});
vi.mock('../dist/transcript/asr.js', async (orig) => {
  const real = await orig<typeof import('../dist/transcript/asr.js')>();
  // See the embedImages mock above: same `never` -> `any` fix.
  return { ...real, transcribeAudio: (...a: unknown[]) => { asrSpy(); return (real.transcribeAudio as any)(...a); } };
});
// Wrapped (not replaced): every existing test in this file needs extractFrame
// to genuinely run, since it's what 'even' sampling and candidate extraction
// both call through to. Only the shortfall test below overrides one call.
vi.mock('../dist/media/ffmpeg.js', async (orig) => {
  const real = await orig<typeof import('../dist/media/ffmpeg.js')>();
  return { ...real, extractFrame: vi.fn(real.extractFrame) };
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

  it('ignores a half-specified range in even mode too (Fix 4b / deferred #20): a lone start does not narrow sampling', async () => {
    // src/mcp.ts documents "provide with end; either alone is ignored" for
    // analyze_video's start/end. Pre-fix, 'even' mode's own from/to fallback
    // took a lone start independently of end, silently narrowing the
    // sampling window to [start, duration) -- a three-way split (download
    // full, transcript full, frames narrowed) nothing documented.
    const { analyzeVideo } = await import('../dist/analyze.js');
    const m = await analyzeVideo(video, {
      start: 7, // end deliberately omitted -- video is the 9s fixture from beforeAll
      frames: 'even', maxFrames: 3, transcript: false,
      outDir: join(dir, 'half-range'),
    });
    expect(m.source.status).toBe('ok');
    // If `start` alone had narrowed the window to [7, 9), every sampled
    // frame would land at or after second 7 (evenTimestamps(7,9,3) is
    // [7, 7.67, 8.33] -- all >= 7). With the bound genuinely ignored,
    // sampling spans the full [0, 9) video instead (evenTimestamps(0,9,3)
    // is [0, 3, 6]), so at least one frame must land before second 7.
    expect(m.frames.some((f) => f.timestamp < 7)).toBe(true);
  }, 300_000);
});

// task-3-brief.md's own reviewed follow-up (task-2-report.md, "minor
// (deferred)"): sampleEven silently drops a timestamp whose extraction
// fails, so a caller can end up with fewer frames than asked for with no
// indication why. Manifest.processing.warnings exists precisely so a
// healthy result is distinguishable from a silently degraded one.
describe('even sampling shortfall warnings', () => {
  it('does not spuriously warn when a single instant collapses a larger budget to one sample', async () => {
    // evenTimestamps(5, 5, 10) legitimately returns exactly ONE stamp --
    // that is not a shortfall, it is what a single-instant request means
    // regardless of the budget. Comparing the actual frame count against
    // the RAW maxFrames (10) instead of against what evenTimestamps itself
    // planned (1) would wrongly flag this healthy result as degraded --
    // catches an implementation that warns on `cands.length < maxFrames`.
    const { analyzeVideo } = await import('../dist/analyze.js');
    const m = await analyzeVideo(video, {
      start: 5, end: 5, maxFrames: 10, frames: 'even', transcript: false,
      outDir: join(dir, 'instant-overbudget'),
    });
    expect(m.source.status).toBe('ok');
    expect(m.frames).toHaveLength(1);
    expect(m.processing.warnings).toEqual([]);
  }, 300_000);

  it('records a warning when even sampling genuinely extracts fewer frames than requested', async () => {
    // Forces a real shortfall: 3 distinct timestamps are planned (clip-
    // relative 0, 2, 4 across the trimmed [2,8) range), and the FIRST
    // extraction is made to fail via the wrapped extractFrame -- the same
    // "skip, don't abort the batch" contract sampleEven documents for a
    // genuinely unseekable point. Catches an implementation that never
    // compares actual output to what was planned at all (no warning ever
    // recorded), or one that miscounts the shortfall.
    const { extractFrame } = await import('../dist/media/ffmpeg.js');
    vi.mocked(extractFrame).mockImplementationOnce(async () => {
      throw new Error('SIMULATED: unseekable timestamp');
    });
    const { analyzeVideo } = await import('../dist/analyze.js');
    const m = await analyzeVideo(video, {
      start: 2, end: 8, maxFrames: 3, frames: 'even', transcript: false,
      outDir: join(dir, 'shortfall'),
    });
    expect(m.source.status).toBe('ok');
    expect(m.frames).toHaveLength(2);
    expect(
      m.processing.warnings.some((w) => w.includes('requested 3') && w.includes('extracted 2')),
    ).toBe(true);
  }, 300_000);
});

// Fix 2 (spec §8): the model-stage short-circuits above are necessary but not
// sufficient -- normalize()'s libx264 re-encode and full WAV extraction ran
// unconditionally underneath them, so a one-frame 'even' request with
// transcript:false still paid to re-encode and fully decode-to-PCM the whole
// source before ever sampling a frame. These assert file EXISTENCE, not
// timing (which is flaky and proves nothing under load): a work.wav/work.mp4
// that should never have been created either exists or it does not.
describe('media-stage cost (Fix 2: normalize()/WAV extraction pay only for what is needed)', () => {
  it('extracts no work.wav when transcript is false, even in the default (key) frame mode', async () => {
    const { analyzeVideo } = await import('../dist/analyze.js');
    const outDir = join(dir, 'no-wav');
    const m = await analyzeVideo(video, { maxFrames: 2, transcript: false, outDir });
    expect(m.source.status).toBe('ok');
    expect(existsSync(join(outDir, 'work.wav'))).toBe(false);
  }, 300_000);

  it('re-encodes no work.mp4 in even mode -- samples the un-normalized media directly', async () => {
    const { analyzeVideo } = await import('../dist/analyze.js');
    const outDir = join(dir, 'no-reencode-even');
    const m = await analyzeVideo(video, {
      start: 1, end: 4, frames: 'even', maxFrames: 2, transcript: false, outDir,
    });
    expect(m.source.status).toBe('ok');
    expect(m.frames.length).toBeGreaterThan(0);
    expect(existsSync(join(outDir, 'work.mp4'))).toBe(false);
  }, 300_000);

  it('re-encodes no work.mp4 when frames is none', async () => {
    const { analyzeVideo } = await import('../dist/analyze.js');
    const outDir = join(dir, 'no-reencode-none');
    const m = await analyzeVideo(video, { frames: 'none', transcript: false, outDir });
    expect(m.source.status).toBe('ok');
    expect(existsSync(join(outDir, 'work.mp4'))).toBe(false);
  }, 300_000);

  it('positive control: key mode DOES produce work.mp4', async () => {
    // Without this, the three negative work.mp4 assertions above could pass
    // vacuously (an implementation that never re-encodes under ANY
    // circumstances would also pass them). This proves the opposite case
    // still does the real work.
    //
    // No work.wav assertion here (there was one, pre-Fix-6): Fix 6 now
    // deletes work.wav unconditionally once the transcript stage is done
    // with it (deferred #18), so its POST-CALL absence is identical whether
    // extraction genuinely ran and was cleaned up, or never ran at all --
    // file existence can no longer distinguish the two once cleanup exists.
    // The positive proof that extractAudio() is genuinely called under
    // transcript:true now lives in tests/analyze.integration.test.ts's
    // mocked-ffmpeg suite (the "extractAudio() throws" test requires the
    // real call to have happened for the mock to have thrown at all).
    const { analyzeVideo } = await import('../dist/analyze.js');
    const outDir = join(dir, 'both-produced');
    const m = await analyzeVideo(video, { maxFrames: 2, outDir });
    expect(m.source.status).toBe('ok');
    expect(existsSync(join(outDir, 'work.mp4'))).toBe(true);
  }, 300_000);
});
