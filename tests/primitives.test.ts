import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { parseArgs } from '../src/cli.js';
import { getFrame, getClip } from '../src/primitives.js';
import { makeTestVideo } from '../src/media/ffmpeg.js';

describe('parseArgs', () => {
  it('parses a url with a time range and frame budget, as real numbers not strings', () => {
    const { url, opts } = parseArgs(['https://x.test/v', '--start', '23', '--end', '60', '--max-frames', '12']);
    expect(url).toBe('https://x.test/v');
    // toBe is Object.is, so a stray '23' string would already fail these --
    // typeof is asserted too so the numeric-conversion requirement is explicit,
    // not just an accidental side effect of strict equality.
    expect(opts.start).toBe(23);
    expect(opts.end).toBe(60);
    expect(opts.maxFrames).toBe(12);
    expect(typeof opts.start).toBe('number');
    expect(typeof opts.end).toBe('number');
    expect(typeof opts.maxFrames).toBe('number');
  });

  it('routes --lang and --out to distinct fields (catches a same-type field swap)', () => {
    // --start/--end/--max-frames could swap and still both be numbers, but a
    // --lang/--out swap between two STRING fields is exactly the case a weak
    // "is it truthy" assertion would miss. Distinct sentinel values close that gap.
    const outSentinel = join(tmpdir(), 'norma-cli-out-sentinel');
    const { opts } = parseArgs(['u', '--lang', 'zh', '--out', outSentinel]);
    expect(opts.preferredLanguage).toBe('zh');
    expect(opts.outDir).toBe(outSentinel);
  });

  it('defaults mode to accurate and supports --fast', () => {
    expect(parseArgs(['u']).opts.mode).toBe('accurate');
    expect(parseArgs(['u', '--fast']).opts.mode).toBe('fast');
  });

  it('supports --no-transcript and leaves transcript unset (not false) by default', () => {
    expect(parseArgs(['u', '--no-transcript']).opts.transcript).toBe(false);
    expect(parseArgs(['u']).opts.transcript).toBeUndefined();
  });

  it('consumes the argv slot immediately after the flag, not an adjacent one', () => {
    // If value-lookup peeks at the next token without actually advancing the
    // cursor past it, a value that itself looks like a flag (here "--fast",
    // passed as the --lang value) is left in the stream and mis-read as a
    // real flag on the next loop iteration -- flipping mode to 'fast' even
    // though --fast never appeared as a token in its own right. A shift in
    // the OTHER direction (skipping too far) would instead turn --lang's
    // value into '--fast' being lost and NaN/'' propagating from the wrong
    // slot. Either off-by-one direction is caught by this one case.
    const { opts } = parseArgs(['u', '--lang', '--fast']);
    expect(opts.preferredLanguage).toBe('--fast');
    expect(opts.mode).toBe('accurate');
  });
});

describe('power primitives', () => {
  let video: string, dir: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'norma-prim-'));
    // makeTestVideo(_, 9) produces a fixture that probes to EXACTLY 9.0s
    // (3 equal-length segments, no encoder rounding) -- verified separately --
    // which is what makes the exact-duration/past-duration cases below precise.
    video = await makeTestVideo(join(dir, 'v.mp4'), 9);
  }, 60_000);

  it('getFrame writes a single non-empty frame', async () => {
    const p = await getFrame(video, 3, dir);
    expect(existsSync(p)).toBe(true);
    // Existence alone is weak: a failed ffmpeg run can still leave a 0-byte file.
    expect(statSync(p).size).toBeGreaterThan(0);
  }, 60_000);

  it('getFrame handles a timestamp at the exact duration without an opaque throw', async () => {
    const p = await getFrame(video, 9, dir); // fixture duration is exactly 9.0s
    expect(existsSync(p)).toBe(true);
    expect(statSync(p).size).toBeGreaterThan(0);
  }, 60_000);

  it('getFrame handles a timestamp well past the duration without an opaque throw', async () => {
    const p = await getFrame(video, 14, dir); // duration(9) + 5
    expect(existsSync(p)).toBe(true);
    expect(statSync(p).size).toBeGreaterThan(0);
  }, 60_000);

  it('getClip at fps=1 over a 3s window returns exactly 3 frames, in order', async () => {
    // Separate output dir per fps value: getClip's file prefix is
    // `clip_${start}_${end}_` and does NOT include fps, so two calls with
    // the same start/end sharing one directory would silently contaminate
    // each other's file counts (stale files from one call surviving into
    // the other's readdir scan). Empirically confirmed via a standalone
    // ffmpeg run before writing this test.
    const frames = await getClip(video, 2, 5, 1, join(dir, 'fps1'));
    expect(frames).toHaveLength(3);
    expect(frames.every((f) => existsSync(f) && statSync(f).size > 0)).toBe(true);
    // Exact expected filename sequence: catches both a wrong frame COUNT
    // (fps ignored/hardcoded) and OUT-OF-ORDER results (reversed/shuffled)
    // in a single assertion, since any reordering changes this array.
    expect(frames.map((f) => basename(f))).toEqual([
      'clip_2_5_0001.jpg', 'clip_2_5_0002.jpg', 'clip_2_5_0003.jpg',
    ]);
  }, 120_000);

  it('getClip at fps=2 over the same window returns exactly 6 frames (double fps=1, not the same count)', async () => {
    const frames = await getClip(video, 2, 5, 2, join(dir, 'fps2'));
    expect(frames).toHaveLength(6);
    expect(frames.every((f) => existsSync(f) && statSync(f).size > 0)).toBe(true);
    expect(frames.map((f) => basename(f))).toEqual([
      'clip_2_5_0001.jpg', 'clip_2_5_0002.jpg', 'clip_2_5_0003.jpg',
      'clip_2_5_0004.jpg', 'clip_2_5_0005.jpg', 'clip_2_5_0006.jpg',
    ]);
  }, 120_000);

  it('getClip results are returned in strictly ascending sequence order', async () => {
    const frames = await getClip(video, 2, 5, 2, join(dir, 'fps2-order'));
    const indices = frames.map((f) => {
      const m = /_(\d+)\.jpg$/.exec(basename(f));
      if (!m?.[1]) throw new Error(`unexpected filename shape: ${f}`);
      return Number(m[1]);
    });
    for (let i = 1; i < indices.length; i++) {
      expect(indices[i]).toBeGreaterThan(indices[i - 1] as number);
    }
  }, 120_000);
});
