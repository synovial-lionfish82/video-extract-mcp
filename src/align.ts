import type { SelectedFrame, TranscriptSegment } from './types.js';

/** Spec §16: what was visible AND what was being said at that moment. */
export function attachTranscript(
  frames: SelectedFrame[], segments: TranscriptSegment[], windowSec = 4,
): SelectedFrame[] {
  return frames.map((f) => {
    const lo = f.timestamp - windowSec;
    const hi = f.timestamp + windowSec;
    const text = segments
      .filter((s) => s.end >= lo && s.start <= hi)   // any overlap counts
      .map((s) => s.text)
      .join(' ')
      .trim();
    return { ...f, transcriptWindow: text.length > 0 ? text : null };
  });
}
