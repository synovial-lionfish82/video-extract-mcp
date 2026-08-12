import { mkdirSync, mkdtempSync, renameSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Chapter } from '../types.js';
import { resolve } from '../resolve/index.js';
import { trim } from '../media/ffmpeg.js';
import { descriptionPreview, mediaFileName, writeMetadata } from './artifacts.js';

export interface ResolveToolResult {
  status: string;
  reason?: string;
  platform?: string;
  title?: string;
  creator?: string | null;
  duration?: number;
  chapters?: Chapter[];
  descriptionPreview?: string | null;
  commentCount?: number | null;
  metadataPath: string;
  videoPath?: string;
  clipStart?: number;
  clipEnd?: number;
  nextSteps?: string;
  note?: string;
}

export interface ResolveToolArgs {
  url: string;
  destinationPath: string;
  returnVideo?: boolean;
  start?: number;
  end?: number;
  comments?: boolean;
}

async function resolveVideoToolAttempt(args: ResolveToolArgs): Promise<ResolveToolResult> {
  const returnVideo = args.returnVideo ?? false;
  mkdirSync(args.destinationPath, { recursive: true });

  const workDir = mkdtempSync(join(tmpdir(), 'norma-res-'));
  const r = await resolve(args.url, {
    workDir,
    returnVideo,
    comments: args.comments ?? false,
    start: returnVideo ? args.start : undefined,
    end: returnVideo ? args.end : undefined,
  });

  if (r.status !== 'ok') {
    // Failure still writes what little we know, so the shape is stable.
    // `url` is included because ResolveFailure itself carries none, and
    // without it a failure record on disk cannot be correlated back to
    // what was being resolved.
    const metadataPath = writeMetadata(args.destinationPath, { url: args.url, ...r });
    // Prefer the categorical reason (e.g. 'drm_protected') when the resolver
    // supplied one, falling back to the human-readable message otherwise --
    // the same fold analyze.ts:86 already uses for the same ResolveFailure
    // shape (`typeof res.reason === 'string' ? res.reason : res.message`).
    // The brief's reference always used r.message, silently discarding a
    // populated r.reason.
    const reason = typeof r.reason === 'string' ? r.reason : r.message;
    return { status: r.status, reason, metadataPath };
  }

  // Range extraction is genuine for yt-dlp sources but is a documented
  // full-download-then-trim for direct URLs and WeChat (design §5) -- those
  // resolvers never read opts.start/opts.end at all (src/resolve/direct.ts,
  // src/resolve/wechat.ts) and always leave rangeApplied false. Without this
  // step, a range request against one of those sources would silently
  // return the FULL video under a full-fetch filename, with no clip fields
  // and no offset note -- an honest-looking but incomplete reply. Mirrors
  // analyze.ts:100-122: trim locally when the resolver could not, and treat
  // the result as a genuine clip. Deliberately NOT wrapped in a local
  // try/catch, matching analyze.ts's own shape -- a trim failure (corrupt
  // source, ffmpeg unavailable) propagates to resolveVideoTool's outer
  // boundary below and becomes an honest failure result, rather than
  // silently falling back to returning the wrong (untrimmed) video under a
  // clip-shaped name.
  let sourcePath = r.filePath;
  let appliedStart = r.clipStart;
  let appliedEnd = r.clipEnd;
  if (returnVideo && args.start !== undefined && args.end !== undefined && !r.rangeApplied) {
    sourcePath = await trim(r.filePath, args.start, args.end, join(workDir, 'clip.mp4'));
    appliedStart = args.start;
    appliedEnd = args.end;
  }

  // Spec §5.1: the saved metadata must record the applied range, whether the
  // resolver applied it or the local trim above just did.
  const metadataPath = writeMetadata(args.destinationPath, {
    url: args.url, platform: r.platform, resolvedBy: r.resolvedBy,
    clipStart: appliedStart, clipEnd: appliedEnd,
    captions: r.captions, languageHint: r.languageHint,
    ...(r.metadata ?? {}),
  });

  let videoPath: string | undefined;
  if (returnVideo && existsSync(sourcePath)) {
    // Range is part of artifact identity (spec §7): a clip and a full fetch
    // coexist; re-fetching the SAME range overwrites in place.
    videoPath = join(args.destinationPath, mediaFileName(appliedStart, appliedEnd));
    try { renameSync(sourcePath, videoPath); }
    catch { copyFileSync(sourcePath, videoPath); }
  }

  const clipped = appliedStart !== undefined && appliedEnd !== undefined;
  return {
    status: 'ok',
    platform: r.platform,
    title: r.metadata?.title ?? r.title,
    creator: r.metadata?.creator ?? null,
    duration: r.metadata?.duration ?? r.duration,
    chapters: r.metadata?.chapters ?? [],
    descriptionPreview: descriptionPreview(r.metadata?.description ?? null),
    commentCount: r.metadata?.commentCount ?? null,
    metadataPath,
    ...(videoPath ? { videoPath } : {}),
    ...(clipped ? { clipStart: appliedStart, clipEnd: appliedEnd } : {}),
    ...(returnVideo ? {} : {
      nextSteps:
        'Media was not downloaded. To fetch it, call resolve_video again with '
        + 'returnVideo: true (optionally with start/end to fetch only a section). '
        + 'To go straight to analysis, call analyze_video with this same URL.',
    }),
    ...(clipped && videoPath ? {
      note:
        `The saved file is a clip and STARTS AT 0 -- it covers ${appliedStart}s to `
        + `${appliedEnd}s of the original. Timestamps passed to analyze_video against `
        + `this file are relative to the clip, so add ${appliedStart} to convert back to `
        + 'original-video time. Passing the original URL instead keeps original timestamps.',
    } : {}),
  };
}

/**
 * Documented contract (matching analyze.ts's analyzeVideo/analyzeResolved
 * split): resolve_video RETURNS a structured result rather than throwing.
 * resolveVideoToolAttempt can throw for reasons that have nothing to do
 * with the URL or the resolver -- mkdirSync EEXIST when destinationPath
 * already exists as a file (an ordinary caller mistake, not adversarial
 * input), mediaFileName rejecting a contract-violating range, or both
 * renameSync and its copyFileSync fallback failing. Anything not already
 * absorbed into a structured ResolveFailure becomes an honest
 * 'extractor_failed' result here instead of an uncaught rejection.
 */
export async function resolveVideoTool(args: ResolveToolArgs): Promise<ResolveToolResult> {
  try {
    return await resolveVideoToolAttempt(args);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    let metadataPath = join(args.destinationPath, 'metadata.json');
    try {
      metadataPath = writeMetadata(args.destinationPath, { url: args.url, status: 'extractor_failed', message });
    } catch {
      // destinationPath itself may be unusable (e.g. it exists as a file,
      // not a directory) -- metadataPath still names where it WOULD have
      // gone, so the result shape stays stable even though nothing could
      // actually be written there.
    }
    return { status: 'extractor_failed', reason: `resolve_video failed: ${message}`, metadataPath };
  }
}
