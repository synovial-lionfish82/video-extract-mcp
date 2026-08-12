import { mkdirSync, existsSync, renameSync, copyFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { FrameMode, Manifest, Transcript } from '../types.js';
import { analyzeVideo } from '../analyze.js';
import { buildManifest } from '../manifest.js';
import { writeManifest, writeTranscript } from './artifacts.js';

/** Above this, the transcript goes to disk only -- a long transcript is
 *  exactly the payload destinationPath exists to keep out of context. */
export const INLINE_TRANSCRIPT_MAX_CHARS = 8000;

export interface AnalyzeToolResult {
  status: string;
  reason?: string;
  title: string;
  duration: number;
  frameCount: number;
  framePaths: string[];
  transcript?: Transcript;
  transcriptPath?: string;
  manifestPath: string;
  videoPath?: string;
  warnings: string[];
}

export interface AnalyzeToolArgs {
  pathOrUrl: string;
  destinationPath: string;
  start?: number;
  end?: number;
  frames?: FrameMode;
  maxFrames?: number;
  transcript?: boolean;
  language?: string;
}

function transcriptChars(t: Transcript): number {
  return t.segments.reduce((n, s) => n + s.text.length, 0);
}

/**
 * Same "bare local path" test src/resolve/index.ts uses ahead of resolver
 * dispatch: no http(s) scheme, and it genuinely exists on disk. Mirrored
 * here (resolve/index.ts does not export it) so this module can tell
 * "already local" apart from "must be fetched" *before* calling
 * analyzeVideo -- the only point where that distinction can still change
 * what gets passed in.
 */
function isLocalPath(pathOrUrl: string): boolean {
  return !/^https?:\/\//i.test(pathOrUrl) && existsSync(pathOrUrl);
}

/**
 * Moves (falling back to copying, e.g. across devices) a working-directory
 * frame image into destinationPath, matching resolveTool.ts's own
 * rename-then-copy pattern for videoPath. A source that no longer exists is
 * left exactly as reported rather than throwing: this only ever runs
 * against paths analyzeVideo itself produced, but a defensive no-op keeps a
 * surprising pipeline state from taking down the whole call over a handful
 * of frame thumbnails.
 */
function relocateFrame(destinationPath: string, imagePath: string): string {
  if (!existsSync(imagePath)) return imagePath;
  const dest = join(destinationPath, basename(imagePath));
  if (dest === imagePath) return imagePath;
  try { renameSync(imagePath, dest); } catch { copyFileSync(imagePath, dest); }
  return dest;
}

async function analyzeVideoToolAttempt(args: AnalyzeToolArgs): Promise<AnalyzeToolResult> {
  mkdirSync(args.destinationPath, { recursive: true });

  // Spec §2.1: a source already on disk must not be duplicated into
  // destinationPath. analyzeVideo's normalize() step unconditionally writes
  // a re-encoded working copy (plus its frames/ subdirectory) into whatever
  // outDir it is given (src/analyze.ts -> src/media/ffmpeg.ts's
  // normalize()) -- there is no way to get frames out of it without also
  // getting that copy in the same directory. For a URL source that copy IS
  // the deliverable (the agent has no other local copy), so outDir stays
  // destinationPath as usual. For an already-local source it would be a
  // second, disk-doubling copy of a file the agent already placed, so
  // outDir is left unset -- analyzeVideo falls back to its own private
  // mkdtempSync'd directory (src/analyze.ts) -- and only the (cheap) frame
  // thumbnails are relocated into destinationPath below.
  const local = isLocalPath(args.pathOrUrl);

  const raw = await analyzeVideo(args.pathOrUrl, {
    start: args.start,
    end: args.end,
    frames: args.frames,
    maxFrames: args.maxFrames,
    transcript: args.transcript,
    // Spec §4: an explicit language is the override; it outranks metadata.
    preferredLanguage: args.language,
    destinationPath: args.destinationPath,
    ...(local ? {} : { outDir: args.destinationPath }),
  });

  // Spec §2.1: for a local source, relocate the frame thumbnails into
  // destinationPath (a handful of JPEGs, not the video) and point
  // source.filePath back at the file the agent already has, rather than at
  // analyzeVideo's private, ephemeral normalized copy -- which is kept OUT
  // of destinationPath specifically so it never persists as a second copy
  // of the source (see the outDir comment above).
  const m: Manifest = local
    ? {
        ...raw,
        source: raw.source.filePath ? { ...raw.source, filePath: args.pathOrUrl } : raw.source,
        frames: raw.frames.map((f) => ({ ...f, image: relocateFrame(args.destinationPath, f.image) })),
      }
    : raw;

  const manifestPath = writeManifest(args.destinationPath, m);

  // Spec §3: the transcript is ALWAYS written, and additionally returned
  // inline only when short enough to be worth the context.
  let transcriptPath: string | undefined;
  let inline: Transcript | undefined;
  if (m.transcript) {
    transcriptPath = writeTranscript(args.destinationPath, m.transcript);
    if (transcriptChars(m.transcript) <= INLINE_TRANSCRIPT_MAX_CHARS) inline = m.transcript;
  }

  return {
    status: m.source.status,
    ...(m.source.reason ? { reason: m.source.reason } : {}),
    title: m.source.title,
    duration: m.source.duration,
    frameCount: m.frames.length,
    framePaths: m.frames.map((f) => f.image),
    ...(inline ? { transcript: inline } : {}),
    ...(transcriptPath ? { transcriptPath } : {}),
    manifestPath,
    ...(m.source.filePath ? { videoPath: m.source.filePath } : {}),
    warnings: m.processing.warnings,
  };
}

/**
 * Documented contract (matching resolveVideoTool/analyzeVideo's own shape):
 * analyze_video RETURNS a structured result rather than throwing.
 * analyzeVideoToolAttempt can throw for reasons that have nothing to do
 * with the URL or the pipeline -- mkdirSync EEXIST when destinationPath
 * already exists as a file (an ordinary caller mistake, not adversarial
 * input), or any other unexpected error analyzeVideo itself did not already
 * absorb into a status-carrying Manifest. Anything not already absorbed
 * becomes an honest 'extractor_failed' result here instead of an uncaught
 * rejection.
 */
export async function analyzeVideoTool(args: AnalyzeToolArgs): Promise<AnalyzeToolResult> {
  try {
    return await analyzeVideoToolAttempt(args);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    let manifestPath = join(args.destinationPath, 'manifest.json');
    try {
      manifestPath = writeManifest(args.destinationPath, buildManifest({
        url: args.pathOrUrl, platform: 'unknown', title: '', duration: 0, resolvedBy: 'none',
        status: 'extractor_failed', reason: `analyze_video failed: ${message}`,
        transcript: null, frames: [], candidateCount: 0, peakRssMb: 0, frameMode: 'none', warnings: [],
      }));
    } catch {
      // destinationPath itself may be unusable (e.g. it exists as a file,
      // not a directory) -- manifestPath still names where it WOULD have
      // gone, so the result shape stays stable even though nothing could
      // actually be written there.
    }
    return {
      status: 'extractor_failed',
      reason: `analyze_video failed: ${message}`,
      title: '', duration: 0, frameCount: 0, framePaths: [],
      manifestPath, warnings: [],
    };
  }
}
