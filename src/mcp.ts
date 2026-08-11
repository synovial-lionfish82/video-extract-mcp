import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { analyzeVideo } from './analyze.js';
import { getFrame, getClip } from './primitives.js';
import { resolve } from './resolve/index.js';
import { isMainModule } from './util/entry.js';

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
        'Video extraction for AI agents. Typical flow: call analyze_video directly -- it '
        + 'returns a transcript plus important, deduplicated keyframes, AND (on success) '
        + "source.filePath, a local path to the downloaded video on this machine. If the "
        + 'overview turns up something worth a closer look at a specific moment, call '
        + 'get_frame or get_clip against that filePath to inspect the moment densely instead '
        + 'of reprocessing the whole video. Call resolve_video only when you need a fast '
        + 'upfront check of whether a URL can be extracted at all before committing to '
        + "analyze_video's slower full pipeline -- resolve_video still downloads the full "
        + 'media itself (it only skips transcription/embedding/OCR), so calling it before '
        + 'analyze_video on the same URL means downloading that video twice.',
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
        + "frame's image field is a local file path on this machine, not a URL. On success, "
        + 'source.filePath is ALSO a local path on this machine, pointing at the full '
        + '(downloaded and normalized) working video -- pass it to get_frame/get_clip for a '
        + 'closer look at a specific moment; source.filePath is absent on failure. Call '
        + 'resolve_video first only if you need a fast upfront check of whether a URL can be '
        + "extracted at all before committing to this tool's slower full pipeline -- note "
        + 'that resolve_video still downloads the full media itself, so calling it before '
        + 'this tool on the same URL means downloading that video twice. Also check '
        + 'processing.warnings: optional stages that failed and were degraded past (OCR, '
        + 'image embeddings, speech recognition) each record an entry there, so an empty '
        + 'transcript or missing on-screen text can be told apart from a healthy video that '
        + 'simply has none.',
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
      title: 'Resolve video (check without analyzing)',
      description:
        'Resolves a URL to determine whether it can be extracted at all, WITHOUT '
        + 'transcribing audio, computing embeddings, or scanning for keyframes -- much faster '
        + 'than analyze_video since it skips those stages. It is NOT cheap or free, though: '
        + 'on success it still performs a full download of the video (and, depending on the '
        + 'source, its audio and subtitle tracks) -- the same download analyze_video itself '
        + 'would perform. Calling this and then analyze_video on the SAME URL downloads that '
        + 'video twice; prefer calling analyze_video directly when you already expect to want '
        + 'its output. Returns platform, title, duration, available captions, and a local '
        + 'filePath to the downloaded source video on this machine. Caption reporting: '
        + 'captions.manual is the deliberately-chosen human caption track when one exists; '
        + 'captions.auto is fetched and reported only when NO manual track exists (manual '
        + 'always wins the transcript tier, so auto availability is not probed behind it). '
        + 'On failure, returns a specific status (e.g. \'auth_required\', '
        + "'unsupported', 'not_found', 'needs_interaction') and a human-readable reason "
        + 'instead of throwing. Use this on its own when you only need to check '
        + 'extractability, or need a local video file path without paying for '
        + 'transcription/embedding/OCR.',
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
        + 'TO THIS MACHINE. source must be a local filesystem path (e.g. the source.filePath '
        + "returned by a successful analyze_video call, or resolve_video's filePath) -- NOT a "
        + 'URL; passing a URL will fail. This is the fine half of the coarse-to-fine workflow: '
        + "once analyze_video's overview points at a moment worth a closer look, call "
        + 'get_frame with that exact timestamp in seconds. Returns the local file path of the '
        + 'extracted JPEG.',
      inputSchema: {
        source: z.string().describe('Local filesystem path to an already-downloaded video file (e.g. a successful analyze_video call\'s source.filePath, or resolve_video\'s filePath). NOT a URL.'),
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
        + "source.filePath returned by a successful analyze_video call, or resolve_video's "
        + 'filePath) -- NOT a URL; passing a URL will fail. Use this for the coarse-to-fine '
        + "second pass: after analyze_video's overview flags something interesting around a "
        + 'timestamp (say, something at 8:31 = 511s), call get_clip with source set to that '
        + 'same analyze_video call\'s source.filePath and a narrow window around the '
        + 'timestamp (e.g. start=505, end=515) to sample it densely -- at fps frames per '
        + 'second, default 2 -- instead of reprocessing the entire video. Returns the local '
        + 'file paths of the extracted JPEGs, in chronological order.',
      inputSchema: {
        source: z.string().describe('Local filesystem path to an already-downloaded video file (e.g. a successful analyze_video call\'s source.filePath, or resolve_video\'s filePath). NOT a URL.'),
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

// isMainModule (src/util/entry.ts) realpaths both sides, covering the two
// known silent-failure shapes of this guard: percent-encoded spaces in the
// checkout path (this repository's own) AND symlinked invocation paths,
// where Node realpaths the main module but argv[1] stays as typed -- the
// server would otherwise exit 0 without ever connecting its transport.
if (isMainModule(import.meta.url)) void main();
