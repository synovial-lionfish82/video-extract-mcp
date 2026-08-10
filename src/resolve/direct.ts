import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import type { VideoResolver, ResolveOptions, ResolveResult } from '../types.js';
import { probe } from '../media/ffmpeg.js';
import { run } from '../util/run.js';

const MEDIA_EXT = /\.(mp4|m4v|mov|mkv|webm|m3u8|mpd|ts)(\?|#|$)/i;

export class DirectMediaResolver implements VideoResolver {
  readonly name = 'direct';
  canResolve(url: string): boolean { return MEDIA_EXT.test(url); }

  async resolve(url: string, opts: ResolveOptions): Promise<ResolveResult> {
    const out = join(opts.workDir, 'source.mp4');
    try {
      // HLS/DASH manifests must be muxed by ffmpeg, not byte-copied.
      if (/\.(m3u8|mpd)(\?|#|$)/i.test(url)) {
        const r = await run('ffmpeg', ['-y', '-i', url, '-c', 'copy', out]);
        if (r.code !== 0) {
          return { status: 'extractor_failed', message: `ffmpeg could not fetch stream: ${r.stderr.slice(-300)}` };
        }
      } else {
        const res = await fetch(url);
        if (res.status === 401 || res.status === 403) {
          return { status: 'auth_required', message: `HTTP ${res.status} fetching media` };
        }
        if (res.status === 404) return { status: 'not_found', message: 'HTTP 404' };
        if (!res.ok || !res.body) {
          return { status: 'extractor_failed', message: `HTTP ${res.status}` };
        }
        await pipeline(Readable.fromWeb(res.body as never), createWriteStream(out));
      }
      const p = await probe(out);
      return {
        status: 'ok', filePath: out, platform: 'direct',
        title: url.split('/').pop() ?? 'video', duration: p.duration,
        resolvedBy: 'direct', captions: { manual: null, auto: null },
        languageHint: null, rangeApplied: false,
      };
    } catch (e) {
      return { status: 'extractor_failed', message: (e as Error).message };
    }
  }
}
