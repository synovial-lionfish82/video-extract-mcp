#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { analyzeVideoTool, type AnalyzeToolArgs } from './agent/analyzeTool.js';
import { resolveVideoTool, type ResolveToolArgs } from './agent/resolveTool.js';
import { createSlotPool, analyzeConcurrencyFromEnv, taskTtlMsFromEnv, type SlotPool } from './agent/slots.js';
import { isMainModule } from './util/entry.js';

export const TOOL_NAMES = ['resolve_video', 'analyze_video'] as const;

const toResult = (r: unknown): CallToolResult =>
  ({ content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] });

const PLATFORMS =
  'Known-working sources: YouTube, TikTok, Facebook and Reels, X/Twitter, Instagram, '
  + 'Twitch, Vimeo, Reddit, WeChat Channels, and direct .mp4/.m3u8 URLs. Many other '
  + 'sites work through generic extraction; some will not, and those return a clear '
  + 'failure status rather than throwing.';

const LIFETIME =
  'Artifacts written to destinationPath are NEVER deleted by this tool -- pick a '
  + 'temp directory if you want them ephemeral. In background-task mode the task '
  + 'handle expires (default 30 minutes) and dies with the server process, but the '
  + 'files are the durable result and survive both.';

const BATCHING =
  'videos is an array: pass one item for a single video, several to process a batch '
  + 'in one call. One video writes directly into destinationPath; several each write '
  + 'into destinationPath/video-1/, video-2/ ... in array order. Results come back as '
  + 'one entry per item, in order, each with its own status -- one video failing '
  + 'never fails the others.';

const SERVER_INSTRUCTIONS =
  'Video extraction for AI agents, in two tools. resolve_video looks videos up and, by '
  + 'default, returns only metadata -- title, creator, duration and chapters -- without '
  + 'downloading anything heavy; pass returnVideo: true per item when you want the media '
  + 'file. analyze_video does the real work: transcript plus important, deduplicated '
  + 'keyframes. Both take a videos array (one item is the common case) and write output '
  + 'to a directory you choose (destinationPath), returning a compact summary plus file '
  + 'paths rather than dumping everything into the conversation. Both also support MCP '
  + 'background tasks: called as a task, they return a handle immediately and push '
  + 'status notifications while the work runs -- useful because a full analysis of a '
  + 'long video takes minutes. A good habit on a long video is to call resolve_video '
  + 'first, read the chapter list, then analyze only the section that matters.';

const analyzeItemSchema = z.object({
  pathOrUrl: z.string().describe('A video URL, or a path to a video file already on this machine. Both are accepted.'),
  start: z.number().optional().describe('Start second of the range to analyze. Provide with end; either alone is ignored. Note that if pathOrUrl is a clip previously fetched with a range, times are relative to that clip, which starts at 0.'),
  end: z.number().optional().describe('End second of the range. Set equal to start for a single instant (requires frames: "even").'),
  frames: z.enum(['key', 'even', 'none']).optional().describe('"key" (default): the most informative frames, deduplicated. "even": uniform sampling across the range. "none": no frames (transcript only).'),
  maxFrames: z.number().optional().describe('Maximum frames to return. With frames "even" this sets density across the range. 0 with frames omitted means the same as frames: "none". Default 35.'),
  transcript: z.boolean().optional().default(true).describe('Produce a transcript. Set false to skip transcription entirely when you only want frames.'),
  language: z.string().optional().describe('Language hint such as "zh", "ja" or "en". Usually inferred from the platform; supply it when the source carries no language metadata or the guess is wrong.'),
});

// Note: `frames` deliberately carries no `.default('key')` -- the 0.1.0 Fix 3
// invariant. A schema-level default would mean `frames` is NEVER undefined
// by the time it reaches resolveFrameMode (src/types.ts), which would make
// the maxFrames:0-with-frames-omitted alias to frames:'none' unreachable
// through this server (tests/mcp.test.ts pins this). `maxFrames` similarly
// carries no `.default(35)`: src/analyze.ts:77's own `opts.maxFrames ?? 35`
// already supplies that default deeper in the pipeline, so an omitted
// maxFrames still behaves as 35 without the schema needing to duplicate it.
const ANALYZE_DESCRIPTION =
  'Given video URLs or local video files, returns for each its transcript and a small '
  + 'set of important, deduplicated keyframes -- not every frame, just the ones that '
  + 'carry information (scene changes, on-screen text, visual novelty). Output is '
  + 'written to destinationPath: per video a manifest, the transcript, and the frame '
  + 'images; the reply is one compact summary per video plus those paths, with a '
  + 'transcript included inline when it is short. The transcript comes from the '
  + "platform's own captions whenever the video has any -- human-written ones first, "
  + "otherwise the platform's automatic ones -- and speech is transcribed locally only "
  + 'for videos with no captions at all; transcript.source tells you which you got. '
  + BATCHING + ' Use start/end per item to analyze only part of a video -- for supported '
  + 'sources only that section is downloaded, and the transcript covers just that '
  + 'section (the single-instant recipe below is the one exception: nothing is trimmed '
  + 'there, so a transcript, if requested, covers the whole video). frames controls how '
  + 'frames are chosen per item; for a single exact frame, set start and end to the same '
  + 'second with frames: "even", maxFrames: 1 and transcript: false. On failure an item '
  + 'returns a status that is not "ok" with a readable reason, rather than throwing -- '
  + "always check each item's status first, and check its warnings: any optional stage "
  + 'that failed and was skipped past records an entry there, so an empty transcript can '
  + 'be told apart from a video that simply has no speech. Called as a background task, '
  + 'this returns a handle immediately; progress arrives as status messages like '
  + '"video 2/3: transcribing" or "queued, 1 ahead" (analyses run through a concurrency '
  + 'pool, default 4 at once, VIDEO_EXTRACT_MAX_CONCURRENCY to change; each concurrent '
  + 'analysis needs about 1.1 GB of memory). A queued task can be cancelled; a task '
  + 'whose work has already started cannot -- it will refuse, finish, and deliver its '
  + 'result. ' + LIFETIME + " Each item's result also carries videoPath, the local file it "
  + 'worked from, which you can pass straight back in to inspect another moment without '
  + 're-downloading. ' + PLATFORMS;

const resolveItemSchema = z.object({
  url: z.string().describe('Page or direct video URL.'),
  returnVideo: z.boolean().optional().default(false).describe('Download the media file as well as its metadata. Default false -- metadata only.'),
  start: z.number().optional().describe('Start second of the section to fetch. Only meaningful with returnVideo: true. Provide with end; either alone is ignored and the whole video is fetched.'),
  end: z.number().optional().describe('End second of the section to fetch. Only meaningful with returnVideo: true. Provide with start; either alone is ignored and the whole video is fetched.'),
  comments: z.boolean().optional().default(false).describe('Also fetch comments into the metadata file. Off by default: can be very slow on popular videos.'),
});

const RESOLVE_DESCRIPTION =
  'Looks up videos and writes what it finds to destinationPath. By DEFAULT it returns '
  + 'metadata only and does NOT download media: per video the title, creator, duration, '
  + 'chapter list (when the platform provides one), a short description preview, and a '
  + 'path to the full metadata file. That is the cheap way to decide what to do next. '
  + "Set returnVideo: true on an item to also download that video's media file -- a "
  + 'real download that takes real time. With returnVideo: true you may also pass '
  + 'start/end (both together; either alone is ignored and fetches the whole video) to '
  + 'fetch only a section; for supported sources only that section is downloaded, and a '
  + 'fetched clip STARTS AT 0 rather than at the original timestamp (the result says '
  + 'so, and gives the offset). ' + BATCHING + ' Use this tool when you only need to know '
  + 'what videos are, or when you want video files without any analysis. Called as a '
  + 'background task it returns a handle immediately and reports status while it runs; '
  + 'resolve work is never queued behind analyses. ' + LIFETIME + ' ' + PLATFORMS + ' Comments are '
  + 'off by default and can be slow to fetch on popular videos; when enabled they are '
  + 'written to the metadata file, never returned inline.';

// Task 6: honest cancellation (spec §8/§13, task-1-report.md's fact (c)).
// Queued-cancel is enforced here -- immediately before an item's real work
// begins, inside the pool-wrapped fn -- because that is the one place
// execution can still be intercepted before onItemStart marks the task
// non-cancellable (see HonestCancelStore below). checkCancelled consults
// the task's OWN status through the same extra.taskStore wrapper the rest
// of the handler uses; a 'cancelled' status can only mean tasks/cancel
// already succeeded (HonestCancelStore only lets that happen before
// onItemStart has fired for this task), so throwing here can never race a
// legitimately-running item.
class TaskCancelledError extends Error {
  constructor() { super('task was cancelled before this item started'); this.name = 'TaskCancelledError'; }
}

/** Spec §8: cancellation is honest or absent. Queued tasks cancel fully;
 *  a task whose work has started refuses -- a task that reports cancelled
 *  while quietly finishing its download is exactly the dishonesty class
 *  this project exists to kill. */
class HonestCancelStore extends InMemoryTaskStore {
  readonly executing = new Set<string>();
  override async updateTaskStatus(
    taskId: string, status: Parameters<InMemoryTaskStore['updateTaskStatus']>[1],
    statusMessage?: string, sessionId?: string,
  ): Promise<void> {
    if (status === 'cancelled' && this.executing.has(taskId)) {
      throw new Error("this task's work has already started and cannot be cancelled; it will finish and deliver its result");
    }
    return super.updateTaskStatus(taskId, status, statusMessage, sessionId);
  }
}

type Store = HonestCancelStore;
const label = (i: number, n: number, msg: string) => (n === 1 ? msg : `video ${i + 1}/${n}: ${msg}`);

function runAnalyzeExecution(
  args: AnalyzeToolArgs, pool: SlotPool,
  onUpdate?: (message: string) => void, onItemStart?: (itemIndex: number) => void,
  checkCancelled?: () => Promise<boolean>,
): Promise<import('./agent/analyzeTool.js').AnalyzeToolResult> {
  const n = args.videos.length;
  return analyzeVideoTool(args, {
    run: (fn, onQueued) => pool.run(async () => {
      if (await checkCancelled?.()) throw new TaskCancelledError();
      return fn();
    }, onQueued),
    onStage: (i, s) => onUpdate?.(label(i, n, s)),
    onQueued: (i, ahead) => onUpdate?.(label(i, n, `queued, ${ahead} ahead`)),
    onItemStart,
  });
}

/**
 * Exposes the finished engine to AI agents over MCP. Both tools are
 * registered with `server.experimental.tasks.registerToolTask` (not the
 * plain `registerTool` the 0.1.x surface used) and
 * `execution: { taskSupport: 'optional' }` -- this single registration
 * serves both an ordinary synchronous `client.callTool()` and a
 * task-augmented background call from the same handler triple
 * (`createTask`/`getTask`/`getTaskResult`), rather than needing two
 * separate code paths. The fact this whole design leans on -- that a plain
 * call against an 'optional' task-registered tool is served by the SDK's
 * own automatic task-polling (`handleAutomaticTaskPolling` in
 * `server/mcp.js`), with no capability declaration and no separate
 * non-task handler required -- was verified empirically against the
 * installed SDK (1.30.0) before any of this was written: see
 * task-1-report.md's "linchpin" finding, pinned permanently by
 * `tests/taskSpike.test.ts`. `registerToolTask` is itself an
 * `@experimental` API, which is why the SDK dependency is pinned to an
 * exact version rather than a caret range (spec §10).
 */
export function buildServer(opts?: { analyzeSlots?: SlotPool }): McpServer {
  const pool = opts?.analyzeSlots ?? createSlotPool(analyzeConcurrencyFromEnv());
  const store: Store = new HonestCancelStore();
  const server = new McpServer(
    { name: 'norma-video', version: '0.2.0' },
    {
      taskStore: store,
      instructions: SERVER_INSTRUCTIONS,
      // Task 6 gap-fix, found via advisor review against task-1-report.md's
      // spike deviation #1: capabilities are never inferred from taskStore
      // or from registerToolTask -- without this explicit declaration the
      // client's isToolTask() stays permanently false and
      // callToolStream()/cancelTask() silently collapse onto the plain
      // automatic-polling fallback (fact (a)), never reaching the real
      // task-augmented path cancellation depends on. Task 5 never surfaced
      // this because tests/mcp.test.ts only makes plain calls, which fact
      // (a) confirms need no capability declaration at all. Shape taken
      // directly from tests/taskSpike.test.ts's own working server.
      capabilities: { tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } } },
    },
  );

  server.experimental.tasks.registerToolTask(
    'analyze_video',
    {
      title: 'Analyze video',
      description: ANALYZE_DESCRIPTION,
      inputSchema: {
        destinationPath: z.string().describe('Directory to write manifests, transcripts and frames into. Created if missing.'),
        videos: z.array(analyzeItemSchema).min(1).describe('One entry per video to analyze. One item = single video, flat layout; several = video-N subdirectories.'),
      },
      // Fix 4(c): both tools write to the user's filesystem -- metadata,
      // media, manifest, transcript and frame images -- and both delete
      // their own working files afterwards. readOnlyHint:true was false,
      // and clients make trust decisions on this annotation.
      annotations: { readOnlyHint: false, openWorldHint: true },
      execution: { taskSupport: 'optional' },
    },
    {
      createTask: async (args, extra) => {
        const task = await extra.taskStore.createTask({ ttl: taskTtlMsFromEnv() });
        void (async () => {
          try {
            const r = await runAnalyzeExecution(
              args as AnalyzeToolArgs, pool,
              (m) => void extra.taskStore.updateTaskStatus(task.taskId, 'working', m).catch(() => {}),
              () => { store.executing.add(task.taskId); },
              async () => (await extra.taskStore.getTask(task.taskId))?.status === 'cancelled',
            );
            try {
              await extra.taskStore.storeTaskResult(task.taskId, 'completed', toResult(r));
            } catch {
              // Task 1's fact (c)-4: a cancel can race a just-finished
              // executor in the narrow gap between the queued-cancel check
              // passing and onItemStart actually marking the task
              // executing -- the store's own terminal-state guard then
              // refuses this write. That is a successful cancellation
              // completing honestly, not wrapper breakage: swallow it here
              // rather than falling into the 'failed' branch below, which
              // would also be refused by the same guard and would
              // misreport an honestly-cancelled task as failed instead.
            }
          } catch (e) {
            // Queued-cancel: the pre-item check above threw because the
            // store already holds 'cancelled' -- that state is durable and
            // complete on its own; there is nothing further to store.
            if (e instanceof TaskCancelledError) return;
            // Spec §8: task-failed is reserved for the wrapper itself breaking.
            await extra.taskStore.storeTaskResult(task.taskId, 'failed', {
              content: [{ type: 'text', text: `task execution failed: ${e instanceof Error ? e.message : String(e)}` }],
              isError: true,
            }).catch(() => {});
          } finally {
            store.executing.delete(task.taskId);
          }
        })();
        return { task };
      },
      getTask: async (_args, extra) => extra.taskStore.getTask(extra.taskId),
      getTaskResult: async (_args, extra) => (await extra.taskStore.getTaskResult(extra.taskId)) as CallToolResult,
    },
  );

  server.experimental.tasks.registerToolTask(
    'resolve_video',
    {
      title: 'Resolve video (metadata, optionally the file)',
      description: RESOLVE_DESCRIPTION,
      inputSchema: {
        destinationPath: z.string().describe('Directory to write metadata (and the video, if requested) into. Created if missing.'),
        videos: z.array(resolveItemSchema).min(1).describe('One entry per video to resolve. One item = single video, flat layout; several = video-N subdirectories.'),
      },
      // Fix 4(c): both tools write to the user's filesystem -- metadata,
      // media, manifest, transcript and frame images -- and both delete
      // their own working files afterwards. readOnlyHint:true was false,
      // and clients make trust decisions on this annotation.
      annotations: { readOnlyHint: false, openWorldHint: true },
      execution: { taskSupport: 'optional' },
    },
    {
      // Spec §6: resolve_video loads no models -- it is network and ffmpeg
      // -- so, unlike analyze_video, it never goes near the slot pool.
      // Task 6 scope note: this handler never adds its taskId to
      // store.executing, so HonestCancelStore never refuses a cancel here --
      // a resolve_video task remains cancellable (store-status-only, per
      // fact (c)-4: nothing stops the in-flight download itself) for its
      // entire run, identical to Task 5's pre-Task-6 behavior. RESOLVE_
      // DESCRIPTION makes no cancellation claim, so nothing here is
      // dishonest, but it does mean a mid-download cancel can still report
      // 'cancelled' while the download quietly finishes -- flagged in
      // task-6-report.md as a follow-up candidate, not fixed here since the
      // brief's mandate (and every Step-1 test) scopes honest cancellation
      // to analyze_video's pool-driven executor.
      createTask: async (args, extra) => {
        const task = await extra.taskStore.createTask({ ttl: taskTtlMsFromEnv() });
        void (async () => {
          try {
            const r = await resolveVideoTool(args as ResolveToolArgs);
            await extra.taskStore.storeTaskResult(task.taskId, 'completed', toResult(r));
          } catch (e) {
            // Spec §8: task-failed is reserved for the wrapper itself breaking.
            await extra.taskStore.storeTaskResult(task.taskId, 'failed', {
              content: [{ type: 'text', text: `task execution failed: ${e instanceof Error ? e.message : String(e)}` }],
              isError: true,
            }).catch(() => {});
          }
        })();
        return { task };
      },
      getTask: async (_args, extra) => extra.taskStore.getTask(extra.taskId),
      getTaskResult: async (_args, extra) => (await extra.taskStore.getTaskResult(extra.taskId)) as CallToolResult,
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
