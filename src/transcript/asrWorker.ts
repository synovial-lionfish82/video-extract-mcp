import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sherpa from 'sherpa-onnx-node';
import type { Vad } from 'sherpa-onnx-node';
import type { Transcript, TranscriptSegment } from '../types.js';
import { pickSenseVoiceLanguage } from './routing.js';

const SENSEVOICE_DIR = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09';
const WHISPER_DIR = 'sherpa-onnx-whisper-small';

function buildRecognizer(engine: string, modelsDir: string) {
  if (engine === 'sensevoice') {
    return new sherpa.OfflineRecognizer({
      modelConfig: {
        senseVoice: { model: join(modelsDir, SENSEVOICE_DIR, 'model.int8.onnx'), useInverseTextNormalization: 1 },
        tokens: join(modelsDir, SENSEVOICE_DIR, 'tokens.txt'),
        numThreads: 2, provider: 'cpu', debug: 0,
      },
    });
  }
  return new sherpa.OfflineRecognizer({
    modelConfig: {
      whisper: {
        encoder: join(modelsDir, WHISPER_DIR, 'small-encoder.int8.onnx'),
        decoder: join(modelsDir, WHISPER_DIR, 'small-decoder.int8.onnx'),
      },
      tokens: join(modelsDir, WHISPER_DIR, 'small-tokens.txt'),
      numThreads: 2, provider: 'cpu', debug: 0,
    },
  });
}

export interface VadSegment { start: number; samples: Float32Array; }

/**
 * Feeds `samples` into `vad` in fixed-size windows, draining every detected
 * speech segment along the way, then flushes and drains whatever segment is
 * still buffered at end-of-stream. Exported so tests can exercise the exact
 * chunking behavior main() uses without a full ASR decode.
 *
 * Tail fix, two parts (see task-11-report.md addendum for the full empirical
 * derivation):
 *
 * 1. The loop bound is `i < samples.length` (not the previous
 *    `i + window < samples.length`), so the final window is always fed --
 *    Float32Array#subarray clamps an out-of-range `end` to the array's true
 *    length, so on the last iteration `samples.subarray(i, i + window)`
 *    returns exactly whatever real audio remains, never an out-of-bounds
 *    slice. This alone fully recovers the case where `samples.length` is an
 *    exact multiple of `window`: previously the entire last window (512
 *    samples / 32ms) was silently dropped, because vad.flush() only
 *    finalizes state already ingested via acceptWaveform -- it cannot
 *    retroactively accept samples that were never pushed to it.
 *
 * 2. When the final chunk is SHORTER than `window` (the more common case --
 *    samples.length not a multiple of window), it is zero-padded up to a
 *    full window before being fed. This is necessary in addition to (1):
 *    empirically, feeding a genuinely short last chunk on its own changes
 *    nothing versus not feeding it at all -- the native Silero addon only
 *    classifies/emits complete `window`-sized frames, and flush() does not
 *    force a partial buffered fragment through classification. Padding with
 *    zeros gives the classifier a complete frame to decide on; the real
 *    content in it (a majority of the frame, for anything but the very
 *    shortest remainders) still reads as speech, so the segment now legitimately
 *    extends into what would otherwise be a permanently-unclassifiable
 *    fragment. This is a design addition beyond the two options originally
 *    suggested (change the loop bound / submit the remainder after the
 *    loop) -- both of those alone still lose this case; see the report.
 *    The trailing zero-padding this can add to a segment's `.samples` is
 *    harmless to the recognizer (silence at the end of an utterance), but
 *    callers must not report it as real audio duration -- main() clamps
 *    each segment's reported `end` to the true wave length below.
 */
export function runVad(vad: Vad, samples: Float32Array, window: number): VadSegment[] {
  const out: VadSegment[] = [];
  for (let i = 0; i < samples.length; i += window) {
    let chunk = samples.subarray(i, i + window);
    if (chunk.length < window) {
      const padded = new Float32Array(window); // zero-filled remainder
      padded.set(chunk);
      chunk = padded;
    }
    vad.acceptWaveform(chunk);
    while (!vad.isEmpty()) {
      const seg = vad.front();
      vad.pop();
      out.push({ start: seg.start, samples: seg.samples });
    }
  }
  vad.flush();
  while (!vad.isEmpty()) {
    const seg = vad.front();
    vad.pop();
    out.push({ start: seg.start, samples: seg.samples });
  }
  return out;
}

async function main(): Promise<void> {
  const [wav, engine = 'whisper', modelsDir = 'models', preferredLanguage] = process.argv.slice(2);
  if (!wav) throw new Error('usage: asrWorker <wav> <engine> <modelsDir> [preferredLanguage]');

  const wave = sherpa.readWave(wav);
  const vad = new sherpa.Vad({
    sileroVad: {
      model: join(modelsDir, 'silero_vad.onnx'),
      threshold: 0.5, minSilenceDuration: 0.5, minSpeechDuration: 0.25, maxSpeechDuration: 20,
    },
    sampleRate: wave.sampleRate, numThreads: 1, debug: 0,
  }, 60);

  const recognizer = buildRecognizer(engine, modelsDir);
  const window = 512;

  // VAD first: only speech regions reach ASR (spec §9/report §10).
  const speechSegments = runVad(vad, wave.samples, window);

  const segments: TranscriptSegment[] = [];
  const rawLangs: Array<string | null | undefined> = [];
  for (const seg of speechSegments) {
    const stream = recognizer.createStream();
    stream.acceptWaveform({ samples: seg.samples, sampleRate: wave.sampleRate });
    recognizer.decode(stream);
    const result = recognizer.getResult(stream);
    const text = result.text.trim();
    if (text) {
      const start = seg.start / wave.sampleRate;
      // runVad's tail fix can zero-pad a segment's final window (see its doc
      // comment), so the raw end sample can slightly overrun the true wave
      // length. Clamp so a reported segment never claims audio duration
      // that doesn't exist in the source file.
      const endSample = Math.min(seg.start + seg.samples.length, wave.samples.length);
      segments.push({ start, end: endSample / wave.sampleRate, text });
      // Captured at zero extra cost (getResult already ran) for
      // pickSenseVoiceLanguage below. Unused on the whisper path.
      rawLangs.push(result.lang);
    }
  }

  // Whisper's config never pins a language, so 'auto' is the honest label
  // (unchanged). SenseVoice's per-segment .lang is used when it carries real
  // signal; see pickSenseVoiceLanguage's doc comment for why it usually
  // doesn't on this library version, and what it falls back to instead.
  const language = engine === 'sensevoice' ? pickSenseVoiceLanguage(rawLangs, preferredLanguage) : 'auto';

  const transcript: Transcript = {
    language,
    source: 'asr',
    segments,
  };
  process.stdout.write(JSON.stringify(transcript));
}

// ESM "is this the entry module" guard: only auto-run main() when this file
// is executed directly as `node asrWorker.js <wav> <engine> <modelsDir>`
// (the worker CLI contract asr.ts's transcribeAudio() spawns) -- not when it
// is imported as a module, e.g. by tests exercising runVad/pickSenseVoiceLanguage
// in isolation. Without this guard, importing the compiled file would
// immediately run main() against the importer's own process.argv and, on
// the resulting "usage" error, call process.exit(1) -- killing whatever
// process did the importing.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main().catch((e) => { process.stderr.write(String(e)); process.exit(1); });
}
