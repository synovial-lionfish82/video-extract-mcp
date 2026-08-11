import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AnalyzeOptions } from './types.js';
import { analyzeVideo } from './analyze.js';
import { isMainModule } from './util/entry.js';

export function parseArgs(argv: string[]): { url: string; opts: AnalyzeOptions } {
  const url = argv[0] ?? '';
  const opts: AnalyzeOptions = { mode: 'accurate' };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    // argv[++i] is undefined once no token remains -- distinct from a
    // deliberately-empty '' value, so a flag truncated at the end of argv
    // (a bare trailing `--start` with nothing after it) leaves the option
    // unset instead of silently coercing to 0 (Number('') === 0 is
    // indistinguishable from an explicit `--start 0`).
    const next = (): string | undefined => argv[++i];
    if (a === '--start') { const v = next(); if (v !== undefined) opts.start = Number(v); }
    else if (a === '--end') { const v = next(); if (v !== undefined) opts.end = Number(v); }
    else if (a === '--max-frames') { const v = next(); if (v !== undefined) opts.maxFrames = Number(v); }
    else if (a === '--lang') { const v = next(); if (v !== undefined) opts.preferredLanguage = v; }
    else if (a === '--out') { const v = next(); if (v !== undefined) opts.outDir = v; }
    else if (a === '--fast') opts.mode = 'fast';
    else if (a === '--no-transcript') opts.transcript = false;
  }
  return { url, opts };
}

async function main(): Promise<void> {
  const { url, opts } = parseArgs(process.argv.slice(2));
  if (!url) {
    console.error('usage: norma <url> [--start S --end E] [--max-frames N] [--lang zh] [--fast] [--no-transcript] [--out DIR]');
    process.exit(1);
  }
  const manifest = await analyzeVideo(url, opts);
  const json = JSON.stringify(manifest, null, 2);
  if (opts.outDir) writeFileSync(join(opts.outDir, 'manifest.json'), json);
  console.log(json);
}

// isMainModule realpaths BOTH sides (src/util/entry.ts): Node realpaths the
// main module while argv[1] stays as typed, so the previous pathToFileURL
// comparison -- itself a fix for percent-encoded spaces in this repo's own
// path -- still failed through any symlinked invocation path, exiting 0
// having silently done nothing. It still never fires when the test suite
// merely imports parseArgs.
if (isMainModule(import.meta.url)) void main();
