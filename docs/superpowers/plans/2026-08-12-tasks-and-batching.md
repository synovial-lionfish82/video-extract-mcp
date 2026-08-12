# Background Tasks and Multi-Video Batching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Both MCP tools accept a `videos` array (batching) and become task-capable (`taskSupport: 'optional'`), with an analyze concurrency slot pool, honest cancellation, and handle-only TTL — shipping as 0.2.0.

**Architecture:** A per-server slot pool gates `analyze_video` item executions (plain and task calls alike). The agent layer's two tool functions become batch-shaped (per-item results, `video-N/` subdirs at N>1, byte-identical flat layout at N=1). `src/mcp.ts` re-registers both tools via the SDK's experimental `registerToolTask`; because `taskSupport: 'optional'` makes the SDK serve plain callers through the same `createTask` path, the queue gates plain calls for free — **verified empirically in Task 1 before anything else builds**.

**Tech Stack:** `@modelcontextprotocol/sdk` pinned **exactly 1.30.0** (experimental API, not semver-covered), zod 4, vitest, existing pipeline unchanged below the agent layer except three `onStage` seams.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-12-tasks-and-batching-design.md`. Sections cited as §N.
- SDK dependency becomes exactly `"1.30.0"` (no caret) in the same commit that first imports from `experimental/` (§10). Version ships as `0.2.0` (Task 7).
- No Python. Node 26, ESM, TypeScript strict with `noUncheckedIndexedAccess: true`. `src/types.ts` is the single source of truth for shared types.
- **The tool never deletes anything under `destinationPath`** (§9). Tested invariant: every path returned in a reply or manifest still exists after the call completes. Task TTL applies to the in-memory handle only.
- **One error model** (§8): tasks always reach `completed` with honest per-item `status` inside; task-`failed` only for wrapper breakage. Cancellation: queued cancels fully, running refuses.
- Memory claim is a rate (§6): ~1.1 GB per concurrent analysis; cap via `VIDEO_EXTRACT_MAX_CONCURRENCY` (default 4); `resolve_video` never queues. Within-item staging (ASR exits before vision) unchanged.
- Tool descriptions are the agent-facing contract; Task 5 dictates them verbatim — drift is a defect.
- Tests: `npm test` builds first; **`npx vitest run` does not** — nine test files import `../dist/`, so rebuild (`npm run build`) before running a single file. Mutants that must die (§13): queue-bypass, cancel-running-pretends-to-cancel, batch-items-share-one-directory, TTL-deletes-files.
- No absolute home-directory paths or OS usernames in committed files. Do not commit `.superpowers/`, `experiments/`, `models/`, `scratch/`.

## File Structure

- Create `src/agent/slots.ts` — slot pool (semaphore + FIFO with queue-position callbacks) + env readers.
- Create `tests/taskSpike.test.ts` (Task 1, permanent), `tests/slots.test.ts`, `tests/taskLifecycle.test.ts`.
- Modify `src/types.ts` (+`AnalyzeStage`, `AnalyzeOptions.onStage`), `src/analyze.ts` (3 seams), `src/agent/analyzeTool.ts` + `src/agent/resolveTool.ts` (batch shape), `src/mcp.ts` (rewrite), `tests/analyzeTool.test.ts`, `tests/resolveTool.test.ts`, `tests/mcp.test.ts`, `tests/analyze.integration.test.ts` (onStage), `package.json`, `README.md`, `CLAUDE.md`, `docs/follow-ups.md`.

---

### Task 1: The §12.1 spike — pin the SDK and prove the linchpin

Nothing else builds until this task's findings are recorded. The design assumes: (a) a **plain** `client.callTool()` against a `registerToolTask`-registered tool with `taskSupport: 'optional'` returns a normal synchronous `CallToolResult`; (b) `updateTaskStatus` reaches the client as `taskStatus` stream messages; (c) `tasks/cancel` routes through the store's `updateTaskStatus` (so a store subclass can refuse it). If (a) fails, STOP and report BLOCKED — the design changes. If (c)'s routing differs, record the actual path in the test file's comments and report it; Task 6 adapts.

**Files:**
- Create: `tests/taskSpike.test.ts`
- Modify: `package.json` (dependency pin only — not version)

**Interfaces:**
- Consumes: SDK experimental API only.
- Produces: recorded facts in `tests/taskSpike.test.ts` comments + the task report; the pinned dependency.

- [ ] **Step 1: Pin the SDK**

In `package.json` change `"@modelcontextprotocol/sdk": "^1.30.0"` to `"@modelcontextprotocol/sdk": "1.30.0"`. Run `npm install` (lockfile update only — same version).

- [ ] **Step 2: Write the spike (assertions for (a) are known; (b)/(c) get pinned after first observation)**

```ts
// tests/taskSpike.test.ts
//
// PERMANENT regression tests for the SDK behaviors the whole tasks design
// rests on (spec §12.1). These were verified empirically against the pinned
// SDK 1.30.0 before any production code was written; if an SDK upgrade
// changes any of them, these tests are the tripwire.
import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import { z } from 'zod';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A throwaway server with one task-capable tool. workMs simulates runtime. */
function buildSpikeServer(workMs: number, store = new InMemoryTaskStore()) {
  const server = new McpServer({ name: 'spike', version: '0.0.1' }, { taskStore: store });
  const running = new Set<string>();
  server.experimental.tasks.registerToolTask(
    'spike_tool',
    {
      description: 'spike',
      inputSchema: { label: z.string() },
      execution: { taskSupport: 'optional' },
    },
    {
      createTask: async (args, extra) => {
        const task = await extra.taskStore.createTask({ ttl: 60_000 });
        void (async () => {
          running.add(task.taskId);
          try {
            await extra.taskStore.updateTaskStatus(task.taskId, 'working', 'spiking');
            await sleep(workMs);
            await extra.taskStore.storeTaskResult(task.taskId, 'completed', {
              content: [{ type: 'text', text: `SPIKE_RESULT:${args.label}` }],
            });
          } finally { running.delete(task.taskId); }
        })();
        return { task };
      },
      getTask: async (_args, extra) => extra.taskStore.getTask(extra.taskId),
      getTaskResult: async (_args, extra) =>
        (await extra.taskStore.getTaskResult(extra.taskId)) as import('@modelcontextprotocol/sdk/types.js').CallToolResult,
    },
  );
  return { server, store, running };
}

async function connect(server: McpServer): Promise<Client> {
  const [st, ct] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'spike-client', version: '0.0.1' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

describe('SDK task spike (spec §12.1) -- the linchpin facts', () => {
  it('(a) LINCHPIN: a plain callTool() on a task-registered optional tool returns a normal result', async () => {
    const { server } = buildSpikeServer(30);
    const client = await connect(server);
    const r = (await client.callTool({ name: 'spike_tool', arguments: { label: 'plain' } })) as {
      content: Array<{ type: string; text: string }>; isError?: boolean;
    };
    expect(r.isError).not.toBe(true);
    expect(r.content[0]!.text).toBe('SPIKE_RESULT:plain');
  });

  it('(b) callToolStream surfaces taskCreated, status updates, and the final result', async () => {
    const { server } = buildSpikeServer(30);
    const client = await connect(server);
    const seen: string[] = [];
    let finalText = '';
    for await (const msg of client.experimental.tasks.callToolStream({
      name: 'spike_tool', arguments: { label: 'task' },
    }) as AsyncGenerator<{ type: string; task?: { status: string }; result?: { content: Array<{ text: string }> } }>) {
      seen.push(msg.type === 'taskStatus' ? `taskStatus:${msg.task!.status}` : msg.type);
      if (msg.type === 'result') finalText = msg.result!.content[0]!.text;
    }
    expect(seen[0]).toBe('taskCreated');
    expect(finalText).toBe('SPIKE_RESULT:task');
    // AFTER FIRST RUN: pin exactly which taskStatus messages arrived (this is
    // fact (b), whether updateTaskStatus auto-notifies). Record the observed
    // sequence in an assertion here and in the task report.
  });

  it('(c) cancellation routing: cancelTask on a running task -- observe and pin', async () => {
    const { server, running } = buildSpikeServer(300);
    const client = await connect(server);
    const stream = client.experimental.tasks.callToolStream({ name: 'spike_tool', arguments: { label: 'x' } });
    const first = await stream.next();
    const taskId = (first.value as { task: { taskId: string } }).task.taskId;
    await sleep(50);                       // executor is mid-flight
    expect(running.size).toBe(1);
    // AFTER FIRST RUN: pin what cancelTask actually does against the default
    // store -- resolves? throws? what does getTask report afterwards? Does the
    // executor's storeTaskResult afterwards throw or overwrite? Assert the
    // observed behavior here; Task 6's HonestCancelStore design depends on
    // whether this call reaches store.updateTaskStatus (subclass to verify:
    // override updateTaskStatus to record calls, assert the record).
    const outcome = await client.experimental.tasks.cancelTask(taskId).then(
      (r) => ({ ok: true as const, r }), (e: unknown) => ({ ok: false as const, e: String(e) }));
    expect(outcome).toBeDefined(); // replace with pinned assertions after observation
  });
});
```

- [ ] **Step 3: Run it, observe, pin**

Run: `npm run build && npx vitest run tests/taskSpike.test.ts`. Test (a) must pass **as written** — if it fails, STOP, report BLOCKED with the observed result shape. For (b) and (c): replace the placeholder assertions with assertions of the exact observed behavior (message sequences, cancel outcome, whether a store-subclass override sees the cancel), each with a comment stating the fact it pins. Use a store subclass with a recording `updateTaskStatus` override in (c) to answer the routing question definitively.

- [ ] **Step 4: Full suite green**

Run: `npm test` → 456 + 3 passing. `npm run typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json tests/taskSpike.test.ts
git commit -m "test: pin SDK 1.30.0 exactly and prove the taskSupport-optional linchpin"
```

---

### Task 2: The slot pool

**Files:**
- Create: `src/agent/slots.ts`
- Test: `tests/slots.test.ts`

**Interfaces:**
- Produces: `createSlotPool(max: number): SlotPool`; `SlotPool = { run<T>(fn: () => Promise<T>, onQueued?: (ahead: number) => void): Promise<T>; readonly running: number; readonly queued: number }`; `analyzeConcurrencyFromEnv(): number`; `taskTtlMsFromEnv(): number`. Task 5 consumes all four.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/slots.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createSlotPool, analyzeConcurrencyFromEnv, taskTtlMsFromEnv } from '../src/agent/slots.js';

afterEach(() => vi.unstubAllEnvs());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('createSlotPool', () => {
  it('runs at most max functions concurrently and queues the rest FIFO', async () => {
    const pool = createSlotPool(2);
    let live = 0, peak = 0;
    const order: number[] = [];
    const job = (i: number, ms: number) => pool.run(async () => {
      live++; peak = Math.max(peak, live);
      order.push(i);
      await sleep(ms); live--;
      return i;
    });
    const results = await Promise.all([job(1, 40), job(2, 40), job(3, 10), job(4, 10)]);
    expect(peak).toBe(2);                       // the cap held
    expect(order.slice(0, 2)).toEqual([1, 2]);  // first two start immediately
    expect(order.slice(2)).toEqual([3, 4]);     // then FIFO, not LIFO
    expect(results).toEqual([1, 2, 3, 4]);      // results map to callers
  });

  it('cap 1 is strictly sequential', async () => {
    const pool = createSlotPool(1);
    const events: string[] = [];
    await Promise.all([
      pool.run(async () => { events.push('a-start'); await sleep(20); events.push('a-end'); }),
      pool.run(async () => { events.push('b-start'); await sleep(5); events.push('b-end'); }),
    ]);
    expect(events).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
  });

  it('reports queue position via onQueued, and again as the queue drains', async () => {
    const pool = createSlotPool(1);
    const positions: number[] = [];
    const p1 = pool.run(() => sleep(30));
    const p2 = pool.run(() => sleep(1));
    const p3 = pool.run(() => sleep(1), (ahead) => positions.push(ahead));
    expect(pool.queued).toBe(2);
    await Promise.all([p1, p2, p3]);
    // Enqueued behind 2, then promoted to behind 1. Never 0 (0 = running).
    expect(positions).toEqual([2, 1]);
  });

  it('a rejecting job frees its slot and rejects only its own caller', async () => {
    const pool = createSlotPool(1);
    const bad = pool.run(async () => { throw new Error('boom'); });
    const good = pool.run(async () => 'fine');
    await expect(bad).rejects.toThrow('boom');
    await expect(good).resolves.toBe('fine');
    expect(pool.running).toBe(0);
    expect(pool.queued).toBe(0);
  });
});

describe('env readers', () => {
  it('VIDEO_EXTRACT_MAX_CONCURRENCY: default 4, floor 1, garbage falls back to 4', () => {
    vi.stubEnv('VIDEO_EXTRACT_MAX_CONCURRENCY', '');
    expect(analyzeConcurrencyFromEnv()).toBe(4);
    vi.stubEnv('VIDEO_EXTRACT_MAX_CONCURRENCY', '2');
    expect(analyzeConcurrencyFromEnv()).toBe(2);
    vi.stubEnv('VIDEO_EXTRACT_MAX_CONCURRENCY', '0');
    expect(analyzeConcurrencyFromEnv()).toBe(1);   // explicit but nonsensical -> floor
    vi.stubEnv('VIDEO_EXTRACT_MAX_CONCURRENCY', '-3');
    expect(analyzeConcurrencyFromEnv()).toBe(1);
    vi.stubEnv('VIDEO_EXTRACT_MAX_CONCURRENCY', 'many');
    expect(analyzeConcurrencyFromEnv()).toBe(4);   // unparseable -> default
  });

  it('VIDEO_EXTRACT_TASK_TTL_MS: default 1800000, same floor/garbage rules', () => {
    vi.stubEnv('VIDEO_EXTRACT_TASK_TTL_MS', '');
    expect(taskTtlMsFromEnv()).toBe(1_800_000);
    vi.stubEnv('VIDEO_EXTRACT_TASK_TTL_MS', '60000');
    expect(taskTtlMsFromEnv()).toBe(60_000);
    vi.stubEnv('VIDEO_EXTRACT_TASK_TTL_MS', 'soon');
    expect(taskTtlMsFromEnv()).toBe(1_800_000);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/slots.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// src/agent/slots.ts
/**
 * Concurrency slot pool for analyze_video item executions (spec §6).
 * Plain and task calls both run through it -- a plain call burns the same
 * CPU and model memory, so exempting it would make the cap fiction
 * (spec §12.2). resolve_video never uses it.
 */
export interface SlotPool {
  run<T>(fn: () => Promise<T>, onQueued?: (ahead: number) => void): Promise<T>;
  readonly running: number;
  readonly queued: number;
}

interface Waiter { start: () => void; onQueued?: (ahead: number) => void }

export function createSlotPool(max: number): SlotPool {
  let running = 0;
  const waiters: Waiter[] = [];
  const pump = () => {
    while (running < max && waiters.length > 0) {
      const next = waiters.shift()!;
      running++;
      next.start();
    }
    // Everyone still waiting just moved up; tell them where they stand.
    waiters.forEach((w, i) => w.onQueued?.(i + 1));
  };
  return {
    get running() { return running; },
    get queued() { return waiters.length; },
    run<T>(fn: () => Promise<T>, onQueued?: (ahead: number) => void): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const start = () => fn().then(resolve, reject).finally(() => { running--; pump(); });
        if (running < max && waiters.length === 0) {
          running++;
          start();
        } else {
          waiters.push({ start, onQueued });
          onQueued?.(waiters.length);
        }
      });
    },
  };
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) return fallback;  // unparseable -> default
  return n < 1 ? 1 : n;                       // explicit nonsense -> floor 1
}

/** VIDEO_EXTRACT_MAX_CONCURRENCY, default 4 (spec §6). */
export function analyzeConcurrencyFromEnv(): number {
  return intFromEnv('VIDEO_EXTRACT_MAX_CONCURRENCY', 4);
}

/** VIDEO_EXTRACT_TASK_TTL_MS, default 30 minutes -- handle lifetime ONLY (spec §9). */
export function taskTtlMsFromEnv(): number {
  return intFromEnv('VIDEO_EXTRACT_TASK_TTL_MS', 1_800_000);
}
```



- [ ] **Step 4: Run to green** — `npx vitest run tests/slots.test.ts` → PASS. Mutate to verify: swap `shift()` for `pop()` (FIFO→LIFO) — the ordering test must fail; remove the `waiters.forEach` re-report — the positions test must fail. Restore.

- [ ] **Step 5: Commit** — `git add src/agent/slots.ts tests/slots.test.ts && git commit -m "feat: analyze concurrency slot pool with queue-position reporting"`

---

### Task 3: `onStage` seams in the pipeline

**Files:**
- Modify: `src/types.ts`, `src/analyze.ts`
- Test: `tests/analyze.integration.test.ts`

**Interfaces:**
- Produces: `export type AnalyzeStage = 'resolving' | 'transcribing' | 'frames';` and `AnalyzeOptions.onStage?: (stage: AnalyzeStage) => void` in `src/types.ts`. Tasks 4/5 consume.

- [ ] **Step 1: Write the failing test** (append to `tests/analyze.integration.test.ts`, which already builds real synthetic videos and mocks `resolve` — follow its existing `vi.mocked(resolve).mockImplementationOnce` fixture pattern with a 9s `makeTestVideo`):

```ts
describe('analyzeVideo -- onStage progress seams (spec §7)', () => {
  it('emits resolving -> transcribing -> frames for a full default run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'norma-e2e-stage-'));
    const v = await makeTestVideo(join(dir, 'v.mp4'), 9);
    vi.mocked(resolve).mockImplementationOnce(async () => ({
      status: 'ok', filePath: v, platform: 'test', title: 'T', duration: 9,
      resolvedBy: 'ytdlp', captions: { manual: null, auto: null },
      languageHint: 'en', rangeApplied: false,
    }));
    const stages: string[] = [];
    const m = await analyzeVideo('https://stage.example/v', {
      maxFrames: 2, outDir: join(dir, 'out'), onStage: (s) => stages.push(s),
    });
    expect(m.source.status).toBe('ok');
    expect(stages).toEqual(['resolving', 'transcribing', 'frames']);
  }, 120_000);

  it('emits only the stages that actually run: transcript off + frames none', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'norma-e2e-stage2-'));
    const v = await makeTestVideo(join(dir, 'v.mp4'), 9);
    vi.mocked(resolve).mockImplementationOnce(async () => ({
      status: 'ok', filePath: v, platform: 'test', title: 'T', duration: 9,
      resolvedBy: 'ytdlp', captions: { manual: null, auto: null },
      languageHint: 'en', rangeApplied: false,
    }));
    const stages: string[] = [];
    const m = await analyzeVideo('https://stage.example/v2', {
      frames: 'none', transcript: false, outDir: join(dir, 'out'), onStage: (s) => stages.push(s),
    });
    expect(m.source.status).toBe('ok');
    expect(stages).toEqual(['resolving']);   // no fabricated stages for skipped work (§7/§8)
  }, 120_000);
});
```

- [ ] **Step 2: Verify failure** — `npm run build && npx vitest run tests/analyze.integration.test.ts -t "onStage"` → FAIL (`onStage` not a known option; stages empty).

- [ ] **Step 3: Implement.** In `src/types.ts`, immediately above `AnalyzeOptions`:

```ts
/** Progress seams analyzeVideo reports through AnalyzeOptions.onStage (spec §7). */
export type AnalyzeStage = 'resolving' | 'transcribing' | 'frames';
```

and add to `AnalyzeOptions`:

```ts
  /** Called at pipeline seams; only for stages that actually run. Failures in
   *  the callback are the caller's own problem -- not caught here. */
  onStage?: (stage: AnalyzeStage) => void;
```

In `src/analyze.ts`: (1) `opts.onStage?.('resolving');` as the first statement of the `try` in `analyzeVideo` (before `analyzeResolved` is called); (2) `opts.onStage?.('transcribing');` as the first statement inside the `if (opts.transcript !== false) {` block; (3) `opts.onStage?.('frames');` immediately before the frame-mode dispatch, gated so `'none'` emits nothing: place it inside the `frameMode === 'even'` branch's top and the `frameMode === 'key'` branch's top (one line each), NOT above the dispatch.

- [ ] **Step 4: Green + suite** — `npm run build && npx vitest run tests/analyze.integration.test.ts` → all pass. Mutate: move the `'frames'` emit above the dispatch (so `'none'` emits it) — the second test must fail. Restore.

- [ ] **Step 5: Commit** — `git add src/types.ts src/analyze.ts tests/analyze.integration.test.ts && git commit -m "feat: onStage progress seams at resolve/transcript/frame boundaries"`

---

### Task 4: Batch-shaped agent layer

Both tool functions change shape: `{destinationPath, videos: [...]}` in, `{videos: [...]}` out. The existing single-video logic becomes the per-item executor, **unchanged in behavior** — at N=1 the layout stays byte-identical (item dir = `destinationPath` itself).

**Files:**
- Modify: `src/agent/analyzeTool.ts`, `src/agent/resolveTool.ts`
- Test: `tests/analyzeTool.test.ts`, `tests/resolveTool.test.ts`

**Interfaces:**
- Consumes: `AnalyzeStage` (Task 3).
- Produces (Task 5 consumes all of these):
  - `analyzeTool.ts`: `AnalyzeVideoItem { pathOrUrl: string; start?: number; end?: number; frames?: FrameMode; maxFrames?: number; transcript?: boolean; language?: string }`; `AnalyzeToolArgs { destinationPath: string; videos: AnalyzeVideoItem[] }`; the old result interface renamed `AnalyzeItemResult` (fields unchanged); `AnalyzeToolResult { videos: AnalyzeItemResult[] }`; `AnalyzeRunHooks { run?: <T>(fn: () => Promise<T>, onQueued: (ahead: number) => void) => Promise<T>; onStage?: (itemIndex: number, stage: AnalyzeStage) => void; onQueued?: (itemIndex: number, ahead: number) => void; onItemStart?: (itemIndex: number) => void }`; `itemDir(destinationPath: string, index: number, total: number): string`; `analyzeVideoTool(args: AnalyzeToolArgs, hooks?: AnalyzeRunHooks): Promise<AnalyzeToolResult>`.
  - `resolveTool.ts`: `ResolveVideoItem { url: string; returnVideo?: boolean; start?: number; end?: number; comments?: boolean }`; `ResolveToolArgs { destinationPath: string; videos: ResolveVideoItem[] }`; old result renamed `ResolveItemResult`; `ResolveToolResult { videos: ResolveItemResult[] }`; `resolveVideoTool(args: ResolveToolArgs): Promise<ResolveToolResult>`.

- [ ] **Step 1: Mechanically migrate the existing tests.** In both test files, every call `analyzeVideoTool({ pathOrUrl, destinationPath, ...rest })` becomes `analyzeVideoTool({ destinationPath, videos: [{ pathOrUrl, ...rest }] })` and every result read `r.x` becomes `r.videos[0]!.x` (same for resolve with `url`). Do not weaken any assertion — the point of the migration is that **every existing single-video behavior test passes against the N=1 batch path**, proving parity. The `keeps analyzeVideo's own working directory out of destinationPath` test and the no-copy/no-move tests migrate identically.

- [ ] **Step 2: Add the new batch tests** (append to `tests/analyzeTool.test.ts`; the file already mocks `analyzeVideo` — reuse its mock helpers):

```ts
describe('batching (spec §3-§5)', () => {
  it('itemDir: flat at N=1, video-N subdirs at N>1', () => {
    expect(itemDir('/d', 0, 1)).toBe('/d');
    expect(itemDir('/d', 0, 3)).toBe(join('/d', 'video-1'));
    expect(itemDir('/d', 2, 3)).toBe(join('/d', 'video-3'));
  });

  it('N=2 writes each item into its own subdir -- manifests do not collide', async () => {
    // mock analyzeVideo to return ok manifests with distinct titles per URL
    const dir = mkdtempSync(join(tmpdir(), 'norma-batch-'));
    const r = await analyzeVideoTool({ destinationPath: dir, videos: [
      { pathOrUrl: 'https://x.test/a' }, { pathOrUrl: 'https://x.test/b' },
    ]});
    expect(r.videos).toHaveLength(2);
    expect(r.videos[0]!.manifestPath).toBe(join(dir, 'video-1', 'manifest.json'));
    expect(r.videos[1]!.manifestPath).toBe(join(dir, 'video-2', 'manifest.json'));
    expect(existsSync(r.videos[0]!.manifestPath)).toBe(true);
    expect(existsSync(r.videos[1]!.manifestPath)).toBe(true);
    const m1 = JSON.parse(readFileSync(r.videos[0]!.manifestPath, 'utf8'));
    const m2 = JSON.parse(readFileSync(r.videos[1]!.manifestPath, 'utf8'));
    expect(m1.source.url).not.toBe(m2.source.url);   // kills the shared-directory mutant
  });

  it('partial failure: item statuses are independent, the call resolves', async () => {
    // mock analyzeVideo: ok for /a, extractor_failed manifest for /b
    const dir = mkdtempSync(join(tmpdir(), 'norma-batch-pf-'));
    const r = await analyzeVideoTool({ destinationPath: dir, videos: [
      { pathOrUrl: 'https://x.test/a' }, { pathOrUrl: 'https://x.test/dead' },
    ]});
    expect(r.videos[0]!.status).toBe('ok');
    expect(r.videos[1]!.status).toBe('extractor_failed');
    expect(r.videos[1]!.manifestPath).toBe(join(dir, 'video-2', 'manifest.json'));
  });

  it('hooks: run wraps each item, onStage/onQueued carry the item index', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'norma-batch-hooks-'));
    const ran: number[] = []; const staged: Array<[number, string]> = [];
    let live = 0, peak = 0;
    await analyzeVideoTool(
      { destinationPath: dir, videos: [{ pathOrUrl: 'https://x.test/a' }, { pathOrUrl: 'https://x.test/b' }] },
      {
        run: async (fn) => { live++; peak = Math.max(peak, live); ran.push(live); const r = await fn(); live--; return r; },
        onStage: (i, s) => staged.push([i, s]),
        onItemStart: (i) => staged.push([i, 'start']),
      },
    );
    expect(ran).toHaveLength(2);                       // every item went through run
    expect(staged.filter(([, s]) => s === 'start').map(([i]) => i).sort()).toEqual([0, 1]);
  });
});
```

And to `tests/resolveTool.test.ts` (which mocks `resolve`): an N=2 test asserting `metadataPath` lands at `video-1/metadata.json` / `video-2/metadata.json` with both files existing, and a partial-failure test (item 1 `ok`, item 2 mocked `not_found`) asserting independent statuses.

- [ ] **Step 3: Verify failure** — `npm run build && npx vitest run tests/analyzeTool.test.ts tests/resolveTool.test.ts` → FAIL on shape.

- [ ] **Step 4: Implement.** In `src/agent/analyzeTool.ts`:

1. Rename `AnalyzeToolResult` → `AnalyzeItemResult` and the old `AnalyzeToolArgs` → `AnalyzeVideoItem` minus `destinationPath` (the item keeps `pathOrUrl`, `start`, `end`, `frames`, `maxFrames`, `transcript`, `language`). Rename the old exported `analyzeVideoTool` → `analyzeOneVideo(item: AnalyzeVideoItem, destinationPath: string, onStage?: (stage: AnalyzeStage) => void): Promise<AnalyzeItemResult>` — body unchanged except it reads `destinationPath` from the parameter and threads `onStage` into the `AnalyzeOptions` it builds. Keep it exported (tests and the batch entry both use it).
2. Add:

```ts
export interface AnalyzeToolArgs { destinationPath: string; videos: AnalyzeVideoItem[]; }
export interface AnalyzeToolResult { videos: AnalyzeItemResult[]; }
export interface AnalyzeRunHooks {
  /** Wraps each item's execution -- the MCP layer passes the slot pool here.
   *  Omitted = run directly (library callers manage their own concurrency). */
  run?: <T>(fn: () => Promise<T>, onQueued: (ahead: number) => void) => Promise<T>;
  onStage?: (itemIndex: number, stage: AnalyzeStage) => void;
  onQueued?: (itemIndex: number, ahead: number) => void;
  /** Fires when the item actually starts executing (post-queue). Task 6 uses
   *  it to mark the task running for honest-cancellation purposes. */
  onItemStart?: (itemIndex: number) => void;
}

/** Spec §4: one video writes flat (today's layout, byte-identical); several
 *  each get destinationPath/video-N so metadata.json never collides. */
export function itemDir(destinationPath: string, index: number, total: number): string {
  return total === 1 ? destinationPath : join(destinationPath, `video-${index + 1}`);
}

export async function analyzeVideoTool(
  args: AnalyzeToolArgs, hooks?: AnalyzeRunHooks,
): Promise<AnalyzeToolResult> {
  const n = args.videos.length;
  const exec = hooks?.run ?? (<T,>(fn: () => Promise<T>) => fn());
  const videos = await Promise.all(args.videos.map((item, i) =>
    exec(
      () => { hooks?.onItemStart?.(i); return analyzeOneVideo(item, itemDir(args.destinationPath, i, n), (s) => hooks?.onStage?.(i, s)); },
      (ahead) => hooks?.onQueued?.(i, ahead),
    ),
  ));
  return { videos };
}
```

Mirror in `src/agent/resolveTool.ts` (no hooks — `resolveVideoTool(args)` maps items through `resolveOneVideo(item, itemDir(...))` with `Promise.all`; import `itemDir` from `./analyzeTool.js` rather than duplicating it).

3. Fix the remaining compile errors mechanically: `src/mcp.ts` still calls the old shapes — **do not redesign it here**; adapt its two handlers minimally to wrap/unwrap (`{ destinationPath: args.destinationPath, videos: [{...}] }`) so the build stays green. Task 5 rewrites that file wholesale anyway. Update `tests/mcp.test.ts` calls the same minimal way if they break.

- [ ] **Step 5: Green + suite + mutation** — `npm test` all green. Mutate `itemDir` to always return `destinationPath` — the N=2 subdir tests in both files must fail (this is the §13 shared-directory mutant). Restore.

- [ ] **Step 6: Commit** — `git add -A src/agent tests/analyzeTool.test.ts tests/resolveTool.test.ts src/mcp.ts tests/mcp.test.ts && git commit -m "feat: batch-shaped agent layer with per-item results and video-N layout"`

---

### Task 5: MCP surface — task registration, batch schemas, dictated descriptions

**Files:**
- Modify: `src/mcp.ts` (wholesale), `tests/mcp.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2 and 4; `InMemoryTaskStore` from `@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js`.
- Produces: `buildServer(opts?: { analyzeSlots?: SlotPool }): McpServer` (the options seam exists for tests to inject an instrumented pool); `TOOL_NAMES` unchanged `['resolve_video', 'analyze_video']`. A shared internal `runAnalyzeExecution(...)` used by Task 6.

The description strings below are **the contract — use them verbatim**. They carry forward every verified claim from the 0.1.0 descriptions (platform honesty, clip-starts-at-zero, both-bounds ranges, comments cost, single-instant recipe, degradation warnings) re-phrased per-item, plus the new batch/task/lifetime text (§9, §12.4).

- [ ] **Step 1: Rewrite `tests/mcp.test.ts`'s call sites** to the batch schema (`videos` arrays, reads via `parsed.videos[0]`), keeping the `connectClient` harness and isError helpers verbatim (their comments pin verified SDK behavior). Add:

```ts
describe('v0.2 batch schema', () => {
  it('rejects an empty videos array', async () => { /* callTool with videos: [] -> isError true */ });
  it('rejects a call missing destinationPath', async () => { /* unchanged guarantee, new shape */ });
  it('N=1 layout is byte-identical to 0.1.0: manifest.json at destinationPath root', async () => {
    /* real makeTestVideo local path; assert join(dir,'manifest.json') exists -- literal path, not read back */
  });
  it('N=2 produces video-1/ and video-2/ with independent manifests', async () => { /* real, tiny videos */ });
});

describe('resolve_video is exempt from the analyze pool (spec §6)', () => {
  it('a metadata-only resolve completes while the cap-1 pool is fully occupied', async () => {
    // Inject a cap-1 pool and occupy its only slot with a long analyze call
    // (do not await it). Then issue a plain metadata-only resolve_video call
    // and await THAT: it must complete while the analyze is still holding the
    // slot -- assert the resolve result arrives and pool.queued === 0
    // throughout (a mutant that routes resolve through the pool queues it
    // behind the analyze and this await never returns before the analyze).
    // Finally await the analyze call so the test exits cleanly.
  });
});

describe('plain calls gate through the slot pool (spec §12.2 -- the queue-bypass mutant)', () => {
  it('two concurrent plain analyze calls on a cap-1 injected pool never overlap', async () => {
    const events: string[] = [];
    const inner = createSlotPool(1);
    const spy: SlotPool = {
      get running() { return inner.running; }, get queued() { return inner.queued; },
      run: (fn, onQ) => inner.run(async () => { events.push('start'); const r = await fn(); events.push('end'); return r; }, onQ),
    };
    const server = buildServer({ analyzeSlots: spy });
    const client = await connectClient(server);
    // two REAL tiny local videos, called concurrently
    await Promise.all([callAnalyze(client, videoA), callAnalyze(client, videoB)]);
    expect(events).toEqual(['start', 'end', 'start', 'end']);   // strictly sequential
  });
});
```

- [ ] **Step 2: Verify failure** — `npm run build && npx vitest run tests/mcp.test.ts` → FAIL.

- [ ] **Step 3: Rewrite `src/mcp.ts`.** Structure (keep `isMainModule` guard and the `registerTool`-vs-`tool()` JSDoc note; imports change):

```ts
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
```

`buildServer(opts?: { analyzeSlots?: SlotPool })`:

```ts
export function buildServer(opts?: { analyzeSlots?: SlotPool }): McpServer {
  const pool = opts?.analyzeSlots ?? createSlotPool(analyzeConcurrencyFromEnv());
  const store = new InMemoryTaskStore();
  const server = new McpServer(
    { name: 'norma-video', version: '0.2.0' },
    { taskStore: store, instructions: /* dictated below */ },
  );
  // ... two registerToolTask calls ...
  return server;
}
```

Server `instructions` (verbatim):

```
Video extraction for AI agents, in two tools. resolve_video looks videos up and, by
default, returns only metadata -- title, creator, duration and chapters -- without
downloading anything heavy; pass returnVideo: true per item when you want the media
file. analyze_video does the real work: transcript plus important, deduplicated
keyframes. Both take a videos array (one item is the common case) and write output
to a directory you choose (destinationPath), returning a compact summary plus file
paths rather than dumping everything into the conversation. Both also support MCP
background tasks: called as a task, they return a handle immediately and push
status notifications while the work runs -- useful because a full analysis of a
long video takes minutes. A good habit on a long video is to call resolve_video
first, read the chapter list, then analyze only the section that matters.
```

`analyze_video` registration — schema:

```ts
const analyzeItemSchema = z.object({
  pathOrUrl: z.string().describe('A video URL, or a path to a video file already on this machine. Both are accepted.'),
  start: z.number().optional().describe('Start second of the range to analyze. Provide with end; either alone is ignored. Note that if pathOrUrl is a clip previously fetched with a range, times are relative to that clip, which starts at 0.'),
  end: z.number().optional().describe('End second of the range. Set equal to start for a single instant (requires frames: "even").'),
  frames: z.enum(['key', 'even', 'none']).optional().describe('"key" (default): the most informative frames, deduplicated. "even": uniform sampling across the range. "none": no frames (transcript only).'),
  maxFrames: z.number().optional().describe('Maximum frames to return. With frames "even" this sets density across the range. 0 with frames omitted means the same as frames: "none". Default 35.'),
  transcript: z.boolean().optional().default(true).describe('Produce a transcript. Set false to skip transcription entirely when you only want frames.'),
  language: z.string().optional().describe('Language hint such as "zh", "ja" or "en". Usually inferred from the platform; supply it when the source carries no language metadata or the guess is wrong.'),
});
// inputSchema: { destinationPath: z.string().describe('Directory to write manifests, transcripts and frames into. Created if missing.'),
//                videos: z.array(analyzeItemSchema).min(1).describe('One entry per video to analyze. One item = single video, flat layout; several = video-N subdirectories.') }
```

(Note `frames` keeps **no** `.default('key')` — the 0.1.0 Fix 3 invariant; `maxFrames: 0`'s alias needs `frames` to reach `resolveFrameMode` as `undefined`.)

`analyze_video` description (verbatim):

```
Given video URLs or local video files, returns for each its transcript and a small
set of important, deduplicated keyframes -- not every frame, just the ones that
carry information (scene changes, on-screen text, visual novelty). Output is
written to destinationPath: per video a manifest, the transcript, and the frame
images; the reply is one compact summary per video plus those paths, with a
transcript included inline when it is short. The transcript comes from the
platform's own captions whenever the video has any -- human-written ones first,
otherwise the platform's automatic ones -- and speech is transcribed locally only
for videos with no captions at all; transcript.source tells you which you got.
[BATCHING] Use start/end per item to analyze only part of a video -- for supported
sources only that section is downloaded, and the transcript covers just that
section (the single-instant recipe below is the one exception: nothing is trimmed
there, so a transcript, if requested, covers the whole video). frames controls how
frames are chosen per item; for a single exact frame, set start and end to the same
second with frames: "even", maxFrames: 1 and transcript: false. On failure an item
returns a status that is not "ok" with a readable reason, rather than throwing --
always check each item's status first, and check its warnings: any optional stage
that failed and was skipped past records an entry there, so an empty transcript can
be told apart from a video that simply has no speech. Called as a background task,
this returns a handle immediately; progress arrives as status messages like
"video 2/3: transcribing" or "queued, 1 ahead" (analyses run through a concurrency
pool, default 4 at once, VIDEO_EXTRACT_MAX_CONCURRENCY to change; each concurrent
analysis needs about 1.1 GB of memory). A queued task can be cancelled; a task
whose work has already started cannot -- it will refuse, finish, and deliver its
result. [LIFETIME] Each item's result also carries videoPath, the local file it
worked from, which you can pass straight back in to inspect another moment without
re-downloading. [PLATFORMS]
```

(`[BATCHING]`/`[LIFETIME]`/`[PLATFORMS]` are the shared constants concatenated at those positions.)

`resolve_video` description (verbatim):

```
Looks up videos and writes what it finds to destinationPath. By DEFAULT it returns
metadata only and does NOT download media: per video the title, creator, duration,
chapter list (when the platform provides one), a short description preview, and a
path to the full metadata file. That is the cheap way to decide what to do next.
Set returnVideo: true on an item to also download that video's media file -- a
real download that takes real time. With returnVideo: true you may also pass
start/end (both together; either alone is ignored and fetches the whole video) to
fetch only a section; for supported sources only that section is downloaded, and a
fetched clip STARTS AT 0 rather than at the original timestamp (the result says
so, and gives the offset). [BATCHING] Use this tool when you only need to know
what videos are, or when you want video files without any analysis. Called as a
background task it returns a handle immediately and reports status while it runs;
resolve work is never queued behind analyses. [LIFETIME] [PLATFORMS] Comments are
off by default and can be slow to fetch on popular videos; when enabled they are
written to the metadata file, never returned inline.
```

Handlers. The execution helper both tools share their pattern with (Task 6 extends it — keep it a named function):

```ts
type Store = InMemoryTaskStore;
const label = (i: number, n: number, msg: string) => (n === 1 ? msg : `video ${i + 1}/${n}: ${msg}`);

function runAnalyzeExecution(
  args: AnalyzeToolArgs, pool: SlotPool,
  onUpdate?: (message: string) => void, onItemStart?: (itemIndex: number) => void,
): Promise<import('./agent/analyzeTool.js').AnalyzeToolResult> {
  const n = args.videos.length;
  return analyzeVideoTool(args, {
    run: (fn, onQueued) => pool.run(fn, onQueued),
    onStage: (i, s) => onUpdate?.(label(i, n, s)),
    onQueued: (i, ahead) => onUpdate?.(label(i, n, `queued, ${ahead} ahead`)),
    onItemStart,
  });
}
```

Both tools register via `server.experimental.tasks.registerToolTask(name, { title, description, inputSchema, annotations: { readOnlyHint: false, openWorldHint: true }, execution: { taskSupport: 'optional' } }, handler)` with the handler triple:

```ts
{
  createTask: async (args, extra) => {
    const task = await extra.taskStore.createTask({ ttl: taskTtlMsFromEnv() });
    void (async () => {
      try {
        const r = await runAnalyzeExecution(args as AnalyzeToolArgs, pool,
          (m) => void extra.taskStore.updateTaskStatus(task.taskId, 'working', m).catch(() => {}));
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
}
```

(`resolve_video`'s createTask is identical minus the pool: it calls `resolveVideoTool(args)` directly. Adapt member names, not structure. If Task 1's spike recorded that the plain-call path or notification wiring differs from this shape, follow the spike's recorded facts and say so in the report.)

- [ ] **Step 4: Green** — `npm run build && npx vitest run tests/mcp.test.ts` → PASS, then `npm test` fully green, `npm run typecheck` clean.

- [ ] **Step 5: Mutation duty** — (1) queue-bypass: change `runAnalyzeExecution` to call `analyzeVideoTool(args, { onStage: ... })` without `run:` — the cap-1 sequential test must fail. (2) Re-add `.default('key')` to `frames` — the existing `maxFrames: 0` alias test must fail. Restore both.

- [ ] **Step 6: Commit** — `git add src/mcp.ts tests/mcp.test.ts && git commit -m "feat: task-capable batch MCP surface behind a shared slot pool"`

---

### Task 6: Task lifecycle — status visibility, honest cancellation, handle-only TTL

**Files:**
- Modify: `src/mcp.ts` (cancellation + running-tracking only — descriptions are frozen from Task 5)
- Create: `tests/taskLifecycle.test.ts`

**Interfaces:**
- Consumes: Task 5's `buildServer`/`runAnalyzeExecution`; Task 1's recorded cancellation-routing fact.
- Produces: `HonestCancelStore` (internal to `src/mcp.ts`).

- [ ] **Step 1: Write the failing tests**

```ts
// tests/taskLifecycle.test.ts
// Uses the SDK's experimental tasks client over InMemoryTransport -- the same
// real-client path tests/mcp.test.ts already established. Real tiny local
// videos via makeTestVideo; transcript: false keeps runs fast.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from '../src/mcp.js';
import { createSlotPool } from '../src/agent/slots.js';
import { makeTestVideo } from '../src/media/ffmpeg.js';
// connectClient: copy the helper from tests/mcp.test.ts verbatim (same comment).

const itemFor = (v: string) => ({ pathOrUrl: v, frames: 'even', maxFrames: 1, start: 1, end: 1, transcript: false });

describe('task lifecycle (spec §7-§9)', () => {
  it('full lifecycle: taskCreated -> working -> completed, result matches a plain call', async () => {
    // build one video; run BOTH paths on it; JSON-parse both results;
    // expect(taskResult).toEqual(plainResult) modulo nothing -- same shape, same content.
  });

  it('statusMessage carries batch position and stage; a bad item does not fail the task (§5/§8)', async () => {
    // N=2 batch as a task on a cap-1 pool, where item 2's pathOrUrl is an
    // unresolvable URL. Collect taskStatus messages; expect some message to
    // match /video [12]\/2: (resolving|frames)/. The task must still reach
    // 'completed' (NOT 'failed' -- §8 reserves failed for wrapper breakage),
    // and the parsed result's videos[1].status must be a non-ok value while
    // videos[0].status is 'ok'.
  });

  it('a queued task cancels fully and never executes', async () => {
    // cap-1 injected pool; occupy the slot with task A (longer video);
    // submit task B; cancelTask(B) while B is queued;
    // assert B's terminal status is 'cancelled' AND B's item never ran --
    // observable because B's destinationPath stays EMPTY (no manifest.json).
  });

  it('a running task refuses cancellation and still delivers its result', async () => {
    // single task mid-flight (start it, wait for a 'working' stage message);
    // cancelTask -> expect refusal (per the exact shape Task 1's spike pinned);
    // then await the stream to completion; result must be intact and status 'completed'.
  });

  it('TTL expires the HANDLE, never the files (kills the TTL-deletes-files mutant)', async () => {
    // VIDEO_EXTRACT_TASK_TTL_MS=200 via vi.stubEnv BEFORE buildServer();
    // run a task to completion; note manifestPath from its result; wait 400ms;
    // getTask(taskId) now errors or reports expiry (pin whichever the store does);
    // expect(existsSync(manifestPath)).toBe(true)  // files survive the handle
  });
});
```

- [ ] **Step 2: Verify failure** — the queued-cancel and refuse-cancel tests fail against Task 5's code (no cancellation semantics yet).

- [ ] **Step 3: Implement honest cancellation in `src/mcp.ts`.** Following Task 1's recorded routing fact (default design below assumes cancel reaches `store.updateTaskStatus`; adapt to the spike's finding if it differed, and say so in the report):

```ts
/** Spec §8: cancellation is honest or absent. Queued tasks cancel fully;
 *  a task whose work has started refuses -- a task that reports cancelled
 *  while quietly finishing its download is exactly the dishonesty class
 *  this project exists to kill. */
class HonestCancelStore extends InMemoryTaskStore {
  readonly executing = new Set<string>();
  override async updateTaskStatus(taskId: string, status: Parameters<InMemoryTaskStore['updateTaskStatus']>[1], statusMessage?: string, sessionId?: string): Promise<void> {
    if (status === 'cancelled' && this.executing.has(taskId)) {
      throw new Error('this task\'s work has already started and cannot be cancelled; it will finish and deliver its result');
    }
    return super.updateTaskStatus(taskId, status, statusMessage, sessionId);
  }
}
```

Wiring inside `createTask`'s executor: pass `onItemStart: () => { store.executing.add(task.taskId); }` into `runAnalyzeExecution`; in the executor's `finally`, `store.executing.delete(task.taskId)`. Before each item executes (inside the `run`-wrapped fn, first statement via a check callback), consult `await extra.taskStore.getTask(task.taskId)` — if its status is `'cancelled'`, throw a sentinel `TaskCancelledError`; the executor catches that sentinel specifically and returns **without** calling `storeTaskResult` (the store already holds the cancelled state). This is what makes queued-cancel real: the slot frees, nothing executes, no result overwrites `cancelled`.

- [ ] **Step 4: Green + suite** — `npm run build && npx vitest run tests/taskLifecycle.test.ts` → PASS; `npm test` fully green.

- [ ] **Step 5: Mutation duty (§13)** — cancel-running-pretends: make `HonestCancelStore.updateTaskStatus` accept the cancel (delete the throw) — the refuse-cancel test must fail. Queued-cancel-executes-anyway: remove the pre-item cancelled check — the queued-cancel test must fail (manifest appears). TTL-deletes-files: add `rmSync(destinationPath, {recursive: true})` on handle expiry anywhere in the flow — the TTL test must fail. Restore all; name each kill in the report.

- [ ] **Step 6: Commit** — `git add src/mcp.ts tests/taskLifecycle.test.ts && git commit -m "feat: task status visibility, honest cancellation, handle-only TTL"`

---

### Task 7: Version, docs, and sweep

**Files:**
- Modify: `package.json`, `README.md`, `CLAUDE.md`, `docs/follow-ups.md`

- [ ] **Step 1: Version** — `package.json` `"version": "0.2.0"`. (The server info string in `src/mcp.ts` was set in Task 5.)

- [ ] **Step 2: README.** (1) In "Why this exists" bullets, the local-machine bullet gains: "Long analyses can run as MCP background tasks — the tool returns a handle immediately and pushes progress; see Background tasks below." (2) Update both tool signature blocks to the `videos` array shape with a one-item and a two-item example. (3) Replace the memory sentence in "Design constraints worth knowing" with the §6 rate claim verbatim: "~1.1 GB peak per concurrent analysis; total footprint ≈ concurrency × 1.1 GB. Default cap 4 ⇒ plan for ~4.5 GB worst case. `VIDEO_EXTRACT_MAX_CONCURRENCY=1` restores the old flat under-2GB behavior." (4) Add a "Background tasks" section after "The two tools": task-augmented calls return a handle; status messages (`"video 2/3: transcribing"`, `"queued, 1 ahead"`); queued tasks cancellable, running ones refuse honestly; handles expire (default 30 min, `VIDEO_EXTRACT_TASK_TTL_MS`) and die with the process while files at `destinationPath` are never deleted by the tool; requires an MCP client that supports the experimental tasks capability — plain calls work identically everywhere. (5) Env table gains `VIDEO_EXTRACT_MAX_CONCURRENCY` and `VIDEO_EXTRACT_TASK_TTL_MS` rows. (6) Library example updates to the batch shape. (7) Update the tests badge count to the final number.

- [ ] **Step 3: CLAUDE.md.** Update the staged-memory invariant: per-item staging unchanged, but the flat "under 2 GB" is now the §6 rate with the concurrency cap; add one line each for: the batch layout rule (flat at N=1, `video-N/` at N>1); the SDK being pinned exactly because of the experimental tasks API (upgrades are deliberate, run `tests/taskSpike.test.ts` first); cancellation honesty (queued cancels, running refuses — do not "fix" this into pretend-cancel).

- [ ] **Step 4: follow-ups.md** — add to §H: real cancellation of running work (process-tree kill of yt-dlp/ffmpeg/workers + cleanup, deferred by §8 with the honest-refusal contract in its place); a durable task store surviving server restarts (in-memory is deliberate; artifacts already survive at `destinationPath`); partial batch results before completion.

- [ ] **Step 5: Gates + leak check** — `npm test` green, `npm run typecheck` clean, `npm run matrix` exits 0 still reporting 0 of 11 executed. The pre-commit name-guard must pass on every commit (it scans staged content for personal identity strings; do not write those strings anywhere, including in scan commands — spell such checks as "the name-guard's patterns" exactly like this step does).

- [ ] **Step 6: Commit** — `git add package.json README.md CLAUDE.md docs/follow-ups.md && git commit -m "docs: 0.2.0 -- background tasks, batching, and the concurrency memory rate"`

---

## Deferred

Real cancellation of running work; durable task store; batch in the CLI; per-call RSS enforcement; partial batch results (all §14, recorded in follow-ups by Task 7).
