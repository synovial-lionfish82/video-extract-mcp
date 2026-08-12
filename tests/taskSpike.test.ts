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
  // DEVIATION FROM THE BRIEF'S STARTING POINT #1 (recorded per the task
  // instructions: "if anything in the brief contradicts what the SDK
  // actually does, the SDK's observed behavior wins -- record the
  // discrepancy"). The brief's server construction omitted `capabilities`.
  // Traced in server/index.js: `this._capabilities = options?.capabilities
  // ?? {}` -- capabilities are NEVER inferred from the presence of
  // `taskStore`; registerToolTask() (mcp-server.js) doesn't register any
  // capability either. Without an explicit `tasks` capability the server's
  // `initialize` response omits it, so the client's `isToolTask()` (see
  // client/index.js) is permanently false regardless of what a tool's own
  // `execution.taskSupport` says, which silently collapses
  // callToolStream()/cancelTask() onto the exact same automatic-polling
  // fallback fact (a) already exercises -- they'd never touch the real
  // task-augmented path this spike exists to observe. This declaration is
  // the fix; the exact shape (list/cancel/requests.tools.call) is taken
  // from `ServerTasksCapabilitySchema` in the SDK's own types.js.
  const server = new McpServer(
    { name: 'spike', version: '0.0.1' },
    { taskStore: store, capabilities: { tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } } } },
  );
  const running = new Set<string>();
  // DEVIATION FROM THE BRIEF'S STARTING POINT #3, added only to make fact
  // (c) observable. The brief's createTask handler has no catch around the
  // detached `void (async () => {...})()` IIFE. That is fine as long as
  // storeTaskResult() always succeeds (true for facts (a)/(b)) -- but fact
  // (c) cancels the task out from under this executor, and
  // InMemoryTaskStore.storeTaskResult() refuses to store a result for a task
  // already in a terminal state (see fact (c)-4 below). With no catch, that
  // throw becomes an unhandled rejection in a promise nothing awaits, which
  // crashes the vitest worker instead of letting the test observe/assert on
  // it. This array captures the failure instead of swallowing or crashing.
  const executorErrors: Array<{ taskId: string; error: string }> = [];
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
          } catch (err) {
            executorErrors.push({ taskId: task.taskId, error: String(err) });
          } finally { running.delete(task.taskId); }
        })();
        return { task };
      },
      getTask: async (_args, extra) => extra.taskStore.getTask(extra.taskId),
      getTaskResult: async (_args, extra) =>
        (await extra.taskStore.getTaskResult(extra.taskId)) as import('@modelcontextprotocol/sdk/types.js').CallToolResult,
    },
  );
  return { server, store, running, executorErrors };
}

async function connect(server: McpServer): Promise<Client> {
  const [st, ct] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'spike-client', version: '0.0.1' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  // DEVIATION FROM THE BRIEF'S STARTING POINT #2. Even with the server
  // capability fix above in place, `client.experimental.tasks.isToolTask()`
  // (client/index.js) has a SECOND, independent gate: it also requires
  // `name` to be present in `_cachedKnownTaskTools`, a cache populated
  // *exclusively* inside `listTools()` (`cacheToolMetadata()` is only ever
  // called from there). A freshly-connected client that never called
  // listTools() has an empty cache, so `callToolStream()` still falls back
  // silently to the plain, non-task-augmented request path -- no error, no
  // warning, just a single 'result' message with no 'taskCreated'/
  // 'taskStatus' at all (confirmed: this is exactly what happened before
  // this line was added, even after fixing capabilities above). Real
  // clients that want streaming task status must call listTools() (or pass
  // `{ task: {} }` explicitly per call) before callToolStream() -- worth
  // knowing for Task 6's own tests, which will hit the same trap.
  await client.listTools();
  return client;
}

/**
 * Records every call reaching the raw store's updateTaskStatus, whoever the
 * caller is (a tool handler via the per-request wrapper, or -- the question
 * fact (c) exists to answer -- the server's own tasks/cancel handler).
 */
class RecordingTaskStore extends InMemoryTaskStore {
  readonly updateTaskStatusCalls: Array<{
    taskId: string;
    status: Parameters<InMemoryTaskStore['updateTaskStatus']>[1];
    statusMessage?: string;
  }> = [];

  override async updateTaskStatus(
    taskId: string,
    status: Parameters<InMemoryTaskStore['updateTaskStatus']>[1],
    statusMessage?: string,
    sessionId?: string,
  ): Promise<void> {
    this.updateTaskStatusCalls.push({ taskId, status, statusMessage });
    return super.updateTaskStatus(taskId, status, statusMessage, sessionId);
  }
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

    // FACT (b), PINNED. Observed sequence, deterministic given the ~33x
    // margin between workMs=30 and the store's default pollInterval=1000ms
    // (InMemoryTaskStore.createTask sets `pollInterval: taskParams.pollInterval
    // ?? 1000`; the spike never overrides it):
    //   1. 'taskCreated'         -- synchronous reply to the task-augmented
    //                               tools/call; task.status is already
    //                               'working' (InMemoryTaskStore.createTask
    //                               sets that as the initial status).
    //   2. 'taskStatus:working'  -- the FIRST poll iteration in
    //                               Protocol.requestStream() (shared/protocol.js)
    //                               runs immediately after 'taskCreated', with
    //                               NO wait beforehand; it observes 'working'
    //                               because the store's status genuinely is
    //                               'working' (whether or not the executor's
    //                               own explicit updateTaskStatus('working',
    //                               'spiking') call has landed yet -- either
    //                               way the *status* reads 'working').
    //   3. 'taskStatus:completed'-- the SECOND poll, after waiting one full
    //                               pollInterval (1000ms), by which time the
    //                               30ms of simulated work is long finished
    //                               and storeTaskResult('completed', ...) has
    //                               run.
    //   4. 'result'               -- terminal status triggers tasks/result.
    // Mechanism, NOT visible from this assertion alone but traced directly in
    // shared/protocol.js and worth recording here because it changes what
    // "surfaces to the client" means: `taskStatus` messages come from the
    // CLIENT'S OWN tasks/get POLLING LOOP (`await this.getTask(...)` on every
    // iteration), not from consuming the server's pushed
    // `notifications/tasks/status` messages. The server DOES send that
    // notification -- confirmed by reading requestTaskStore()'s
    // updateTaskStatus/storeTaskResult wrappers, which call `this.notification()`
    // after every store write reachable through a tool handler's
    // `extra.taskStore` -- but the default Client installs no handler for
    // `notifications/tasks/status`, and callToolStream()'s stream is built
    // entirely from polling, independent of that push. Practical
    // consequence for Task 6: rapid or closely-spaced updateTaskStatus calls
    // within one pollInterval will be COALESCED into a single taskStatus
    // message (only the latest status at poll time is ever seen), and status
    // visibility is delayed by up to one pollInterval unless the task sets a
    // shorter one via `createTask({ pollInterval })`.
    expect(seen).toEqual(['taskCreated', 'taskStatus:working', 'taskStatus:completed', 'result']);
  });

  it('(c) cancellation routing: cancelTask on a running task -- observe and pin', async () => {
    const recordingStore = new RecordingTaskStore();
    const { server, running, executorErrors } = buildSpikeServer(300, recordingStore);
    const client = await connect(server);
    const stream = client.experimental.tasks.callToolStream({ name: 'spike_tool', arguments: { label: 'x' } });
    const first = await stream.next();
    const taskId = (first.value as { task: { taskId: string } }).task.taskId;
    await sleep(50);                       // executor is mid-flight
    expect(running.size).toBe(1);

    const outcome = await client.experimental.tasks.cancelTask(taskId).then(
      (r) => ({ ok: true as const, r }), (e: unknown) => ({ ok: false as const, e: String(e) }));

    // FACT (c)-1, PINNED. cancelTask() against a running (non-terminal) task
    // RESOLVES -- it does not throw/reject. It returns the task's new state
    // directly (CancelTaskResultSchema = ResultSchema.merge(TaskSchema), so
    // fields like `status`/`taskId` are top-level, not nested under `.task`),
    // already flipped to 'cancelled', with a fixed statusMessage the SDK
    // hardcodes in shared/protocol.js's CancelTaskRequestSchema handler.
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable: asserted outcome.ok === true above');
    expect(outcome.r.status).toBe('cancelled');
    expect(outcome.r.taskId).toBe(taskId);
    expect(outcome.r.statusMessage).toBe('Client cancelled task execution.');

    // FACT (c)-2, PINNED -- the routing question itself, answered
    // definitively via the recording override rather than by inference from
    // reading the source. tasks/cancel reaches the store's updateTaskStatus
    // DIRECTLY: shared/protocol.js's CancelTaskRequestSchema handler calls
    // `this._taskStore.updateTaskStatus(taskId, 'cancelled', 'Client
    // cancelled task execution.', sessionId)` on the RAW store instance
    // (`this._taskStore`, set once from `new McpServer(..., { taskStore })`)
    // -- NOT through the per-request wrapper (`requestTaskStore()`) that tool
    // handlers receive as `extra.taskStore` and that also fires
    // notifications/tasks/status (see fact (b)'s comment). Two calls are
    // recorded below in call order: the executor's own 'working' transition
    // (made through the wrapper, which still delegates to this same raw
    // store), then cancellation's 'cancelled' transition (made directly).
    // Consequence for Task 6's HonestCancelStore: overriding
    // updateTaskStatus on a store subclass is sufficient to observe AND to
    // refuse/veto a cancel (e.g. by throwing for 'cancelled' transitions on
    // tasks the store considers not-yet-safe-to-cancel), because the
    // cancel-routing handler has no separate code path that bypasses it.
    expect(recordingStore.updateTaskStatusCalls).toEqual([
      { taskId, status: 'working', statusMessage: 'spiking' },
      { taskId, status: 'cancelled', statusMessage: 'Client cancelled task execution.' },
    ]);

    // FACT (c)-3, PINNED. getTask() immediately after cancellation reports
    // 'cancelled' -- the same store state tasks/get reads was already
    // updated synchronously as part of handling tasks/cancel, so there is no
    // propagation delay/race for a caller that reads via getTask right after
    // cancelTask() resolves.
    const afterCancel = await client.experimental.tasks.getTask(taskId);
    expect(afterCancel.status).toBe('cancelled');

    // FACT (c)-4, PINNED. The running executor is NOT interrupted by
    // cancellation: nothing in InMemoryTaskStore or the createTask/getTask/
    // getTaskResult handler triple wires an AbortSignal or any other kill
    // hook from tasks/cancel through to the in-flight async work (matches
    // spec §14, "real cancellation of running work... out of scope"). The
    // executor keeps running, reaches storeTaskResult('completed', ...)
    // after its full workMs, and InMemoryTaskStore.storeTaskResult() REFUSES
    // it: 'cancelled' is a terminal status (isTerminal() in interfaces.js
    // treats completed/failed/cancelled alike), and storeTaskResult()
    // explicitly rejects writes against a task already in a terminal status
    // with "Cannot store result for task <id> in terminal status
    // 'cancelled'. Task results can only be stored once." The executor does
    // NOT overwrite the cancelled state -- it fails instead, and the
    // cancelled status stands as the durable outcome.
    await sleep(300); // >= remaining workMs (300 - 50 elapsed already), so the executor has definitely tried storeTaskResult by now
    expect(running.size).toBe(0); // executor's finally block ran; no longer "running"
    expect(executorErrors).toHaveLength(1);
    expect(executorErrors[0]!.taskId).toBe(taskId);
    expect(executorErrors[0]!.error).toContain("terminal status 'cancelled'");

    // Belt-and-suspenders: the store's status after the executor's refused
    // write is still 'cancelled', not silently reverted to 'completed'.
    const finalTask = await client.experimental.tasks.getTask(taskId);
    expect(finalTask.status).toBe('cancelled');
  });

  it('(c) VETO: a store that refuses the cancelled transition blocks tasks/cancel without corrupting task state', async () => {
    // FACT (c)-2 above was traced from shared/protocol.js's source (the
    // CancelTaskRequestSchema handler's catch block re-wraps a non-McpError
    // throw as `McpError(InvalidRequest, "Failed to cancel task: " +
    // message)`) but never actually EXERCISED -- and this file's own history
    // (deviations #1/#2) is a direct lesson that source-reading alone was
    // twice insufficient to predict this SDK's real behavior. Task 6's
    // HonestCancelStore design depends on a store being able to refuse a
    // cancel, so that path gets its own empirical test here rather than
    // resting on inference (spec §13 also names this scenario: "running
    // task's cancel is refused and the task still completes" -- see the
    // FACT (c)-VETO-3 comment below for how the "still completes" half was
    // verified).
    class VetoingTaskStore extends InMemoryTaskStore {
      override async updateTaskStatus(
        taskId: string,
        status: Parameters<InMemoryTaskStore['updateTaskStatus']>[1],
        statusMessage?: string,
        sessionId?: string,
      ): Promise<void> {
        if (status === 'cancelled') {
          throw new Error('VETO: this store refuses to cancel this task');
        }
        return super.updateTaskStatus(taskId, status, statusMessage, sessionId);
      }
    }
    const vetoStore = new VetoingTaskStore();
    const { server, running } = buildSpikeServer(150, vetoStore);
    const client = await connect(server);
    const stream = client.experimental.tasks.callToolStream({ name: 'spike_tool', arguments: { label: 'veto' } });
    const first = await stream.next();
    const taskId = (first.value as { task: { taskId: string } }).task.taskId;
    await sleep(50); // executor is mid-flight
    expect(running.size).toBe(1);

    const outcome = await client.experimental.tasks.cancelTask(taskId).then(
      (r) => ({ ok: true as const, r }), (e: unknown) => ({ ok: false as const, e: String(e) }));

    // FACT (c)-VETO-1, PINNED. cancelTask() REJECTS (does not resolve) when
    // the store's updateTaskStatus throws for the 'cancelled' transition.
    // The client observes this as a rejected promise carrying the
    // server-side McpError, wrapped with a "Failed to cancel task:" prefix
    // plus the store's own thrown message.
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable: asserted outcome.ok === false above');
    expect(outcome.e).toContain('Failed to cancel task');
    expect(outcome.e).toContain('VETO: this store refuses to cancel this task');

    // FACT (c)-VETO-2, PINNED. The refused cancel attempt left the task's
    // status UNCHANGED -- still 'working', not 'cancelled'. A vetoed cancel
    // is a true no-op on task state, not a partial/inconsistent transition.
    const afterVetoedCancel = await client.experimental.tasks.getTask(taskId);
    expect(afterVetoedCancel.status).toBe('working');

    // FACT (c)-VETO-3 is NOT asserted here (see the report's "veto path"
    // section for why: this exact test shape, extended with a further wait
    // plus post-cancel getTask()/getTaskResult() calls to confirm the
    // executor completes normally afterward, triggered a reproducible but
    // unexplained vitest-environment-only crash deep inside the SDK's own
    // response handling -- reproduced 15/15 runs in that shape, absent in a
    // byte-for-byte equivalent plain Node script, and absent again once
    // those trailing calls were removed, which is what this test now is).
    // FACT (c)-VETO-3 ("the executor's storeTaskResult then succeeds and the
    // task completes normally") was instead confirmed via a standalone
    // out-of-band script run directly under Node (not vitest) against this
    // same SDK version -- see the report for the transcript. Task 6 should
    // budget time for this if its own HonestCancelStore tests combine
    // callToolStream() with post-cancel polling in one test.
  });
});
