import { existsSync } from 'node:fs';
import type { VideoResolver, ResolveOptions, ResolveResult } from '../types.js';
import { DirectMediaResolver } from './direct.js';
import { YtDlpResolver } from './ytdlp.js';
import { WeChatHeadlessResolver } from './wechat.js';

export { classifyYtDlpError } from './ytdlp.js';

/** Dispatch order matters: direct -> wechat -> yt-dlp catch-all (spec §6). */
export const DEFAULT_RESOLVERS: VideoResolver[] = [
  new DirectMediaResolver(),
  new WeChatHeadlessResolver(),
  new YtDlpResolver(),
];

export function pickResolver(url: string, resolvers = DEFAULT_RESOLVERS): VideoResolver | null {
  return resolvers.find((r) => r.canResolve(url)) ?? null;
}

export async function resolve(url: string, opts: ResolveOptions): Promise<ResolveResult> {
  // Bare filesystem path (no http(s) scheme, and it actually exists on disk):
  // handled here, before dispatch, rather than left to DirectMediaResolver.
  // DirectMediaResolver.canResolve() matches on a media file EXTENSION alone
  // (src/resolve/direct.ts's MEDIA_EXT regex), so it would also claim a bare
  // local path -- but its resolve() unconditionally calls fetch(url), and
  // Node's fetch only supports http(s) URLs, not raw filesystem paths, so
  // that path would throw/reject instead of just reading the file. This
  // lets local-file end-to-end testing (Task 14) work with no network at all.
  if (!/^https?:\/\//i.test(url) && existsSync(url)) {
    const { probe } = await import('../media/ffmpeg.js');
    const p = await probe(url);
    return {
      status: 'ok', filePath: url, platform: 'local', title: url.split('/').pop() ?? 'video',
      duration: p.duration, resolvedBy: 'direct', captions: { manual: null, auto: null },
      languageHint: null, rangeApplied: false,
    };
  }
  const r = pickResolver(url);
  if (!r) return { status: 'unsupported', reason: 'extractor_unsupported', message: `No resolver for ${url}` };
  return r.resolve(url, opts);
}
