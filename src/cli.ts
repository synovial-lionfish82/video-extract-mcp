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

// A plain `file://${process.argv[1]}` comparison is wrong at runtime, not
// at compile time: import.meta.url is always percent-encoded, while naive
// template-literal concatenation of process.argv[1] is not, so the two
// never compare equal in a checkout path containing a space or other
// special character -- including this repository's own. pathToFileURL is
// the fix, and it needs the `?? ''` fallback because (unlike a template
// literal) its own signature requires a `string`, not `string | undefined`.
// This is the correct precedent already established by scripts/preflight.ts
// -- followed verbatim here so this entry guard doesn't fire (and doesn't
// call analyzeVideo against a live URL) while the test suite merely
// imports parseArgs.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) void main();
