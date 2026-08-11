import { describe, it, expect } from 'vitest';
import { attachTranscript } from '../src/align.js';
import type { SelectedFrame, TranscriptSegment } from '../src/types.js';

const frame = (timestamp: number): SelectedFrame => ({
  timestamp, sceneId: 0, image: 'f.jpg', importance: 0.5, reasons: [],
  ocrContent: null, transcriptWindow: null, nearestSelectedSimilarity: 0,
});
const segs: TranscriptSegment[] = [
  { start: 0, end: 3, text: 'intro words' },
  { start: 10, end: 13, text: 'middle words' },
  { start: 30, end: 33, text: 'later words' },
];

describe('attachTranscript', () => {
  it('attaches segments overlapping the +/-4s window', () => {
    const out = attachTranscript([frame(11)], segs);
    expect(out[0]!.transcriptWindow).toBe('middle words');
  });
  it('includes a segment that merely overlaps the window edge', () => {
    const out = attachTranscript([frame(6.5)], segs);   // window 2.5..10.5 overlaps seg 0 and 1
    expect(out[0]!.transcriptWindow).toContain('intro words');
    expect(out[0]!.transcriptWindow).toContain('middle words');
  });
  it('is null when no speech is near the frame', () => {
    expect(attachTranscript([frame(20)], segs)[0]!.transcriptWindow).toBeNull();
  });
  it('respects a custom window', () => {
    expect(attachTranscript([frame(20)], segs, 12)[0]!.transcriptWindow).toContain('later words');
  });
  it('is null when there is no transcript at all', () => {
    expect(attachTranscript([frame(5)], [])[0]!.transcriptWindow).toBeNull();
  });
  it('does not mutate the input frames', () => {
    const f = [frame(11)];
    attachTranscript(f, segs);
    expect(f[0]!.transcriptWindow).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Mutation-hardening tests. The six tests above are the brief's Step 1
// fixture, kept byte-verbatim. These close gaps a reviewer's independent
// mutation would find that the six above do not:
//   - none of the six pin the JOIN ORDER or SEPARATOR: the "merely overlaps
//     the window edge" test uses two toContain() calls on a 2-segment
//     result, which both pass even if the segments are reversed or joined
//     with '' -- 'intro words' and 'middle words' are each a complete
//     substring wholly on one side of the join point, so neither check can
//     see a corrupted or reordered join;
//   - all six call attachTranscript with a SINGLE-element frames array, so
//     a mutant that hoists lo/hi out of the .map (computing the window once
//     from frames[0] and reusing it for every frame) is indistinguishable
//     from correct code across all of them.
// ---------------------------------------------------------------------------
describe('attachTranscript (mutation hardening)', () => {
  it('joins overlapping segments in chronological order with a single space', () => {
    // Same fixture as "merely overlaps the window edge" (frame 6.5, window
    // 2.5..10.5, matches seg0+seg1) but pinned with an EXACT string: a
    // reversed join ('middle words intro words') or a bad separator
    // ('intro wordsmiddle words', 'intro words  middle words') both fail
    // this assertion, whereas two independent toContain() calls would not.
    const out = attachTranscript([frame(6.5)], segs);
    expect(out[0]!.transcriptWindow).toBe('intro words middle words');
  });

  it('includes a segment whose end exactly touches the lower window bound', () => {
    // Deliberate choice: overlap uses CLOSED intervals ([s.start, s.end] vs
    // [lo, hi]), so end === lo counts as touching, not as missing. This
    // matches the reference implementation's `s.end >= lo` and the spec's
    // instruction that a segment straddling the window edge "must be
    // included" -- a segment ending exactly at the boundary is the limiting
    // case of straddling, not the first instant of silence.
    // frame(10), default window = [6, 14]. 'touches' ends exactly at 6;
    // 'outside' ends 0.001s earlier, pinning the cutoff precisely at the
    // boundary rather than at some looser margin.
    const boundarySegs: TranscriptSegment[] = [
      { start: 2, end: 5.999, text: 'outside' },
      { start: 3, end: 6, text: 'touches' },
    ];
    const out = attachTranscript([frame(10)], boundarySegs);
    expect(out[0]!.transcriptWindow).toBe('touches');
  });

  it('includes a segment whose start exactly touches the upper window bound', () => {
    // Symmetric case: start === hi counts as touching (s.start <= hi).
    // frame(10), default window = [6, 14]. 'touches' starts exactly at 14;
    // 'outside' starts 0.001s later and must be excluded.
    const boundarySegs: TranscriptSegment[] = [
      { start: 14, end: 17, text: 'touches' },
      { start: 14.001, end: 17, text: 'outside' },
    ];
    const out = attachTranscript([frame(10)], boundarySegs);
    expect(out[0]!.transcriptWindow).toBe('touches');
  });

  it('computes an independent window per frame instead of one shared window', () => {
    // Two frames whose +/-4s windows do not overlap each other's relevant
    // segment. A mutant that hoists lo/hi out of the .map (e.g. computing
    // them once from frames[0] and reusing that window for every frame) is
    // invisible to every test above, because they all pass a single-element
    // frames array.
    const out = attachTranscript([frame(1.5), frame(11)], segs);
    expect(out[0]!.transcriptWindow).toBe('intro words');   // window -2.5..5.5
    expect(out[1]!.transcriptWindow).toBe('middle words');  // window 7..15
  });
});
