import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, isAbsolute, resolve } from 'node:path';
import { resolveModelsDir } from '../src/util/models.js';

const originalCwd = process.cwd();
afterEach(() => { process.chdir(originalCwd); vi.unstubAllEnvs(); });

describe('resolveModelsDir', () => {
  it('honours VIDEO_EXTRACT_MODELS_DIR above everything else', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vem-explicit-'));
    // Deliberately ALSO create ./models, so a precedence inversion is
    // visible: without the ordering, this would return the local one.
    const cwd = mkdtempSync(join(tmpdir(), 'vem-cwd-'));
    mkdirSync(join(cwd, 'models'));
    process.chdir(cwd);
    vi.stubEnv('VIDEO_EXTRACT_MODELS_DIR', dir);
    expect(resolveModelsDir()).toBe(resolve(dir));
  });

  it('uses ./models when it exists, keeping the checkout workflow working', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'vem-local-'));
    mkdirSync(join(cwd, 'models'));
    process.chdir(cwd);
    vi.stubEnv('VIDEO_EXTRACT_MODELS_DIR', '');
    expect(resolveModelsDir()).toBe(resolve(realpathSync(cwd), "models"));
  });

  it('falls back to the user cache dir when there is no ./models', () => {
    // The npx / global-install case: CWD is wherever the agent started, so
    // the old relative-'models' default resolved to a directory that does
    // not exist and every uncaptioned video degraded to "asr failed".
    const cwd = mkdtempSync(join(tmpdir(), 'vem-none-'));
    process.chdir(cwd);
    vi.stubEnv('VIDEO_EXTRACT_MODELS_DIR', '');
    expect(resolveModelsDir()).toBe(join(homedir(), '.cache', 'video-extract-mcp', 'models'));
  });

  it('always returns an absolute path, since workers may not share this CWD', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'vem-abs-'));
    process.chdir(cwd);
    vi.stubEnv('VIDEO_EXTRACT_MODELS_DIR', 'relative/models');
    const got = resolveModelsDir();
    expect(isAbsolute(got)).toBe(true);
    expect(got).toBe(resolve(realpathSync(cwd), 'relative/models'));
  });

  it('treats a whitespace-only override as unset rather than as a real path', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'vem-blank-'));
    process.chdir(cwd);
    vi.stubEnv('VIDEO_EXTRACT_MODELS_DIR', '   ');
    expect(resolveModelsDir()).toBe(join(homedir(), '.cache', 'video-extract-mcp', 'models'));
  });
});
