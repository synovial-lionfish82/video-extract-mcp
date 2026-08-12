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
 *
 * Finding 1 fix: All four shapes produce distinct filenames:
 *   - full (no bounds): source.mp4
 *   - start-only: source_s${start}.mp4
 *   - end-only: source_e${end}.mp4
 *   - both bounds: source_s${start}_e${end}.mp4
 * The s/e prefixes make the distinction unambiguous and collision-free even with negatives.
 *
 * Finding 2 fix: ext is validated to alphanumeric only; path traversal throws.
 *
 * Finding 3 fix: Non-finite numbers (NaN, Infinity, -Infinity) throw.
 * Note: rounding to 2 decimals means ranges like 0.001 and 0.002 both round to 0.00
 * and produce identical filenames; this is intentional, as sub-centisecond precision
 * is meaningless for video.
 *
 * Item 2 fix: Extreme-magnitude finite values that overflow the rounding throw.
 * Threshold is Number.MAX_VALUE / 100 (approximately 1.8e306). Values whose
 * magnitude is greater than or equal to this will overflow n * 100 to Infinity,
 * causing collisions. This is a programming error (timestamps near 1e306 seconds
 * indicate unit-conversion bugs), so throwing is appropriate.
 */
export function mediaFileName(start?: number, end?: number, ext = 'mp4'): string {
  // Finding 2: validate extension
  if (!/^[a-zA-Z0-9]+$/.test(ext)) {
    throw new Error(`Invalid extension: must be alphanumeric only, got "${ext}"`);
  }

  // Finding 3: validate non-finite numbers
  if (start !== undefined && !Number.isFinite(start)) {
    throw new Error(`Invalid start: must be finite, got ${start}`);
  }
  if (end !== undefined && !Number.isFinite(end)) {
    throw new Error(`Invalid end: must be finite, got ${end}`);
  }

  // Item 2: detect overflow in rounding (n * 100 > Number.MAX_VALUE)
  const ROUNDING_OVERFLOW_THRESHOLD = Number.MAX_VALUE / 100;
  if (start !== undefined && Math.abs(start) >= ROUNDING_OVERFLOW_THRESHOLD) {
    throw new Error(`Value too large for timestamp encoding: start ${start} exceeds overflow threshold`);
  }
  if (end !== undefined && Math.abs(end) >= ROUNDING_OVERFLOW_THRESHOLD) {
    throw new Error(`Value too large for timestamp encoding: end ${end} exceeds overflow threshold`);
  }

  // Finding 1: encode all four shapes distinctly
  if (start === undefined && end === undefined) {
    return `source.${ext}`;
  }
  if (start !== undefined && end === undefined) {
    return `source_s${tag(start)}.${ext}`;
  }
  if (start === undefined && end !== undefined) {
    return `source_e${tag(end)}.${ext}`;
  }
  // Both defined
  return `source_s${tag(start!)}_e${tag(end!)}.${ext}`;
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
