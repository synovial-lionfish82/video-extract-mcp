import { mkdtempSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from './util/run.js';
import { extractFrame, probe } from './media/ffmpeg.js';

/**
 * Extract a single frame at `timestamp`.
 *
 * ffmpeg cannot seek to (or past) end-of-file and still decode a frame there --
 * a timestamp at or very near the source's duration fails with an opaque
 * "Invalid argument" error from the encoder rather than a helpful message
 * (verified directly: a 9.0s fixture fails at ts=9.0 AND at ts=8.99, but
 * succeeds at ts=8.9). On that failure, retry once against a timestamp
 * stepped back from the probed duration by a margin scaled to the source's
 * own frame rate (floor 0.1s when fps is unavailable), so a caller asking
 * for "the end" of a video still gets a real frame instead of a crash.
 * A failure NOT shaped like an end-of-file seek -- the clamped candidate
 * would move the seek point LATER, not earlier, than what was requested --
 * rethrows the original error unchanged instead of masking a real problem.
 */
export async function getFrame(source: string, timestamp: number, outDir?: string): Promise<string> {
  const dir = outDir ?? mkdtempSync(join(tmpdir(), 'norma-frame-'));
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `frame_${timestamp.toFixed(2)}.jpg`);
  try {
    return await extractFrame(source, timestamp, out);
  } catch (e) {
    const meta = await probe(source).catch(() => null);
    if (!meta || meta.duration <= 0) throw e;
    const margin = meta.fps > 0 ? Math.max(2 / meta.fps, 0.1) : 0.1;
    const clamped = meta.duration - margin;
    if (clamped < 0 || clamped >= timestamp) throw e;
    return await extractFrame(source, clamped, out);
  }
}

/** Dense sampling of a narrow window — the coarse-to-fine second pass (spec §18). */
export async function getClip(
  source: string, start: number, end: number, fps = 2, outDir?: string,
): Promise<string[]> {
  const dir = outDir ?? mkdtempSync(join(tmpdir(), 'norma-clip-'));
  mkdirSync(dir, { recursive: true });
  const prefix = `clip_${start}_${end}_`;
  const r = await run('ffmpeg', [
    '-y', '-ss', String(start), '-to', String(end), '-i', source,
    '-vf', `fps=${fps}`, '-q:v', '3', join(dir, `${prefix}%04d.jpg`),
  ], { timeoutMs: 5 * 60_000 });
  if (r.code !== 0) throw new Error(`getClip failed: ${r.stderr.slice(-300)}`);
  return readdirSync(dir).filter((f) => f.startsWith(prefix)).sort().map((f) => join(dir, f));
}
