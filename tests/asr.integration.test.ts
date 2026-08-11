import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';

// Also requires the wav fixture: without this check, a machine with models
// fetched and the project built but the fixture never generated (Step 7's
// `say`/`ffmpeg` command) would hit sherpa.readWave's file-not-found error
// instead of skipping cleanly.
const ready = existsSync('models/silero_vad.onnx')
  && existsSync('dist/transcript/asrWorker.js')
  && existsSync('tests/fixtures/speech.wav');

describe.skipIf(!ready)('ASR worker (integration)', () => {
  it('transcribes a short wav and exits cleanly', async () => {
    const { transcribeAudio } = await import('../dist/transcript/asr.js');
    const t = await transcribeAudio('tests/fixtures/speech.wav', { engine: 'whisper' });
    expect(t.source).toBe('asr');
    expect(Array.isArray(t.segments)).toBe(true);
  }, 300_000);
});
