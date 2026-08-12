import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { userInfo } from 'node:os';
import { buildManifest } from '../src/manifest.js';
// run() (src/util/run.ts) is a plain child_process wrapper with no
// import.meta.url-relative worker to spawn -- same "safe to pull straight
// from src/" reasoning as buildManifest above.
import { run } from '../src/util/run.js';
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
    peakRssMb: 512, frameMode: 'key', ...over,
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
    // VIDEO_EXTRACT_WECHAT_COOKIE, without it, and coming back auth_required -- which
    // would then be scored as a plain FAIL instead of an honest SKIP.
    vi.stubEnv('VIDEO_EXTRACT_WECHAT_COOKIE', '');
    const reason = skipReason({ ...CASE, requiresEnv: ['VIDEO_EXTRACT_WECHAT_COOKIE'] });
    expect(reason).toMatch(/VIDEO_EXTRACT_WECHAT_COOKIE/);
    vi.unstubAllEnvs();
  });

  it('treats a whitespace-only required env var as missing (mirrors wechat.ts getCredential)', () => {
    vi.stubEnv('VIDEO_EXTRACT_WECHAT_COOKIE', '   ');
    expect(skipReason({ ...CASE, requiresEnv: ['VIDEO_EXTRACT_WECHAT_COOKIE'] })).not.toBeNull();
    vi.unstubAllEnvs();
  });

  it('returns null (runnable) when the URL and all required env vars are present', () => {
    // Bug this catches: an over-eager skip check that never lets a fully
    // configured case run at all.
    vi.stubEnv('VIDEO_EXTRACT_WECHAT_COOKIE', 'real-cookie-value');
    expect(skipReason({ ...CASE, requiresEnv: ['VIDEO_EXTRACT_WECHAT_COOKIE'] })).toBeNull();
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

  it('escapes pipe characters and collapses newlines/carriage returns to spaces (Finding 2)', () => {
    // Bug this catches: a raw '|' or line break surviving into a markdown
    // table cell, corrupting the row's column count once rendered -- found
    // in code review, reproduced against the pre-fix code (see
    // task-17-report.md): a message with 6 raw pipes and one embedded
    // newline turned a 9-column row into 16 raw-pipe-delimited fragments
    // split across two output lines.
    const out = sanitize('a|b\nc\r\nd|||e');
    expect(out).not.toMatch(/[\r\n]/);
    expect(out).not.toMatch(/(?<!\\)\|/); // no UNescaped pipe survives
    expect(out).toContain('\\|'); // but the pipes are preserved, escaped -- not silently dropped
  });
});

describe('formatRow -- table-structural characters in a thrown message (Finding 2)', () => {
  it('keeps a threw row at exactly 9 cells (10 unescaped pipes) and free of raw newlines for a realistic pipe-and-newline-heavy error', () => {
    // Reproduces the code-review finding's exact message shape -- realistic
    // for ffmpeg/yt-dlp stderr, which is routinely multi-line and pipe-heavy,
    // and sits outside analyzeVideo's try/catch (src/analyze.ts:57-58) so it
    // can reach here verbatim as a thrown Error's .message. Verified directly
    // against the pre-fix sanitize(): this exact message produced a row with
    // 16 raw pipe characters and an embedded newline instead of the correct
    // 10 pipes / 0 newlines (see task-17-report.md for the literal capture).
    const nasty = 'usage: tool --a=1|--b=2 failed | exit 1\nsecond line of stderr | more pipes |||';
    const row = formatRow(toMatrixResult(CASE, { kind: 'threw', message: nasty }));

    expect(row.includes('\n')).toBe(false);
    expect(row.includes('\r')).toBe(false);

    // A well-formed 9-column row has exactly 10 unescaped '|' delimiters,
    // regardless of what the free-text Status cell contains -- this is what
    // guarantees any compliant table parser recovers exactly 9 cells, so the
    // true trailing Pass token is never truncated off the end or replaced by
    // some other column's content landing in its place.
    const unescapedPipeCount = (row.match(/(?<!\\)\|/g) ?? []).length;
    expect(unescapedPipeCount).toBe(10);

    expect(row).toContain('\\|'); // the message's own pipes are preserved, escaped
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

  it('never touches analyze/resolveAnalyze when the case is skipped (execCase\'s own contract -- does NOT by itself prove the Finding 1 ordering fix)', async () => {
    // RELABELED after code review correctly identified this as a false
    // guard: this test's comment previously claimed it caught "resolving
    // the real analyzeVideo unconditionally before the skip check runs".
    // It cannot and never could -- empirically confirmed by reconstructing
    // the TRUE pre-fix execCase (git show 5009fa3:scripts/matrix.ts) and
    // running this exact assertion against it: it PASSED identically,
    // because pre-fix execCase already called skipReason() first and
    // returned before ever touching opts.analyze. The Finding 1 bug never
    // lived in execCase -- it lived one level up, in runMatrix's pre-loop
    // resolution (see the true differential test below, in the "real
    // subprocess" describe block). What this test DOES legitimately pin:
    // execCase's own skip-before-resolve ordering, a real property worth
    // protecting against a future regression that reorders execCase's OWN
    // body, even though it says nothing about where analyze/resolveAnalyze
    // gets resolved one level up in runMatrix.
    const resolveAnalyze = vi.fn(async (): Promise<AnalyzeFn> => {
      throw new Error('simulated: dist/analyze.js not found (no build yet)');
    });
    const exec = await execCase({ ...CASE, url: '' }, { timeoutMs: 1000, resolveAnalyze });
    expect(exec.kind).toBe('skipped');
    expect(resolveAnalyze).not.toHaveBeenCalled();
  });

  it('surfaces a failed real-analyze resolution as an honest FAIL row, not an uncaught crash (Finding 1)', async () => {
    // For a case that IS configured (has a URL), a failure to resolve the
    // real analyzeVideo (e.g. `npm run build` was never run) must still
    // produce a row -- not propagate out of execCase uncaught, which would
    // abort the whole matrix run with no document written at all.
    //
    // Confirmed genuinely discriminating (unlike the two tests flagged in
    // code review): reconstructing the TRUE pre-fix execCase and running
    // this exact test against it FAILS -- but via a different mechanism
    // than originally described here. Pre-fix execCase's `analyze` was a
    // REQUIRED parameter with no resolveAnalyze fallback at all; calling it
    // the way this test does (only resolveAnalyze supplied) left
    // `opts.analyze` undefined, so `opts.analyze(...)` threw a plain
    // TypeError ("opts.analyze is not a function") caught by pre-fix's own
    // catch block -- resolveAnalyze itself was never invoked, so
    // `toHaveBeenCalledTimes(1)` failed with "0 times". Literal pre-fix
    // failure: `AssertionError: expected "spy" to be called 1 times, but
    // got 0 times` (see task-17-report.md). What this test actually proves
    // post-fix: resolveAnalyze IS consulted when analyze is absent, and a
    // failure from it becomes an honest FAIL row rather than a crash.
    const resolveAnalyze = vi.fn(async (): Promise<AnalyzeFn> => {
      throw new Error('simulated: dist/analyze.js not found (no build yet)');
    });
    const exec = await execCase(CASE, { timeoutMs: 1000, resolveAnalyze });
    expect(resolveAnalyze).toHaveBeenCalledTimes(1);
    expect(exec.kind).toBe('threw');
    if (exec.kind === 'threw') expect(exec.message).toContain('dist/analyze.js not found');
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

  it('resolves cleanly and writes the honest all-skip document with NEITHER analyze NOR resolveAnalyze injected (Finding 1)', async () => {
    // The literal "fresh checkout, nothing configured" scenario this task
    // exists to handle: no injected analyze (so this exercises the real
    // getRealAnalyze() code path), no M_* URLs. On THIS machine dist/
    // happens to be built already, so this test alone cannot distinguish
    // pre-fix from post-fix code -- both resolve dist/analyze.js
    // successfully here, and pre-fix code merely left that reference
    // unused once every case turned out to skip. The genuinely differential
    // proof that the *ordering* bug is fixed -- confirmed to fail against
    // true pre-fix code, not just a reconstruction of it -- lives in the
    // "real subprocess, isolated copy with no dist/" describe block below,
    // which reproduces the actual missing-dist/ condition on disk instead
    // of relying on a mock old code doesn't know how to call. This test
    // pins the literal end-to-end contract as a real, no-mocks smoke test
    // -- the same shape of call `npm run matrix` itself makes.
    const blankCases = CASES.map((c) => ({ ...c, url: '' }));
    const results = await runMatrix(blankCases, { outFile, timeoutMs: 1000 });
    expect(results.every((r) => r.outcome === 'SKIP')).toBe(true);
    const written = readFileSync(outFile, 'utf8');
    expect(written).toContain(`0 of ${CASES.length} rows executed`);
  });
});

describe('runMatrix -- real subprocess, isolated copy with no dist/ (Finding 1, genuinely discriminating)', () => {
  it('exits 0 and writes the honest all-skip document when dist/ genuinely does not exist on disk', async () => {
    // REPLACES a test (previously here) whose own comment asserted it
    // "discriminates regardless of whether dist/ happens to exist on the
    // machine running the test" -- code review disproved that empirically:
    // reconstructing the TRUE pre-fix runMatrix (git show
    // 5009fa3:scripts/matrix.ts) and running that exact assertion against it
    // PASSED identically, because pre-fix runMatrix reads only opts.analyze
    // (`opts.analyze ?? await getRealAnalyze()`) and has no
    // opts.resolveAnalyze field at all -- an unrecognized extra property on
    // a plain object is silently ignored at runtime, so the mock went
    // uncalled in both versions for the same reason as the disclosed smoke
    // test above, not because the ordering bug was fixed. A comment
    // asserting discrimination that does not exist is worse than no
    // comment, so that test was removed rather than merely relabeled.
    //
    // This test instead reproduces the ACTUAL bug end-to-end, the same
    // technique the code reviewer used to independently verify the fix:
    // copy the real scripts/matrix.ts into an isolated temp directory that
    // has neither dist/ nor src/ (matrix.ts's only src/ import is `import
    // type`, fully erased at transpile time, so it is never touched at
    // runtime), run it as a real subprocess with no M_*/VIDEO_EXTRACT_* env vars,
    // and observe the result. dist/ does not exist there -- genuinely
    // absent, not simulated -- so getRealAnalyze()'s dynamic import would
    // fail exactly as on a fresh clone, IF it were ever reached. Runs
    // against an ISOLATED copy specifically so this cannot race with other
    // test files that may concurrently import the real project's shared
    // dist/ during a parallel `npx vitest run`.
    //
    // Verified genuinely differential by running this exact reproduction
    // (manually, then via this test's own logic) against both versions:
    // pre-fix -> exit 1, `ERR_MODULE_NOT_FOUND`, no document written;
    // post-fix -> exit 0, honest document written (see task-17-report.md
    // for both literal captures).
    const root = mkdtempSync(join(tmpdir(), 'norma-matrix-nodist-'));
    mkdirSync(join(root, 'scripts'), { recursive: true });
    mkdirSync(join(root, 'docs'), { recursive: true });
    // tsx/esbuild falls back to CJS output (which rejects this file's
    // top-level-await entry guard) when it finds no package.json declaring
    // "type": "module" anywhere above the target file -- unrelated to the
    // bug under test; this just makes the isolated copy behave like the
    // real project instead of erroring for a different reason first.
    writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
    cpSync(join(process.cwd(), 'scripts', 'matrix.ts'), join(root, 'scripts', 'matrix.ts'));
    // Deliberately: no dist/ created under `root`. Of src/, ONLY the entry
    // guard helper is copied: matrix.ts's one runtime src/ import is
    // src/util/entry.ts (isMainModule -- the symlink-robust entry guard);
    // every other src/ import in it is `import type`, erased at transpile
    // time. dist/ -- the thing this test is about -- stays genuinely absent.
    mkdirSync(join(root, 'src', 'util'), { recursive: true });
    cpSync(join(process.cwd(), 'src', 'util', 'entry.ts'), join(root, 'src', 'util', 'entry.ts'));

    const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
    for (const k of Object.keys(cleanEnv)) {
      if (/^(M_|VIDEO_EXTRACT_|NORMA_)/.test(k)) delete cleanEnv[k];
    }

    const tsxBin = join(process.cwd(), 'node_modules', '.bin', 'tsx');
    // The script argument MUST be relative (matching exactly how `npm run
    // matrix` itself invokes tsx: `tsx scripts/matrix.ts` from the project
    // root), not an absolute path built from `root`. Found while building
    // this test: on macOS, os.tmpdir() resolves under /var/folders, and
    // /var is itself a symlink to /private/var. Passed an ABSOLUTE script
    // path, Node leaves process.argv[1] as the literal (pre-symlink) path
    // while import.meta.url reflects the realpath-resolved location, so
    // even the "robust" pathToFileURL(process.argv[1]).href entry guard
    // fails to match -- a second, independent way to make this exact guard
    // silently never fire, distinct from the space-in-path issue it was
    // originally written to fix. Passed a RELATIVE path with the matching
    // `cwd`, both sides resolve through the same realpath and match
    // correctly (verified directly: see task-17-report.md). This is a
    // test-harness-only concern -- `npm run matrix` always uses a relative
    // path from the project root, so production is unaffected -- but it
    // would have made this specific test silently useless (0 rows, no
    // crash, indistinguishable from "working") had it gone unnoticed.
    const result = await run(tsxBin, ['scripts/matrix.ts'], {
      cwd: root, env: cleanEnv, timeoutMs: 20_000,
    });

    expect(result.stderr).not.toContain('ERR_MODULE_NOT_FOUND');
    expect(result.code).toBe(0);

    const written = readFileSync(join(root, 'docs', 'acceptance-matrix.md'), 'utf8');
    expect(written).toContain(`0 of ${CASES.length} rows executed`);
    expect(written.toUpperCase()).toContain('UNPROVEN');
  });
});
