import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyYtDlpError, pickResolver } from '../src/resolve/index.js';
import { DirectMediaResolver } from '../src/resolve/direct.js';
import { YtDlpResolver } from '../src/resolve/ytdlp.js';
import {
  WeChatHeadlessResolver, parseShareLink, classifyBusinessError, businessFailure,
} from '../src/resolve/wechat.js';
import { makeTestVideo } from '../src/media/ffmpeg.js';

describe('classifyYtDlpError', () => {
  it('maps DRM messages to unsupported/drm_protected', () => {
    const f = classifyYtDlpError('ERROR: This video is DRM protected');
    expect(f.status).toBe('unsupported');
    expect(f.reason).toBe('drm_protected');
  });
  it('maps login walls to auth_required', () => {
    expect(classifyYtDlpError('ERROR: Sign in to confirm your age').status).toBe('auth_required');
    expect(classifyYtDlpError('ERROR: Private video. Please sign in').status).toBe('auth_required');
  });
  it('maps removed videos to not_found', () => {
    expect(classifyYtDlpError('ERROR: Video unavailable').status).toBe('not_found');
  });
  it('maps unsupported-URL/no-extractor messages to unsupported/extractor_unsupported', () => {
    // Distinct branch from the DRM case: a mapping that collapsed every non-auth/not_found
    // error into a single status (e.g. always extractor_failed) would fail this.
    const f = classifyYtDlpError('ERROR: Unsupported URL: https://example.com/weird');
    expect(f.status).toBe('unsupported');
    expect(f.reason).toBe('extractor_unsupported');
  });
  it('defaults to extractor_failed', () => {
    expect(classifyYtDlpError('ERROR: some new breakage').status).toBe('extractor_failed');
  });
});

describe('pickResolver dispatch order (spec §6)', () => {
  it('routes a bare .mp4 URL to the direct resolver', () => {
    expect(pickResolver('https://example.com/a/b.mp4')?.name).toBe('direct');
  });
  it('routes an HLS manifest to the direct resolver', () => {
    expect(pickResolver('https://example.com/stream.m3u8')?.name).toBe('direct');
  });
  it('routes a WeChat share link to the wechat resolver', () => {
    expect(pickResolver('https://weixin.qq.com/sph/Axv548mzBF')?.name).toBe('wechat');
  });
  it('routes everything else to yt-dlp', () => {
    expect(pickResolver('https://www.youtube.com/watch?v=abc')?.name).toBe('ytdlp');
    expect(pickResolver('https://www.tiktok.com/@x/video/123')?.name).toBe('ytdlp');
    expect(pickResolver('https://some-unknown-site.example/watch/9')?.name).toBe('ytdlp');
  });
});

describe('resolver canResolve predicates', () => {
  it('direct only claims media-ish URLs', () => {
    const d = new DirectMediaResolver();
    expect(d.canResolve('https://x.com/v.mp4')).toBe(true);
    expect(d.canResolve('https://youtube.com/watch?v=1')).toBe(false);
  });
  it('wechat claims weixin/channels hosts', () => {
    const w = new WeChatHeadlessResolver();
    expect(w.canResolve('https://weixin.qq.com/sph/abc')).toBe(true);
    expect(w.canResolve('https://channels.weixin.qq.com/web/pages/feed?x=1')).toBe(true);
    expect(w.canResolve('https://youtube.com/watch?v=1')).toBe(false);
  });
  it('ytdlp claims any http(s) URL as the catch-all', () => {
    expect(new YtDlpResolver().canResolve('https://anything.example/x')).toBe(true);
  });
});

describe('WeChatHeadlessResolver without credentials', () => {
  // Hermetic regardless of the ambient shell: without this, a developer machine or CI runner
  // that happens to export NORMA_WECHAT_COOKIE (e.g. for manual testing) would make this suite
  // silently start issuing real requests to yuanbao.tencent.com.
  beforeEach(() => { vi.stubEnv('NORMA_WECHAT_COOKIE', ''); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('returns auth_required rather than throwing', async () => {
    const w = new WeChatHeadlessResolver();
    const r = await w.resolve('https://weixin.qq.com/sph/abc', { workDir: '/tmp' });
    expect(r.status).toBe('auth_required');
  });
  it('rejects a non-WeChat URL as unsupported without ever reaching the credential check', async () => {
    // If the internal host guard were deleted, this would fall through to the same
    // auth_required path as every other WeChat URL, and this test would fail.
    const w = new WeChatHeadlessResolver();
    const r = await w.resolve('https://youtube.com/watch?v=1', { workDir: '/tmp' });
    expect(r.status).toBe('unsupported');
  });
});

describe('WeChat credential never leaks into a failure message', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('does not leak an embedded-newline-corrupted cookie into the returned failure message', async () => {
    // Synthetic, fake credential only -- NEVER a real one. A cookie corrupted by an ordinary
    // copy-paste (e.g. a multi-header clipboard block, or a .env value with an embedded
    // newline) is invalid as an HTTP header value. Node's fetch throws a TypeError whose
    // .message embeds the raw offending header value verbatim (reproduced locally against
    // Headers construction: `Headers.append: "<value>" is an invalid header value.`). That
    // message must never reach a returned ResolveFailure: src/types.ts's Manifest.source.reason
    // persists it to disk, and callers may log it.
    const marker = 'X-Evil-Injected-Header-MARKER';
    vi.stubEnv('NORMA_WECHAT_COOKIE', `sessionid=abc123\n${marker}: leaked`);
    const w = new WeChatHeadlessResolver();
    const r = await w.resolve('https://weixin.qq.com/sph/abc', { workDir: '/tmp' });
    expect(r.status).toBe('auth_required');
    if (r.status === 'ok') throw new Error('expected a failure, got ok');
    expect(r.message).not.toContain(marker);
    expect(r.message).not.toContain('sessionid=abc123');
  });
});

describe('WeChat helpers ported from the clean-room resolver (pure logic, no network)', () => {
  it('parseShareLink extracts the share id from a /sph/<id> link', () => {
    const p = parseShareLink('https://weixin.qq.com/sph/Azf0g96b4P');
    expect(p?.shareId).toBe('Azf0g96b4P');
  });
  it('parseShareLink rejects a non-WeChat URL', () => {
    expect(parseShareLink('https://youtube.com/watch?v=x')).toBeNull();
  });
  it('classifyBusinessError maps HTTP 401 to auth', () => {
    expect(classifyBusinessError({}, 401)).toBe('auth');
  });
  it('classifyBusinessError does not misclassify a success response as an error', () => {
    // Catches a classifier collapsed to "any message present => auth" (verified by mutation:
    // dropping the keyword-regex checks makes this and the not_found case below both return
    // 'auth' instead of null/'not_found').
    expect(classifyBusinessError({ code: 0, msg: 'success', data: {} }, 200)).toBeNull();
  });
  it('classifyBusinessError maps a not-found-shaped message to not_found', () => {
    expect(classifyBusinessError({ msg: '视频不存在' }, 200)).toBe('not_found');
  });
});

describe('businessFailure (pure logic, no network)', () => {
  // Direct, minimal-surface coverage of the exact mutation class flagged in review: swapping
  // the 'auth' and 'not_found' branch bodies. Each of these two assertions independently fails
  // under that swap (verified -- see task-5-report.md's mutation-proof section).
  it('maps auth to auth_expired', () => {
    expect(businessFailure('auth')?.status).toBe('auth_expired');
  });
  it('maps not_found to not_found', () => {
    expect(businessFailure('not_found')?.status).toBe('not_found');
  });
  it('maps unsupported to unsupported/unsupported_link', () => {
    const f = businessFailure('unsupported');
    expect(f?.status).toBe('unsupported');
    expect(f?.reason).toBe('unsupported_link');
  });
  it('maps null (no business error) to null', () => {
    // Catches a bug where the "no error" case is accidentally treated as a failure somewhere
    // (e.g. a fall-through default branch), which would make every successful stage 2/3 call
    // in resolve() incorrectly short-circuit into a failure.
    expect(businessFailure(null)).toBeNull();
  });
});

describe('WeChatHeadlessResolver.resolve() against a stubbed network (hermetic, no live calls)', () => {
  type FetchRoute = { test: (url: string) => boolean; respond: (init?: RequestInit) => Response };

  function stubFetchRoutes(routes: FetchRoute[]) {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = input.toString();
      const route = routes.find((r) => r.test(url));
      if (!route) throw new Error(`Unexpected stubbed fetch call: ${url}`);
      return route.respond(init);
    }));
  }
  const okUserInfo: FetchRoute = {
    test: (u) => u.includes('/api/getuserinfo'),
    respond: () => new Response('{}', { status: 200 }),
  };

  // A real, tiny, ffmpeg-generated MP4 -- NOT a fabricated/mocked probe() result. The success
  // test below downloads this through the real streamed-pipeline code path and hands it to the
  // real ffprobe binary via probe(), exactly like a genuine WeChat download would be validated.
  let fixtureVideo: Buffer;
  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'norma-wechat-fixture-'));
    const videoPath = await makeTestVideo(join(dir, 'fixture.mp4'), 3);
    fixtureVideo = readFileSync(videoPath);
  }, 30_000);

  let workDir: string;
  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'norma-wechat-work-'));
    vi.stubEnv('NORMA_WECHAT_COOKIE', 'sessionid=test-fixture-cookie');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('classifies an auth-rejected parse response as auth_expired (classifyBusinessError -> businessFailure wiring)', async () => {
    // Catches a bug where classifyBusinessError's result is computed but not actually threaded
    // into businessFailure at the resolve() call site (e.g. the return value is discarded, or
    // the wrong variable is passed).
    stubFetchRoutes([
      okUserInfo,
      { test: (u) => u.includes('/api/weixin/get_parse_result'),
        respond: () => new Response(JSON.stringify({ error: { message: 'get token err' } }), { status: 401 }) },
    ]);
    const r = await new WeChatHeadlessResolver().resolve('https://weixin.qq.com/sph/abc', { workDir });
    expect(r.status).toBe('auth_expired');
  });

  it('maps an empty wx_export_id to not_found', async () => {
    // Catches extractParsedExport treating an empty string as a present export id, or the
    // !parsedExport branch in resolve() being deleted or misrouted to a different status.
    stubFetchRoutes([
      okUserInfo,
      { test: (u) => u.includes('/api/weixin/get_parse_result'),
        respond: () => new Response(JSON.stringify({ code: 0, msg: 'success', data: { wx_export_id: '' } }), { status: 200 }) },
    ]);
    const r = await new WeChatHeadlessResolver().resolve('https://weixin.qq.com/sph/abc', { workDir });
    expect(r.status).toBe('not_found');
  });

  it('resolves end-to-end and sends step 2\'s wx_export_id back as the singular exportId in step 3', async () => {
    let capturedObjectUrlBody: unknown = null;
    stubFetchRoutes([
      okUserInfo,
      { test: (u) => u.includes('/api/weixin/get_parse_result'),
        respond: () => new Response(JSON.stringify({
          code: 0, msg: 'success', data: { wx_export_id: 'export/ABC123', author: 'Tester', desc: '' },
        }), { status: 200 }) },
      { test: (u) => u.includes('/api/findergetobjecturl'),
        respond: (init) => {
          capturedObjectUrlBody = init?.body ? JSON.parse(init.body as string) : null;
          return new Response(JSON.stringify({ videoUrl: 'https://finder.video.qq.com/x/stodownload?token=t' }), { status: 200 });
        } },
      { test: (u) => u.startsWith('https://finder.video.qq.com/'),
        respond: () => new Response(new Uint8Array(fixtureVideo), { status: 200, headers: { 'Content-Type': 'video/mp4' } }) },
    ]);

    const result = await new WeChatHeadlessResolver().resolve('https://weixin.qq.com/sph/abc', { workDir });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(existsSync(result.filePath)).toBe(true);
    expect(result.resolvedBy).toBe('wechat');
    expect(result.title).toBe('Tester');
    // The data handoff the two-step flow depends on: step 2's wx_export_id must be echoed back
    // as the SINGULAR `exportId` string in step 3 -- the {exportIds:[...]} array form is a
    // documented, previously-hit real bug (business-code 500 from findergetobjecturl).
    expect(capturedObjectUrlBody).toEqual({ exportId: 'export/ABC123' });
  });
});
