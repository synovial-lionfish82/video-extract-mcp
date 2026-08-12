import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Manifest, Transcript } from '../types.js';

/** Spec §2.1: the search-snippet-sized opening, not the whole description. */
export const PREVIEW_CHARS = 125;

export function descriptionPreview(description: string | null, max = PREVIEW_CHARS): string | null {
  if (description === null) return null;
  const flat = description.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max).trimEnd()}…`;
}

const tag = (n: number): string => String(Math.round(n * 100) / 100).replace('.', '_');

/**
 * Spec §7: a clip and a full fetch are different artifacts and must not
 * silently overwrite each other; re-fetching the SAME range must overwrite
 * in place so repeating a call is safe.
 */
export function mediaFileName(start?: number, end?: number, ext = 'mp4'): string {
  if (start === undefined || end === undefined) return `source.${ext}`;
  return `source_${tag(start)}-${tag(end)}.${ext}`;
}

function writeJson(dir: string, name: string, value: unknown): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(value, null, 2));
  return p;
}

/** Metadata describes the source video, not a clip: single file, always replaced. */
export function writeMetadata(dir: string, meta: unknown): string {
  return writeJson(dir, 'metadata.json', meta);
}

export function writeTranscript(dir: string, t: Transcript): string {
  return writeJson(dir, 'transcript.json', t);
}

export function writeManifest(dir: string, m: Manifest): string {
  return writeJson(dir, 'manifest.json', m);
}
