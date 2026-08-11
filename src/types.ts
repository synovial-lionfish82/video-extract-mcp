export type ResolveStatus =
  | 'ok' | 'auth_required' | 'auth_expired' | 'needs_interaction'
  | 'unsupported' | 'not_found' | 'extractor_failed';

export type UnsupportedReason = 'drm_protected' | 'unsupported_link' | 'extractor_unsupported';

/** One acquired caption file plus the language it is actually in. */
export interface CaptionTrack {
  /** Local path to the downloaded caption file (VTT, or SRT -- parseVtt reads both cue syntaxes). */
  path: string;
  /** Normalized base language of the track (e.g. 'en' for an 'en-US' tag), when known. */
  language: string | null;
}

export interface ResolvedMedia {
  status: 'ok';
  filePath: string;
  platform: string;
  title: string;
  duration: number;
  resolvedBy: 'ytdlp' | 'direct' | 'wechat';
  captions: { manual: CaptionTrack | null; auto: CaptionTrack | null };
  languageHint: string | null;
  /** True when the resolver already trimmed to the requested range. */
  rangeApplied: boolean;
}

export interface ResolveFailure {
  status: Exclude<ResolveStatus, 'ok'>;
  reason?: UnsupportedReason | string;
  message: string;
  resolvedBy?: string;
}

export type ResolveResult = ResolvedMedia | ResolveFailure;

export interface ResolveOptions {
  start?: number; end?: number; workDir: string;
  /** Caller's language preference -- steers which caption track a resolver picks. */
  preferredLanguage?: string;
}

export interface VideoResolver {
  readonly name: string;
  canResolve(url: string): boolean;
  resolve(url: string, opts: ResolveOptions): Promise<ResolveResult>;
}

export interface TranscriptSegment { start: number; end: number; text: string; }
export type TranscriptSource = 'manual' | 'auto' | 'asr';
export interface Transcript {
  language: string; source: TranscriptSource; segments: TranscriptSegment[];
}

export interface Candidate {
  timestamp: number;
  sceneId: number;
  imagePath: string;
  /** Set by scene detector: how strong the boundary was, 0..1. 0 for heartbeat frames. */
  sceneSignificance: number;
  quality: number;               // 0..1, from src/vision/quality.ts
  embedding?: number[];          // 768-dim, normalized
  ocrContent?: string;           // persistent-region text only
  ocrSubtitle?: string;          // caption-band text (discounted)
  textNovelty?: number;          // 0..1, computed subtitle-aware
}

export interface SelectedFrame {
  timestamp: number;
  sceneId: number;
  image: string;
  importance: number;
  reasons: string[];
  ocrContent: string | null;
  transcriptWindow: string | null;
  nearestSelectedSimilarity: number;
}

export interface Manifest {
  source: {
    url: string; platform: string; title: string; duration: number;
    resolvedBy: string; status: ResolveStatus; reason?: string;
    /**
     * Local filesystem path to the normalized working video analyzeVideo
     * produced (NOT the original download) -- present only on the 'ok'
     * path. This is what closes the coarse-to-fine loop: get_frame/get_clip
     * operate on a local file, and until this field existed, analyzeVideo's
     * own manifest had no such path for them to operate on (only individual
     * per-keyframe image paths). See task-16-report.md Finding 2.
     */
    filePath?: string;
  };
  transcript: Transcript | null;
  frames: SelectedFrame[];
  processing: {
    selectedFrames: number; candidateFrames: number;
    peakRssMb: number; selectorVersion: string; mode: AnalyzeMode;
  };
}

export type AnalyzeMode = 'fast' | 'accurate';

export interface AnalyzeOptions {
  start?: number; end?: number; maxFrames?: number; transcript?: boolean;
  preferredLanguage?: string; mode?: AnalyzeMode; outDir?: string;
}
