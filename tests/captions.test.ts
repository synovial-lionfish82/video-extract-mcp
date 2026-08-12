import { describe, it, expect } from 'vitest';
import { parseVtt, chooseCaptionTier, clampSegmentsToRange, dedupeRollingCues } from '../src/transcript/captions.js';

const VTT = `WEBVTT

00:00:01.000 --> 00:00:04.200
Hello there

00:00:04.500 --> 00:00:06.000
<c>Second</c> line
`;

describe('parseVtt', () => {
  it('parses cues into timestamped segments', () => {
    const s = parseVtt(VTT);
    expect(s).toHaveLength(2);
    expect(s[0]).toEqual({ start: 1, end: 4.2, text: 'Hello there' });
  });
  it('strips inline cue tags and verifies second cue timing', () => {
    const s = parseVtt(VTT);
    expect(s[1]!.text).toBe('Second line');
    expect(s[1]).toEqual({ start: 4.5, end: 6, text: 'Second line' });
  });
  it('ignores malformed cues rather than throwing', () => {
    expect(parseVtt('WEBVTT\n\ngarbage\n')).toEqual([]);
  });
  it('recovers from malformed blocks between valid cues', () => {
    const vttMixed = `WEBVTT

00:00:01.000 --> 00:00:02.000
First valid cue

garbage line without timestamp

00:00:03.000 --> 00:00:04.000
Second valid cue
`;
    const s = parseVtt(vttMixed);
    expect(s).toHaveLength(2);
    expect(s[0]).toEqual({ start: 1, end: 2, text: 'First valid cue' });
    expect(s[1]).toEqual({ start: 3, end: 4, text: 'Second valid cue' });
  });
  it('correctly converts timestamps with hours', () => {
    const vttWithHours = `WEBVTT

01:23:45.500 --> 02:10:30.250
Long video segment
`;
    const s = parseVtt(vttWithHours);
    expect(s).toHaveLength(1);
    // 1h 23m 45.5s = 3600 + 1380 + 45.5 = 5025.5
    // 2h 10m 30.25s = 7200 + 600 + 30.25 = 7830.25
    expect(s[0]).toEqual({ start: 5025.5, end: 7830.25, text: 'Long video segment' });
  });
});

describe('clampSegmentsToRange', () => {
  const segs = [
    { start: 0.5, end: 1.5, text: 'before' },
    { start: 4, end: 5, text: 'inside' },
    { start: 8, end: 12, text: 'straddles-end' },
    { start: 20, end: 21, text: 'after' },
  ];
  it('drops segments outside the range and re-bases the rest to clip time', () => {
    expect(clampSegmentsToRange(segs, 3, 10)).toEqual([
      { start: 1, end: 2, text: 'inside' },
      { start: 5, end: 7, text: 'straddles-end' }, // truncated at the clip's end
    ]);
  });
  it('truncates a segment straddling the range start to clip time zero', () => {
    expect(clampSegmentsToRange([{ start: 2, end: 4, text: 'straddles-start' }], 3, 10))
      .toEqual([{ start: 0, end: 1, text: 'straddles-start' }]);
  });
  it('drops a segment that only touches the range boundary without overlap', () => {
    expect(clampSegmentsToRange([{ start: 1, end: 3, text: 'ends-at-start' }], 3, 10)).toEqual([]);
  });
});

describe('chooseCaptionTier', () => {
  const manual = { path: 'a.vtt', language: 'en' };
  const auto = { path: 'b.vtt', language: 'en' };
  it('prefers manual captions when both exist', () => {
    expect(chooseCaptionTier({ manual, auto })).toBe('manual');
    expect(chooseCaptionTier({ manual, auto: null })).toBe('manual');
  });
  it('USES automatic captions rather than falling back to local ASR', () => {
    // The policy reversal: measured against the shipped Whisper small model,
    // platform automatic captions won on transcript quality AND on timing
    // resolution for accented speech, sung speech and non-English speech.
    // Local ASR is the no-captions fallback, never a preferred tier.
    expect(chooseCaptionTier({ manual: null, auto })).toBe('auto');
  });
  it('falls back to asr only when the video has no captions at all', () => {
    expect(chooseCaptionTier({ manual: null, auto: null })).toBe('asr');
  });
});

describe('dedupeRollingCues (platform rolling captions)', () => {
  it('collapses the real YouTube pattern: scroll cue + repeated leading line', () => {
    // Shape copied from a real YouTube automatic track: a ~10ms "scroll" cue
    // holding the completed line, then a cue repeating it and appending.
    const cues = [
      { start: 0.654, end: 1.829, lines: ['[music] After the friendly against the'] },
      { start: 1.829, end: 1.839, lines: ['[music] After the friendly against the'] },
      { start: 1.839, end: 4.230, lines: ['[music] After the friendly against the', 'under-20 side, Blue Lock enters'] },
      { start: 4.230, end: 4.240, lines: ['under-20 side, Blue Lock enters'] },
      { start: 4.240, end: 6.269, lines: ['under-20 side, Blue Lock enters', 'a decisive new phase.'] },
    ];
    expect(dedupeRollingCues(cues)).toEqual([
      { start: 0.654, end: 1.829, lines: ['[music] After the friendly against the'] },
      { start: 1.839, end: 4.230, lines: ['under-20 side, Blue Lock enters'] },
      { start: 4.240, end: 6.269, lines: ['a decisive new phase.'] },
    ]);
  });

  it('keeps a genuine repeat that carries no new content (a chorus, not a scroll)', () => {
    // Same text twice, but at normal duration and with nothing appended.
    // Dropping this would silently delete a repeated lyric from a transcript.
    const cues = [
      { start: 0, end: 2, lines: ['we will take it back'] },
      { start: 2, end: 4, lines: ['we will take it back'] },
    ];
    expect(dedupeRollingCues(cues)).toEqual(cues);
  });

  it('leaves ordinary non-rolling captions completely untouched', () => {
    const cues = [
      { start: 0, end: 2, lines: ['first line'] },
      { start: 2, end: 4, lines: ['second line'] },
    ];
    expect(dedupeRollingCues(cues)).toEqual(cues);
  });

  it('strips a two-line overlap, not just a one-line one', () => {
    const cues = [
      { start: 0, end: 2, lines: ['alpha', 'bravo'] },
      { start: 2, end: 4, lines: ['alpha', 'bravo', 'charlie'] },
    ];
    expect(dedupeRollingCues(cues)).toEqual([
      { start: 0, end: 2, lines: ['alpha', 'bravo'] },
      { start: 2, end: 4, lines: ['charlie'] },
    ]);
  });

  it('deduplicates end to end through parseVtt, preserving per-cue timing', () => {
    const vtt = [
      'WEBVTT', '',
      '00:00:00.654 --> 00:00:01.829 align:start position:0%',
      ' ',
      '[music]<00:00:00.680><c> After</c><00:00:00.960><c> the</c>', '',
      '00:00:01.829 --> 00:00:01.839 align:start position:0%',
      '[music] After the',
      ' ', '',
      '00:00:01.839 --> 00:00:04.230 align:start position:0%',
      '[music] After the',
      'friendly<00:00:02.240><c> match</c>', '',
    ].join('\n');
    // Without dedupe this yields 3 segments and repeats "[music] After the"
    // three times; the inline word-timing tags must not defeat the match.
    expect(parseVtt(vtt)).toEqual([
      { start: 0.654, end: 1.829, text: '[music] After the' },
      { start: 1.839, end: 4.23, text: 'friendly match' },
    ]);
  });
});

describe('caption text is XML-decoded', () => {
  it("decodes entities so YouTube's >> speaker markers are readable", () => {
    const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n&gt;&gt; Tom &amp; Ana said &quot;hi&quot;\n';
    expect(parseVtt(vtt)[0]!.text).toBe('>> Tom & Ana said "hi"');
  });
  it('decodes after tag stripping, so an escaped angle bracket survives', () => {
    // Decoding first would produce a literal '<' that the tag stripper then
    // eats together with everything up to the next '>'.
    const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nuse &lt;div&gt; here\n';
    expect(parseVtt(vtt)[0]!.text).toBe('use <div> here');
  });
});
