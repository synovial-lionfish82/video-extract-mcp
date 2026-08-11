import { describe, it, expect } from 'vitest';
import { chooseAsrEngine } from '../src/transcript/routing.js';

describe('chooseAsrEngine (spec §9)', () => {
  it.each(['zh', 'yue', 'ja', 'ko'])('routes %s to SenseVoice', (lang) => {
    expect(chooseAsrEngine({ preferredLanguage: lang })).toBe('sensevoice');
  });
  it('normalizes locale tags like zh-CN and ZH_hant', () => {
    expect(chooseAsrEngine({ preferredLanguage: 'zh-CN' })).toBe('sensevoice');
    expect(chooseAsrEngine({ preferredLanguage: 'ZH_hant' })).toBe('sensevoice');
  });
  it('routes English and unknown languages to Whisper', () => {
    expect(chooseAsrEngine({ preferredLanguage: 'en' })).toBe('whisper');
    expect(chooseAsrEngine({ preferredLanguage: 'sw' })).toBe('whisper');
  });
  it('defaults to Whisper when nothing is known', () => {
    expect(chooseAsrEngine({})).toBe('whisper');
  });
  it('prefers the explicit preferredLanguage over platform metadata', () => {
    expect(chooseAsrEngine({ preferredLanguage: 'en', languageHint: 'zh' })).toBe('whisper');
  });
  it('falls back to platform metadata when no preference is given', () => {
    expect(chooseAsrEngine({ languageHint: 'ja' })).toBe('sensevoice');
  });
});
