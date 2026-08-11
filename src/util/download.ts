import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Overall media-transfer deadline -- matches the ceiling already applied to
 *  the yt-dlp subprocess, so every network path in the engine is bounded. */
export const MEDIA_DOWNLOAD_TIMEOUT_MS = 15 * 60_000;

export interface FetchToFileResult { ok: boolean; status: number }

/**
 * Streams an HTTP(S) body to a local file under a bounded overall deadline.
 * AbortSignal.timeout() covers the WHOLE transfer -- connect, headers and
 * body consumption (verified empirically in tests/download.test.ts with a
 * mid-body stall) -- so a stalled CDN aborts the call instead of hanging
 * analyze_video indefinitely, which is what the previous bare fetch()+
 * pipeline() did.
 *
 * Non-2xx responses return { ok:false, status } without touching the file,
 * so callers can classify 401/403/404 themselves. Network errors and
 * timeouts throw (every caller already unlinks the partial file and
 * classifies in its catch).
 */
export async function fetchToFile(
  url: string, out: string,
  opts: { timeoutMs?: number; headers?: Record<string, string> } = {},
): Promise<FetchToFileResult> {
  const timeoutMs = opts.timeoutMs ?? MEDIA_DOWNLOAD_TIMEOUT_MS;
  const res = await fetch(url, { headers: opts.headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok || !res.body) return { ok: false, status: res.status };
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(out));
  return { ok: true, status: res.status };
}
