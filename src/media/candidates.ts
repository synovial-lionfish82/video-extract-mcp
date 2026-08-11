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
