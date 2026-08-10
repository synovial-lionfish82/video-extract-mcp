import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { VideoResolver, ResolveOptions, ResolveResult, ResolveFailure } from '../types.js';
import { run } from '../util/run.js';
import { probe } from '../media/ffmpeg.js';

export function classifyYtDlpError(stderr: string): ResolveFailure {
  const s = stderr.toLowerCase();
  if (/drm|widevine|protected by drm/.test(s)) {
    return { status: 'unsupported', reason: 'drm_protected', message: 'DRM-protected media', resolvedBy: 'ytdlp' };
  }
  if (/sign in|log in|login required|private video|members-only|age.?restricted|cookies/.test(s)) {
    return { status: 'auth_required', message: 'Authentication required', resolvedBy: 'ytdlp' };
  }
  if (/video unavailable|not available|has been removed|does not exist|404/.test(s)) {
    return { status: 'not_found', message: 'Media not found', resolvedBy: 'ytdlp' };
  }
  if (/unsupported url|no video formats|no suitable extractor/.test(s)) {
    return { status: 'unsupported', reason: 'extractor_unsupported', message: 'No extractor for this URL', resolvedBy: 'ytdlp' };
  }
  return { status: 'extractor_failed', message: stderr.slice(-300).trim() || 'yt-dlp failed', resolvedBy: 'ytdlp' };
}

function findCaption(dir: string, auto: boolean): string | null {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith('.vtt'));
  // yt-dlp writes auto-captions as *.<lang>.vtt too; distinguish by our own subdirs.
  const hit = files.find((f) => (auto ? f.includes('.auto.') : !f.includes('.auto.')));
  return hit ? join(dir, hit) : null;
}

export class YtDlpResolver implements VideoResolver {
  readonly name = 'ytdlp';
  canResolve(url: string): boolean { return /^https?:\/\//i.test(url); }

  async resolve(url: string, opts: ResolveOptions): Promise<ResolveResult> {
    const out = join(opts.workDir, 'source.%(ext)s');
    const args = [
      '--no-playlist', '--no-warnings',
      '-f', 'bv*[height<=1080]+ba/b[height<=1080]/b',
      '--merge-output-format', 'mp4',
      '--write-subs', '--write-auto-subs', '--sub-format', 'vtt', '--sub-langs', 'all,-live_chat',
      '--print-json', '--no-simulate',
      '-o', out,
    ];

    // Range download is an OPTIMIZATION, never a guarantee (spec §18).
    const wantsRange = opts.start !== undefined && opts.end !== undefined;
    if (wantsRange) {
      args.push('--download-sections', `*${opts.start}-${opts.end}`, '--force-keyframes-at-cuts');
    }

    const r = await run('yt-dlp', [...args, url], { timeoutMs: 15 * 60_000 });
    if (r.code !== 0) return classifyYtDlpError(r.stderr);

    let meta: { title?: string; extractor?: string; language?: string; duration?: number } = {};
    const lastJson = r.stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop();
    if (lastJson) { try { meta = JSON.parse(lastJson); } catch { /* metadata is optional */ } }

    const produced = readdirSync(opts.workDir).find((f) => /^source\.(mp4|mkv|webm|m4v)$/.test(f));
    if (!produced) return { status: 'extractor_failed', message: 'yt-dlp produced no media file', resolvedBy: 'ytdlp' };
    const filePath = join(opts.workDir, produced);
    const p = await probe(filePath);

    // VERIFY the range actually applied; caller falls back to ffmpeg trim if not.
    let rangeApplied = false;
    if (wantsRange) {
      const expected = opts.end! - opts.start!;
      rangeApplied = Math.abs(p.duration - expected) <= Math.max(1.5, expected * 0.15);
    }

    return {
      status: 'ok', filePath, platform: meta.extractor ?? 'unknown',
      title: meta.title ?? 'video', duration: p.duration, resolvedBy: 'ytdlp',
      captions: { manual: findCaption(opts.workDir, false), auto: findCaption(opts.workDir, true) },
      languageHint: meta.language ?? null,
      rangeApplied,
    };
  }
}
