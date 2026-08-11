import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';

const ready = existsSync('models/silero_vad.onnx') && existsSync('dist/transcript/asrWorker.js');

describe.skipIf(!ready)('ASR worker (integration)', () => {
  it('transcribes a short wav and exits cleanly', async () => {
    const { transcribeAudio } = await import('../dist/transcript/asr.js');
    const t = await transcribeAudio('tests/fixtures/speech.wav', { engine: 'whisper' });
    expect(t.source).toBe('asr');
    expect(Array.isArray(t.segments)).toBe(true);
  }, 300_000);
});
