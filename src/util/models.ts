import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Where the speech models live.
 *
 * The default used to be the literal relative string 'models', resolved
 * against the PROCESS CWD. That works when the tool is run from a checkout
 * and nowhere else: installed globally or launched through npx, the CWD is
 * whatever directory the caller's agent happened to start in, so the models
 * were never found and every uncaptioned video degraded to "asr failed".
 *
 * Resolution order, first hit wins:
 *  1. VIDEO_EXTRACT_MODELS_DIR -- explicit, always respected.
 *  2. ./models -- only when it actually exists, which keeps the repo
 *     workflow (`./scripts/fetch-models.sh`) working unchanged.
 *  3. ~/.cache/video-extract-mcp/models -- the installed-package location,
 *     outside node_modules so a reinstall or npx cache eviction does not
 *     discard 1.5GB of downloads.
 *
 * Returns an absolute path so the value survives being handed to a worker
 * process that may not share this process's CWD.
 */
export function resolveModelsDir(): string {
  const explicit = process.env.VIDEO_EXTRACT_MODELS_DIR?.trim();
  if (explicit) return resolve(explicit);
  const local = resolve('models');
  if (existsSync(local)) return local;
  return join(homedir(), '.cache', 'video-extract-mcp', 'models');
}
