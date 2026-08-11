import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { orderByLanguagePreference, pickManualCaption, pickAutoTrack } from '../src/resolve/ytdlp.js';
import type { YtDlpMeta } from '../src/resolve/ytdlp.js';

// Pure-logic coverage for the metadata-driven caption selection that replaced
// the filename-infix guesswork (the old findCaption keyed on a `.auto.`
// infix yt-dlp never writes). The resolver-level, faked-yt-dlp tests live in
// tests/resolve.test.ts; these pin the selection rules themselves.

function workDirWith(files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'norma-caps-'));
  for (const f of files) writeFileSync(join(dir, f), 'WEBVTT\n');
  return dir;
}

describe('orderByLanguagePreference', () => {
  it('orders preferred > platform hint > English > rest', () => {
    expect(orderByLanguagePreference(['ar', 'en', 'fr', 'ja'], 'ja', 'fr'))
      .toEqual(['ja', 'fr', 'en', 'ar']);
  });
  it('matches language variants by base tag (en-US counts as en; zh-Hans as zh)', () => {
    expect(orderByLanguagePreference(['ar', 'en-US', 'zh-Hans'], 'zh')[0]).toBe('zh-Hans');
    expect(orderByLanguagePreference(['ar', 'en-US'], undefined, null)[0]).toBe('en-US');
  });
  it('prefers the -orig (as-spoken) variant within a tier', () => {
    expect(orderByLanguagePreference(['en', 'en-orig'], undefined, null)[0]).toBe('en-orig');
  });
  it('keeps stable input order when nothing else discriminates', () => {
    expect(orderByLanguagePreference(['de', 'ar'], undefined, null)).toEqual(['de', 'ar']);
  });
});

describe('pickManualCaption', () => {
  it('returns null for an auto-captions-only video (the case the old code misreported as manual)', () => {
    const dir = workDirWith(['source.en.vtt']); // the auto track, as the OLD invocation wrote it
    const meta: YtDlpMeta = {
      subtitles: {},
      automatic_captions: { en: [{ ext: 'vtt', url: 'https://x/en' }] },
      requested_subtitles: null,
    };
    expect(pickManualCaption(dir, meta)).toBeNull();
  });
  it('picks the deliberately-ordered language among downloaded manual tracks', () => {
    const dir = workDirWith(['source.ar.vtt', 'source.en.vtt']);
    const meta: YtDlpMeta = {
      language: null,
      requested_subtitles: { ar: { ext: 'vtt' }, en: { ext: 'vtt' } },
    };
    const pick = pickManualCaption(dir, meta);
    expect(pick?.path.endsWith('source.en.vtt')).toBe(true);
    expect(pick?.language).toBe('en');
  });
  it('skips a track whose negotiated ext nothing downstream can parse (yt-dlp falls back to formats[-1], e.g. json3)', () => {
    const dir = workDirWith(['source.en.json3']);
    const meta: YtDlpMeta = { requested_subtitles: { en: { ext: 'json3' } } };
    expect(pickManualCaption(dir, meta)).toBeNull();
  });
  it('ignores a requested track whose file was never written', () => {
    const dir = workDirWith([]);
    const meta: YtDlpMeta = { requested_subtitles: { en: { ext: 'vtt' } } };
    expect(pickManualCaption(dir, meta)).toBeNull();
  });
});

describe('pickAutoTrack', () => {
  it('chooses by the same deliberate language order and only formats it can use', () => {
    const meta: YtDlpMeta = {
      language: 'fr',
      automatic_captions: {
        ar: [{ ext: 'vtt', url: 'https://x/ar' }],
        fr: [{ ext: 'json3', url: 'https://x/fr-json' }, { ext: 'vtt', url: 'https://x/fr-vtt' }],
      },
    };
    const t = pickAutoTrack(meta);
    expect(t?.lang).toBe('fr');
    expect(t?.format.url).toBe('https://x/fr-vtt');
  });
  it('falls past a language with no parseable format to the next choice', () => {
    const meta: YtDlpMeta = {
      language: 'fr',
      automatic_captions: {
        fr: [{ ext: 'json3', url: 'https://x/fr-json' }],
        en: [{ ext: 'vtt', url: 'https://x/en' }],
      },
    };
    expect(pickAutoTrack(meta)?.lang).toBe('en');
  });
  it('never picks live_chat and returns null when nothing usable exists', () => {
    expect(pickAutoTrack({ automatic_captions: { live_chat: [{ ext: 'json', url: 'https://x/lc' }] } })).toBeNull();
    expect(pickAutoTrack({})).toBeNull();
  });
});
