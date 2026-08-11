import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isMainModule } from '../src/util/entry.js';

const pexec = promisify(execFile);

describe('isMainModule', () => {
  let dir: string, realFile: string, linkDir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'norma-entry-'));
    const realDir = join(dir, 'real');
    mkdirSync(realDir, { recursive: true });
    realFile = join(realDir, 'prog.js');
    writeFileSync(realFile, '');
    writeFileSync(join(dir, 'other.js'), '');
    // a symlinked DIRECTORY, the shape of `ln -s repo/dist /usr/local/lib/norma`
    linkDir = join(dir, 'link');
    symlinkSync(realDir, linkDir);
  });

  it('matches when argv[1] reaches the same file through a symlinked directory', () => {
    // Node realpaths the main module, so import.meta.url carries the REAL
    // path while argv[1] keeps the symlinked spelling -- the exact case the
    // old `import.meta.url === pathToFileURL(argv[1]).href` comparison
    // failed on, making every entry point exit 0 having done nothing.
    const importMetaUrl = pathToFileURL(realpathSync(realFile)).href;
    expect(isMainModule(importMetaUrl, join(linkDir, 'prog.js'))).toBe(true);
  });

  it('matches the plain same-path invocation (spaces in the checkout path included)', () => {
    expect(isMainModule(pathToFileURL(realFile).href, realFile)).toBe(true);
  });

  it('rejects a different file, a missing argv[1], and a nonexistent path', () => {
    expect(isMainModule(pathToFileURL(realFile).href, join(dir, 'other.js'))).toBe(false);
    expect(isMainModule(pathToFileURL(realFile).href, undefined)).toBe(false);
    expect(isMainModule(pathToFileURL(realFile).href, join(dir, 'no-such-file.js'))).toBe(false);
  });
});

describe('entry guards fire through a symlinked dist/ (reproduction of the review finding)', () => {
  it('cli.js run via a symlinked path prints usage and exits 1 instead of silently exiting 0', async () => {
    // Pre-fix reproduction: `node /tmp/norma-link/cli.js` exited 0 having
    // done nothing. dist/ exists because the pretest hook builds first.
    const dir = mkdtempSync(join(tmpdir(), 'norma-entry-e2e-'));
    const link = join(dir, 'norma-link');
    symlinkSync(resolvePath('dist'), link);
    const r = await pexec(process.execPath, [join(link, 'cli.js')]).then(
      (ok) => ({ code: 0, stderr: ok.stderr }),
      (err: { code?: number; stderr?: string }) => ({ code: err.code ?? -1, stderr: err.stderr ?? '' }),
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('usage:');
  }, 30_000);
});
