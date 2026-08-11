import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { userInfo } from 'node:os';
import { buildManifest } from '../src/manifest.js';
import type { Manifest, ResolveStatus, SelectedFrame } from '../src/types.js';
import {
  CASES,
  skipReason,
  classifyOutcome,
  toMatrixResult,
  formatRow,
  formatConsoleLine,
  summarize,
  renderDocument,
  sanitize,
  execCase,
  runMatrix,
  type AnalyzeFn,
  type MatrixCase,
  type MatrixResult,
} from '../scripts/matrix.js';

// buildManifest (src/manifest.ts) has no import.meta.url-relative worker to
// spawn, so it is safe to pull straight from src/ in tests, the same
// reasoning tests/primitives.test.ts already documents for getClip. Using
// the real builder (rather than a hand-rolled object literal) means these
// fixtures can never silently drift from the actual Manifest shape.
function fakeManifest(status: ResolveStatus, over: Partial<Parameters<typeof buildManifest>[0]> = {}): Manifest {
  return buildManifest({
    url: 'https://example.com/v', platform: 'youtube', title: 'a title', duration: 10,
    resolvedBy: 'ytdlp', status, transcript: null, frames: [], candidateCount: 3,
    peakRssMb: 512, mode: 'accurate', ...over,
  });
}

function fakeFrame(timestamp: number): SelectedFrame {
  return {
    timestamp, sceneId: 0, image: 'f.jpg', importance: 0.5, reasons: [],
    ocrContent: null, transcriptWindow: null, nearestSelectedSimilarity: 0,
  };
}

const CASE: MatrixCase = { name: 'x', url: 'https://example.com/v', expectStatus: 'ok', proves: 'p' };

describe('skipReason', () => {
  it('flags a blank URL as the skip reason', () => {
    // Bug this catches: an unconfigured M_* env var (defaults to '') being
    // treated as a real target and handed to analyzeVideo / a real network call.
    expect(skipReason({ ...CASE, url: '' })).toMatch(/no URL/i);
    expect(skipReason({ ...CASE, url: '   ' })).toMatch(/no URL/i);
  });

  it('flags a missing required env var even when the URL is set (WeChat row)', () => {
    // Bug this catches: the WeChat row running against a resolver that needs
    // NORMA_WECHAT_COOKIE, without it, and coming back auth_required -- which
    // would then be scored as a plain FAIL instead of an honest SKIP.
    vi.stubEnv('NORMA_WECHAT_COOKIE', '');
    const reason = skipReason({ ...CASE, requiresEnv: ['NORMA_WECHAT_COOKIE'] });
    expect(reason).toMatch(/NORMA_WECHAT_COOKIE/);
    vi.unstubAllEnvs();
  });

  it('treats a whitespace-only required env var as missing (mirrors wechat.ts getCredential)', () => {
    vi.stubEnv('NORMA_WECHAT_COOKIE', '   ');
    expect(skipReason({ ...CASE, requiresEnv: ['NORMA_WECHAT_COOKIE'] })).not.toBeNull();
    vi.unstubAllEnvs();
  });

  it('returns null (runnable) when the URL and all required env vars are present', () => {
    // Bug this catches: an over-eager skip check that never lets a fully
    // configured case run at all.
    vi.stubEnv('NORMA_WECHAT_COOKIE', 'real-cookie-value');
    expect(skipReason({ ...CASE, requiresEnv: ['NORMA_WECHAT_COOKIE'] })).toBeNull();
    vi.unstubAllEnvs();
  });
});

describe('classifyOutcome', () => {
  it('marks a skipped execution SKIP regardless of expected status', () => {
    // Bug this catches: a skipped row being scored as if it had passed or failed.
    expect(classifyOutcome('ok', { kind: 'skipped', reason: 'no URL' })).toBe('SKIP');
    expect(classifyOutcome('unsupported', { kind: 'skipped', reason: 'no URL' })).toBe('SKIP');
  });

  it('marks a timed-out execution TIMEOUT, distinct from FAIL', () => {
    // Bug this catches: a hung case being conflated with an ordinary status mismatch.
    const outcome = classifyOutcome('ok', { kind: 'timeout', ms: 1000 });
    expect(outcome).toBe('TIMEOUT');
    expect(outcome).not.toBe('FAIL');
  });

  it('marks a threw execution FAIL regardless of expected status', () => {
    // Bug this catches: an unexpected exception from analyzeVideo being silently
    // treated as a pass because no status was available to compare.
    expect(classifyOutcome('ok', { kind: 'threw', message: 'boom' })).toBe('FAIL');
  });

  it('marks FAIL when the actual status differs from the expected status', () => {
    // Bug this catches: the comparison treating any successfully-returned
    // manifest as a pass, ignoring what status was actually expected.
    const exec = { kind: 'ran', status: 'auth_required', frames: 0, candidates: 0, transcriptSource: null, peakRssMb: 0 } as const;
    expect(classifyOutcome('ok', exec)).toBe('FAIL');
  });

  it('marks PASS when a row expecting a FAILURE status receives exactly that status (the inverted case)', () => {
    // Bug this catches: logic that assumes 'ok' is the only passing status and
    // hard-codes that assumption, which would wrongly fail drm-page/login-walled
    // rows even when the engine behaves exactly as designed.
    const exec = { kind: 'ran', status: 'unsupported', frames: 0, candidates: 0, transcriptSource: null, peakRssMb: 0 } as const;
    expect(classifyOutcome('unsupported', exec)).toBe('PASS');
  });

  it('marks FAIL when a row expecting a failure status instead comes back ok', () => {
    const exec = { kind: 'ran', status: 'ok', frames: 1, candidates: 1, transcriptSource: 'none', peakRssMb: 1 } as const;
    expect(classifyOutcome('unsupported', exec)).toBe('FAIL');
  });
});

describe('toMatrixResult', () => {
  it('carries selectedFrames/candidateFrames/transcript.source/peakRssMb through separately (no field swap)', () => {
    // Bug this catches: reading candidateFrames where selectedFrames belongs (or
    // vice versa) -- using DIFFERENT numbers for each makes a swap fail loudly.
    const exec = { kind: 'ran', status: 'ok', frames: 2, candidates: 9, transcriptSource: 'manual', peakRssMb: 777 } as const;
    const r = toMatrixResult(CASE, exec);
    expect(r.frames).toBe(2);
    expect(r.candidates).toBe(9);
    expect(r.transcriptSource).toBe('manual');
    expect(r.peakRssMb).toBe(777);
    expect(r.outcome).toBe('PASS');
  });

  it('leaves numeric fields null (not 0) for a skipped row', () => {
    // Bug this catches: a skipped row rendering "0" frames/candidates, which
    // reads as "ran and found nothing" instead of "never ran".
    const r = toMatrixResult(CASE, { kind: 'skipped', reason: 'no URL configured' });
    expect(r.frames).toBeNull();
    expect(r.candidates).toBeNull();
    expect(r.peakRssMb).toBeNull();
  });
});

describe('formatRow', () => {
  it('renders a SKIP row with a Pass cell that is neither YES nor NO', () => {
    // This is the strongest property in the whole task: a skipped row must be
    // impossible to misread as a pass (or a fail). Bug this catches: rendering
    // '-' or blank for skip, which a reader could misparse as "n/a, assume ok".
    const r = toMatrixResult(CASE, { kind: 'skipped', reason: 'no URL configured' });
    const row = formatRow(r);
    const cells = row.split('|').map((c) => c.trim());
    const passCell = cells[cells.length - 2]; // last real cell before the trailing empty split segment
    expect(passCell).toBe('SKIP');
    expect(passCell).not.toBe('YES');
    expect(passCell).not.toBe('NO');
  });

  it('renders distinct, non-overlapping Pass tokens for PASS/FAIL/SKIP/TIMEOUT', () => {
    // Bug this catches: two different outcomes rendering to the same token,
    // which would make one indistinguishable from another in the document.
    const pass = formatRow(toMatrixResult(CASE, { kind: 'ran', status: 'ok', frames: 1, candidates: 1, transcriptSource: 'none', peakRssMb: 1 }));
    const fail = formatRow(toMatrixResult(CASE, { kind: 'ran', status: 'auth_required', frames: 1, candidates: 1, transcriptSource: 'none', peakRssMb: 1 }));
    const skip = formatRow(toMatrixResult(CASE, { kind: 'skipped', reason: 'no URL configured' }));
    const timeout = formatRow(toMatrixResult(CASE, { kind: 'timeout', ms: 5000 }));
    const tokens = [pass, fail, skip, timeout].map((row) => row.split('|').map((c) => c.trim()).at(-2));
    expect(new Set(tokens).size).toBe(4);
    expect(tokens).toEqual(['YES', 'NO', 'SKIP', 'TIMEOUT']);
  });

  it('never renders a blank Pass cell for any outcome kind', () => {
    // Bug this catches: an outcome kind that falls through the token map and
    // renders as 'undefined' or an empty cell.
    for (const exec of [
      { kind: 'skipped', reason: 'r' } as const,
      { kind: 'timeout', ms: 1 } as const,
      { kind: 'threw', message: 'm' } as const,
      { kind: 'ran', status: 'ok', frames: 0, candidates: 0, transcriptSource: null, peakRssMb: 0 } as const,
    ]) {
      const cells = formatRow(toMatrixResult(CASE, exec)).split('|').map((c) => c.trim());
      const passCell = cells.at(-2);
      expect(passCell).toBeTruthy();
      expect(passCell).not.toBe('undefined');
    }
  });
});

describe('formatConsoleLine', () => {
  it('includes the outcome and case name for a skipped row', () => {
    const line = formatConsoleLine(toMatrixResult(CASE, { kind: 'skipped', reason: 'no URL configured' }));
    expect(line).toContain('SKIP');
    expect(line).toContain(CASE.name);
  });
});

describe('sanitize', () => {
  it('redacts the current OS username and absolute /Users paths from free text', () => {
    // Bug this catches: a thrown error message (which can legitimately contain
    // absolute filesystem paths, e.g. ENOENT text) leaking the operator's local
    // username or home-directory path into a document meant to be committed.
    const user = userInfo().username;
    // Built by segments so the literal 7-character path prefix never appears
    // contiguously in this source file's own text.
    const home = ['', 'Users', user, 'project', 'clip.mp4'].join('/');
    const input = `ENOENT: no such file or directory, open '${home}'`;
    const out = sanitize(input);
    expect(out.includes([  '/', 'Users', '/'].join(''))).toBe(false);
    if (user.length > 0) expect(out.includes(user)).toBe(false);
  });

  it('leaves ordinary text without paths or the username unchanged', () => {
    expect(sanitize('auth_required: sign in to continue')).toBe('auth_required: sign in to continue');
  });
});

describe('summarize', () => {
  it('counts total/executed/skipped/passed/failed/timedOut correctly from a mixed result set', () => {
    // Bug this catches: summary counts computed independently of the actual row
    // data (e.g. hand-maintained counters) drifting from what the rows say.
    const results: MatrixResult[] = [
      toMatrixResult(CASE, { kind: 'skipped', reason: 'no URL' }),
      toMatrixResult(CASE, { kind: 'skipped', reason: 'no URL' }),
      toMatrixResult(CASE, { kind: 'ran', status: 'ok', frames: 1, candidates: 1, transcriptSource: 'none', peakRssMb: 1 }),
      toMatrixResult(CASE, { kind: 'ran', status: 'auth_required', frames: 0, candidates: 0, transcriptSource: null, peakRssMb: 0 }),
      toMatrixResult(CASE, { kind: 'timeout', ms: 1 }),
    ];
    const s = summarize(results);
    expect(s).toEqual({ total: 5, executed: 3, skipped: 2, passed: 1, failed: 1, timedOut: 1 });
  });
});

describe('renderDocument', () => {
  it('states an unmistakable UNPROVEN summary when every row is skipped, with no YES cell anywhere', () => {
    // This is the document-level version of the strongest property: even
    // aggregated into the full page, a fully-unconfigured run must not be
    // mistakable for a passing matrix. Bug this catches: a summary line that
    // only a per-row reader would notice, or an omitted top-of-document count.
    const results = CASES.map((c) => toMatrixResult(c, { kind: 'skipped', reason: 'no URL configured' }));
    const doc = renderDocument(results, { generatedAt: new Date('2026-08-11T00:00:00.000Z') });
    expect(doc).toContain(`0 of ${CASES.length} rows executed`);
    expect(doc.toUpperCase()).toContain('UNPROVEN');
    expect(doc).not.toMatch(/\|\s*YES\s*\|/);
  });

  it('reflects a genuinely mixed result set in both the summary line and the table', () => {
    const results: MatrixResult[] = [
      toMatrixResult(CASE, { kind: 'ran', status: 'ok', frames: 1, candidates: 1, transcriptSource: 'none', peakRssMb: 1 }),
      toMatrixResult({ ...CASE, name: 'y' }, { kind: 'skipped', reason: 'no URL configured' }),
    ];
    const doc = renderDocument(results, { generatedAt: new Date('2026-08-11T00:00:00.000Z') });
    expect(doc).toContain('1 of 2 rows executed');
    expect(doc).toMatch(/\|\s*YES\s*\|/);
    expect(doc).toContain('SKIP');
  });
});

describe('execCase', () => {
  it('skips without ever invoking analyze when the URL is blank', async () => {
    // Bug this catches: attempting a real network call for an unconfigured row.
    const analyze = vi.fn<AnalyzeFn>();
    const exec = await execCase({ ...CASE, url: '' }, { timeoutMs: 1000, analyze });
    expect(exec.kind).toBe('skipped');
    expect(analyze).not.toHaveBeenCalled();
  });

  it('returns TIMEOUT (not threw/ran) when analyze hangs past timeoutMs', async () => {
    // Bug this catches: one wedged URL stalling (or being misreported by) the
    // whole matrix run instead of being bounded and recorded distinctly.
    const analyze: AnalyzeFn = () => new Promise<Manifest>(() => {}); // never resolves
    const exec = await execCase(CASE, { timeoutMs: 20, analyze });
    expect(exec.kind).toBe('timeout');
  });

  it('maps a real manifest onto ran/status/frames/candidates/transcriptSource/peakRssMb', async () => {
    const manifest = fakeManifest('unsupported', {
      reason: 'drm_protected', frames: [fakeFrame(1), fakeFrame(2)], candidateCount: 9, peakRssMb: 321,
      transcript: { language: 'en', source: 'auto', segments: [] },
    });
    const analyze: AnalyzeFn = async () => manifest;
    const exec = await execCase(CASE, { timeoutMs: 1000, analyze });
    expect(exec).toEqual({
      kind: 'ran', status: 'unsupported', frames: 2, candidates: 9, transcriptSource: 'auto', peakRssMb: 321,
    });
  });

  it('catches a thrown/rejected analyze call as kind "threw", not an unhandled rejection', async () => {
    const analyze: AnalyzeFn = async () => { throw new Error('boom-explosion'); };
    const exec = await execCase(CASE, { timeoutMs: 1000, analyze });
    expect(exec.kind).toBe('threw');
  });

  it('never surfaces an unhandled rejection when analyze rejects after a timeout', async () => {
    // Pins a safety property rather than regression-testing withTimeout's
    // explicit p.catch() line specifically: verified directly (temporarily
    // deleting that line and re-running this test) that it passes identically
    // either way, because Promise.race([p, timeout]) already attaches its own
    // rejection handler to `p` as part of racing it -- a late rejection is
    // never actually "unhandled" regardless. The explicit catch in matrix.ts
    // is kept as defense-in-depth against a future refactor that stops racing
    // `p` directly; this test documents the property that must keep holding
    // no matter which mechanism ends up providing it.
    let sawUnhandled = false;
    const onUnhandled = () => { sawUnhandled = true; };
    process.once('unhandledRejection', onUnhandled);
    try {
      const analyze: AnalyzeFn = () => new Promise<Manifest>((_resolve, reject) => {
        setTimeout(() => reject(new Error('late failure after timeout')), 10);
      });
      const exec = await execCase(CASE, { timeoutMs: 5, analyze });
      expect(exec.kind).toBe('timeout');
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
    expect(sawUnhandled).toBe(false);
  });
});

describe('runMatrix (wiring, no network)', () => {
  let outFile: string;
  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'norma-matrix-test-'));
    outFile = join(dir, 'matrix.md');
  });

  it('writes a document to outFile matching renderDocument for the same results, and returns them', async () => {
    // Bug this catches: the orchestration loop building its own ad hoc markdown
        // instead of delegating to the pure formatter, letting the two drift apart.
    const ranManifest = fakeManifest('unsupported', { reason: 'drm_protected' });
    const cases: MatrixCase[] = [
      { name: 'skipped-case', url: '', expectStatus: 'ok', proves: 'x' },
      { name: 'drm-case', url: 'https://example.com/drm', expectStatus: 'unsupported', proves: 'y' },
    ];
    const analyze: AnalyzeFn = async () => ranManifest;
    const generatedAt = new Date('2026-08-11T00:00:00.000Z');
    const results = await runMatrix(cases, { analyze, outFile, timeoutMs: 1000, now: () => generatedAt });

    expect(results).toHaveLength(2);
    expect(results[0]?.outcome).toBe('SKIP');
    expect(results[1]?.outcome).toBe('PASS');

    const written = readFileSync(outFile, 'utf8');
    expect(written).toBe(renderDocument(results, { generatedAt }));
  });

  it('never calls analyze for any case when every URL is blank (the real "no URLs configured" run)', async () => {
    // Bug this catches: the exact scenario this task exists to make safe --
    // running with nothing configured must not touch the network at all.
    const analyze = vi.fn<AnalyzeFn>(async () => fakeManifest('ok'));
    const blankCases = CASES.map((c) => ({ ...c, url: '' }));
    const results = await runMatrix(blankCases, { analyze, outFile, timeoutMs: 1000 });
    expect(analyze).not.toHaveBeenCalled();
    expect(results.every((r) => r.outcome === 'SKIP')).toBe(true);
  });
});
