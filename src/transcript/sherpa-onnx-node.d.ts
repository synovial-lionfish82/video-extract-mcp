/**
 * sherpa-onnx-node@1.13.4 ships no TypeScript types (plain CommonJS + JSDoc).
 * This ambient module declares only the subset asrWorker.ts actually calls,
 * verified against the installed package's own JSDoc typedefs
 * (node_modules/sherpa-onnx-node/types.js, non-streaming-asr.js, vad.js,
 * addon.js) rather than guessed. Kept intentionally minimal -- no speculative
 * members for APIs this codebase does not use.
 */
declare module 'sherpa-onnx-node' {
  export interface WaveObject {
    samples: Float32Array;
    sampleRate: number;
  }

  export interface OfflineRecognizerResult {
    lang: string;
    emotion: string;
    event: string;
    text: string;
    timestamps: number[];
    durations: number[];
    tokens: string[];
  }

  export interface OfflineSenseVoiceModelConfig {
    model?: string;
    language?: string;
    useInverseTextNormalization?: number;
  }

  export interface OfflineWhisperModelConfig {
    encoder?: string;
    decoder?: string;
    language?: string;
    task?: string;
    tailPaddings?: number;
  }

  export interface OfflineModelConfig {
    senseVoice?: OfflineSenseVoiceModelConfig;
    whisper?: OfflineWhisperModelConfig;
    tokens?: string;
    numThreads?: number;
    debug?: boolean | number;
    provider?: string;
  }

  export interface OfflineRecognizerConfig {
    modelConfig: OfflineModelConfig;
  }

  export class OfflineStream {
    acceptWaveform(obj: { samples: Float32Array; sampleRate: number }): void;
  }

  export class OfflineRecognizer {
    constructor(config: OfflineRecognizerConfig);
    createStream(hotwords?: string): OfflineStream;
    decode(stream: OfflineStream): void;
    getResult(stream: OfflineStream): OfflineRecognizerResult;
  }

  export interface SileroVadModelConfig {
    model?: string;
    threshold?: number;
    minSilenceDuration?: number;
    minSpeechDuration?: number;
    windowSize?: number;
    maxSpeechDuration?: number;
  }

  export interface VadConfig {
    sileroVad?: SileroVadModelConfig;
    sampleRate?: number;
    numThreads?: number;
    provider?: string;
    debug?: boolean | number;
  }

  export interface SpeechSegment {
    start: number;
    samples: Float32Array;
  }

  export class Vad {
    constructor(config: VadConfig, bufferSizeInSeconds: number);
    acceptWaveform(samples: Float32Array): void;
    isEmpty(): boolean;
    isDetected(): boolean;
    pop(): void;
    front(enableExternalBuffer?: boolean): SpeechSegment;
    reset(): void;
    flush(): void;
  }

  export function readWave(filename: string, enableExternalBuffer?: boolean): WaveObject;
  export function writeWave(filename: string, obj: WaveObject): boolean;

  interface SherpaOnnxNode {
    OfflineRecognizer: typeof OfflineRecognizer;
    Vad: typeof Vad;
    readWave: typeof readWave;
    writeWave: typeof writeWave;
  }

  const sherpa: SherpaOnnxNode;
  export default sherpa;
}
