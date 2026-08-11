import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { run } from '../util/run.js';
import type { Transcript } from '../types.js';
import type { AsrEngine } from './routing.js';

export async function transcribeAudio(
  wav: string, opts: { engine?: AsrEngine; modelsDir?: string; preferredLanguage?: string } = {},
): Promise<Transcript> {
  const here = dirname(fileURLToPath(import.meta.url));
  const worker = join(here, 'asrWorker.js');
  const engine = opts.engine ?? 'whisper';
  const modelsDir = opts.modelsDir ?? 'models';

  // preferredLanguage is an optional 4th positional CLI arg -- appended only
  // when supplied, never as a literal "undefined" string, since run() joins
  // args as-is into the child's argv.
  const args = [worker, wav, engine, modelsDir];
  if (opts.preferredLanguage) args.push(opts.preferredLanguage);

  // Separate process so model memory is fully released on exit (spec §4).
  const r = await run(process.execPath, args, { timeoutMs: 30 * 60_000 });
  if (r.code !== 0) throw new Error(`ASR worker failed: ${r.stderr.slice(-400)}`);
  return JSON.parse(r.stdout) as Transcript;
}
