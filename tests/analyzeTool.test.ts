import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const analyzeMock = vi.fn();
vi.mock('../src/analyze.js', () => ({ analyzeVideo: (...a: unknown[]) => analyzeMock(...a) }));
const { analyzeVideoTool } = await import('../src/agent/analyzeTool.js');
afterEach(() => analyzeMock.mockReset());

const manifest = (over: Record<string, unknown> = {}) => ({
  source: { url: 'u', platform: 'p', title: 'T', duration: 10, resolvedBy: 'ytdlp', status: 'ok', filePath: '/x/work.mp4' },
  transcript: { language: 'en', source: 'asr', segments: [{ start: 0, end: 1, text: 'hi' }] },
  frames: [{ timestamp: 1, sceneId: 0, image: '/x/f1.jpg', importance: 0.5, reasons: [], ocrContent: null, transcriptWindow: null, nearestSelectedSimilarity: 0 }],
  processing: { selectedFrames: 1, candidateFrames: 3, peakRssMb: 100, selectorVersion: '1', frameMode: 'key', warnings: [] },
  ...over,
});

describe('analyzeVideoTool', () => {
  it('always writes the transcript to disk, even when returning it inline', async () => {
    analyzeMock.mockResolvedValue(manifest());
    const dir = mkdtempSync(join(tmpdir(), 'norma-at-'));
    const r = await analyzeVideoTool({ pathOrUrl: 'https://x/v', destinationPath: dir });
    expect(existsSync(r.transcriptPath!)).toBe(true);
    expect(r.transcript).toBeDefined();
  });

  it('writes the transcript but omits it inline when it is long', async () => {
    // NOTE: the brief's own fixture (800 segments of `line ${i}`) totals
    // 6290 chars -- BELOW INLINE_TRANSCRIPT_MAX_CHARS (8000), so it would
    // actually get inlined and this test would fail against a correct
    // implementation (verified directly: node -e with the brief's exact
    // generator prints 6290). Padded here so the total genuinely clears
    // the threshold, which is the property this test exists to check.
    const segments = Array.from({ length: 800 }, (_, i) => ({ start: i, end: i + 1, text: `line number ${i} of the transcript` }));
    analyzeMock.mockResolvedValue(manifest({ transcript: { language: 'en', source: 'asr', segments } }));
    const dir = mkdtempSync(join(tmpdir(), 'norma-at-'));
    const r = await analyzeVideoTool({ pathOrUrl: 'https://x/v', destinationPath: dir });
    expect(existsSync(r.transcriptPath!)).toBe(true);
    expect(r.transcript).toBeUndefined();
    expect(JSON.parse(readFileSync(r.transcriptPath!, 'utf8')).segments).toHaveLength(800);
  });

  it('always writes the manifest at the literal expected path (manifest.json)', async () => {
    // Asserts the literal expected path, not just existsSync(r.manifestPath)
    // read back from the function's own return value -- an implementation
    // that writes to the wrong filename but faithfully reports that same
    // wrong path back would pass an existsSync-only check. This is the
    // exact weakness called out from an earlier task in this plan, where
    // three mutants survived a test shaped that way.
    analyzeMock.mockResolvedValue(manifest());
    const dir = mkdtempSync(join(tmpdir(), 'norma-at-'));
    const r = await analyzeVideoTool({ pathOrUrl: 'https://x/v', destinationPath: dir });
    const expectedPath = join(dir, 'manifest.json');
    expect(r.manifestPath).toBe(expectedPath);
    expect(existsSync(expectedPath)).toBe(true);
  });

  it('passes destinationPath and outDir down so the video and frames land there (spec §2.2)', async () => {
    analyzeMock.mockResolvedValue(manifest());
    const dir = mkdtempSync(join(tmpdir(), 'norma-at-'));
    await analyzeVideoTool({ pathOrUrl: 'https://x/v', destinationPath: dir });
    expect(analyzeMock.mock.calls[0]![1]).toMatchObject({ destinationPath: dir, outDir: dir });
  });

  it('forwards language as the explicit override (spec §4)', async () => {
    analyzeMock.mockResolvedValue(manifest());
    const dir = mkdtempSync(join(tmpdir(), 'norma-at-'));
    await analyzeVideoTool({ pathOrUrl: 'https://x/v', destinationPath: dir, language: 'ja' });
    expect(analyzeMock.mock.calls[0]![1]).toMatchObject({ preferredLanguage: 'ja' });
  });

  it('surfaces a failure manifest without throwing', async () => {
    analyzeMock.mockResolvedValue(manifest({
      source: { url: 'u', platform: 'unknown', title: '', duration: 0, resolvedBy: 'none', status: 'unsupported', reason: 'drm_protected' },
      transcript: null, frames: [],
    }));
    const dir = mkdtempSync(join(tmpdir(), 'norma-at-'));
    const r = await analyzeVideoTool({ pathOrUrl: 'https://x/v', destinationPath: dir });
    expect(r.status).toBe('unsupported');
    expect(r.frameCount).toBe(0);
  });

  it('returns a structured failure instead of throwing when destinationPath exists as a file (EEXIST)', async () => {
    // Mirrors tests/resolveTool.test.ts's own EEXIST case: an ordinary
    // caller mistake (a stale or mistyped destinationPath that is actually
    // a file) throws from mkdirSync before analyzeVideo is ever called.
    // Without an outer boundary this is an uncaught rejection, breaking the
    // "returns a result, never throws" contract every other failure path
    // in this module (and its sibling resolveVideoTool) honours.
    analyzeMock.mockResolvedValue(manifest());
    const parent = mkdtempSync(join(tmpdir(), 'norma-at-'));
    const notADir = join(parent, 'blocked');
    writeFileSync(notADir, 'i am a file, not a directory');
    const r = await analyzeVideoTool({ pathOrUrl: 'https://x/v', destinationPath: notADir });
    expect(r.status).not.toBe('ok');
    expect(typeof r.manifestPath).toBe('string');
    expect(r.videoPath).toBeUndefined();
  });

  it('returns a structured failure instead of throwing when analyzeVideo itself rejects unexpectedly', async () => {
    // The real analyzeVideo never rejects (src/analyze.ts wraps its whole
    // body in try/catch and always resolves to a Manifest) -- but this
    // handler must not simply trust that forever. A mocked rejection
    // stands in for "something inside the attempt threw" generally,
    // proving the outer boundary catches it rather than propagating an
    // unhandled rejection to the caller.
    analyzeMock.mockRejectedValue(new Error('pipeline exploded'));
    const dir = mkdtempSync(join(tmpdir(), 'norma-at-'));
    const r = await analyzeVideoTool({ pathOrUrl: 'https://x/v', destinationPath: dir });
    expect(r.status).not.toBe('ok');
    expect(r.reason).toContain('pipeline exploded');
    expect(r.videoPath).toBeUndefined();
  });

  it('reports degradation warnings so silent failure is visible', async () => {
    analyzeMock.mockResolvedValue(manifest({
      processing: { selectedFrames: 1, candidateFrames: 3, peakRssMb: 100, selectorVersion: '1', frameMode: 'key', warnings: ['ocr unavailable'] },
    }));
    const dir = mkdtempSync(join(tmpdir(), 'norma-at-'));
    const r = await analyzeVideoTool({ pathOrUrl: 'https://x/v', destinationPath: dir });
    expect(r.warnings).toEqual(['ocr unavailable']);
  });

  it('omits transcriptPath entirely when no transcript was produced', async () => {
    analyzeMock.mockResolvedValue(manifest({ transcript: null }));
    const dir = mkdtempSync(join(tmpdir(), 'norma-at-'));
    const r = await analyzeVideoTool({ pathOrUrl: 'https://x/v', destinationPath: dir });
    expect(r.transcriptPath).toBeUndefined();
  });

  it('does not copy a local source into destinationPath (spec §2.1)', async () => {
    // A clip the agent already placed must not be duplicated: videoPath
    // points at the existing file, and no copy of it appears alongside
    // the manifest. Catches an implementation that copies unconditionally.
    const src = mkdtempSync(join(tmpdir(), 'norma-src-'));
    const local = join(src, 'clip.mp4');
    writeFileSync(local, 'not-real-video');
    analyzeMock.mockResolvedValue(manifest({
      source: { url: local, platform: 'local', title: 'T', duration: 10, resolvedBy: 'direct', status: 'ok', filePath: local },
    }));
    const dir = mkdtempSync(join(tmpdir(), 'norma-at-'));
    const r = await analyzeVideoTool({ pathOrUrl: local, destinationPath: dir });
    expect(r.videoPath).toBe(local);
    expect(readdirSync(dir).filter((f) => f.endsWith('.mp4'))).toEqual([]);
  });

  it("keeps analyzeVideo's own working directory out of destinationPath for a local source (spec §2.1)", async () => {
    // analyzeVideo's normalize() step (src/media/ffmpeg.ts) unconditionally
    // writes a re-encoded working copy into whatever outDir it receives
    // (src/analyze.ts passes opts.outDir straight through as workDir).
    // Passing destinationPath as outDir for an already-local source would
    // put that re-encoded copy directly in the deliverable directory --
    // exactly the duplication spec §2.1 forbids -- even though the tool
    // itself never calls copyFileSync. Because analyzeVideo is mocked here
    // and never really runs normalize(), readdirSync(dir) alone cannot
    // observe this; only the options passed to analyzeVideo can prove the
    // fix is in place.
    const src = mkdtempSync(join(tmpdir(), 'norma-src-'));
    const local = join(src, 'clip.mp4');
    writeFileSync(local, 'not-real-video');
    analyzeMock.mockResolvedValue(manifest({
      source: { url: local, platform: 'local', title: 'T', duration: 10, resolvedBy: 'direct', status: 'ok', filePath: local },
    }));
    const dir = mkdtempSync(join(tmpdir(), 'norma-at-'));
    await analyzeVideoTool({ pathOrUrl: local, destinationPath: dir });
    const opts = analyzeMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(opts.outDir).not.toBe(dir);
  });

  it('relocates frame thumbnails into destinationPath for a local source, without duplicating the video (spec §2.1)', async () => {
    // Frames are new artifacts analyzeVideo just generated (not a copy of
    // the source), so they belong in destinationPath regardless of where
    // the source came from -- the "not a duplicate of the video" rule
    // applies only to the video itself. Since outDir is deliberately kept
    // away from destinationPath for a local source (previous test), frames
    // land in analyzeVideo's own private working directory unless this
    // handler relocates them itself.
    const src = mkdtempSync(join(tmpdir(), 'norma-src-'));
    const local = join(src, 'clip.mp4');
    writeFileSync(local, 'not-real-video');
    const workDir = mkdtempSync(join(tmpdir(), 'norma-work-'));
    const framePath = join(workDir, 'f1.jpg');
    writeFileSync(framePath, 'not-real-jpeg');
    analyzeMock.mockResolvedValue(manifest({
      source: { url: local, platform: 'local', title: 'T', duration: 10, resolvedBy: 'direct', status: 'ok', filePath: local },
      frames: [{ timestamp: 1, sceneId: 0, image: framePath, importance: 0.5, reasons: [], ocrContent: null, transcriptWindow: null, nearestSelectedSimilarity: 0 }],
    }));
    const dir = mkdtempSync(join(tmpdir(), 'norma-at-'));
    const r = await analyzeVideoTool({ pathOrUrl: local, destinationPath: dir });
    const expectedFrame = join(dir, 'f1.jpg');
    expect(r.framePaths).toEqual([expectedFrame]);
    expect(existsSync(expectedFrame)).toBe(true);
    expect(existsSync(framePath)).toBe(false);
    const saved = JSON.parse(readFileSync(r.manifestPath, 'utf8'));
    expect(saved.frames[0].image).toBe(expectedFrame);
  });

  it('cleans up analyzeVideo\'s orphaned working copy for a local source, without ever touching the caller\'s own file (Fix 6, deferred #18 leak half)', async () => {
    // frameMode 'key' means analyzeVideo's own manifest.source.filePath
    // points at its private, ephemeral re-encoded copy (work.mp4) -- a REAL
    // file here, standing in for what normalizeVideo() actually produces.
    // The rewrite above replaces source.filePath with args.pathOrUrl
    // (`local`), so nothing in the final reply/manifest references the
    // ephemeral copy any more once this call returns -- exactly the leak
    // deferred #18 describes ("every local analyze_video call leaves a full
    // re-encode... behind"). local !== ephemeralCopy is the load-bearing
    // part of this fixture: an implementation that deleted based on `local`
    // alone (not on whether the path actually changed) would ALSO destroy
    // the caller's own file whenever frameMode wasn't 'key' and filePath
    // already equalled pathOrUrl -- see the companion test below.
    const src = mkdtempSync(join(tmpdir(), 'norma-src-'));
    const local = join(src, 'clip.mp4');
    writeFileSync(local, 'the-callers-own-video-bytes');
    const workDir = mkdtempSync(join(tmpdir(), 'norma-work-'));
    const ephemeralCopy = join(workDir, 'work.mp4');
    writeFileSync(ephemeralCopy, 'analyzeVideos-own-reencoded-copy');
    analyzeMock.mockResolvedValue(manifest({
      source: { url: local, platform: 'local', title: 'T', duration: 10, resolvedBy: 'direct', status: 'ok', filePath: ephemeralCopy },
    }));
    const dir = mkdtempSync(join(tmpdir(), 'norma-at-'));
    const r = await analyzeVideoTool({ pathOrUrl: local, destinationPath: dir });
    expect(r.status).toBe('ok');
    expect(r.videoPath).toBe(local);
    expect(existsSync(local)).toBe(true);
    expect(existsSync(ephemeralCopy)).toBe(false);
  });

  it('does NOT delete the caller\'s own file when analyzeVideo already reports it verbatim as filePath (regression guard for the fix above)', async () => {
    // The companion/negative case: when analyzeVideo's own filePath ALREADY
    // equals pathOrUrl (the common case for 'even'/'none' frame modes, or
    // any local source resolve() passes straight through unchanged), the
    // cleanup must be a no-op -- deleting it here would destroy the file the
    // reply itself points at, reintroducing a Fix-1-shaped data-loss bug
    // through Fix 6 instead.
    const src = mkdtempSync(join(tmpdir(), 'norma-src-'));
    const local = join(src, 'clip.mp4');
    writeFileSync(local, 'the-callers-own-video-bytes');
    analyzeMock.mockResolvedValue(manifest({
      source: { url: local, platform: 'local', title: 'T', duration: 10, resolvedBy: 'direct', status: 'ok', filePath: local },
    }));
    const dir = mkdtempSync(join(tmpdir(), 'norma-at-'));
    const r = await analyzeVideoTool({ pathOrUrl: local, destinationPath: dir });
    expect(r.status).toBe('ok');
    expect(r.videoPath).toBe(local);
    expect(existsSync(local)).toBe(true);
  });
});
