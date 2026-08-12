import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { resolveVideoTool } from './agent/resolveTool.js';
import { analyzeVideoTool } from './agent/analyzeTool.js';
import { isMainModule } from './util/entry.js';

export const TOOL_NAMES = ['resolve_video', 'analyze_video'] as const;

const PLATFORMS =
  'Known-working sources: YouTube, TikTok, Facebook and Reels, X/Twitter, Instagram, '
  + 'Twitch, Vimeo, Reddit, WeChat Channels, and direct .mp4/.m3u8 URLs. Many other '
  + 'sites work through generic extraction; some will not, and those return a clear '
  + 'failure status rather than throwing.';

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
    { name: 'norma-video', version: '2.0.0' },
    {
      instructions:
        'Video extraction for AI agents, in two tools. resolve_video looks a video up '
        + 'and, by default, returns only its metadata -- title, creator, duration and '
        + 'chapters -- without downloading anything heavy; pass returnVideo: true when '
        + 'you actually want the media file. analyze_video does the real work: transcript '
        + 'plus important, deduplicated keyframes. Both write their output to a directory '
        + 'you choose (destinationPath), returning a compact summary plus file paths '
        + 'rather than dumping everything into the conversation. A good habit on a long '
        + 'video is to call resolve_video first, read the chapter list, then call '
        + 'analyze_video with start/end covering only the chapter that matters -- for '
        + 'supported sources that downloads just that section instead of the whole video.',
    },
  );

  server.registerTool(
    'resolve_video',
    {
      title: 'Resolve video (metadata, optionally the file)',
      description:
        'Looks up a video and writes what it finds to destinationPath. By DEFAULT it '
        + 'returns metadata only and does NOT download the media: title, creator, '
        + 'duration, chapter list (when the platform provides one), a short description '
        + 'preview, and a path to the full metadata file. That is the cheap way to decide '
        + 'what to do next. Set returnVideo: true to also download the media file -- that '
        + 'is a real download and takes real time. With returnVideo: true you may also '
        + 'pass start/end to fetch only a section; for supported sources only that section '
        + 'is downloaded, and a fetched clip STARTS AT 0 rather than at the original '
        + 'timestamp (the result says so, and gives the offset). Use this tool when you '
        + 'only need to know what a video is, or when you want the video file itself '
        + 'without any analysis. ' + PLATFORMS + ' Comments are off by default and can be '
        + 'slow to fetch on popular videos; when enabled they are written to the metadata '
        + 'file, never returned inline.',
      inputSchema: {
        url: z.string().describe('Page or direct video URL.'),
        destinationPath: z.string().describe('Directory to write metadata (and the video, if requested) into. Created if missing. Re-running the same call overwrites in place.'),
        returnVideo: z.boolean().optional().default(false).describe('Download the media file as well as its metadata. Default false -- metadata only.'),
        start: z.number().optional().describe('Start second of the section to fetch. Only meaningful with returnVideo: true. Provide with end; either alone is ignored and the whole video is fetched.'),
        end: z.number().optional().describe('End second of the section to fetch. Only meaningful with returnVideo: true. Provide with start; either alone is ignored and the whole video is fetched.'),
        comments: z.boolean().optional().default(false).describe('Also fetch comments into the metadata file. Off by default: can be very slow on popular videos.'),
      },
      // Fix 4(c): both tools write to the user's filesystem -- metadata,
      // media, manifest, transcript and frame images -- and both delete
      // their own working files afterwards. readOnlyHint:true was false,
      // and clients make trust decisions on this annotation.
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async (args) => {
      const r = await resolveVideoTool(args);
      return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
    },
  );

  server.registerTool(
    'analyze_video',
    {
      title: 'Analyze video',
      description:
        'Given a video URL or a local video file, returns its transcript and a small set '
        + 'of important, deduplicated keyframes -- not every frame, just the ones that '
        + 'carry information (scene changes, on-screen text, visual novelty). Output is '
        + 'written to destinationPath: a manifest, the transcript, and the frame images; '
        + 'the reply is a summary plus those paths, with the transcript included inline '
        + 'when it is short. Use start/end to analyze only part of a video -- for '
        + 'supported sources only that section is downloaded, and the transcript covers '
        + 'just that section (the single-instant recipe below is the one exception: '
        + 'nothing is trimmed there, so a transcript, if requested, covers the whole '
        + 'video, not just the instant). frames controls how frames are chosen: "key" (default) picks '
        + 'the most informative ones, "even" samples the range uniformly (maxFrames over '
        + 'the window sets the density, so 60 frames across 30 seconds is 2 per second), '
        + 'and "none" returns no frames at all, which is how you ask for a transcript '
        + 'alone. For a single exact frame, set start and end to the same second with '
        + 'frames: "even", maxFrames: 1 and transcript: false -- a single instant has no '
        + 'speech to transcribe, and leaving transcript on makes the cheapest request pay '
        + "for the whole video's transcription. On failure this returns a result whose status "
        + 'is not "ok" with a readable reason, rather than throwing -- always check status '
        + 'first. Check warnings too: any optional stage that failed and was skipped past '
        + '(on-screen text, image analysis, speech recognition) records an entry there, so '
        + 'an empty transcript can be told apart from a video that simply has no speech. '
        + 'The result also carries videoPath, the local file it worked from, which you can '
        + 'pass straight back in to inspect another moment without re-downloading. '
        + PLATFORMS,
      inputSchema: {
        pathOrUrl: z.string().describe('A video URL, or a path to a video file already on this machine. Both are accepted.'),
        destinationPath: z.string().describe('Directory to write the manifest, transcript and frames into. Created if missing.'),
        start: z.number().optional().describe('Start second of the range to analyze. Provide with end; either alone is ignored. Note that if pathOrUrl is a clip previously fetched with a range, times are relative to that clip, which starts at 0.'),
        end: z.number().optional().describe('End second of the range. For a single instant, set this equal to start -- but only with frames: "even"; the default "key" mode fails on a zero-length range.'),
        frames: z.enum(['key', 'even', 'none']).optional().describe('"key" (default): the most informative frames, deduplicated. "even": uniform sampling across the range. "none": no frames (transcript only).'),
        maxFrames: z.number().optional().default(35).describe('Maximum frames to return. With frames "even" this sets density across the range. 0 means the same as frames: "none", but only when frames is not given at all -- an explicit frames value always wins, so frames: "even", maxFrames: 0 stays "even".'),
        transcript: z.boolean().optional().default(true).describe('Produce a transcript. Set false to skip transcription entirely when you only want frames.'),
        language: z.string().optional().describe('Language hint such as "zh", "ja" or "en". Usually inferred from the platform; supply it when the source carries no language metadata or the guess is wrong.'),
      },
      // Fix 4(c): both tools write to the user's filesystem -- metadata,
      // media, manifest, transcript and frame images -- and both delete
      // their own working files afterwards. readOnlyHint:true was false,
      // and clients make trust decisions on this annotation.
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async (args) => {
      const r = await analyzeVideoTool(args);
      return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
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
