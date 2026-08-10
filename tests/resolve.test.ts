import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { classifyYtDlpError, pickResolver } from '../src/resolve/index.js';
import { DirectMediaResolver } from '../src/resolve/direct.js';
import { YtDlpResolver } from '../src/resolve/ytdlp.js';
import { WeChatHeadlessResolver, parseShareLink, classifyBusinessError } from '../src/resolve/wechat.js';

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
