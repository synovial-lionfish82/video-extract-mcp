import sharp from 'sharp';
import type { Candidate } from '../types.js';

/**
 * Variance of the discrete Laplacian (Pech-Pacheco et al.) over the interior
 * pixels of a grayscale image -- the standard cheap blur-detection metric.
 * Flat regions (no edges) produce a Laplacian of 0 everywhere, so the
 * variance is 0; sharp edges push individual responses far from the mean,
 * inflating the variance. w/h must match gray's dimensions (one byte per
 * pixel, row-major).
 */
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

// Starting thresholds (spec §12), validated in tests/quality.test.ts against
// real sharp/blurred/black/white/gray fixtures -- not against real footage.
const BLUR_FLOOR = 8; // laplacian variance below this reads as blur, fade, or dissolve
const DARK_FLOOR = 12; // mean luma (0..255)
const BRIGHT_CEIL = 243; // mean luma (0..255)

type RejectReason = 'too_dark' | 'too_bright' | 'blurry';

interface QualityScore {
  quality: number;
  blur: number;
  brightness: number;
  reject: boolean;
  reason?: RejectReason;
}

/**
 * Cheap pixel-statistics quality gate (spec §12), run before any OCR or
 * embedding model sees a candidate frame. Rejects near-black/near-white
 * frames and low-detail frames (motion blur, fades/dissolves -- both read as
 * low Laplacian variance). On survivors, `quality` is a saturating function
 * of blur so that ordinary sharp frames land mid-range rather than clustering
 * at 1.0 -- it is one weighted term in the later importance-selection score
 * (spec §15), so relative ordering among survivors matters, not just the
 * reject/keep boundary.
 */
export async function scoreQuality(imagePath: string): Promise<QualityScore> {
  const img = sharp(imagePath).grayscale();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const gray = new Uint8Array(data.buffer, data.byteOffset, data.length);
  const brightness = gray.reduce((a, b) => a + b, 0) / gray.length;
  const blur = laplacianVariance(gray, info.width, info.height);

  if (brightness < DARK_FLOOR) return { quality: 0, blur, brightness, reject: true, reason: 'too_dark' };
  if (brightness > BRIGHT_CEIL) return { quality: 0, blur, brightness, reject: true, reason: 'too_bright' };
  if (blur < BLUR_FLOOR) return { quality: 0, blur, brightness, reject: true, reason: 'blurry' };

  const quality = Math.min(1, Math.log10(1 + blur) / 3);
  return { quality, blur, brightness, reject: false };
}

/**
 * Scores every candidate and drops rejects. A candidate whose image can't
 * even be read (missing/corrupt file) is dropped the same way, rather than
 * failing the whole batch over one bad frame.
 */
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
