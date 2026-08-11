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
 *
 * The default weights are deliberately strictly distinct (scene > text >
 * quality). Equal weights would make the scene/text priority order
 * unobservable — swapping them would be a behavioral no-op.
 */
export function intrinsicImportance(c: Candidate, o: SelectorOpts = {}): number {
  const wScene = o.wScene ?? 0.40;
  const wText = o.wText ?? 0.35;
  const wQuality = o.wQuality ?? 0.25;
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
