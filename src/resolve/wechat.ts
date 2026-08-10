import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import type { VideoResolver, ResolveOptions, ResolveResult, ResolveFailure } from '../types.js';
import { probe } from '../media/ffmpeg.js';

/**
 * WeChat Channels (视频号) headless resolver.
 *
 * Ported from the verified clean-room implementation at
 * experiments/wechat-clean-room/src/wechatResolver.ts (see PROTOCOL.md / FINDINGS.md there for
 * the full derivation). experiments/ is gitignored, so this file does NOT import from it --
 * this is a first-class re-implementation against Norma's own src/types.ts contracts.
 *
 * VERIFIED FLOW (all requests: Content-Type: application/json, X-Source: web,
 * Cookie: <yuanbao session>, plus Origin/Referer/UA):
 *   1. GET  /api/getuserinfo                                   -> HTTP 200 means cookie valid.
 *   2. POST /api/weixin/get_parse_result  {type:"video_channel_url", url, scene:1}
 *        -> data.wx_export_id
 *   3. POST /api/findergetobjecturl       {exportId:<string>}   SINGULAR string -- the
 *        {exportIds:[...]} array form fails with business-code 500.
 *        -> videoUrl, a direct MP4.
 * The resulting media URL is self-authenticated (token/sign query params): no cookie is needed
 * to download it, so a plain fetch works, exactly like DirectMediaResolver.
 */

/** Internal states from spec §7.1, mapped onto Norma's external ResolveStatus (spec §6):
 *  resolved -> ok, auth_required -> auth_required, auth_expired -> auth_expired,
 *  unsupported_link -> unsupported (reason: 'unsupported_link'). 'ready' is a pre-flight state,
 *  not a terminal one. This type documents the mapping; it is not threaded through ResolveResult. */
export type WeChatState = 'ready' | 'auth_required' | 'auth_expired' | 'unsupported_link' | 'resolved';

const WECHAT_HOST = /(^|\.)(weixin\.qq\.com|channels\.weixin\.qq\.com)$/i;

export function getCredential(): string | null {
  // Injected only; never hardcoded, never logged (spec §7.2).
  return process.env.NORMA_WECHAT_COOKIE?.trim() || null;
}

// ---------------------------------------------------------------------------
// Share-link recognition (ported; verified 301-redirect shape -- PROTOCOL.md §1)
// ---------------------------------------------------------------------------

const SPH_PATH_RE = /^\/sph\/([A-Za-z0-9_-]+)/;

export interface ParsedShareLink { shareId: string; previewUrl: string; }

/**
 * Recognise a WeChat Channels share link and extract its "sph" share id, for display/logging
 * purposes only -- the resolve POST sends the raw url, not this id, so this is NOT a gate on
 * canResolve() or resolve(): canResolve() intentionally accepts any weixin/channels host (a
 * feed link like channels.weixin.qq.com/web/pages/feed?... has no /sph/ path yet is still a
 * real Channels URL), and resolve() lets Tencent's own parse endpoint decide what is resolvable.
 */
export function parseShareLink(rawUrl: string): ParsedShareLink | null {
  let u: URL;
  try {
    u = new URL(rawUrl.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (!WECHAT_HOST.test(u.hostname)) return null;

  // Form 1 (verified): https://weixin.qq.com/sph/<id>
  const idFromPath = SPH_PATH_RE.exec(u.pathname)?.[1];
  if (idFromPath) return { shareId: idFromPath, previewUrl: previewUrlFor(idFromPath) };

  // Form 2 (verified): https://channels.weixin.qq.com/finder-preview/pages/sph?id=<id>
  const idFromQuery = u.searchParams.get('id');
  if (idFromQuery && /^[A-Za-z0-9_-]+$/.test(idFromQuery) && u.pathname.includes('/sph')) {
    return { shareId: idFromQuery, previewUrl: previewUrlFor(idFromQuery) };
  }
  return null;
}

function previewUrlFor(shareId: string): string {
  return `https://channels.weixin.qq.com/finder-preview/pages/sph?id=${encodeURIComponent(shareId)}`;
}

// ---------------------------------------------------------------------------
// Wire protocol (verified endpoints/headers/body shapes)
// ---------------------------------------------------------------------------

const YUANBAO = 'https://yuanbao.tencent.com';
const USER_INFO_URL = `${YUANBAO}/api/getuserinfo`;
const PARSE_URL = `${YUANBAO}/api/weixin/get_parse_result`;
const OBJECT_URL_URL = `${YUANBAO}/api/findergetobjecturl`;
const X_SOURCE = 'web';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const REQUEST_TIMEOUT_MS = 15_000;

type ApiResult = { ok: true; httpStatus: number; json: unknown } | { ok: false; error: string };

/** POSTs JSON when `body` is given, otherwise GETs. Never throws -- network errors come back
 *  as { ok: false }, matching the "resolve() must never throw" contract for this resolver. */
async function callApi(url: string, cookie: string, body?: unknown): Promise<ApiResult> {
  try {
    const headers: Record<string, string> = {
      Accept: 'application/json, text/plain, */*',
      'X-Source': X_SOURCE,
      Origin: YUANBAO,
      Referer: `${YUANBAO}/`,
      'User-Agent': USER_AGENT,
      Cookie: cookie,
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body; treat as no data */ }
    return { ok: true, httpStatus: res.status, json };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ---------------------------------------------------------------------------
// Response classification (ported; verified 401/403 + inferred keyword fallbacks --
// PROTOCOL.md §6. The credential itself is never part of any response body, so none of this
// can leak it.)
// ---------------------------------------------------------------------------

type BusinessClass = 'auth' | 'unsupported' | 'not_found' | null;

const AUTH_HINT_RE = /(get\s*token\s*err|token|登录|未登录|登陆|not\s*login|unauthorized|no\s*login|invalid\s*session|请先登录|重新登录)/i;
const UNSUPPORTED_HINT_RE = /(直播|live\b|回放|replay|不支持|unsupported|无法解析|cannot\s*parse|已下架|已删除|removed|deleted|违规)/i;
const NOTFOUND_HINT_RE = /(不存在|not\s*found|无效|expired|已过期|失效|404)/i;

function extractErrorMessage(json: unknown): string | null {
  if (json && typeof json === 'object') {
    const rec = json as Record<string, unknown>;
    if (rec.error && typeof rec.error === 'object') {
      const msg = (rec.error as Record<string, unknown>).message;
      if (typeof msg === 'string') return msg;
    }
    const topMsg = rec.message ?? rec.msg;
    if (typeof topMsg === 'string') return topMsg;
  }
  return null;
}

/** Classify a response into an auth / unsupported / not_found bucket, or null (no error). */
export function classifyBusinessError(json: unknown, httpStatus: number): BusinessClass {
  if (httpStatus === 401 || httpStatus === 403) return 'auth';
  if (httpStatus === 404) return 'not_found';
  const msg = extractErrorMessage(json);
  if (msg) {
    if (/^success$/i.test(msg.trim())) return null; // "success" must never look like an error.
    if (AUTH_HINT_RE.test(msg)) return 'auth';
    if (UNSUPPORTED_HINT_RE.test(msg)) return 'unsupported';
    if (NOTFOUND_HINT_RE.test(msg)) return 'not_found';
  }
  return null;
}

function businessFailure(cls: BusinessClass): ResolveFailure | null {
  if (cls === 'auth') {
    return {
      status: 'auth_expired', resolvedBy: 'wechat',
      message: 'WeChat session credential was rejected. Re-run the activation to refresh it.',
    };
  }
  if (cls === 'unsupported') {
    return {
      status: 'unsupported', reason: 'unsupported_link', resolvedBy: 'wechat',
      message: 'This share link is not a resolvable on-demand video (e.g. live or replay).',
    };
  }
  if (cls === 'not_found') {
    return {
      status: 'not_found', resolvedBy: 'wechat',
      message: 'The shared video does not exist or has expired.',
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Field extraction (ported; verified field names -- PROTOCOL.md §4)
// ---------------------------------------------------------------------------

function firstString(obj: unknown, keys: string[]): string | undefined {
  if (!obj || typeof obj !== 'object') return undefined;
  const rec = obj as Record<string, unknown>;
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

/** Unwrap the common { data: {...} } envelope, else return the object itself. */
function dataOf(json: unknown): Record<string, unknown> {
  if (json && typeof json === 'object') {
    const rec = json as Record<string, unknown>;
    if (rec.data && typeof rec.data === 'object') return rec.data as Record<string, unknown>;
    return rec;
  }
  return {};
}

interface ParsedExport { exportId: string; title?: string; author?: string; }

/** Verified shape: { code:0, data:{ wx_export_id, author, desc, cover_url, playable_url } }.
 *  A missing/empty wx_export_id means the shared video is unavailable to this account. */
function extractParsedExport(json: unknown): ParsedExport | null {
  const d = dataOf(json);
  const exportId = firstString(d, ['wx_export_id', 'exportId', 'export_id']);
  if (!exportId) return null;
  const title = firstString(d, ['desc', 'title', 'objectDesc']);
  const author = firstString(d, ['author', 'nickname', 'authorName']);
  return { exportId, title, author };
}

const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp|bmp|svg|ico)(\?|$)/i;
const VIDEO_EXT_RE = /\.(mp4|m3u8|ts|mov|m4v|flv)(\?|$)/i;
const VIDEO_HOST_RE = /(finder\.video\.qq\.com|\.video\.qq\.com|\.tc\.qq\.com|mmfinder|szextshort)/i;

function looksLikeMediaUrl(s: string): boolean {
  if (!/^https?:\/\//i.test(s)) return false;
  if (IMAGE_EXT_RE.test(s)) return false;
  // finder.video.qq.com/.../stodownload?... has no file extension, so accept by host too.
  return VIDEO_EXT_RE.test(s) || VIDEO_HOST_RE.test(s);
}

/** Verified shape: { videoUrl:"https://finder.video.qq.com/.../stodownload?...", authIconUrl }. */
function extractVideoUrl(json: unknown): string | null {
  if (json && typeof json === 'object') {
    const rec = json as Record<string, unknown>;
    const direct = firstString(rec, ['videoUrl', 'video_url', 'url']);
    if (direct && looksLikeMediaUrl(direct)) return direct;
    const nested = firstString(dataOf(json), ['videoUrl', 'video_url', 'url']);
    if (nested && looksLikeMediaUrl(nested)) return nested;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The resolver
// ---------------------------------------------------------------------------

export class WeChatHeadlessResolver implements VideoResolver {
  readonly name = 'wechat';

  canResolve(url: string): boolean {
    try { return WECHAT_HOST.test(new URL(url).hostname); } catch { return false; }
  }

  async resolve(url: string, opts: ResolveOptions): Promise<ResolveResult> {
    if (!this.canResolve(url)) {
      return {
        status: 'unsupported', reason: 'unsupported_link', resolvedBy: 'wechat',
        message: 'Not a WeChat Channels (视频号) share link.',
      };
    }

    const cookie = getCredential();
    if (!cookie) {
      return {
        status: 'auth_required', resolvedBy: 'wechat',
        message: 'WeChat extraction not activated. Run the one-time activation to store a session credential.',
      };
    }

    // Stage 1 (verified): probe credential validity before spending a resolve call on it.
    // A network hiccup on the probe itself is non-fatal -- fall through to the real calls.
    const probeRes = await callApi(USER_INFO_URL, cookie);
    if (probeRes.ok && classifyBusinessError(probeRes.json, probeRes.httpStatus) === 'auth') {
      return {
        status: 'auth_expired', resolvedBy: 'wechat',
        message: 'WeChat session credential was rejected by getuserinfo. Re-run the activation to refresh it.',
      };
    }

    // Stage 2 (verified): parse the share link into a finder export id.
    const parseRes = await callApi(PARSE_URL, cookie, { type: 'video_channel_url', url, scene: 1 });
    if (!parseRes.ok) {
      return { status: 'extractor_failed', resolvedBy: 'wechat', message: `Network error contacting WeChat resolver: ${parseRes.error}` };
    }
    const parseFailure = businessFailure(classifyBusinessError(parseRes.json, parseRes.httpStatus));
    if (parseFailure) return parseFailure;

    const parsedExport = extractParsedExport(parseRes.json);
    if (!parsedExport) {
      return {
        status: 'not_found', resolvedBy: 'wechat',
        message: 'WeChat resolver returned no export id -- the shared video is unavailable (removed, private, or expired).',
      };
    }

    // Stage 3 (verified): export id -> direct media URL. exportId MUST be a singular string;
    // the {exportIds:[...]} array form fails with business-code 500.
    const objRes = await callApi(OBJECT_URL_URL, cookie, { exportId: parsedExport.exportId });
    if (!objRes.ok) {
      return { status: 'extractor_failed', resolvedBy: 'wechat', message: `Network error contacting WeChat resolver: ${objRes.error}` };
    }
    const objFailure = businessFailure(classifyBusinessError(objRes.json, objRes.httpStatus));
    if (objFailure) return objFailure;

    const mediaUrl = extractVideoUrl(objRes.json);
    if (!mediaUrl) {
      return {
        status: 'extractor_failed', resolvedBy: 'wechat',
        message: 'WeChat resolver reached the object-url endpoint but returned no media URL.',
      };
    }

    const shareId = parseShareLink(url)?.shareId;
    const title = parsedExport.title || parsedExport.author || (shareId ? `WeChat video ${shareId}` : 'WeChat video');
    return this.download(mediaUrl, opts, title);
  }

  /** Stage 4 (verified): the media URL is self-authenticated (token+sign) -- no cookie needed.
   *  Downloads exactly like DirectMediaResolver so downstream code sees a local file either way. */
  private async download(mediaUrl: string, opts: ResolveOptions, title: string): Promise<ResolveResult> {
    const out = join(opts.workDir, 'source.mp4');
    try {
      const res = await fetch(mediaUrl);
      if (res.status === 404) {
        return { status: 'not_found', resolvedBy: 'wechat', message: 'Media URL returned HTTP 404.' };
      }
      if (!res.ok || !res.body) {
        // Not auth_required/auth_expired: the yuanbao cookie does not apply to this URL (it is
        // self-authenticated by its own token+sign params), so re-authenticating would not help.
        // A failure here more likely means the token/sign expired between resolve and download.
        return { status: 'extractor_failed', resolvedBy: 'wechat', message: `HTTP ${res.status} downloading media` };
      }
      await pipeline(Readable.fromWeb(res.body as never), createWriteStream(out));
      const p = await probe(out);
      return {
        status: 'ok', filePath: out, platform: 'wechat_channels', title, duration: p.duration,
        resolvedBy: 'wechat', captions: { manual: null, auto: null }, languageHint: null,
        rangeApplied: false,
      };
    } catch (e) {
      return { status: 'extractor_failed', resolvedBy: 'wechat', message: `Failed to download media: ${(e as Error).message}` };
    }
  }
}
