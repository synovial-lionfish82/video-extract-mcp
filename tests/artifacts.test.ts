import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { descriptionPreview, mediaFileName, writeMetadata, PREVIEW_CHARS } from '../src/agent/artifacts.js';

describe('descriptionPreview', () => {
  it('returns null for a null description', () => {
    expect(descriptionPreview(null)).toBeNull();
  });
  it('returns a short description unchanged and unmarked', () => {
    expect(descriptionPreview('short')).toBe('short');
  });
  it('truncates a long description to the preview budget', () => {
    const p = descriptionPreview('y'.repeat(400))!;
    expect(p.length).toBeLessThanOrEqual(PREVIEW_CHARS + 1);
  });
  it('marks a truncated preview so the agent knows more exists', () => {
    expect(descriptionPreview('y'.repeat(400))!.endsWith('…')).toBe(true);
  });
  it('collapses newlines so the preview stays one line', () => {
    expect(descriptionPreview('a\n\nb')).toBe('a b');
  });
});

describe('mediaFileName (spec §7: range is part of identity)', () => {
  it('names a full fetch distinctly from a clip', () => {
    expect(mediaFileName()).not.toBe(mediaFileName(12, 20));
  });
  it('gives the same name for the same range, so a repeat overwrites', () => {
    expect(mediaFileName(12, 20)).toBe(mediaFileName(12, 20));
  });
  it('gives different names for different ranges, so both can coexist', () => {
    expect(mediaFileName(12, 20)).not.toBe(mediaFileName(12, 30));
  });
  it('produces no path separators', () => {
    expect(mediaFileName(1.5, 2.5)).not.toContain('/');
  });
});

describe('writeMetadata', () => {
  it('replaces an existing metadata file rather than duplicating it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'norma-art-'));
    const p1 = writeMetadata(dir, { a: 1 });
    const p2 = writeMetadata(dir, { a: 2 });
    expect(p2).toBe(p1);
    expect(JSON.parse(readFileSync(p1, 'utf8')).a).toBe(2);
  });
  it('creates the directory when it does not exist', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'norma-art-')), 'nested', 'deep');
    const p = writeMetadata(dir, { a: 1 });
    expect(existsSync(p)).toBe(true);
  });
});
