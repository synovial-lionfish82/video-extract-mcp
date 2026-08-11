import { describe, it, expect } from 'vitest';
import { parseVtt, chooseCaptionTier } from '../src/transcript/captions.js';

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

describe('chooseCaptionTier', () => {
  const manual = { path: 'a.vtt', language: 'en' };
  const auto = { path: 'b.vtt', language: 'en' };
  it('always prefers manual captions', () => {
    expect(chooseCaptionTier({ manual, auto }, 'accurate')).toBe('manual');
    expect(chooseCaptionTier({ manual, auto: null }, 'fast')).toBe('manual');
    expect(chooseCaptionTier({ manual, auto }, 'fast')).toBe('manual');
  });
  it('uses auto captions only in fast mode', () => {
    expect(chooseCaptionTier({ manual: null, auto }, 'fast')).toBe('auto');
    expect(chooseCaptionTier({ manual: null, auto }, 'accurate')).toBe('asr');
  });
  it('falls back to asr when nothing exists', () => {
    expect(chooseCaptionTier({ manual: null, auto: null }, 'fast')).toBe('asr');
  });
});
