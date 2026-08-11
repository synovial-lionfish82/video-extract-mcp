import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../util/run.js';

export async function embedImages(paths: string[]): Promise<number[][]> {
  // Nothing to embed: return before touching the filesystem or spawning the
  // worker (tests/embed.test.ts asserts spawn() is never called for this case).
  if (paths.length === 0) return [];
  const here = dirname(fileURLToPath(import.meta.url));
  const worker = join(here, 'embedWorker.js');
  const dir = mkdtempSync(join(tmpdir(), 'norma-embed-'));
  const listFile = join(dir, 'paths.json');
  writeFileSync(listFile, JSON.stringify(paths));

  // Separate process so the SigLIP model's memory is fully released on exit,
  // the same staged-worker strategy as src/transcript/asr.ts (spec §4): this
  // file must never import @huggingface/transformers directly.
  const r = await run(process.execPath, [worker, listFile], { timeoutMs: 20 * 60_000 });
  if (r.code !== 0) throw new Error(`embed worker failed: ${r.stderr.slice(-400)}`);
  return JSON.parse(r.stdout) as number[][];
}
