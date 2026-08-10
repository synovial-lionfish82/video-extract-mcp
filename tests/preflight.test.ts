import { describe, it, expect } from 'vitest';
import { checkBinary, parseVersion } from '../scripts/preflight.js';

describe('preflight', () => {
  it('parses a yt-dlp style date version', () => {
    const result = parseVersion('2026.07.04');
    expect(result.version).toBe('2026.07.04');
    expect(result.matched).toBe(true);
  });
  it('reports a missing binary as not ok', async () => {
    const s = await checkBinary('definitely-not-a-real-binary-xyz');
    expect(s.present).toBe(false);
    expect(s.ok).toBe(false);
  });
  it('finds ffmpeg', async () => {
    const s = await checkBinary('ffmpeg');
    expect(s.present).toBe(true);
    expect(s.ok).toBe(true);
  });
  it('rejects a binary that exits with non-version stderr', async () => {
    // Test with 'false' which exits non-zero with no output
    const s = await checkBinary('false');
    expect(s.ok).toBe(false);
  });
});
