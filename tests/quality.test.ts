import { describe, it, expect, beforeAll } from 'vitest';
import sharp from 'sharp';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { laplacianVariance, scoreQuality, filterCandidates } from '../src/vision/quality.js';
import type { Candidate } from '../src/types.js';

let dir: string;
let blackPath: string;
let whitePath: string;
let grayPath: string;
let detailPath: string;
let blurredPath: string;
let mildBlur2Path: string;
let mildBlur3Path: string;
let missingPath: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'norma-q-'));
  blackPath = join(dir, 'black.jpg');
  whitePath = join(dir, 'white.jpg');
  grayPath = join(dir, 'gray.jpg');
  detailPath = join(dir, 'detail.jpg');
  blurredPath = join(dir, 'blurred.jpg');
  mildBlur2Path = join(dir, 'mild-blur-2.jpg');
  mildBlur3Path = join(dir, 'mild-blur-3.jpg');
  // Never written -- exercises the "unreadable frame" path deterministically.
  missingPath = join(dir, 'does-not-exist.jpg');

  await sharp({ create: { width: 64, height: 64, channels: 3, background: '#000000' } })
    .jpeg().toFile(blackPath);
  await sharp({ create: { width: 64, height: 64, channels: 3, background: '#ffffff' } })
    .jpeg().toFile(whitePath);
  // Flat mid-tone: a stand-in for a fade/dissolve frame (spec §12) -- low
  // information, but nowhere near the dark/bright brightness extremes, so a
  // correct implementation must catch it via the blur/variance floor, not
  // the brightness floors.
  await sharp({ create: { width: 64, height: 64, channels: 3, background: '#808080' } })
    .jpeg().toFile(grayPath);

  // Sharp checkerboard: high edge energy.
  const px = Buffer.alloc(64 * 64 * 3);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    const v = ((x >> 3) + (y >> 3)) % 2 ? 255 : 0;
    const i = (y * 64 + x) * 3;
    px[i] = px[i + 1] = px[i + 2] = v;
  }
  await sharp(px, { raw: { width: 64, height: 64, channels: 3 } }).jpeg().toFile(detailPath);

  // Real blurs of the SAME detailed image via sharp's own Gaussian blur --
  // not a separately-authored "looks blurry" fixture. sigma=20 is heavy
  // enough to read as genuinely blurry; sigma=2/3 are mild enough that the
  // frame should still be kept, letting the ordering test compare two
  // "kept" frames of different sharpness.
  await sharp(detailPath).blur(20).jpeg().toFile(blurredPath);
  await sharp(detailPath).blur(2).jpeg().toFile(mildBlur2Path);
  await sharp(detailPath).blur(3).jpeg().toFile(mildBlur3Path);
}, 30_000);

describe('laplacianVariance', () => {
  it('is ~0 for a flat image (no edges -> the discrete Laplacian is 0 at every interior pixel)', () => {
    expect(laplacianVariance(new Uint8Array(64 * 64).fill(128), 64, 64)).toBeLessThan(1);
  });

  it('is large for a high-contrast edge pattern, far outside the flat-image range', () => {
    const g = new Uint8Array(64 * 64);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) g[y * 64 + x] = ((x >> 3) + (y >> 3)) % 2 ? 255 : 0;
    const v = laplacianVariance(g, 64, 64);
    // Measured for this exact 64x64, 8px-block checkerboard: ~35997 (see
    // task-7-report.md). Asserting a bound well below that (not exact
    // equality, to stay robust to arithmetic-order differences) still leaves
    // a >100x margin over the brief's original >100 floor.
    expect(v).toBeGreaterThan(10_000);
    // Together with the flat-image assertion above (<1), no single constant
    // return value can satisfy both -- an implementation that always returns
    // the same number, whatever it is, fails at least one of these two tests.
  });

  it('is ~0 for a linear ramp -- catches a miscalibrated center coefficient the flat/edgy pair above cannot', () => {
    // A flat image is constant under ANY spatially-uniform kernel, correct or
    // not: variance of a constant is 0 no matter what the kernel's exact
    // weights are, so the flat-image test above cannot tell the correct
    // kernel (center weight -4, balancing the four unit-weight neighbors)
    // apart from a miscalibrated one. A linear ramp closes that gap: its
    // discrete second derivative is exactly 0 only when the center
    // coefficient exactly balances the neighbor weights.
    // Empirically verified against a hand-written -3-instead-of-4 mutant of
    // this exact function: it scores 0 on the flat image (identical to
    // correct) and ~22887 on the checkerboard above -- comfortably over the
    // >10_000 bound, i.e. it silently passes both tests above -- but scores
    // ~320 on this ramp, versus the correct implementation's exact 0.
    const ramp = new Uint8Array(64 * 64);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) ramp[y * 64 + x] = x;
    expect(laplacianVariance(ramp, 64, 64)).toBeLessThan(1);
  });
});

describe('scoreQuality', () => {
  it('rejects an all-black frame specifically as too_dark', async () => {
    const r = await scoreQuality(blackPath);
    expect(r.reject).toBe(true);
    expect(r.reason).toBe('too_dark');
    expect(r.brightness).toBeLessThan(12);
  });

  it('rejects an all-white frame specifically as too_bright', async () => {
    const r = await scoreQuality(whitePath);
    expect(r.reject).toBe(true);
    expect(r.reason).toBe('too_bright');
    expect(r.brightness).toBeGreaterThan(243);
  });

  it('rejects a genuinely blurred detailed frame specifically as blurry', async () => {
    // detailPath (unblurred) is proven "kept" by the test below; blurredPath
    // is the identical image run through a real sharp Gaussian blur. A filter
    // that accepts everything, or that never checks blur at all, would pass
    // a "sharp image is kept" test trivially -- this is the test that
    // actually exercises rejection and proves it does the job.
    const r = await scoreQuality(blurredPath);
    expect(r.reject).toBe(true);
    expect(r.reason).toBe('blurry');
    // Mid-range brightness proves this rejection is genuinely about blur,
    // not a side effect of the dark/bright checks misfiring for the wrong
    // reason (blurring is expected to roughly preserve mean brightness).
    expect(r.brightness).toBeGreaterThan(12);
    expect(r.brightness).toBeLessThan(243);
  });

  it('rejects a flat mid-gray frame as blurry (fade/dissolve proxy, spec §12), not as dark/bright', async () => {
    const r = await scoreQuality(grayPath);
    expect(r.reject).toBe(true);
    expect(r.reason).toBe('blurry');
  });

  it('keeps a sharp detailed frame, with no reason and quality above zero', async () => {
    const r = await scoreQuality(detailPath);
    expect(r.reject).toBe(false);
    expect(r.reason).toBeUndefined();
    expect(r.quality).toBeGreaterThan(0);
  });

  it('reject reasons are individually distinct, not collapsed into one label', async () => {
    // Asserting reject===true alone (as in the two tests above, read in
    // isolation) would also pass an implementation that always reports the
    // SAME reason regardless of cause. This test fails that implementation
    // directly: three different rejection causes must produce three
    // different reason strings.
    const [dark, bright, blurry] = await Promise.all([
      scoreQuality(blackPath),
      scoreQuality(whitePath),
      scoreQuality(blurredPath),
    ]);
    const reasons = new Set([dark.reason, bright.reason, blurry.reason]);
    expect(reasons.size).toBe(3);
  });

  it('quality ordering tracks blur magnitude among frames that are ALL kept -- not a fixed pass value', async () => {
    // Design intent (spec §15): quality is one weighted term in the later
    // importance score, so its relative ordering matters, not only its
    // reject/keep threshold behavior. All three images here are unrejected
    // (reject: false) -- an implementation that returns a constant quality
    // whenever reject is false (e.g. always 1) would tie all three and fail
    // this test, even though it would pass every reject/keep test above.
    const sharpR = await scoreQuality(detailPath);
    const mild2 = await scoreQuality(mildBlur2Path);
    const mild3 = await scoreQuality(mildBlur3Path);
    expect(sharpR.reject).toBe(false);
    expect(mild2.reject).toBe(false);
    expect(mild3.reject).toBe(false);
    expect(sharpR.quality).toBeGreaterThan(mild2.quality);
    expect(mild2.quality).toBeGreaterThan(mild3.quality);
  });

  it('rejects (does not silently succeed) when the image cannot be read', async () => {
    // Grounds filterCandidates' per-candidate catch: if scoreQuality never
    // threw, that catch block would be dead code and an unreadable frame
    // would instead propagate as an unhandled rejection or fabricate a
    // result out of garbage/empty data.
    await expect(scoreQuality(missingPath)).rejects.toThrow();
  });
});

describe('filterCandidates', () => {
  // quality: -1 is an out-of-range sentinel (scoreQuality's real range is
  // [0,1]) -- it can only show up in the output if filterCandidates fails to
  // overwrite it with the freshly computed score.
  const cand = (imagePath: string, overrides: Partial<Candidate> = {}): Candidate => ({
    timestamp: 0,
    sceneId: 0,
    imagePath,
    sceneSignificance: 0,
    quality: -1,
    ...overrides,
  });

  it('drops rejected candidates and keeps the accepted one, verified by identity not just count', async () => {
    const cands: Candidate[] = [
      cand(blackPath, { timestamp: 1 }),
      cand(detailPath, { timestamp: 2 }),
      cand(whitePath, { timestamp: 3 }),
      cand(blurredPath, { timestamp: 4 }),
    ];
    const out = await filterCandidates(cands);
    // A bug that drops the WRONG candidates (e.g. an off-by-one in the loop,
    // or filtering on index parity instead of q.reject) could coincidentally
    // produce the right length; checking which candidate survived, by a
    // field the rejected ones don't share, rules that out.
    expect(out).toHaveLength(1);
    expect(out[0]!.imagePath).toBe(detailPath);
    expect(out[0]!.timestamp).toBe(2);
  });

  it('returns an empty array, not a throw, when every candidate is rejected', async () => {
    const out = await filterCandidates([cand(blackPath), cand(whitePath), cand(blurredPath)]);
    expect(out).toEqual([]);
  });

  it('overwrites a survivor quality with the real measured score, not the input placeholder', async () => {
    const out = await filterCandidates([cand(detailPath)]);
    expect(out).toHaveLength(1);
    const expected = await scoreQuality(detailPath);
    expect(out[0]!.quality).not.toBe(-1);
    expect(out[0]!.quality).toBeCloseTo(expected.quality, 10);
  });

  it('preserves every other Candidate field unchanged on a survivor', async () => {
    const input = cand(detailPath, { timestamp: 12.5, sceneId: 3, sceneSignificance: 0.42 });
    const out = await filterCandidates([input]);
    expect(out).toHaveLength(1);
    expect(out[0]!.timestamp).toBe(12.5);
    expect(out[0]!.sceneId).toBe(3);
    expect(out[0]!.sceneSignificance).toBeCloseTo(0.42, 10);
    expect(out[0]!.imagePath).toBe(detailPath);
  });

  it('drops a candidate whose image cannot be read, without rejecting the whole batch', async () => {
    const cands: Candidate[] = [cand(missingPath, { timestamp: 1 }), cand(detailPath, { timestamp: 2 })];
    const out = await filterCandidates(cands);
    expect(out).toHaveLength(1);
    expect(out[0]!.imagePath).toBe(detailPath);
  });

  it('drops an unreadable candidate AND a quality-rejected candidate in the same batch, keeping only the genuinely good one unchanged', async () => {
    // Complements the test above: mixes a scoring ERROR (missingPath) with a
    // legitimate quality REJECTION (blackPath, readable but too_dark) and a
    // genuine accept (detailPath), in one batch. Proves the fix below (which
    // counts errors to detect a systemic failure) does not conflate "readable
    // but quality-rejected" with "failed to score" -- if it did, this 3-item
    // batch (1 error + 1 reject + 1 accept, i.e. 1 of 3 failed, not 3 of 3)
    // could wrongly trip a "some/all failed" throw, or the reject-counting
    // could wrongly feed the failure counter and throw here too.
    const cands: Candidate[] = [
      cand(missingPath, { timestamp: 1 }),
      cand(blackPath, { timestamp: 2 }),
      cand(detailPath, { timestamp: 3 }),
    ];
    const out = await filterCandidates(cands);
    expect(out).toHaveLength(1);
    expect(out[0]!.imagePath).toBe(detailPath);
    expect(out[0]!.timestamp).toBe(3);
  });

  it('throws, naming the failure count and the first underlying error, when every candidate in a non-empty batch fails to score', async () => {
    // The dangerous case: if sharp were systemically broken (bad native
    // binding) or an upstream bug corrupted every frame in a batch, ALL
    // scoreQuality calls would throw. The per-frame tolerance proven by the
    // two tests above must not extend to this case -- a totally-failed batch
    // silently returning [] is indistinguishable downstream from "this video
    // legitimately had no good frames". This is the test that matters most
    // for this fix. Confirmed (see task-7-report.md's fix-round section) to
    // FAIL against the pre-fix implementation, which returns [] here instead
    // of throwing.
    const cands: Candidate[] = [
      cand(missingPath, { timestamp: 1 }),
      cand(join(dir, 'also-missing.jpg'), { timestamp: 2 }),
      cand(join(dir, 'still-missing.jpg'), { timestamp: 3 }),
    ];
    let caught: unknown;
    try {
      await filterCandidates(cands);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toMatch(/3/); // names the failure count (3 of 3)
    expect(message).toMatch(/Input file is missing/); // carries the first underlying error's own message
  });

  it('returns [] without throwing for an empty input array -- an empty batch is not a systemic failure', async () => {
    // Guards the boundary the fix above must not cross: cands.length===0
    // trivially satisfies "every candidate failed" (0 of 0) under a naive
    // failures===cands.length check with no additional guard, which would
    // make an empty batch throw. An empty batch is a no-op, not a failure.
    await expect(filterCandidates([])).resolves.toEqual([]);
  });
});
