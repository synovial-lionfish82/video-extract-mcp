import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planCandidates, extractCandidates } from '../src/media/candidates.js';
import { makeTestVideo } from '../src/media/ffmpeg.js';

describe('planCandidates', () => {
  it('samples strictly after a boundary, never at the boundary itself (spec §10)', () => {
    const plan = planCandidates(60, [{ time: 10, score: 0.9 }], { heartbeatSec: 1000 });
    const fromScene = plan.find((p) => p.sceneSignificance > 0);
    expect(fromScene).toBeDefined();
    // Window (10.2, 10.6) straddles the ~350ms default offset and genuinely
    // excludes t=10 itself: an implementation that samples AT the cut (t=10,
    // the transition frame the design explicitly forbids) fails
    // toBeGreaterThan(10.2); one that ignores the offset also fails.
    expect(fromScene!.timestamp).toBeGreaterThan(10.2);
    expect(fromScene!.timestamp).toBeLessThan(10.6);
  });

  it('honors a custom postBoundaryOffsetMs precisely', () => {
    const plan = planCandidates(60, [{ time: 10, score: 0.9 }], {
      heartbeatSec: 1000,
      postBoundaryOffsetMs: 400,
    });
    const fromScene = plan.find((p) => p.sceneSignificance > 0);
    // Catches a hardcoded 350ms offset that ignores opts.postBoundaryOffsetMs.
    expect(fromScene!.timestamp).toBeCloseTo(10.4, 5);
  });

  it('adds heartbeat candidates spaced at heartbeatSec, proving periodicity (spec §11)', () => {
    const plan = planCandidates(30, [], { heartbeatSec: 5 });
    expect(plan.every((p) => p.sceneSignificance === 0)).toBe(true);
    expect(plan.length).toBeGreaterThanOrEqual(6);
    const times = plan.map((p) => p.timestamp);
    // A buggy implementation that satisfies "length >= N" with clustered or
    // randomly-jittered timestamps (not evenly spaced) would fail this loop --
    // merely having "some candidates" is not periodicity.
    for (let i = 1; i < times.length; i++) {
      expect(times[i]! - times[i - 1]!).toBeCloseTo(5, 5);
    }
  });

  it('heartbeat spacing follows a custom heartbeatSec, not a hardcoded default', () => {
    const plan = planCandidates(20, [], { heartbeatSec: 4 });
    const times = plan.map((p) => p.timestamp);
    expect(times.length).toBeGreaterThanOrEqual(5);
    for (let i = 1; i < times.length; i++) {
      expect(times[i]! - times[i - 1]!).toBeCloseTo(4, 5);
    }
  });

  it('sorts out-of-order boundaries before assigning ids, matching each id to its source boundary', () => {
    const plan = planCandidates(40, [{ time: 30, score: 0.9 }, { time: 8, score: 0.7 }], { heartbeatSec: 1000 });
    const sceneSamples = plan.filter((p) => p.sceneSignificance > 0).sort((a, b) => a.timestamp - b.timestamp);
    // Catches an implementation that assigns sceneId/significance by *input*
    // order instead of *time* order (the t=30 boundary was supplied first).
    expect(sceneSamples.map((p) => p.sceneId)).toEqual([1, 2]);
    expect(sceneSamples[0]!.sceneSignificance).toBeCloseTo(0.7, 5); // boundary at t=8
    expect(sceneSamples[1]!.sceneSignificance).toBeCloseTo(0.9, 5); // boundary at t=30
  });

  it('clamps a near-end boundary to duration rather than dropping it', () => {
    const plan = planCandidates(12, [{ time: 11.9, score: 0.9 }], { heartbeatSec: 5 });
    expect(plan.every((p) => p.timestamp <= 12)).toBe(true);
    // A naive "drop if timestamp+offset > duration" implementation would pass
    // the loose <=12 check above by omission; this proves the sample survives
    // (clamped), rather than vanishing.
    const clamped = plan.find((p) => p.sceneSignificance > 0);
    expect(clamped).toBeDefined();
    expect(clamped!.timestamp).toBe(12);
  });

  it('keeps the scene-derived candidate, not the heartbeat one, when timestamps collide', () => {
    const plan = planCandidates(30, [{ time: 5, score: 0.9 }], { heartbeatSec: 5 });
    const times = plan.map((p) => p.timestamp);
    const unique = new Set(times.map((t) => t.toFixed(1)));
    expect(unique.size).toBe(times.length);
    // The boundary sample lands at ~5.35 and collides with the heartbeat
    // sample at t=5 (both within the 0.5s merge window). If the dedup kept
    // the heartbeat instead of the scene sample, sceneSignificance here would
    // be 0, not 0.9 -- this is the actual defect a "no duplicate timestamps"
    // check alone would miss (it would pass either way).
    const survivor = plan.find((p) => Math.abs(p.timestamp - 5) < 0.5);
    expect(survivor).toBeDefined();
    expect(survivor!.sceneSignificance).toBeCloseTo(0.9, 5);
  });

  it('returns candidates in ascending time order', () => {
    const plan = planCandidates(40, [{ time: 30, score: 0.9 }, { time: 8, score: 0.7 }], { heartbeatSec: 5 });
    const t = plan.map((p) => p.timestamp);
    expect([...t].sort((a, b) => a - b)).toEqual(t);
  });
});

describe('extractCandidates', () => {
  let video: string;
  let outDir: string;
  let duration: number;
  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'norma-cand-'));
    video = await makeTestVideo(join(dir, 's.mp4'), 6);
    duration = 6;
    outDir = join(dir, 'out');
    mkdirSync(outDir, { recursive: true });
  }, 60_000);

  it('extracts a real frame per candidate and carries plan metadata through unchanged', async () => {
    const plan = [
      { timestamp: 1, sceneId: 0, sceneSignificance: 0 },
      { timestamp: 2.35, sceneId: 1, sceneSignificance: 0.8 },
      { timestamp: 4.35, sceneId: 2, sceneSignificance: 0.6 },
    ];
    const out = await extractCandidates(video, plan, outDir);
    expect(out).toHaveLength(3);
    out.forEach((c, i) => {
      // Fields must pass through unchanged from the plan (catches dropped or
      // mismapped metadata), and each image must be a real, non-empty file
      // written by a real ffmpeg call (no mocking).
      expect(c.timestamp).toBe(plan[i]!.timestamp);
      expect(c.sceneId).toBe(plan[i]!.sceneId);
      expect(c.sceneSignificance).toBe(plan[i]!.sceneSignificance);
      expect(existsSync(c.imagePath)).toBe(true);
      expect(statSync(c.imagePath).size).toBeGreaterThan(0);
      expect(c.quality).toBeGreaterThanOrEqual(0);
      expect(c.quality).toBeLessThanOrEqual(1);
    });
    // Distinct files -- catches a filename-template bug where every candidate
    // collides on the same output path (e.g. an index that never increments).
    expect(new Set(out.map((c) => c.imagePath)).size).toBe(3);
  }, 60_000);

  it('skips a candidate at an unseekable timestamp without rejecting the whole batch', async () => {
    const plan = [
      { timestamp: 1, sceneId: 0, sceneSignificance: 0 },
      { timestamp: duration + 500, sceneId: 1, sceneSignificance: 0.9 },
    ];
    const out = await extractCandidates(video, plan, outDir);
    // The bad seek (ffmpeg exits non-zero and writes no file, verified
    // separately at the ffmpeg layer) must be skipped, not thrown -- and the
    // good candidate must still come through. An implementation that lets the
    // rejection propagate would fail this whole test; one that "skips" by
    // still pushing a Candidate pointing at a nonexistent file would fail the
    // length/timestamp assertions below.
    expect(out).toHaveLength(1);
    expect(out[0]!.timestamp).toBe(1);
    expect(existsSync(out[0]!.imagePath)).toBe(true);
  }, 60_000);
});
