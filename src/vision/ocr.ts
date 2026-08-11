import sharp from 'sharp';
import { run } from '../util/run.js';
import type { Candidate } from '../types.js';

/** Burned-in captions live in the top/bottom bands; real content lives in the middle. */
export function classifyTextRegion(
  box: { top: number; height: number }, frameHeight: number,
): 'caption_band' | 'content' {
  const center = box.top + box.height / 2;
  const r = center / frameHeight;
  return r > 0.78 || r < 0.12 ? 'caption_band' : 'content';
}

export function normalizeText(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Token-level Jaccard distance: robust to OCR jitter, sensitive to real edits. */
export function textDelta(a: string, b: string): number {
  const A = new Set(normalizeText(a).split(' ').filter(Boolean));
  const B = new Set(normalizeText(b).split(' ').filter(Boolean));
  if (A.size === 0 && B.size === 0) return 0;
  if (A.size === 0 || B.size === 0) return 1;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const union = A.size + B.size - inter;
  return 1 - inter / union;
}

// spec §13: burned-in captions (TikTok/Reels/Shorts-style) churn every couple
// of seconds as the speaker talks and are already captured by the transcript,
// so a subtitle-only change must not by itself make a visually-redundant
// frame look "important". Content-region text (slide/code/chart/UI) changing
// is the strong signal; a subtitle changing alone should nudge novelty up
// only slightly, never dominate it.
const SUBTITLE_DISCOUNT = 0.1;   // spec §13: overlays must not rescue redundant frames

export function computeTextNovelty(cands: Candidate[]): Candidate[] {
  return cands.map((c, i) => {
    if (i === 0) return { ...c, textNovelty: 0 };
    const prev = cands[i - 1]!;
    const contentDelta = textDelta(prev.ocrContent ?? '', c.ocrContent ?? '');
    const subtitleDelta = textDelta(prev.ocrSubtitle ?? '', c.ocrSubtitle ?? '');
    const novelty = Math.min(1, contentDelta + SUBTITLE_DISCOUNT * subtitleDelta);
    return { ...c, textNovelty: novelty };
  });
}

/** Splits the frame into caption bands vs content and OCRs them separately. */
export async function ocrFrame(imagePath: string, langs = 'eng') {
  const meta = await sharp(imagePath).metadata();
  const w = meta.width ?? 0, h = meta.height ?? 0;
  if (!w || !h) return { content: '', subtitle: '' };

  const contentTop = Math.floor(h * 0.12);
  const contentH = Math.max(1, Math.floor(h * 0.66));

  // tesseract reads a file more reliably than stdin across builds; write temp crops.
  const contentBuf = await sharp(imagePath).extract({ left: 0, top: contentTop, width: w, height: contentH }).png().toBuffer();
  const bottomTop = Math.floor(h * 0.78);
  const bottomBuf = await sharp(imagePath)
    .extract({ left: 0, top: bottomTop, width: w, height: Math.max(1, h - bottomTop) }).png().toBuffer();

  const [content, subtitle] = await Promise.all([
    ocrBuffer(contentBuf, langs), ocrBuffer(bottomBuf, langs),
  ]);
  return { content, subtitle };
}

async function ocrBuffer(buf: Buffer, langs: string): Promise<string> {
  const { writeFile, unlink } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const p = join(tmpdir(), `norma-ocr-${process.pid}-${Math.random().toString(36).slice(2)}.png`);
  await writeFile(p, buf);
  try {
    const { stdout } = await run('tesseract', [p, 'stdout', '-l', langs], { timeoutMs: 30_000 });
    return stdout.replace(/\s+/g, ' ').trim();
  } catch { return ''; }
  finally { await unlink(p).catch(() => {}); }
}
