import type { Manifest, SelectedFrame, Transcript, AnalyzeMode, ResolveStatus } from './types.js';
import { SELECTOR_VERSION } from './vision/select.js';

export function buildManifest(p: {
  url: string; platform: string; title: string; duration: number; resolvedBy: string;
  status: ResolveStatus; reason?: string; filePath?: string;
  transcript: Transcript | null; frames: SelectedFrame[];
  candidateCount: number; peakRssMb: number; mode: AnalyzeMode;
}): Manifest {
  return {
    source: {
      url: p.url, platform: p.platform, title: p.title, duration: p.duration,
      resolvedBy: p.resolvedBy, status: p.status, ...(p.reason ? { reason: p.reason } : {}),
      ...(p.filePath ? { filePath: p.filePath } : {}),
    },
    transcript: p.transcript,
    frames: p.frames,
    processing: {
      selectedFrames: p.frames.length,
      candidateFrames: p.candidateCount,
      peakRssMb: p.peakRssMb,
      selectorVersion: SELECTOR_VERSION,
      mode: p.mode,
    },
  };
}
