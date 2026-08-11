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
  // Single instant (end === start) and reversed ranges (end < start) both return a single sample at start.
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
