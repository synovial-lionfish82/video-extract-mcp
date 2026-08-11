import { describe, it, expect, beforeAll } from 'vitest';
import sharp from 'sharp';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyTextRegion, normalizeText, textDelta, computeTextNovelty, ocrFrame,
} from '../src/vision/ocr.js';
import type { Candidate } from '../src/types.js';

const cand = (over: Partial<Candidate>): Candidate => ({
  timestamp: 0, sceneId: 0, imagePath: 'x.jpg', sceneSignificance: 0, quality: 1, ...over,
});

// ---------------------------------------------------------------------------
// Pure-logic tests: classifyTextRegion, normalizeText, textDelta, and
// computeTextNovelty all take primitives/plain objects and do no I/O, so per
// the task brief these are exercised directly with real strings -- no
// mocking of tesseract or sharp is needed or used anywhere in this section.
// ---------------------------------------------------------------------------

describe('classifyTextRegion', () => {
  it('treats the lower third as a caption band', () => {
    // Kills "classifyTextRegion always returns 'content'": this must be caption_band.
    expect(classifyTextRegion({ top: 640, height: 40 }, 720)).toBe('caption_band');
  });
  it('treats the upper edge as a caption band', () => {
    // Second, independent way to kill "always returns 'content'" -- an upper-band case too.
    expect(classifyTextRegion({ top: 10, height: 30 }, 720)).toBe('caption_band');
  });
  it('treats the middle as content', () => {
    // Kills "classifyTextRegion always returns 'caption_band'": this must be content.
    expect(classifyTextRegion({ top: 300, height: 40 }, 720)).toBe('content');
  });
});

describe('normalizeText', () => {
  it('lowercases', () => {
    expect(normalizeText('Revenue')).toBe('revenue');
  });
  it('collapses internal whitespace runs to a single space', () => {
    expect(normalizeText('a    b\t\tc')).toBe('a b c');
  });
  it('trims leading and trailing whitespace', () => {
    expect(normalizeText('  padded  ')).toBe('padded');
  });
});

describe('textDelta', () => {
  it('is 0 for identical text', () => expect(textDelta('total = 0', 'total = 0')).toBe(0));
  it('is 1 when text appears from nothing', () => expect(textDelta('', 'Revenue: $12M')).toBe(1));
  it('is high for a changed value', () => {
    expect(textDelta('Revenue: $12M', 'Revenue: $27M')).toBeGreaterThan(0.2);
  });
  it('ignores whitespace and case noise', () => {
    // Together with the two tests above (which require deltas of 1 and >0.2),
    // no constant return value can also satisfy this 0 -- kills "textDelta
    // returns a constant".
    expect(textDelta('Total = 0', 'total   =  0')).toBe(0);
  });
});

describe('computeTextNovelty (spec §13)', () => {
  it('gives HIGH novelty when persistent content text changes', () => {
    const out = computeTextNovelty([
      cand({ timestamp: 0, ocrContent: 'total = 0', ocrSubtitle: '' }),
      cand({ timestamp: 5, ocrContent: 'total = calculate_total(items)', ocrSubtitle: '' }),
    ]);
    expect(out[1]!.textNovelty!).toBeGreaterThan(0.3);
  });

  it('gives LOW novelty when only the subtitle overlay changes', () => {
    const out = computeTextNovelty([
      cand({ timestamp: 0, ocrContent: 'same slide', ocrSubtitle: 'and then I said' }),
      cand({ timestamp: 5, ocrContent: 'same slide', ocrSubtitle: 'something completely different' }),
    ]);
    expect(out[1]!.textNovelty!).toBeLessThan(0.15);
  });

  it('still gives a subtitle-only change a small POSITIVE novelty -- not zero', () => {
    // Pins the exact discounted value. contentDelta is 0 (identical content
    // text) and subtitleDelta is exactly 1 (zero token overlap between "and
    // then i said" and "something completely different"), so a correct
    // SUBTITLE_DISCOUNT=0.1 implementation must land on exactly 0 + 0.1*1 =
    // 0.1. This single assertion kills BOTH required mutations at once:
    // - SUBTITLE_DISCOUNT=1.0 would give 0 + 1.0*1 = 1.0 (fails toBeCloseTo(0.1))
    // - SUBTITLE_DISCOUNT=0   would give 0 + 0*1   = 0.0 (fails toBeGreaterThan(0)
    //   AND fails toBeCloseTo(0.1))
    const out = computeTextNovelty([
      cand({ timestamp: 0, ocrContent: 'same slide', ocrSubtitle: 'and then I said' }),
      cand({ timestamp: 5, ocrContent: 'same slide', ocrSubtitle: 'something completely different' }),
    ]);
    expect(out[1]!.textNovelty!).toBeGreaterThan(0);
    expect(out[1]!.textNovelty!).toBeCloseTo(0.1, 10);
  });

  it('ranks a content change above a subtitle change (the decisive spec §13 behavior)', () => {
    // This is the test that encodes the whole point of the task: a
    // visually-identical pair of frames where ONLY the caption-band text
    // changed must rank BELOW a pair where the content-region text changed.
    // An implementation that returns a mid-range constant for every input
    // (e.g. always 0.5) ties these two cases and fails the ordering
    // assertion below, even though such a constant might slip past
    // threshold-only tests elsewhere.
    const [, subtitleOnly] = computeTextNovelty([
      cand({ timestamp: 0, ocrContent: 'slide', ocrSubtitle: 'a' }),
      cand({ timestamp: 5, ocrContent: 'slide', ocrSubtitle: 'totally new words here' }),
    ]);
    const [, contentChange] = computeTextNovelty([
      cand({ timestamp: 0, ocrContent: 'slide one', ocrSubtitle: 'a' }),
      cand({ timestamp: 5, ocrContent: 'slide two entirely', ocrSubtitle: 'a' }),
    ]);
    expect(contentChange!.textNovelty!).toBeGreaterThan(subtitleOnly!.textNovelty!);
  });

  it('gives the first candidate zero novelty (nothing to compare against)', () => {
    const out = computeTextNovelty([cand({ ocrContent: 'hello', ocrSubtitle: '' })]);
    expect(out[0]!.textNovelty).toBe(0);
  });

  it('compares each candidate against the PRECEDING candidate, not a fixed reference', () => {
    // With only 2 candidates (as in every test above), "prev" and "the first
    // candidate" are the same object, so those tests cannot distinguish a
    // correct cands[i-1] lookup from a bug that always compares against
    // cands[0]. A 3rd candidate whose content diverges from candidate 0 but
    // matches candidate 1 breaks that tie.
    const out = computeTextNovelty([
      cand({ timestamp: 0, ocrContent: 'aaa', ocrSubtitle: '' }),
      cand({ timestamp: 5, ocrContent: 'bbb', ocrSubtitle: '' }),
      cand({ timestamp: 10, ocrContent: 'bbb', ocrSubtitle: '' }),
    ]);
    // Sanity check shared by both correct and buggy implementations (i=1's
    // predecessor is index 0 either way): totally disjoint tokens -> max delta.
    expect(out[1]!.textNovelty).toBe(1);
    // Decisive: candidate 2 has IDENTICAL text to candidate 1 (its true
    // predecessor) but totally different text from candidate 0 (the first
    // candidate). Comparing against cands[i-1] gives 0; comparing against a
    // fixed "first candidate" reference gives 1.
    expect(out[2]!.textNovelty).toBe(0);
  });

  it('preserves unrelated Candidate fields on the output, not just the ones it reads', () => {
    const c0 = cand({
      timestamp: 1, sceneId: 4, imagePath: 'foo.jpg', sceneSignificance: 0.5,
      quality: 0.77, embedding: [1, 2, 3], ocrContent: 'a', ocrSubtitle: '',
    });
    const c1 = cand({
      timestamp: 2, sceneId: 9, imagePath: 'bar.jpg', sceneSignificance: 0.9,
      quality: 0.42, embedding: [4, 5, 6], ocrContent: 'b', ocrSubtitle: '',
    });
    const out = computeTextNovelty([c0, c1]);
    expect(out[0]!.imagePath).toBe('foo.jpg');
    expect(out[0]!.embedding).toEqual([1, 2, 3]);
    expect(out[0]!.quality).toBe(0.77);
    expect(out[1]!.imagePath).toBe('bar.jpg');
    expect(out[1]!.sceneId).toBe(9);
    expect(out[1]!.embedding).toEqual([4, 5, 6]);
  });
});

// ---------------------------------------------------------------------------
// ocrFrame: the real I/O boundary (sharp crop + tesseract subprocess). Per
// the task's evidence-integrity bar, this is exercised against REAL
// generated images containing REAL text -- no mocking of sharp or tesseract.
// Images are synthesized with sharp's SVG rasterizer so the exact pixels are
// under test control, then handed to the real ocrFrame implementation.
// ---------------------------------------------------------------------------

describe('ocrFrame', () => {
  let dir: string;
  let mixedPath: string;   // content-region text + caption-band text, same frame
  let blankPath: string;   // no text anywhere
  let chinesePath: string; // non-Latin script, content region only
  let oddPaths: string[];  // atypical dimensions, to prove the crop math never exceeds bounds

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'norma-ocr-'));

    // 1280x720: content text sits mid-frame (well inside the [0.12h, 0.78h]
    // content band); caption text sits on a black bar in the bottom 100px
    // (well inside the bottom 22% caption band), mimicking a burned-in
    // subtitle. Manually verified with the real tesseract binary before
    // writing this test: content crop OCRs to "Revenue 12M dollars" and the
    // bottom crop OCRs to "and then | said something" (capital "I" reads as
    // a pipe -- real OCR jitter), which is why assertions below key on
    // lowercased substrings that are robust to that jitter, not exact equality.
    mixedPath = join(dir, 'mixed.png');
    const mixedSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720">
      <rect width="1280" height="720" fill="white"/>
      <text x="80" y="360" font-family="Arial, sans-serif" font-size="60" fill="black">Revenue 12M dollars</text>
      <rect x="0" y="620" width="1280" height="100" fill="black"/>
      <text x="80" y="685" font-family="Arial, sans-serif" font-size="40" fill="white">and then I said something</text>
    </svg>`;
    await sharp(Buffer.from(mixedSvg)).png().toFile(mixedPath);

    // Pure white, no text anywhere -- OCR on a blank frame should yield "".
    blankPath = join(dir, 'blank.png');
    await sharp({ create: { width: 640, height: 360, channels: 3, background: '#ffffff' } })
      .png().toFile(blankPath);

    // Chinese content text (simplified). Manually verified: chi_sim reads
    // this correctly as "你好世界收入"; the default 'eng' langs reads the
    // SAME image as garbage ("(oF tt RUA") -- grounding why the langs
    // parameter must actually reach tesseract, not be hardcoded to 'eng'.
    chinesePath = join(dir, 'chinese.png');
    const chineseSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="300">
      <rect width="800" height="300" fill="white"/>
      <text x="40" y="150" font-family="PingFang SC, Heiti SC, Arial Unicode MS, sans-serif" font-size="60" fill="black">你好世界收入</text>
    </svg>`;
    await sharp(Buffer.from(chineseSvg)).png().toFile(chinesePath);

    // Atypical dimensions (odd, tiny) exercising the floor()-based crop math
    // (spec brief: sharp's .extract throws if a region exceeds the image
    // bounds). Blank content is fine here -- the point is that ocrFrame must
    // resolve at all, not what text it finds.
    const oddDims: Array<[number, number]> = [[11, 9], [101, 203], [721, 1281], [3, 7]];
    oddPaths = [];
    for (const [w, h] of oddDims) {
      const p = join(dir, `odd-${w}x${h}.png`);
      await sharp({ create: { width: w, height: h, channels: 3, background: '#ffffff' } })
        .png().toFile(p);
      oddPaths.push(p);
    }
  }, 30_000);

  it('separates persistent content-region text from caption-band text', async () => {
    const { content, subtitle } = await ocrFrame(mixedPath);
    const c = content.toLowerCase();
    const s = subtitle.toLowerCase();
    // The content crop must contain the content-region text...
    expect(c).toContain('revenue');
    expect(c).toContain('12m');
    // ...and must NOT contain the caption text (proves the crop is spatially
    // bounded to the content band, not the whole frame).
    expect(c).not.toContain('something');
    // The caption crop must contain the caption text...
    expect(s).toContain('something');
    // ...and must NOT contain the content text (proves the two regions
    // aren't swapped or merged).
    expect(s).not.toContain('revenue');
  });

  it('returns empty strings for a frame with no text at all', async () => {
    const { content, subtitle } = await ocrFrame(blankPath);
    expect(content).toBe('');
    expect(subtitle).toBe('');
  });

  it('reads non-Latin script when the caller passes the matching tesseract language', async () => {
    const { content } = await ocrFrame(chinesePath, 'chi_sim');
    expect(content).toContain('你好');
  });

  it('does not throw when crop regions fall on atypical (odd/tiny) pixel boundaries', async () => {
    for (const p of oddPaths) {
      const result = await ocrFrame(p);
      expect(typeof result.content).toBe('string');
      expect(typeof result.subtitle).toBe('string');
    }
  });
});
