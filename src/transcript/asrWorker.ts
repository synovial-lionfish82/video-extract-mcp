import { join } from 'node:path';
import sherpa from 'sherpa-onnx-node';
import type { Transcript, TranscriptSegment } from '../types.js';

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

async function main(): Promise<void> {
  const [wav, engine = 'whisper', modelsDir = 'models'] = process.argv.slice(2);
  if (!wav) throw new Error('usage: asrWorker <wav> <engine> <modelsDir>');

  const wave = sherpa.readWave(wav);
  const vad = new sherpa.Vad({
    sileroVad: {
      model: join(modelsDir, 'silero_vad.onnx'),
      threshold: 0.5, minSilenceDuration: 0.5, minSpeechDuration: 0.25, maxSpeechDuration: 20,
    },
    sampleRate: wave.sampleRate, numThreads: 1, debug: 0,
  }, 60);

  const recognizer = buildRecognizer(engine, modelsDir);
  const segments: TranscriptSegment[] = [];
  const window = 512;

  // VAD first: only speech regions reach ASR (spec §9/report §10).
  for (let i = 0; i + window < wave.samples.length; i += window) {
    vad.acceptWaveform(wave.samples.subarray(i, i + window));
    while (!vad.isEmpty()) {
      const seg = vad.front();
      vad.pop();
      const stream = recognizer.createStream();
      stream.acceptWaveform({ samples: seg.samples, sampleRate: wave.sampleRate });
      recognizer.decode(stream);
      const text = recognizer.getResult(stream).text.trim();
      if (text) {
        const start = seg.start / wave.sampleRate;
        segments.push({ start, end: start + seg.samples.length / wave.sampleRate, text });
      }
    }
  }
  vad.flush();
  while (!vad.isEmpty()) {
    const seg = vad.front(); vad.pop();
    const stream = recognizer.createStream();
    stream.acceptWaveform({ samples: seg.samples, sampleRate: wave.sampleRate });
    recognizer.decode(stream);
    const text = recognizer.getResult(stream).text.trim();
    if (text) {
      const start = seg.start / wave.sampleRate;
      segments.push({ start, end: start + seg.samples.length / wave.sampleRate, text });
    }
  }

  const transcript: Transcript = {
    language: engine === 'sensevoice' ? 'zh' : 'auto',
    source: 'asr',
    segments,
  };
  process.stdout.write(JSON.stringify(transcript));
}

void main().catch((e) => { process.stderr.write(String(e)); process.exit(1); });
