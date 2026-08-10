import type { TranscriptSegment, AnalyzeMode } from '../types.js';

const CUE = /(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[.,](\d{3})/;

function toSeconds(h: string, m: string, s: string, ms: string): number {
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
}

export function parseVtt(vtt: string): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  for (const block of vtt.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/).filter((l) => l.trim() !== '');
    const idx = lines.findIndex((l) => CUE.test(l));
    if (idx === -1) continue;
    const m = CUE.exec(lines[idx]!);
    if (!m) continue;
    const text = lines.slice(idx + 1)
      .join(' ')
      .replace(/<[^>]+>/g, '')      // inline cue tags
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) continue;
    out.push({
      start: toSeconds(m[1]!, m[2]!, m[3]!, m[4]!),
      end: toSeconds(m[5]!, m[6]!, m[7]!, m[8]!),
      text,
    });
  }
  return out;
}

/** Spec §9: accuracy-biased. Auto captions are only trusted in fast mode. */
export function chooseCaptionTier(
  captions: { manual: string | null; auto: string | null },
  mode: AnalyzeMode,
): 'manual' | 'auto' | 'asr' {
  if (captions.manual) return 'manual';
  if (captions.auto && mode === 'fast') return 'auto';
  return 'asr';
}
