import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseScdetOutput, FFmpegSceneDetector } from '../src/media/scenes.js';
import { makeTestVideo } from '../src/media/ffmpeg.js';

describe('parseScdetOutput', () => {
  it('extracts exact time and score values from scdet lavfi lines', () => {
    const s = `[scdet @ 0x1] lavfi.scd.score: 12.700, lavfi.scd.time: 2.000
[scdet @ 0x1] lavfi.scd.score: 30.100, lavfi.scd.time: 4.000`;
    const b = parseScdetOutput(s);
    // Exact structural equality (not toBeCloseTo/toBeGreaterThan): a swapped
    // time/score capture group, or a wrong normalization divisor (e.g. /10
    // instead of /100), would fail this. Expected scores are written as the
    // same division the implementation performs, so this isn't a float trap.
    expect(b).toEqual([
      { time: 2, score: 12.7 / 100 },
      { time: 4, score: 30.1 / 100 },
    ]);
  });

  it('returns an empty array when no scenes are detected', () => {
    expect(parseScdetOutput('no matches here')).toEqual([]);
  });

  it('defaults score to 0.5 when a time line has no accompanying score', () => {
    // Exercises the `s ? Number(s[1])/100 : 0.5` fallback branch, which the
    // two-line happy-path example above never reaches.
    const b = parseScdetOutput('[scdet @ 0x1] lavfi.scd.time: 3.5');
    expect(b).toEqual([{ time: 3.5, score: 0.5 }]);
  });

  it('parses real ffmpeg 8.0.1 scdet output, where whole-second times have no decimal point', () => {
    // Captured verbatim from a live `ffmpeg -vf scdet=... -f null -` run against
    // this project's fixture during implementation: real output renders
    // whole-second times as "2", not "2.000" like the hand-written example
    // above. A regex requiring a decimal point (e.g. `\d+\.\d+`) would match
    // the synthetic example but silently drop every real integer-second cut.
    const real = `[scdet @ 0x600000210000] lavfi.scd.score: 15.625, lavfi.scd.time: 2
[scdet @ 0x600000210000] lavfi.scd.score: 15.625, lavfi.scd.time: 4`;
    const b = parseScdetOutput(real);
    expect(b).toEqual([
      { time: 2, score: 15.625 / 100 },
      { time: 4, score: 15.625 / 100 },
    ]);
  });
});

describe('FFmpegSceneDetector', () => {
  let video: string;
  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'norma-scene-'));
    video = await makeTestVideo(join(dir, 's.mp4'), 6);
  }, 60_000);

  it('exposes a stable name for the pluggable-detector interface (spec §10)', () => {
    expect(new FFmpegSceneDetector().name).toBe('ffmpeg-scdet');
  });

  it('detects the two hard cuts in the synthetic fixture at ~2s and ~4s', async () => {
    const b = await new FFmpegSceneDetector().detect(video);
    expect(b.length).toBeGreaterThanOrEqual(2);
    // Membership checks rather than sorted-index checks: robust to an extra
    // spurious detection landing first, while still requiring the two real
    // cuts to be present at approximately the right times.
    expect(b.some((x) => x.time > 1.5 && x.time < 2.5)).toBe(true);
    expect(b.some((x) => x.time > 3.5 && x.time < 4.5)).toBe(true);
    expect(b.every((x) => x.score > 0)).toBe(true);
  }, 60_000);

  it('raising the threshold above the fixture score suppresses detection', async () => {
    // Proves the constructor's threshold argument actually reaches the ffmpeg
    // invocation rather than being accepted but ignored. The fixture's cuts
    // score ~15.6 (see the real-output parse test above); 50 is comfortably
    // above it, so a wired-through threshold must yield zero detections.
    const b = await new FFmpegSceneDetector(50).detect(video);
    expect(b).toEqual([]);
  }, 60_000);

  it('rejects when ffmpeg fails outright, instead of silently reporting no scenes', async () => {
    // A literal port of the brief's Step-3 sample parses stderr unconditionally
    // and never inspects the exit code, so a hard ffmpeg failure (missing
    // input, corrupt file) is indistinguishable from "no scene changes" --
    // both would resolve to []. This proves detect() surfaces the failure.
    await expect(
      new FFmpegSceneDetector().detect(join(tmpdir(), 'norma-does-not-exist-6.mp4')),
    ).rejects.toThrow();
  });
});
