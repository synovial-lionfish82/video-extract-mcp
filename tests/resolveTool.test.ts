import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

const resolveMock = vi.fn();
vi.mock('../src/resolve/index.js', () => ({ resolve: (...a: unknown[]) => resolveMock(...a) }));
const { resolveVideoTool } = await import('../src/agent/resolveTool.js');
afterEach(() => resolveMock.mockReset());

/**
 * resolveVideoTool gates the video move on existsSync(r.filePath) -- a
 * defensive check (resolve()'s own contract promises a real file whenever
 * status is 'ok', mirroring the existsSync guards analyze.ts already uses
 * around res.captions.*.path). A fixture pointing at a nonexistent path
 * (e.g. a bare '/x/source.mp4' literal) silently short-circuits that guard:
 * videoPath, note and the clip filename all end up computed against a file
 * that was never there, so any test relying on them passes for the wrong
 * reason -- it cannot tell a correct implementation from a broken one.
 * Verified empirically: the brief's own literal reference implementation,
 * run against its own literal fixture, fails "warns that a clipped file
 * starts at zero" (r.note is undefined) for exactly this reason -- see
 * task-6-report.md. A real file avoids the trap.
 */
function realSourceFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'norma-src-'));
  const p = join(dir, 'source.mp4');
  writeFileSync(p, 'fake-video-bytes');
  return p;
}

const ok = (over: Record<string, unknown> = {}) => ({
  status: 'ok', filePath: realSourceFile(), platform: 'youtube', title: 'T',
  duration: 100, resolvedBy: 'ytdlp', captions: { manual: null, auto: null },
  languageHint: null, rangeApplied: false,
  metadata: {
    title: 'T', creator: 'C', duration: 100,
    chapters: [{ start: 0, end: 12, title: 'Intro' }],
    description: 'z'.repeat(400), uploadDate: null, viewCount: 9, commentCount: 3,
  },
  ...over,
});

describe('resolveVideoTool', () => {
  it('does not fetch media by default (spec §2.1)', async () => {
    // Mutation 1: media fetched by default rather than only on request.
    // Kills any implementation that hardcodes returnVideo:true downstream,
    // or that defaults args.returnVideo to true.
    resolveMock.mockResolvedValue(ok());
    const dir = mkdtempSync(join(tmpdir(), 'norma-rt-'));
    const r = await resolveVideoTool({ url: 'https://x/v', destinationPath: dir });
    expect(resolveMock.mock.calls[0]![1]).toMatchObject({ returnVideo: false });
    expect(r.videoPath).toBeUndefined();
  });

  it('tells the agent both ways forward when it withheld the media', async () => {
    // Mutation 2 (direction A): nextSteps missing when the media WAS withheld.
    resolveMock.mockResolvedValue(ok());
    const dir = mkdtempSync(join(tmpdir(), 'norma-rt-'));
    const r = await resolveVideoTool({ url: 'https://x/v', destinationPath: dir });
    expect(r.nextSteps).toMatch(/returnVideo/);
    expect(r.nextSteps).toMatch(/analyze_video/);
  });

  it('omits next-steps guidance once the media has been fetched', async () => {
    // Mutation 2 (direction B): nextSteps appearing even though the media WAS fetched.
    resolveMock.mockResolvedValue(ok());
    const dir = mkdtempSync(join(tmpdir(), 'norma-rt-'));
    const r = await resolveVideoTool({ url: 'https://x/v', destinationPath: dir, returnVideo: true });
    expect(r.nextSteps).toBeUndefined();
  });

  it('surfaces title, creator, duration and chapters inline', async () => {
    resolveMock.mockResolvedValue(ok());
    const dir = mkdtempSync(join(tmpdir(), 'norma-rt-'));
    const r = await resolveVideoTool({ url: 'https://x/v', destinationPath: dir });
    expect(r.title).toBe('T');
    expect(r.creator).toBe('C');
    expect(r.duration).toBe(100);
    expect(r.chapters).toEqual([{ start: 0, end: 12, title: 'Intro' }]);
  });

  it('sends only a preview inline and the full description to the file', async () => {
    // Mutation 3: the full description leaking into the inline reply.
    resolveMock.mockResolvedValue(ok());
    const dir = mkdtempSync(join(tmpdir(), 'norma-rt-'));
    const r = await resolveVideoTool({ url: 'https://x/v', destinationPath: dir });
    expect(r.descriptionPreview!.length).toBeLessThanOrEqual(126);
    const saved = JSON.parse(readFileSync(r.metadataPath, 'utf8'));
    expect(saved.description).toHaveLength(400);
  });

  it('never returns comments inline, only their count (spec §2.1)', async () => {
    // Mutation 4: comments appearing inline rather than only in the metadata
    // file. Strengthened beyond the brief's version: the brief's own `ok()`
    // fixture never populates metadata.comments, so JSON.stringify(r) could
    // never contain "comments" either way -- even a mutant that spreads
    // `comments: r.metadata?.comments` inline would stringify to nothing
    // (JSON.stringify drops undefined-valued keys), so that version of the
    // test cannot discriminate. Giving the fixture REAL comment content
    // closes that gap in both directions: absent inline, present in the file.
    const richComments = [
      { id: '1', text: 'nice video, thanks!' },
      { id: '2', text: 'great content, subscribed' },
    ];
    resolveMock.mockResolvedValue(ok({
      metadata: {
        title: 'T', creator: 'C', duration: 100,
        chapters: [{ start: 0, end: 12, title: 'Intro' }],
        description: 'z'.repeat(400), uploadDate: null, viewCount: 9, commentCount: 3,
        comments: richComments,
      },
    }));
    const dir = mkdtempSync(join(tmpdir(), 'norma-rt-'));
    const r = await resolveVideoTool({ url: 'https://x/v', destinationPath: dir, comments: true });
    expect(r.commentCount).toBe(3);
    expect(JSON.stringify(r)).not.toContain('nice video');
    expect(JSON.stringify(r)).not.toContain('"comments"');
    const saved = JSON.parse(readFileSync(r.metadataPath, 'utf8'));
    expect(saved.comments).toEqual(richComments);
  });

  it('warns that a clipped file starts at zero (spec §5.1)', async () => {
    // Mutation 5 (direction A): the note missing when a range WAS applied.
    // Also confirms the video is actually saved under the range-encoded
    // filename (spec §7), not just that a truthy string exists.
    resolveMock.mockResolvedValue(ok({ clipStart: 724, clipEnd: 1200 }));
    const dir = mkdtempSync(join(tmpdir(), 'norma-rt-'));
    const r = await resolveVideoTool({
      url: 'https://x/v', destinationPath: dir, returnVideo: true, start: 724, end: 1200,
    });
    expect(r.note).toMatch(/starts at 0|begins at zero/i);
    expect(r.note).toContain('724');
    expect(r.videoPath).toBeDefined();
    expect(existsSync(r.videoPath!)).toBe(true);
    expect(basename(r.videoPath!)).toBe('source_s724_e1200.mp4');
  });

  it('omits the clip-offset note when a range was requested but not applied (spec §5.1)', async () => {
    // Mutation 5 (direction B) -- the one the brief's own test 7 cannot
    // catch. The caller still asks for start:724/end:1200, but the mocked
    // resolve() reports NO clipStart/clipEnd (rangeApplied stays false,
    // exactly as ytdlp.ts leaves it when --download-sections did not take,
    // or as any source that only supports full-then-trim can leave it).
    // args.start/args.end and r.clipStart/r.clipEnd DISAGREE here, so this
    // is the only test that can tell apart an implementation keyed off the
    // caller's request from one keyed off what the resolver actually did.
    // Two independent things must both key off r.clipStart, not args: the
    // note's gating, AND mediaFileName's arguments (an implementation that
    // names the file via args.start/args.end would produce
    // "source_s724_e1200.mp4" for what is actually the untrimmed full
    // video -- precisely the §7 collision the design calls out).
    resolveMock.mockResolvedValue(ok());
    const dir = mkdtempSync(join(tmpdir(), 'norma-rt-'));
    const r = await resolveVideoTool({
      url: 'https://x/v', destinationPath: dir, returnVideo: true, start: 724, end: 1200,
    });
    expect(r.note).toBeUndefined();
    expect(r.clipStart).toBeUndefined();
    expect(r.clipEnd).toBeUndefined();
    expect(r.videoPath).toBeDefined();
    expect(basename(r.videoPath!)).toBe('source.mp4');
  });

  it('returns a failure shape without throwing', async () => {
    // Mutation 6: a failure status throwing instead of returning a
    // structured result. Also checks nextSteps stays absent on failure --
    // telling the agent to retry with returnVideo:true after a DRM failure
    // would be actively misleading.
    resolveMock.mockResolvedValue({ status: 'unsupported', reason: 'drm_protected', message: 'DRM-protected media' });
    const dir = mkdtempSync(join(tmpdir(), 'norma-rt-'));
    const r = await resolveVideoTool({ url: 'https://x/v', destinationPath: dir });
    expect(r.status).toBe('unsupported');
    expect(r.videoPath).toBeUndefined();
    expect(r.nextSteps).toBeUndefined();
  });

  it('surfaces the categorical failure reason and records the url alongside it', async () => {
    // Documents a deliberate, small deviation from the brief's reference
    // (which set ResolveToolResult.reason to r.message, discarding r.reason
    // entirely): fold r.reason first, matching the precedent already set at
    // analyze.ts:86 (`typeof res.reason === 'string' ? res.reason : res.message`),
    // and include the url in the failure metadata file since ResolveFailure
    // itself carries no url to correlate the failure record back to it.
    resolveMock.mockResolvedValue({ status: 'unsupported', reason: 'drm_protected', message: 'DRM-protected media' });
    const dir = mkdtempSync(join(tmpdir(), 'norma-rt-'));
    const r = await resolveVideoTool({ url: 'https://x/v', destinationPath: dir });
    expect(r.reason).toBe('drm_protected');
    const saved = JSON.parse(readFileSync(r.metadataPath, 'utf8'));
    expect(saved.url).toBe('https://x/v');
  });

  it('writes metadata even on the metadata-only path', async () => {
    resolveMock.mockResolvedValue(ok());
    const dir = mkdtempSync(join(tmpdir(), 'norma-rt-'));
    const r = await resolveVideoTool({ url: 'https://x/v', destinationPath: dir });
    expect(existsSync(r.metadataPath)).toBe(true);
  });
});
