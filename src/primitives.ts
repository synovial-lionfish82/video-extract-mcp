import { mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from './util/run.js';
import { extractFrame, probe } from './media/ffmpeg.js';

// getFrame/getClip are internal helpers, not MCP tools. The v1 four-tool
// surface (analyze_video, resolve_video, get_frame, get_clip) collapsed to
// two (resolve_video, analyze_video) in the v2 rewrite; src/mcp.ts no
// longer imports this module, and nothing else in src/ calls into it
// either -- both functions are exercised only by tests/primitives.test.ts
// and tests/analyze.integration.test.ts. They stay: they implement the
// coarse-to-fine single-frame/dense-window primitives spec §18 describes,
// and a future surface change may need them again. Do not delete them as
// dead code, and do not re-expose them as MCP tools without revisiting
// that decision first.

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
 *
 * The retry is bounded: a request only a few frame-durations past the
 * probed duration is treated as a genuine near-EOF seek, but anything
 * further out is a caller error, not something to silently satisfy with a
 * plausible-looking wrong frame (caught on review: getFrame(source, 100000,
 * dir) against a 9s video used to succeed, returning a file literally named
 * "frame_100000.00.jpg" whose actual content was the ~8.9s frame). The
 * output file is always named from the timestamp actually extracted, not
 * the one requested, so a retried result can never mislabel itself.
 */
export async function getFrame(source: string, timestamp: number, outDir?: string): Promise<string> {
  const dir = outDir ?? mkdtempSync(join(tmpdir(), 'norma-frame-'));
  mkdirSync(dir, { recursive: true });
  const nameFor = (ts: number) => join(dir, `frame_${ts.toFixed(2)}.jpg`);
  try {
    return await extractFrame(source, timestamp, nameFor(timestamp));
  } catch (e) {
    const meta = await probe(source).catch(() => null);
    if (!meta || meta.duration <= 0) throw e;
    const frameDur = meta.fps > 0 ? 1 / meta.fps : 0.04;
    const retreat = Math.max(2 * frameDur, 0.1);
    const maxOverage = Math.max(5 * frameDur, 0.5);
    if (timestamp < meta.duration - retreat) throw e;
    if (timestamp > meta.duration + maxOverage) {
      throw new Error(
        `getFrame: requested timestamp ${timestamp}s is too far past the source's duration `
        + `(${meta.duration}s) to be treated as an end-of-file seek`,
      );
    }
    const clamped = meta.duration - retreat;
    return await extractFrame(source, clamped, nameFor(clamped));
  }
}

/**
 * Dense sampling of a narrow window — the coarse-to-fine second pass (spec §18).
 *
 * `outDir` is meant to be reused across calls -- an agent doing coarse-to-fine
 * inspection calling this repeatedly against one scratch directory is the
 * intended usage, not an edge case. The prefix therefore includes `fps` (not
 * just start/end), and any pre-existing files matching it are cleared before
 * ffmpeg runs, so a later call's readdir scan can never silently pick up an
 * earlier call's leftover frames (caught on review: getClip(v,2,5,4,shared)
 * followed by getClip(v,2,5,2,shared) used to return 12 frames instead of 6,
 * because the old prefix -- `clip_${start}_${end}_`, no fps component --
 * made both calls' output indistinguishable by filename).
 */
export async function getClip(
  source: string, start: number, end: number, fps = 2, outDir?: string,
): Promise<string[]> {
  const dir = outDir ?? mkdtempSync(join(tmpdir(), 'norma-clip-'));
  mkdirSync(dir, { recursive: true });
  const prefix = `clip_${start}_${end}_${fps}_`;
  for (const stale of readdirSync(dir).filter((f) => f.startsWith(prefix))) {
    rmSync(join(dir, stale), { force: true });
  }
  const r = await run('ffmpeg', [
    '-y', '-ss', String(start), '-to', String(end), '-i', source,
    '-vf', `fps=${fps}`, '-q:v', '3', join(dir, `${prefix}%04d.jpg`),
  ], { timeoutMs: 5 * 60_000 });
  if (r.code !== 0) throw new Error(`getClip failed: ${r.stderr.slice(-300)}`);
  return readdirSync(dir).filter((f) => f.startsWith(prefix)).sort().map((f) => join(dir, f));
}
