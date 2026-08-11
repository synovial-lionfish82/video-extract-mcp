import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchToFile } from '../src/util/download.js';

// Bounded-download coverage (review IMPORTANT-2): the three network paths
// that previously ran with NO deadline (direct body fetch, wechat media
// fetch; the HLS mux is a run() timeout) now go through fetchToFile. A
// local loopback server -- never a real video platform -- simulates the two
// stall shapes a CDN can produce: never answering, and stalling mid-body.
// The pre-fix code cannot be run red here without hanging the suite
// indefinitely (that IS the defect); these tests pin the replacement's
// deadline behaviour instead.

let server: Server;
let base: string;
const hangingResponses: ServerResponse[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/ok') {
      res.writeHead(200, { 'Content-Type': 'video/mp4' });
      res.end('MEDIA_BYTES');
    } else if (req.url === '/missing') {
      res.writeHead(404).end('nope');
    } else if (req.url === '/forbidden') {
      res.writeHead(403).end('denied');
    } else if (req.url === '/stall-headers') {
      hangingResponses.push(res); // accept the socket, answer nothing, ever
    } else if (req.url === '/stall-body') {
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': '1048576' });
      res.write('PARTIAL'); // then never send the rest
      hangingResponses.push(res);
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(async () => {
  for (const res of hangingResponses) res.destroy();
  await new Promise<void>((r) => server.close(() => r()));
});

describe('fetchToFile (bounded media download)', () => {
  it('streams a 2xx body to the target file', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'norma-dl-')), 'a.bin');
    const r = await fetchToFile(`${base}/ok`, out, { timeoutMs: 5_000 });
    expect(r).toEqual({ ok: true, status: 200 });
    expect(readFileSync(out, 'utf8')).toBe('MEDIA_BYTES');
  });

  it('returns non-ok with the status for 404/403 without touching the file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'norma-dl-'));
    const out = join(dir, 'b.bin');
    expect(await fetchToFile(`${base}/missing`, out, { timeoutMs: 5_000 })).toEqual({ ok: false, status: 404 });
    expect(await fetchToFile(`${base}/forbidden`, out, { timeoutMs: 5_000 })).toEqual({ ok: false, status: 403 });
    expect(existsSync(out)).toBe(false);
  });

  it('aborts within the deadline when the server never answers', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'norma-dl-')), 'c.bin');
    const started = Date.now();
    await expect(fetchToFile(`${base}/stall-headers`, out, { timeoutMs: 400 })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('aborts within the deadline when the body stalls mid-transfer (the stalled-CDN shape)', async () => {
    // This is the load-bearing claim about AbortSignal.timeout(): it must
    // cover BODY consumption, not just connect/headers -- verified here
    // empirically rather than assumed.
    const out = join(mkdtempSync(join(tmpdir(), 'norma-dl-')), 'd.bin');
    const started = Date.now();
    await expect(fetchToFile(`${base}/stall-body`, out, { timeoutMs: 400 })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
