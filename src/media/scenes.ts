import { run } from '../util/run.js';

export interface SceneBoundary { time: number; score: number; }

export interface SceneDetector {
  readonly name: string;
  detect(video: string): Promise<SceneBoundary[]>;
}

const SCORE_RE = /lavfi\.scd\.score:\s*([\d.]+)/;
const TIME_RE = /lavfi\.scd\.time:\s*([\d.]+)/;

export function parseScdetOutput(stderr: string): SceneBoundary[] {
  const out: SceneBoundary[] = [];
  for (const line of stderr.split(/\r?\n/)) {
    const t = TIME_RE.exec(line);
    if (!t) continue;
    const s = SCORE_RE.exec(line);
    out.push({ time: Number(t[1]), score: s ? Number(s[1]) / 100 : 0.5 });
  }
  return out;
}

/**
 * Behind the SceneDetector interface so PySceneDetect/TransNetV2 can be
 * benchmarked against it later without touching callers (spec §10).
 *
 * `threshold` is ffmpeg's own scdet scale (0-100, filter default 10; see
 * `ffmpeg -h filter=scdet`) -- NOT a normalized 0-1 fraction. 8 keeps us
 * close to ffmpeg's own default while being slightly more sensitive.
 */
export class FFmpegSceneDetector implements SceneDetector {
  readonly name = 'ffmpeg-scdet';
  constructor(private readonly threshold = 8) {}

  async detect(video: string): Promise<SceneBoundary[]> {
    const r = await run('ffmpeg', [
      '-i', video, '-vf', `scdet=threshold=${this.threshold}`,
      '-f', 'null', '-',
    ], { timeoutMs: 10 * 60_000 });
    // run() resolves (never throws) on a non-zero exit; without this check a
    // hard ffmpeg failure (missing/corrupt input) parses to the same [] as a
    // video with genuinely no scene changes, silently masking the error.
    if (r.code !== 0) throw new Error(`scdet failed for ${video}: ${r.stderr.slice(-400)}`);
    return parseScdetOutput(r.stderr);
  }
}
