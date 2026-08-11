import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

// Gate on BOTH compiled outputs, not just the worker: embed.ts is what these
// tests actually `import()`, and Task 11's review found a skip-guard gap of
// exactly this shape (models present, one required build artifact missing)
// that errored loudly instead of skipping cleanly.
const ready = existsSync('dist/vision/embedWorker.js') && existsSync('dist/vision/embed.js');
let red: string, blue: string, red2: string, missing: string;

beforeAll(async () => {
  const d = mkdtempSync(join(tmpdir(), 'norma-emb-'));
  red = join(d, 'red.jpg'); blue = join(d, 'blue.jpg'); red2 = join(d, 'red2.jpg');
  missing = join(d, 'does-not-exist.jpg'); // never written -- deliberately unreadable
  await sharp({ create: { width: 224, height: 224, channels: 3, background: '#cc2222' } }).jpeg().toFile(red);
  await sharp({ create: { width: 224, height: 224, channels: 3, background: '#cc2222' } }).jpeg().toFile(red2);
  await sharp({ create: { width: 224, height: 224, channels: 3, background: '#2222cc' } }).jpeg().toFile(blue);
});

describe.skipIf(!ready)('SigLIP embed worker (integration)', () => {
  it('returns 768-dim normalized vectors, NOT raw pixels', async () => {
    const { embedImages } = await import('../dist/vision/embed.js');
    const [a] = await embedImages([red]);
    // 150528 = 224*224*3 is exactly what pipeline('image-feature-extraction')
    // returns (raw preprocessed pixels) if it is ever substituted in place of
    // SiglipVisionModel + pooler_output -- see task-12-brief.md's "THE TRAP".
    // If this assertion ever reports 150528 instead of 768, the wrong API is
    // in use and the frame selector would be deduplicating on raw pixels, not
    // semantics.
    expect(a!.length).toBe(768);
    expect(Math.hypot(...a!)).toBeCloseTo(1, 3);
  }, 600_000);

  it('scores identical images higher than different ones, and L2-normalizes every vector in the batch', async () => {
    const { embedImages } = await import('../dist/vision/embed.js');
    const { cosine } = await import('../dist/vision/select.js');
    const [a, b, c] = await embedImages([red, red2, blue]);
    // Semantic-meaningfulness check. NOTE this alone cannot distinguish real
    // SigLIP embeddings from raw pixels -- two bitwise-identical solid-color
    // JPEGs would also score highest cosine similarity as raw pixel vectors.
    // The 768-dim test above is the sole trap discriminator; this test only
    // establishes that whatever the vectors are, "same image" outscores
    // "different image", which is necessary but not sufficient on its own.
    expect(cosine(a!, b!)).toBeGreaterThan(cosine(a!, c!));
    // Extended beyond the brief's sample: every vector in the batch is
    // checked, not just index 0, so a mutant that only normalizes the first
    // image (e.g. a `norm` hoisted out of the per-image loop) is caught.
    expect(Math.hypot(...a!)).toBeCloseTo(1, 3);
    expect(Math.hypot(...b!)).toBeCloseTo(1, 3);
    expect(Math.hypot(...c!)).toBeCloseTo(1, 3);
  }, 600_000);

  it('keeps index alignment when one path in the middle fails to embed', async () => {
    const { embedImages } = await import('../dist/vision/embed.js');
    const r = await embedImages([red, missing, blue]);
    // The bad path sits in the MIDDLE slot on purpose -- this is the position
    // where a dropped-entry bug (as opposed to a truncated-at-the-end bug)
    // becomes visible: a naive `.filter(Boolean)`-style implementation would
    // return only 2 entries and silently shift blue's embedding into index 1.
    expect(r).toHaveLength(3);
    expect(r[0]).toHaveLength(768);
    expect(r[1]).toEqual([]); // unreadable path's slot: empty, not dropped
    expect(r[2]).toHaveLength(768);
  }, 600_000);
});
