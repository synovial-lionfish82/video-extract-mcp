import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pexec = promisify(execFile);

export interface BinaryStatus {
  name: string;
  present: boolean;
  version: string | null;
  ok: boolean;
  note?: string;
}

export function parseVersion(raw: string): string {
  const m = raw.match(/\d+(?:\.\d+)+/);
  return m ? m[0] : raw.trim();
}

export async function checkBinary(
  name: string,
  versionArg = '--version'
): Promise<BinaryStatus> {
  try {
    const { stdout } = await pexec(name, [versionArg]);
    return { name, present: true, version: parseVersion(stdout), ok: true };
  } catch (err: unknown) {
    // Some binaries (like ffmpeg) output version to stderr, not stdout.
    // Check if we have stderr content from the error.
    if (
      err &&
      typeof err === 'object' &&
      'stderr' in err &&
      typeof err.stderr === 'string' &&
      err.stderr.length > 0
    ) {
      return { name, present: true, version: parseVersion(err.stderr), ok: true };
    }
    return { name, present: false, version: null, ok: false, note: 'not found on PATH' };
  }
}

const REQUIRED = ['ffmpeg', 'ffprobe', 'yt-dlp', 'tesseract'];

export async function main(): Promise<void> {
  const results = await Promise.all(REQUIRED.map((b) => checkBinary(b)));
  for (const r of results) console.log(`${r.ok ? 'OK  ' : 'MISS'} ${r.name} ${r.version ?? ''}`);

  // yt-dlp staleness: releases are date-versioned; anything older than ~3 months
  // routinely fails on current YouTube.
  const ytdlp = results.find((r) => r.name === 'yt-dlp');
  if (ytdlp?.version && ytdlp.version < '2026.06.00') {
    console.warn(`\nyt-dlp ${ytdlp.version} is stale -> run: brew upgrade yt-dlp`);
  }

  const { stdout: langs } = await pexec('tesseract', ['--list-langs']).catch(() => ({
    stdout: '',
  }));
  if (!langs.includes('chi_sim')) {
    console.warn('tesseract lacks chi_sim (needed for WeChat OCR) -> run: brew install tesseract-lang');
  }

  if (results.some((r) => !r.ok)) process.exitCode = 1;
}

if (import.meta.url === `file://${encodeURI(process.argv[1])}`) void main();
