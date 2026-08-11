import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * "Is this module the process's entry point?" -- robust to BOTH known ways
 * the naive comparisons break:
 *
 *  1. Percent-encoding: import.meta.url is always percent-encoded while
 *     process.argv[1] never is, so `file://${process.argv[1]}` template
 *     comparison silently never matches in a checkout path containing a
 *     space (this repository's own). pathToFileURL fixed that first.
 *  2. Symlinks: Node REALPATHS the main module before importing it, so
 *     import.meta.url holds the resolved physical path while argv[1] stays
 *     exactly as typed -- `node /tmp/norma-link/dist/cli.js` (a symlinked
 *     dir) made even the pathToFileURL comparison fail, and every entry
 *     point exited 0 having silently done nothing. Comparing realpathSync
 *     of BOTH sides (which also decodes the URL via fileURLToPath, covering
 *     problem 1) is the fix.
 *
 * Returns false when argv[1] is missing or unresolvable (e.g. the module is
 * merely being imported by a test runner or another module).
 */
export function isMainModule(importMetaUrl: string, argv1: string | undefined = process.argv[1]): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(importMetaUrl)) === realpathSync(argv1);
  } catch {
    return false; // non-file URL, or a path that doesn't exist
  }
}
