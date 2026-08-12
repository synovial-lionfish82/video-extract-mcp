import { mkdirSync, mkdtempSync, renameSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Chapter } from '../types.js';
import { resolve } from '../resolve/index.js';
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

export async function resolveVideoTool(args: ResolveToolArgs): Promise<ResolveToolResult> {
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

  const metadataPath = writeMetadata(args.destinationPath, {
    url: args.url, platform: r.platform, resolvedBy: r.resolvedBy,
    clipStart: r.clipStart, clipEnd: r.clipEnd,
    captions: r.captions, languageHint: r.languageHint,
    ...(r.metadata ?? {}),
  });

  let videoPath: string | undefined;
  if (returnVideo && existsSync(r.filePath)) {
    // Range is part of artifact identity (spec §7): a clip and a full fetch
    // coexist; re-fetching the SAME range overwrites in place.
    videoPath = join(args.destinationPath, mediaFileName(r.clipStart, r.clipEnd));
    try { renameSync(r.filePath, videoPath); }
    catch { copyFileSync(r.filePath, videoPath); }
  }

  const clipped = r.clipStart !== undefined && r.clipEnd !== undefined;
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
    ...(clipped ? { clipStart: r.clipStart, clipEnd: r.clipEnd } : {}),
    ...(returnVideo ? {} : {
      nextSteps:
        'Media was not downloaded. To fetch it, call resolve_video again with '
        + 'returnVideo: true (optionally with start/end to fetch only a section). '
        + 'To go straight to analysis, call analyze_video with this same URL.',
    }),
    ...(clipped && videoPath ? {
      note:
        `The saved file is a clip and STARTS AT 0 -- it covers ${r.clipStart}s to `
        + `${r.clipEnd}s of the original. Timestamps passed to analyze_video against `
        + `this file are relative to the clip, so add ${r.clipStart} to convert back to `
        + 'original-video time. Passing the original URL instead keeps original timestamps.',
    } : {}),
  };
}
