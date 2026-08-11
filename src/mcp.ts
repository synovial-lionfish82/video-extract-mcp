import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { analyzeVideo } from './analyze.js';
import { getFrame, getClip } from './primitives.js';
import { resolve } from './resolve/index.js';

export const TOOL_NAMES = ['analyze_video', 'resolve_video', 'get_frame', 'get_clip'] as const;

/**
 * Exposes the finished engine to AI agents over MCP. Built with
 * `registerTool` (not the older `tool(name, description, schema, handler)`
 * overload the brief's own sample used) -- that overload still exists on
 * this SDK version (1.30.0) and would compile, but its own JSDoc marks it
 * `@deprecated Use registerTool instead`, and `registerTool`'s config-object
 * form is what the SDK's README documents as the current way to register a
 * tool with a description, input schema and (optionally) annotations
 * together. See task-16-report.md for how this was verified against the
 * installed package's own .d.ts rather than assumed from the brief's sample.
 */
export function buildServer(): McpServer {
  const server = new McpServer(
    { name: 'norma-video', version: '0.1.0' },
    {
      instructions:
        'Video extraction for AI agents. Typical flow: call resolve_video first for a '
        + 'cheap upfront check (also returns a local filePath you can reuse). Call '
        + 'analyze_video for the real payload -- a transcript plus important, deduplicated '
        + 'keyframes. If the overview turns up something worth a closer look at a specific '
        + 'moment, call get_frame or get_clip against a local video file path (from '
        + "resolve_video's filePath -- analyze_video's manifest does not itself carry one) "
        + 'to inspect that moment densely instead of reprocessing the whole video.',
    },
  );

  server.registerTool(
    'analyze_video',
    {
      title: 'Analyze video',
      description:
        'Primary extraction tool: given one video URL, downloads and analyzes it end-to-end '
        + 'and returns a JSON manifest with the spoken/on-screen transcript (when available) '
        + 'plus a small set of important, deduplicated keyframes -- not every frame, just the '
        + 'ones that matter (scene changes, on-screen text, visual novelty). This can take '
        + 'anywhere from several seconds to a few minutes depending on video length, network '
        + 'speed and mode; a long wait does not mean it is stuck. On failure (private video, '
        + 'DRM-protected, unsupported site, not found, ...) this returns a manifest whose '
        + "source.status is not 'ok' with a human-readable reason, rather than throwing -- "
        + 'always check source.status before trusting the rest of the manifest. Each returned '
        + "frame's image field is a local file path on this machine, not a URL. This manifest "
        + 'does NOT include a reusable local path to the full source video -- call '
        + 'resolve_video first and keep its filePath if you will need get_frame/get_clip '
        + 'afterwards. Consider calling resolve_video first if you only need a cheap upfront '
        + 'check of whether a URL can be extracted at all.',
      inputSchema: {
        url: z.string().describe('Page or direct video URL to extract (e.g. a YouTube/TikTok/WeChat Channels link, or a direct .mp4/.m3u8 URL).'),
        start: z.number().optional().describe('Start second of the range to analyze -- provide together with end (start alone, or end alone, has no effect). Omit both to analyze the whole video.'),
        end: z.number().optional().describe('End second of the range to analyze -- see start.'),
        maxFrames: z.number().optional().default(35).describe('Maximum number of keyframes to return after deduplication. Default 35.'),
        preferredLanguage: z.string().optional().describe('Language hint for transcription/OCR, e.g. "zh", "ja", "en". Improves accuracy when the language is known but not otherwise detectable from the URL.'),
        mode: z.enum(['fast', 'accurate']).optional().default('accurate').describe('"accurate" (default): full quality pipeline. "fast": quicker, lower quality.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      const m = await analyzeVideo(args.url, args);
      return { content: [{ type: 'text', text: JSON.stringify(m, null, 2) }] };
    },
  );

  server.registerTool(
    'resolve_video',
    {
      title: 'Resolve video (cheap check)',
      description:
        'Cheap upfront check: resolves a URL to determine whether it can be extracted at all, '
        + 'without transcribing audio or scanning for keyframes -- much faster than '
        + 'analyze_video. On success, returns platform, title, duration, which captions '
        + '(manual/auto) are already available, and a local filePath to the downloaded source '
        + 'video on this machine. On failure, returns a specific status (e.g. '
        + "'auth_required', 'unsupported', 'not_found', 'needs_interaction') and a "
        + 'human-readable reason instead of throwing. Use this to fail fast on a bad link, to '
        + "decide whether analyze_video's slower full pipeline is worth running, or to obtain "
        + 'a local video file path to pass into get_frame/get_clip for direct frame-level '
        + 'inspection.',
      inputSchema: {
        url: z.string().describe('Page or direct video URL to check.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ url }) => {
      const r = await resolve(url, { workDir: mkdtempSync(join(tmpdir(), 'norma-res-')) });
      return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
    },
  );

  server.registerTool(
    'get_frame',
    {
      title: 'Get one frame',
      description:
        'Extracts a single frame at an exact timestamp from a video file ALREADY DOWNLOADED '
        + 'TO THIS MACHINE. source must be a local filesystem path (e.g. the filePath '
        + "returned by resolve_video) -- NOT a URL; passing a URL will fail. This is the fine "
        + 'half of the coarse-to-fine workflow: once an overview (from analyze_video) or a '
        + 'resolved source (from resolve_video) points at a moment worth a closer look, call '
        + 'get_frame with that exact timestamp in seconds. Returns the local file path of the '
        + 'extracted JPEG.',
      inputSchema: {
        source: z.string().describe('Local filesystem path to an already-downloaded video file (e.g. resolve_video\'s filePath). NOT a URL.'),
        timestamp: z.number().describe('Timestamp in seconds to extract.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ source, timestamp }) => {
      const p = await getFrame(source, timestamp);
      return { content: [{ type: 'text', text: p }] };
    },
  );

  server.registerTool(
    'get_clip',
    {
      title: 'Get a clip (dense sampling)',
      description:
        'Densely samples frames across a narrow time window from a video file ALREADY '
        + 'DOWNLOADED TO THIS MACHINE. source must be a local filesystem path (e.g. the '
        + "filePath returned by resolve_video) -- NOT a URL; passing a URL will fail. Use "
        + "this for the coarse-to-fine second pass: after analyze_video's overview flags "
        + 'something interesting around a timestamp (say, something at 8:31 = 511s), call '
        + 'get_clip with a narrow window around it (e.g. start=505, end=515) to sample it '
        + 'densely -- at fps frames per second, default 2 -- instead of reprocessing the '
        + 'entire video. Returns the local file paths of the extracted JPEGs, in '
        + 'chronological order.',
      inputSchema: {
        source: z.string().describe('Local filesystem path to an already-downloaded video file (e.g. resolve_video\'s filePath). NOT a URL.'),
        start: z.number().describe('Start second of the window to sample.'),
        end: z.number().describe('End second of the window to sample.'),
        fps: z.number().optional().default(2).describe('Sampling rate in frames per second. Default 2 -- higher values give denser sampling at the cost of more frames.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ source, start, end, fps }) => {
      const frames = await getClip(source, start, end, fps);
      return { content: [{ type: 'text', text: JSON.stringify(frames, null, 2) }] };
    },
  );

  return server;
}

async function main(): Promise<void> {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
}

// pathToFileURL (not a bare `file://${process.argv[1]}` template), matching
// the established convention in src/cli.ts and scripts/preflight.ts: import.
// meta.url is always percent-encoded, while naive template concatenation of
// process.argv[1] is not, so a checkout path containing a space -- like this
// repository's own ".../Xcode progects/extract tools" -- would otherwise
// never compare equal and this guard would silently never fire.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) void main();
