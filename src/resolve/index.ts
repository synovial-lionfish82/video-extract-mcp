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
  const r = pickResolver(url);
  if (!r) return { status: 'unsupported', reason: 'extractor_unsupported', message: `No resolver for ${url}` };
  return r.resolve(url, opts);
}
