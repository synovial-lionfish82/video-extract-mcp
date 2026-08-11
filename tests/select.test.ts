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

// ---------------------------------------------------------------------------
// Mutation-hardening tests. Each fixture is small enough to hand-check.
// Default weights assumed: wScene=0.40, wText=0.35, wQuality=0.25,
// coverageWeight=0.5, similarityWeight=0.6.
// All quality values are 0.5, so every candidate carries +0.125 from quality.
// ---------------------------------------------------------------------------
describe('selectFrames (mutation hardening)', () => {
  const e1 = [1, 0, 0];
  const e2 = [0, 1, 0];
  const e3 = [0, 0, 1];

  it('re-scores the remaining pool after EVERY pick, not once up front', () => {
    // duration 40, budget 3 => coverage unit = 40/3 ~= 13.33s.
    // intrinsic: A=0.485, B=0.365, C=0.325, D=0.205 (hand-checkable).
    const cands = [
      cand({ timestamp: 0, sceneSignificance: 0.9, embedding: e1 }),  // A
      cand({ timestamp: 10, sceneSignificance: 0.6, embedding: e2 }), // B
      cand({ timestamp: 20, sceneSignificance: 0.5, embedding: e2 }), // C, visual twin of B
      cand({ timestamp: 30, sceneSignificance: 0.2, embedding: e3 }), // D, distinct but dull
    ];
    // Correct greedy: A (best) -> C (0.325+0.5*1=0.825 beats B 0.365+0.5*0.75=0.740)
    // -> then B is a twin of the JUST-picked C (0.365+0.375-0.6=0.140) so D wins (0.205+0.375=0.580).
    // One-shot ranking returns the top-3 intrinsic [A,B,C] = [0,10,20].
    // Scoring against only the FIRST pick also returns [0,10,20] (B's twin C is invisible to it).
    expect(selectFrames(cands, 3, 40).map((f) => f.timestamp)).toEqual([0, 20, 30]);
  });

  it('penalizes by the MAXIMUM similarity to the selected set, not the minimum', () => {
    // C is a twin of A (the first pick) and orthogonal to B (the second pick).
    // max similarity for C = 1 (correctly excluded); min similarity = 0 (would be picked).
    // intrinsic: A=0.485, B=0.365, C=0.405, D=0.205.
    const cands = [
      cand({ timestamp: 0, sceneSignificance: 0.9, embedding: e1 }),  // A
      cand({ timestamp: 10, sceneSignificance: 0.6, embedding: e2 }), // B
      cand({ timestamp: 20, sceneSignificance: 0.7, embedding: e1 }), // C, visual twin of A
      cand({ timestamp: 30, sceneSignificance: 0.2, embedding: e3 }), // D
    ];
    // Correct: A -> B (0.740) -> C penalized to 0.405+0.375-0.6=0.180, D wins with 0.705.
    // Min-similarity mutant: C scores 0.405+0.375-0=0.780 > 0.705 and steals the third slot.
    expect(selectFrames(cands, 3, 40).map((f) => f.timestamp)).toEqual([0, 10, 30]);
  });

  it('breaks exact score ties deterministically by earliest timestamp', () => {
    // No embeddings, identical intrinsic (0.125): pick 1 is a 4-way exact tie,
    // pick 2 an exact tie between t=200 and t=300 (both coverage 1). Every score
    // involved (0.625, 0.375) is float-exact, so the ties are exact, not approximate.
    const cands = [
      cand({ timestamp: 0, embedding: undefined }),
      cand({ timestamp: 100, embedding: undefined }),
      cand({ timestamp: 200, embedding: undefined }),
      cand({ timestamp: 300, embedding: undefined }),
    ];
    const first = selectFrames(cands, 2, 400).map((f) => f.timestamp);
    expect(first).toEqual([0, 200]);
    for (let run = 0; run < 5; run++) {
      expect(selectFrames(cands, 2, 400).map((f) => f.timestamp)).toEqual(first);
    }
  });

  it('distributes picks across timeline buckets instead of milking the hot cluster', () => {
    // Same shape as the spec §15 test but asserting the distribution directly:
    // picks must land in >=4 distinct 600s buckets and at most 2 may come from
    // the hot first minute.
    const hot = Array.from({ length: 15 }, (_, i) =>
      cand({ timestamp: i * 4, sceneSignificance: 0.9, embedding: v([1, i * 0.01 + 0.01, 0]) }));
    const cold = Array.from({ length: 5 }, (_, i) =>
      cand({ timestamp: 600 + i * 600, sceneSignificance: 0.2, embedding: v([0, 0, i + 1]) }));
    const picked = selectFrames([...hot, ...cold], 6, 3600);
    const buckets = new Set(picked.map((f) => Math.floor(f.timestamp / 600)));
    expect(buckets.size).toBeGreaterThanOrEqual(4);
    expect(picked.filter((f) => f.timestamp <= 60).length).toBeLessThanOrEqual(2);
  });

  it('rescues a high-textNovelty frame AFTER its visual twin was already selected', () => {
    // Unlike the spec-level rescue test above (where the texty frame has the top
    // intrinsic score and is picked first), here the twin A wins pick 1, so B must
    // survive a full similarity-1 penalty on pick 2. This is the slide-deck case:
    // every frame is a visual twin and textNovelty is the only differentiator.
    // intrinsic: A=0.505, B=0.44, C=0.125.
    const cands = [
      cand({ timestamp: 1, sceneSignificance: 0.95, embedding: e1 }),                    // A
      cand({ timestamp: 2, sceneSignificance: 0, textNovelty: 0.9, embedding: e1 }),     // B
      cand({ timestamp: 3, sceneSignificance: 0, embedding: e1 }),                       // C
    ];
    // Pick 2 scores: B = 0.44 + 0.5*0.2 - 0.6*1 = -0.06; C = 0.125 + 0.5*0.4 - 0.6*1 = -0.275.
    const picked = selectFrames(cands, 2, 10);
    expect(picked.map((f) => f.timestamp)).toEqual([1, 2]);
    expect(picked[1]!.nearestSelectedSimilarity).toBeCloseTo(1, 4);
    expect(picked[0]!.nearestSelectedSimilarity).toBeCloseTo(0, 4);
  });

  it('weights scene > text > quality with strictly distinct coefficients', () => {
    // Kills any permutation of the intrinsic weights: each candidate isolates one
    // weight, so the strict ordering pins wScene > wText > wQuality.
    const scene = intrinsicImportance(cand({ timestamp: 0, sceneSignificance: 1, textNovelty: 0, quality: 0 }));
    const text = intrinsicImportance(cand({ timestamp: 0, sceneSignificance: 0, textNovelty: 1, quality: 0 }));
    const quality = intrinsicImportance(cand({ timestamp: 0, sceneSignificance: 0, textNovelty: 0, quality: 1 }));
    expect(scene).toBeGreaterThan(text);
    expect(text).toBeGreaterThan(quality);
    expect(quality).toBeGreaterThan(0);
  });

  it('returns an empty array for a zero budget', () => {
    expect(selectFrames([cand({ timestamp: 1 })], 0, 10)).toEqual([]);
  });
});
