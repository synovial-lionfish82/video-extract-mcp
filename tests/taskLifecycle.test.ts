// tests/taskLifecycle.test.ts
// Uses the SDK's experimental tasks client over InMemoryTransport -- the same
// real-client path tests/mcp.test.ts already established. Real tiny local
// videos via makeTestVideo; transcript: false keeps runs fast.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { buildServer } from '../src/mcp.js';
import { createSlotPool, type SlotPool } from '../src/agent/slots.js';
import { makeTestVideo } from '../src/media/ffmpeg.js';

// connectClient: copy of tests/mcp.test.ts's own helper, with ONE addition
// -- a call to listTools() before returning. This is a deliberate deviation
// from the brief's "copy verbatim" instruction, recorded here and in
// task-6-report.md: tests/mcp.test.ts never needed listTools() because it
// only ever makes plain client.callTool() calls, which task-1-report.md's
// fact (a) confirms are served by the SDK's automatic task-polling with NO
// capability declaration and no prior listTools() call at all. Every test
// below instead uses experimental.tasks.callToolStream()/cancelTask(),
// which hit a SECOND, independent gate traced in tests/taskSpike.test.ts's
// own connect() helper (deviation #2): client.experimental.tasks.isToolTask()
// requires the tool's name to be present in the client's own
// _cachedKnownTaskTools cache, populated exclusively by listTools(). Without
// this line every callToolStream() call below would silently fall back to
// the plain, non-task-augmented path -- one 'result' message, no
// 'taskCreated', no taskId, nothing to cancel.
async function connectClient(server: McpServer): Promise<Client> {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'norma-test-client', version: '0.0.1' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  await client.listTools();
  return client;
}

const itemFor = (v: string) => ({ pathOrUrl: v, frames: 'even', maxFrames: 1, start: 1, end: 1, transcript: false });

/** Shape of client.experimental.tasks.callToolStream()'s yielded messages,
 *  narrowed to the fields these tests read. Mirrors tests/taskSpike.test.ts's
 *  own inline casts for the same generator. */
type StreamMsg = {
  type: string;
  task?: { taskId: string; status: string; statusMessage?: string };
  result?: { content: Array<{ type: string; text: string }> };
};

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/** A cap-1 pool wrapping a real createSlotPool(1), padding every item's slot
 *  hold by padMs AFTER its real work resolves but BEFORE the slot is
 *  released. This is tests/mcp.test.ts's own HOLD_PAD_MS technique (see its
 *  "resolve_video is exempt from the analyze pool" test), reused here for a
 *  different purpose: it keeps a status/queued-position observable for a
 *  long, deterministic window regardless of how fast the real (tiny,
 *  local-source) analyze work actually finishes on whatever machine runs
 *  this, which is what makes the timing-sensitive assertions below robust
 *  rather than a race against real pipeline speed.
 */
function paddedCap1Pool(padMs: number): SlotPool {
  const inner = createSlotPool(1);
  return {
    get running() { return inner.running; },
    get queued() { return inner.queued; },
    run: (fn, onQueued) => inner.run(async () => {
      const r = await fn();
      await sleep(padMs);
      return r;
    }, onQueued),
  };
}

describe('task lifecycle (spec §7-§9)', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('full lifecycle: taskCreated -> working -> completed, result matches a plain call', async () => {
    const srcDir = mkdtempSync(join(tmpdir(), 'norma-lifecycle-src-'));
    const video = await makeTestVideo(join(srcDir, 'v.mp4'), 6);
    const destDir = mkdtempSync(join(tmpdir(), 'norma-lifecycle-full-'));
    const server = buildServer();
    const client = await connectClient(server);

    // Plain call: task-1-report.md fact (a) -- client.callTool() against a
    // task-registered 'optional' tool is served by the SDK's own automatic
    // task-polling and returns an ordinary CallToolResult. No task
    // machinery is visible at this call site at all.
    const plainResult = (await client.callTool({
      name: 'analyze_video',
      arguments: { destinationPath: destDir, videos: [itemFor(video)] },
    })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(plainResult.isError).not.toBe(true);
    const plainParsed = JSON.parse(plainResult.content[0]!.text) as unknown;

    // Same video, same destinationPath, run again as an explicit task via
    // callToolStream -- N=1 flat layout gives deterministic manifest/frame
    // paths, so the second run's reply is directly comparable to the
    // first's, not just structurally similar.
    const seen: string[] = [];
    let finalContent: Array<{ type: string; text: string }> | undefined;
    const stream = client.experimental.tasks.callToolStream({
      name: 'analyze_video',
      arguments: { destinationPath: destDir, videos: [itemFor(video)] },
    }) as AsyncGenerator<StreamMsg>;
    for await (const msg of stream) {
      seen.push(msg.type === 'taskStatus' ? `taskStatus:${msg.task!.status}` : msg.type);
      if (msg.type === 'result') finalContent = msg.result!.content;
    }

    // taskCreated -> ... -> completed -> result (spec §7-§9's shape).
    // Real analyze work can land on more than one intermediate 'working'
    // poll (task-1-report.md fact (b): status is polling-based and
    // coalesced), so this asserts the SHAPE, not an exact message count.
    expect(seen[0]).toBe('taskCreated');
    expect(seen.filter((s) => s === 'taskStatus:working').length).toBeGreaterThanOrEqual(1);
    expect(seen[seen.length - 2]).toBe('taskStatus:completed');
    expect(seen[seen.length - 1]).toBe('result');

    expect(finalContent).toBeDefined();
    const taskParsed = JSON.parse(finalContent![0]!.text) as unknown;
    expect(taskParsed).toEqual(plainParsed);

    await client.close();
  }, 30_000);

  it('statusMessage carries batch position and stage; a bad item does not fail the task (§5/§8)', async () => {
    // N=2 batch as a task on a cap-1 pool, item 2 unresolvable. The pad
    // holds item 1's LAST real status ("video 1/2: frames") for padMs after
    // its fast local-source work genuinely finishes -- 1.5x the client's
    // own ~1000ms poll gap, which is enough: the very next scheduled poll
    // (at most ~1000ms after the previous one) must land inside a window
    // that outlasts it, so at least one poll is guaranteed (by
    // construction, not timing luck: setTimeout never fires early, and the
    // pigeonhole guarantee holds at 1.5x same as it would at 10x) to land
    // while that label is current.
    const pool = paddedCap1Pool(1500);
    const server = buildServer({ analyzeSlots: pool });
    const client = await connectClient(server);

    const srcDir = mkdtempSync(join(tmpdir(), 'norma-lifecycle-status-src-'));
    const video = await makeTestVideo(join(srcDir, 'v.mp4'), 6);
    // A syntactically valid-looking but nonexistent local path -- the same
    // proven-fast-failing pattern tests/mcp.test.ts uses throughout (fails
    // at the resolve stage in ~tens of ms, no network involved at all), not
    // a real unreachable URL, to keep this test fast and independent of
    // network/DNS conditions.
    const badPath = join(tmpdir(), 'norma-lifecycle-does-not-exist', 'nope.mp4');
    const destDir = mkdtempSync(join(tmpdir(), 'norma-lifecycle-status-'));

    const statusMessages: Array<string | undefined> = [];
    let finalContent: Array<{ type: string; text: string }> | undefined;
    let terminalStatus: string | undefined;
    const stream = client.experimental.tasks.callToolStream({
      name: 'analyze_video',
      arguments: { destinationPath: destDir, videos: [itemFor(video), itemFor(badPath)] },
    }) as AsyncGenerator<StreamMsg>;
    for await (const msg of stream) {
      if (msg.type === 'taskStatus') {
        statusMessages.push(msg.task!.statusMessage);
        terminalStatus = msg.task!.status;
      }
      if (msg.type === 'result') finalContent = msg.result!.content;
    }

    expect(statusMessages.some((m) => m !== undefined && /video [12]\/2: (resolving|frames)/.test(m))).toBe(true);
    // Spec §8: task-failed is reserved for the wrapper breaking, NOT for one
    // bad item in an otherwise-fine batch.
    expect(terminalStatus).toBe('completed');

    const parsed = JSON.parse(finalContent![0]!.text) as { videos: Array<{ status: string }> };
    expect(parsed.videos).toHaveLength(2);
    expect(parsed.videos[0]!.status).toBe('ok');
    expect(parsed.videos[1]!.status).not.toBe('ok');

    await client.close();
  }, 30_000);

  it('a queued task cancels fully and never executes', async () => {
    const pool = paddedCap1Pool(2000);
    const server = buildServer({ analyzeSlots: pool });
    const client = await connectClient(server);

    const srcDir = mkdtempSync(join(tmpdir(), 'norma-lifecycle-queued-src-'));
    const videoA = await makeTestVideo(join(srcDir, 'a.mp4'), 6);
    const videoB = await makeTestVideo(join(srcDir, 'b.mp4'), 3);
    const destA = mkdtempSync(join(tmpdir(), 'norma-lifecycle-queued-a-'));
    const destB = mkdtempSync(join(tmpdir(), 'norma-lifecycle-queued-b-'));

    // Task A: occupies the pool's only slot (queueing decisions happen
    // synchronously inside pool.run(), before createTask's handler ever
    // returns -- see task-6-report.md for the trace -- so this is not a
    // timing gamble).
    const streamA = client.experimental.tasks.callToolStream({
      name: 'analyze_video',
      arguments: { destinationPath: destA, videos: [itemFor(videoA)] },
    }) as AsyncGenerator<StreamMsg>;
    const firstA = await streamA.next();
    expect((firstA.value as StreamMsg).type).toBe('taskCreated');
    await sleep(100); // small margin, matching tests/mcp.test.ts's own precedent
    expect(pool.running).toBe(1);

    // Task B: submitted while A holds the only slot -- genuinely queued,
    // not started.
    const streamB = client.experimental.tasks.callToolStream({
      name: 'analyze_video',
      arguments: { destinationPath: destB, videos: [itemFor(videoB)] },
    }) as AsyncGenerator<StreamMsg>;
    const firstB = await streamB.next();
    const taskIdB = (firstB.value as StreamMsg).task!.taskId;
    expect(pool.queued).toBe(1);

    const outcome = await client.experimental.tasks.cancelTask(taskIdB).then(
      (r) => ({ ok: true as const, r }),
      (e: unknown) => ({ ok: false as const, e: String(e) }),
    );
    // Task 1's fact (c)-1 shape: a successful cancel RESOLVES with the
    // task's new state, flattened (not nested under .task).
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable: asserted outcome.ok === true above');
    expect(outcome.r.status).toBe('cancelled');
    expect(outcome.r.taskId).toBe(taskIdB);
    expect(outcome.r.statusMessage).toBe('Client cancelled task execution.');

    // Drain A to its OWN natural completion first. This necessarily spans
    // at least one full client poll interval (~1000ms, fact (b)) past A's
    // real server-side completion, which is itself past the pool's 2000ms
    // pad -- ample time for the pool to have hand B's slot over and for
    // B's pre-item cancelled check to run (or, under the
    // queued-cancel-executes-anyway mutant, for B's own small/fast item to
    // have actually run and written a manifest).
    for await (const _msg of streamA) { /* drain to completion */ }
    // Extra margin on top, purely defensive.
    await sleep(500);

    const afterB = await client.experimental.tasks.getTask(taskIdB);
    expect(afterB.status).toBe('cancelled'); // never quietly flipped to 'completed'
    expect(existsSync(join(destB, 'manifest.json'))).toBe(false); // B's item never ran

    await client.close();
  }, 30_000);

  it('a running task refuses cancellation and still delivers its result', async () => {
    const pool = paddedCap1Pool(1500);
    const server = buildServer({ analyzeSlots: pool });
    const client = await connectClient(server);

    const srcDir = mkdtempSync(join(tmpdir(), 'norma-lifecycle-refuse-src-'));
    const video = await makeTestVideo(join(srcDir, 'v.mp4'), 6);
    const destDir = mkdtempSync(join(tmpdir(), 'norma-lifecycle-refuse-'));

    const stream = client.experimental.tasks.callToolStream({
      name: 'analyze_video',
      arguments: { destinationPath: destDir, videos: [itemFor(video)] },
    }) as AsyncGenerator<StreamMsg>;
    const first = await stream.next();
    const taskId = (first.value as StreamMsg).task!.taskId;

    // Wait for a genuine stage message via direct getTask polling (NOT the
    // stream's own ~1000ms poll cadence -- this is a separate, much finer
    // grained loop) -- proof onItemStart has already fired, since it is
    // unconditionally the first statement of the real per-item fn, strictly
    // before analyzeVideo's own first onStage call. At N=1, label(i,n,msg)
    // is the bare stage string (n===1 short-circuits the "video i/n:"
    // prefix) -- no "video 1/1:" prefix to match here.
    let stageSeen = false;
    for (let i = 0; i < 40 && !stageSeen; i++) {
      const t = await client.experimental.tasks.getTask(taskId);
      if (t.statusMessage === 'resolving' || t.statusMessage === 'frames') stageSeen = true;
      else await sleep(50);
    }
    expect(stageSeen).toBe(true);

    const outcome = await client.experimental.tasks.cancelTask(taskId).then(
      (r) => ({ ok: true as const, r }),
      (e: unknown) => ({ ok: false as const, e: String(e) }),
    );

    // Task 1's fact (c)-VETO-1 shape: cancelTask() REJECTS -- an McpError
    // wrapped with "Failed to cancel task:" plus the store's own message
    // (a non-McpError throw gets that prefix; HonestCancelStore throws a
    // plain Error, so this is the wrapped shape, not the pass-through one).
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable: asserted outcome.ok === false above');
    expect(outcome.e).toContain('Failed to cancel task');
    expect(outcome.e).toContain("this task's work has already started and cannot be cancelled");
    expect(outcome.e).toContain('it will finish and deliver its result');

    // The refused attempt left status untouched -- still 'working'.
    const afterRefusal = await client.experimental.tasks.getTask(taskId);
    expect(afterRefusal.status).toBe('working');

    // Drain to completion: the executor is uninterrupted (task-1-report.md
    // fact (c)-4: no AbortSignal wiring exists), and its result is intact.
    let finalContent: Array<{ type: string; text: string }> | undefined;
    let terminalStatus: string | undefined;
    for await (const msg of stream) {
      if (msg.type === 'taskStatus') terminalStatus = msg.task!.status;
      if (msg.type === 'result') finalContent = msg.result!.content;
    }
    expect(terminalStatus).toBe('completed');
    const parsed = JSON.parse(finalContent![0]!.text) as { videos: Array<{ status: string; manifestPath: string }> };
    expect(parsed.videos[0]!.status).toBe('ok');
    expect(existsSync(parsed.videos[0]!.manifestPath)).toBe(true);

    await client.close();
  }, 30_000);

  it('TTL expires the HANDLE, never the files (kills the TTL-deletes-files mutant)', async () => {
    // BRIEF DEVIATION (recorded per task instructions -- observed SDK
    // behavior wins): the brief's skeleton suggests TTL_MS=200. Empirically
    // (and confirmed by reading InMemoryTaskStore's source, dist/esm/
    // experimental/tasks/stores/in-memory.js), storeTaskResult/
    // updateTaskStatus RESET the cleanup timer to start counting from
    // completion, not from task creation -- but the ORIGINAL,
    // pre-completion timer (started at createTask time) still races the
    // real analyze work. At 200ms that original timer can fire BEFORE a
    // real (if tiny) local-video analysis finishes, deleting the task row
    // out from under the still-running executor: storeTaskResult('completed')
    // then throws "Task ... not found" (swallowed by this file's own
    // just-added inner try/catch, same as an honest cancellation race), the
    // task never observably reaches 'completed', and the client's own poll
    // loop -- gated behind a genuine ~1000ms pollInterval, task-1-report.md
    // fact (b) -- throws mid-stream instead of ever seeing 'result'. A TTL
    // comfortably longer than that ~1000ms poll gap (2500ms here, matching
    // this codebase's own HOLD_PAD_MS precedent for "definitely done by
    // then") avoids that race while still being far short of the 30-minute
    // default, so the test doesn't need to wait 30 minutes to observe expiry.
    const TTL_MS = 2500;
    vi.stubEnv('VIDEO_EXTRACT_TASK_TTL_MS', String(TTL_MS));
    const server = buildServer();
    const client = await connectClient(server);

    const srcDir = mkdtempSync(join(tmpdir(), 'norma-lifecycle-ttl-src-'));
    const video = await makeTestVideo(join(srcDir, 'v.mp4'), 6);
    const destDir = mkdtempSync(join(tmpdir(), 'norma-lifecycle-ttl-'));

    let taskId = '';
    let finalContent: Array<{ type: string; text: string }> | undefined;
    const stream = client.experimental.tasks.callToolStream({
      name: 'analyze_video',
      arguments: { destinationPath: destDir, videos: [itemFor(video)] },
    }) as AsyncGenerator<StreamMsg>;
    for await (const msg of stream) {
      if (msg.type === 'taskCreated') taskId = msg.task!.taskId;
      if (msg.type === 'result') finalContent = msg.result!.content;
    }
    expect(taskId).not.toBe('');
    const parsed = JSON.parse(finalContent![0]!.text) as { videos: Array<{ manifestPath: string }> };
    const manifestPath = parsed.videos[0]!.manifestPath;
    expect(existsSync(manifestPath)).toBe(true);

    // Wait comfortably past the RESET expiry window (counted from
    // completion, not from task creation -- see the deviation note above).
    await sleep(TTL_MS + 500);

    // Pin whichever the store does (brief's own instruction): confirmed
    // directly from shared/protocol.js's GetTaskRequestSchema handler --
    // `if (!task) throw new McpError(ErrorCode.InvalidParams, 'Failed to
    // retrieve task: Task not found')`. A store returning null for a
    // deleted task becomes exactly this rejection, not some other shape
    // (e.g. not a resolved "expired" status on the task object).
    await expect(client.experimental.tasks.getTask(taskId)).rejects.toThrow(/Task not found/);

    // The durable result -- the files -- survives the handle's own expiry.
    expect(existsSync(manifestPath)).toBe(true);

    await client.close();
  }, 30_000);
});
