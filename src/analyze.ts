import { mkdtempSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AnalyzeOptions, Manifest, Transcript, Candidate } from './types.js';
import { resolve } from './resolve/index.js';
import { probe, normalize, trim } from './media/ffmpeg.js';
import { FFmpegSceneDetector } from './media/scenes.js';
import { planCandidates, extractCandidates } from './media/candidates.js';
import { filterCandidates } from './vision/quality.js';
import { ocrFrame, computeTextNovelty } from './vision/ocr.js';
import { embedImages } from './vision/embed.js';
import { selectFrames } from './vision/select.js';
import { attachTranscript } from './align.js';
import { parseVtt, chooseCaptionTier } from './transcript/captions.js';
import { chooseAsrEngine } from './transcript/routing.js';
import { transcribeAudio } from './transcript/asr.js';
import { buildManifest } from './manifest.js';
import { PeakRssTracker } from './util/rss.js';

// This module must NEVER import sherpa-onnx-node or @huggingface/transformers
// directly (spec §4/§19) -- only the driver modules above (transcribeAudio,
// embedImages), which spawn short-lived child processes that load those
// libraries, transcribe/embed, and exit. That process boundary is the entire
// memory strategy: it is what lets the ASR model's RSS be fully released
// before the vision model is ever loaded. Importing either library here
// directly would pull its native addon / ONNX runtime into the long-lived
// orchestrator process, permanently resident for the tool's whole lifetime.

export async function analyzeVideo(url: string, opts: AnalyzeOptions = {}): Promise<Manifest> {
  const mode = opts.mode ?? 'accurate';
  const maxFrames = opts.maxFrames ?? 35;
  const rss = new PeakRssTracker();
  rss.start();

  const workDir = opts.outDir ?? mkdtempSync(join(tmpdir(), 'norma-'));
  mkdirSync(workDir, { recursive: true });
  const framesDir = join(workDir, 'frames');
  mkdirSync(framesDir, { recursive: true });

  // 1. Resolve
  const res = await resolve(url, { start: opts.start, end: opts.end, workDir });
  if (res.status !== 'ok') {
    return buildManifest({
      url, platform: 'unknown', title: '', duration: 0, resolvedBy: res.resolvedBy ?? 'none',
      status: res.status, reason: typeof res.reason === 'string' ? res.reason : res.message,
      transcript: null, frames: [], candidateCount: 0, peakRssMb: rss.stop(), mode,
    });
  }

  // 2. Apply the range if the resolver could not (spec §18: optimization, not guarantee)
  let media = res.filePath;
  if (opts.start !== undefined && opts.end !== undefined && !res.rangeApplied) {
    media = await trim(media, opts.start, opts.end, join(workDir, 'clip.mp4'));
  }

  // 3. Normalize
  const { video, audio } = await normalize(media, workDir);
  const meta = await probe(video);

  // ASR routing depends only on preferredLanguage/languageHint, so the same
  // engine choice governs both the transcript stage and OCR's language pack
  // below -- computed once so the two decisions can't silently diverge.
  const engine = chooseAsrEngine({ preferredLanguage: opts.preferredLanguage, languageHint: res.languageHint });

  // 4. Transcript -- STAGE 1 (ASR worker runs and exits before any vision work)
  let transcript: Transcript | null = null;
  if (opts.transcript !== false) {
    const tier = chooseCaptionTier(res.captions, mode);
    if (tier !== 'asr') {
      const file = tier === 'manual' ? res.captions.manual! : res.captions.auto!;
      if (existsSync(file)) {
        transcript = { language: res.languageHint ?? 'unknown', source: tier, segments: parseVtt(readFileSync(file, 'utf8')) };
      }
    }
    if (!transcript && existsSync(audio)) {
      // preferredLanguage is passed through (not dropped): pickSenseVoiceLanguage
      // falls back to it when SenseVoice's own raw per-segment language signal
      // isn't usable (routing.ts; the common case on the current sherpa-onnx-node
      // build per task-11-report.md), so wiring it through is what lets a
      // caller-declared language reach transcript.language honestly instead of
      // silently downgrading to 'auto'.
      transcript = await transcribeAudio(audio, { engine, preferredLanguage: opts.preferredLanguage }).catch(() => null);
    }
  }

  // 5. Candidates -> quality filter -> OCR -> text novelty. No resident model
  // in this block (scene detection/candidates/quality/OCR are all subprocess
  // or cheap-native), but two of its steps can genuinely throw:
  //  - FFmpegSceneDetector.detect() on a hard ffmpeg failure (corrupt/empty
  //    normalized video), and
  //  - filterCandidates() when EVERY candidate in a non-empty batch fails to
  //    SCORE (src/vision/quality.ts) -- added deliberately (Task 7) so a
  //    systemic failure (broken sharp install, a corrupted extraction batch)
  //    cannot silently look identical to "this video legitimately has no
  //    interesting frames". Both failure modes mean the same thing from here:
  //    "no usable candidates" -- so both are caught by one boundary around
  //    the whole candidate-generation stage, surfaced as an honest non-'ok'
  //    manifest rather than swallowed into an empty-but-'ok' frame list
  //    (which would silently restore exactly the failure mode Task 7 added
  //    the throw to prevent) or left to reject analyzeVideo's promise.
  let candidateCount = 0;
  let cands: Candidate[] = [];
  try {
    const boundaries = await new FFmpegSceneDetector().detect(video);
    const plan = planCandidates(meta.duration, boundaries);
    cands = await extractCandidates(video, plan, framesDir);
    candidateCount = cands.length;
    cands = await filterCandidates(cands);

    const langs = engine === 'sensevoice' ? 'chi_sim+eng' : 'eng';
    for (const c of cands) {
      const { content, subtitle } = await ocrFrame(c.imagePath, langs).catch(() => ({ content: '', subtitle: '' }));
      c.ocrContent = content; c.ocrSubtitle = subtitle;
    }
    // One pass over the FULL surviving batch, not chunked: computeTextNovelty's
    // persistence check looks one candidate ahead to decide whether a text
    // change holds (genuine) or churns (subtitle/OCR noise), so only the
    // batch's true final candidate should ever fall back to full weight.
    // Splitting this call would manufacture an artificial "last candidate"
    // at every chunk boundary, multiplying the one-frame edge case that
    // computeTextNovelty's own doc comment already accepts at the real end.
    cands = computeTextNovelty(cands);
  } catch (e) {
    return buildManifest({
      url, platform: res.platform, title: res.title, duration: meta.duration,
      resolvedBy: res.resolvedBy, status: 'extractor_failed',
      reason: `candidate pipeline failed: ${e instanceof Error ? e.message : String(e)}`,
      transcript, frames: [], candidateCount, peakRssMb: rss.stop(), mode,
    });
  }

  // 6. Embeddings -- STAGE 2 (vision worker; ASR already exited)
  const vectors = await embedImages(cands.map((c) => c.imagePath)).catch(() => [] as number[][]);

  // Guarded assignment: embedImages returns `[]` (never a dropped array
  // entry) in a candidate's slot when that one image failed to embed, to
  // preserve index alignment with `cands` (src/vision/embed.ts). Only ever
  // assign a REAL vector; a candidate whose embed failed keeps `embedding`
  // unset. This alone is necessary but NOT sufficient: an empty array and
  // `undefined` are provably indistinguishable to src/vision/select.ts's
  // selectFrames today (cosine([], x) truncates to length 0 and returns
  // exactly 0, the same value maxSim already defaults to when `c.embedding`
  // is falsy -- verified directly against the compiled selector, see
  // task-14-report.md), so leaving the array unassigned changes nothing about
  // that candidate's own selection score by itself.
  let anyEmbedded = false;
  cands.forEach((c, i) => {
    const v = vectors[i];
    if (v && v.length) { c.embedding = v; anyEmbedded = true; }
  });
  if (anyEmbedded) {
    // The actual fix: drop a candidate whose embedding failed, but ONLY when
    // at least one other candidate in this batch embedded successfully.
    // Rationale: selectFrames treats "no embedding" as maxSim=0, i.e.
    // unpenalized for similarity to whatever is already picked -- the most
    // favorable score the diversity term can produce. A real embedded
    // candidate almost never scores that well (two genuinely different
    // images still cosine-similarity high in practice -- Task 12 measured
    // 0.82 between two flat, unrelated colours), so an embedding-less
    // candidate would systematically outrank ones we can actually vouch for.
    // Dropping it is safe here specifically because these images already
    // passed filterCandidates' own sharp-decode gate upstream, so a
    // SigLIP-only failure on one of them is a genuine anomaly, not the
    // common case. When NONE embedded (worker crashed, model unavailable,
    // no network) every candidate is treated identically -- keep them all,
    // since a uniform maxSim=0 is an unbiased degrade, not a bias toward any
    // particular frame, and dropping the whole pool would silently turn a
    // healthy video into an empty result.
    cands = cands.filter((c) => c.embedding !== undefined);
  }

  // 7. Select + align
  let frames = selectFrames(cands, maxFrames, meta.duration);
  if (transcript) frames = attachTranscript(frames, transcript.segments);

  return buildManifest({
    url, platform: res.platform, title: res.title, duration: meta.duration,
    resolvedBy: res.resolvedBy, status: 'ok', filePath: video,
    transcript, frames, candidateCount, peakRssMb: rss.stop(), mode,
  });
}
