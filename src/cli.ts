import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AnalyzeOptions } from './types.js';
import { analyzeVideo } from './analyze.js';

export function parseArgs(argv: string[]): { url: string; opts: AnalyzeOptions } {
  const url = argv[0] ?? '';
  const opts: AnalyzeOptions = { mode: 'accurate' };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => argv[++i] ?? '';
    if (a === '--start') opts.start = Number(next());
    else if (a === '--end') opts.end = Number(next());
    else if (a === '--max-frames') opts.maxFrames = Number(next());
    else if (a === '--lang') opts.preferredLanguage = next();
    else if (a === '--out') opts.outDir = next();
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

// A plain `file://${process.argv[1]}` comparison breaks under TypeScript
// strict mode with noUncheckedIndexedAccess (process.argv[1] is
// `string | undefined`) and mishandles paths containing special characters.
// pathToFileURL with an explicit undefined guard is the correct precedent
// already established by scripts/preflight.ts -- followed verbatim here so
// this entry guard doesn't fire (and doesn't call analyzeVideo against a
// live URL) while the test suite merely imports parseArgs.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) void main();
