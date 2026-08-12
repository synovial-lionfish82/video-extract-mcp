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

  it('accepts each --frames mode, the only way the CLI can reach "even"', () => {
    // resolveFrameMode only returns 'even' for an explicit frames value, so
    // without this flag uniform sampling and the single-frame recipe are
    // unreachable from the command line no matter what --max-frames says.
    expect(parseArgs(['u', '--frames', 'key']).opts.frames).toBe('key');
    expect(parseArgs(['u', '--frames', 'even']).opts.frames).toBe('even');
    expect(parseArgs(['u', '--frames', 'none']).opts.frames).toBe('none');
    expect(parseArgs(['u']).opts.frames).toBeUndefined();
  });

  it('rejects an invalid --frames value loudly instead of silently using "key"', () => {
    // A cast would let `--frames evne` through and analyze in the default
    // mode, so the caller gets a plausible-looking manifest for a request
    // that was never honoured.
    expect(() => parseArgs(['u', '--frames', 'evne'])).toThrow(/must be key, even or none/);
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

  it('supports --no-transcript and leaves transcript unset (not false) by default', () => {
    expect(parseArgs(['u', '--no-transcript']).opts.transcript).toBe(false);
    expect(parseArgs(['u']).opts.transcript).toBeUndefined();
  });

  it('consumes the argv slot immediately after the flag, not an adjacent one', () => {
    // If value-lookup peeks at the next token without actually advancing the
    // cursor past it, a value that itself looks like a flag (here
    // "--no-transcript", passed as the --lang value) is left in the stream
    // and mis-read as a real flag on the next loop iteration -- flipping
    // transcript to false even though --no-transcript never appeared as a
    // token in its own right. A shift in the OTHER direction (skipping too
    // far) would instead turn --lang's value into '--no-transcript' being
    // lost and NaN/'' propagating from the wrong slot. Either off-by-one
    // direction is caught by this one case. (Formerly used the now-removed
    // --fast flag as the "looks like a flag" canary -- spec §2.2 dropped
    // `mode` entirely, so --no-transcript takes over the same role here.)
    const { opts } = parseArgs(['u', '--lang', '--no-transcript']);
    expect(opts.preferredLanguage).toBe('--no-transcript');
    expect(opts.transcript).toBeUndefined();
  });

  it('a numeric flag with no following value does not silently become 0', () => {
    // Number('') is 0, so a `--start` truncated at the end of argv (no value
    // token left) previously set opts.start = 0 -- indistinguishable from an
    // explicit `--start 0`, silently changing behaviour for a truncated command.
    const { opts } = parseArgs(['u', '--start']);
    expect(opts.start).toBeUndefined();
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

  it('getFrame succeeds for a timestamp slightly past duration, naming the file from the timestamp actually used', async () => {
    const p = await getFrame(video, 9.2, dir); // 9.0s fixture, 0.2s past duration -- a genuine near-EOF seek
    expect(existsSync(p)).toBe(true);
    expect(statSync(p).size).toBeGreaterThan(0);
    // Must be named from the clamped timestamp actually extracted (duration
    // - retreat = 9 - 0.1 = 8.9), not the originally requested 9.2 -- a file
    // named after the request when the request wasn't what was extracted
    // actively misrepresents which instant it depicts.
    expect(basename(p)).toBe('frame_8.90.jpg');
  }, 60_000);

  it('getFrame throws, naming both the requested timestamp and the actual duration, for a wildly out-of-range request', async () => {
    // Reproduces the reviewer's exact repro: a request 100000s into a 9s
    // video must not silently succeed with a plausible-looking wrong frame.
    const err = await getFrame(video, 100000, dir).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toContain('100000');
    // '9' alone would trivially match a stray digit anywhere in the message;
    // '(9s)' pins the actual probed duration specifically.
    expect(msg).toContain('(9s)'); // the fixture's probed duration
  }, 60_000);

  it('getClip at fps=1 over a 3s window returns exactly 3 frames, in order', async () => {
    // Each fps value still gets its own output dir here, for clarity of
    // which files belong to which call -- but getClip itself is now safe
    // against outDir reuse across different fps values regardless (its file
    // prefix includes fps and clears stale matches before writing; see the
    // dedicated contamination-regression test below for the same-dir case).
    const frames = await getClip(video, 2, 5, 1, join(dir, 'fps1'));
    expect(frames).toHaveLength(3);
    expect(frames.every((f) => existsSync(f) && statSync(f).size > 0)).toBe(true);
    // Exact expected filename sequence: catches both a wrong frame COUNT
    // (fps ignored/hardcoded) and OUT-OF-ORDER results (reversed/shuffled)
    // in a single assertion, since any reordering changes this array.
    expect(frames.map((f) => basename(f))).toEqual([
      'clip_2_5_1_0001.jpg', 'clip_2_5_1_0002.jpg', 'clip_2_5_1_0003.jpg',
    ]);
  }, 120_000);

  it('getClip at fps=2 over the same window returns exactly 6 frames (double fps=1, not the same count)', async () => {
    const frames = await getClip(video, 2, 5, 2, join(dir, 'fps2'));
    expect(frames).toHaveLength(6);
    expect(frames.every((f) => existsSync(f) && statSync(f).size > 0)).toBe(true);
    expect(frames.map((f) => basename(f))).toEqual([
      'clip_2_5_2_0001.jpg', 'clip_2_5_2_0002.jpg', 'clip_2_5_2_0003.jpg',
      'clip_2_5_2_0004.jpg', 'clip_2_5_2_0005.jpg', 'clip_2_5_2_0006.jpg',
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

  it('getClip does not contaminate results when outDir is reused across calls with different fps', async () => {
    // outDir reuse across calls is the intended coarse-to-fine usage pattern,
    // not an edge case. Reproduces the reviewer's exact repro: a 4fps call
    // followed by a 2fps call into the SAME directory over the SAME window
    // must return exactly the second call's own 6 frames, not the first
    // call's leftover 12 (the old prefix, `clip_${start}_${end}_`, had no
    // fps component, so the second call's readdir scan silently absorbed
    // the first call's stale files).
    const shared = join(dir, 'shared-fps');
    const first = await getClip(video, 2, 5, 4, shared);
    expect(first).toHaveLength(12);
    const second = await getClip(video, 2, 5, 2, shared);
    expect(second).toHaveLength(6);
    expect(second.every((f) => existsSync(f) && statSync(f).size > 0)).toBe(true);
  }, 120_000);
});
