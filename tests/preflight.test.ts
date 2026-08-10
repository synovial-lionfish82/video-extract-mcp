import { describe, it, expect } from 'vitest';
import { checkBinary, parseVersion } from '../scripts/preflight.js';

describe('preflight', () => {
  it('parses a yt-dlp style date version', () => {
    expect(parseVersion('2026.07.04')).toBe('2026.07.04');
  });
  it('reports a missing binary as not ok', async () => {
    const s = await checkBinary('definitely-not-a-real-binary-xyz');
    expect(s.present).toBe(false);
    expect(s.ok).toBe(false);
  });
  it('finds ffmpeg', async () => {
    const s = await checkBinary('ffmpeg');
    expect(s.present).toBe(true);
  });
});
