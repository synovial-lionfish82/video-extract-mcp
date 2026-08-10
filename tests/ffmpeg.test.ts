import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probe, normalize, trim, extractFrame, makeTestVideo } from '../src/media/ffmpeg.js';

let dir: string, sample: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'norma-'));
  sample = await makeTestVideo(join(dir, 'sample.mp4'), 6);
}, 60_000);

describe('ffmpeg layer', () => {
  it('probes duration and dimensions', async () => {
    const p = await probe(sample);
    expect(p.duration).toBeGreaterThan(5);
    expect(p.width).toBe(640);
    expect(p.fps).toBeGreaterThan(0);
  });
  it('normalizes to a 720p-capped video plus 16kHz mono wav', async () => {
    const { video, audio } = await normalize(sample, dir);
    expect(existsSync(video)).toBe(true);
    expect(existsSync(audio)).toBe(true);
    expect((await probe(video)).height).toBeLessThanOrEqual(720);
  });
  it('trims to the requested range', async () => {
    const out = await trim(sample, 1, 3, join(dir, 'clip.mp4'));
    const p = await probe(out);
    expect(p.duration).toBeGreaterThan(1.5);
    expect(p.duration).toBeLessThan(2.6);
  });
  it('extracts a single frame at a timestamp', async () => {
    const out = await extractFrame(sample, 2.5, join(dir, 'f.jpg'));
    expect(existsSync(out)).toBe(true);
  });
});
