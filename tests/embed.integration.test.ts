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
    // TRAP GUARD -- the custom message below is the load-bearing part, not
    // this comment: it must appear in the test's FAILURE OUTPUT so a future
    // maintainer who "simplifies" to pipeline('image-feature-extraction')
    // sees why it broke without having to go read this source file.
    expect(
      a!.length,
      `got ${a!.length}-dim vector, expected 768. 150528 = 196*768 is what ` +
      `pipeline('image-feature-extraction') actually returns for this model -- ` +
      `the UN-POOLED per-patch hidden state (a 14x14=196 patch grid x 768 ` +
      `dims), NOT the pooled embedding and NOT raw pixels either. Similarity ` +
      `computed over it is dominated by low-level patch statistics, not the ` +
      `pooled semantic representation, so it silently "works" (cosine ordering ` +
      `can still look plausible) while destroying the semantic signal this ` +
      `tool depends on. Use SiglipVisionModel + pooler_output instead. See ` +
      `task-12-brief.md, section "THE TRAP".`,
    ).toBe(768);
    expect(Math.hypot(...a!)).toBeCloseTo(1, 3);
  }, 600_000);

  it('scores identical images higher than different ones, and L2-normalizes every vector in the batch', async () => {
    const { embedImages } = await import('../dist/vision/embed.js');
    const { cosine } = await import('../dist/vision/select.js');
    const [a, b, c] = await embedImages([red, red2, blue]);
    // Semantic-meaningfulness check. NOTE this alone cannot distinguish real
    // SigLIP embeddings from the trap. Confirmed directly by running
    // pipeline('image-feature-extraction') against these same red/red2/blue
    // fixtures: under the trap, cosine(red,red2) = 0.9999999999999566 and
    // cosine(red,blue) = 0.8235119358344026 -- "same image" still outscores
    // "different image" there too, so this test alone would pass just as
    // readily whether the wrong or the right API is in use.
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
