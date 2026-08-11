import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { VideoResolver, ResolveOptions, ResolveResult } from '../types.js';
import { probe } from '../media/ffmpeg.js';
import { run } from '../util/run.js';
import { fetchToFile, MEDIA_DOWNLOAD_TIMEOUT_MS } from '../util/download.js';

const MEDIA_EXT = /\.(mp4|m4v|mov|mkv|webm|m3u8|mpd|ts)(\?|#|$)/i;

export class DirectMediaResolver implements VideoResolver {
  readonly name = 'direct';
  canResolve(url: string): boolean { return MEDIA_EXT.test(url); }

  async resolve(url: string, opts: ResolveOptions): Promise<ResolveResult> {
    const out = join(opts.workDir, 'source.mp4');
    try {
      // HLS/DASH manifests must be muxed by ffmpeg, not byte-copied. Bounded
      // like every other subprocess: a stalled origin used to hang this mux
      // (and analyze_video with it) forever.
      if (/\.(m3u8|mpd)(\?|#|$)/i.test(url)) {
        const r = await run('ffmpeg', ['-y', '-i', url, '-c', 'copy', out], { timeoutMs: MEDIA_DOWNLOAD_TIMEOUT_MS });
        if (r.code !== 0) {
          // A failed mux can leave a partial file behind -- this return path
          // bypasses the catch below, so it must clean up itself.
          await unlink(out).catch(() => {});
          return { status: 'extractor_failed', message: `ffmpeg could not fetch stream: ${r.stderr.slice(-300)}` };
        }
      } else {
        const dl = await fetchToFile(url, out); // bounded: stalls abort into the catch below
        if (dl.status === 401 || dl.status === 403) {
          return { status: 'auth_required', message: `HTTP ${dl.status} fetching media` };
        }
        if (dl.status === 404) return { status: 'not_found', message: 'HTTP 404' };
        if (!dl.ok) return { status: 'extractor_failed', message: `HTTP ${dl.status}` };
      }
      const p = await probe(out);
      return {
        status: 'ok', filePath: out, platform: 'direct',
        title: url.split('/').pop() ?? 'video', duration: p.duration,
        resolvedBy: 'direct', captions: { manual: null, auto: null },
        languageHint: null, rangeApplied: false,
      };
    } catch (e) {
      await unlink(out).catch(() => {}); // best-effort: never leave a partial download behind
      return { status: 'extractor_failed', message: (e as Error).message };
    }
  }
}
