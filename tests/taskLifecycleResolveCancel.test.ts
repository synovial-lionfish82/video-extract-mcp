// tests/taskLifecycleResolveCancel.test.ts
//
// Isolated in its own file because it needs a module-level vi.mock() of the
// resolve leaf (src/resolve/index.ts) to slow a resolve down deterministically
// -- vi.mock() factories are hoisted and apply to this file's WHOLE module
// graph, which would corrupt every real-ffmpeg/real-local-file test in
// tests/taskLifecycle.test.ts if mixed into that file. Mirrors
// tests/resolveTool.test.ts's own proven mock-then-dynamic-import pattern for
// this exact module (src/resolve/index.js), just reached through a real,
// connected MCP client/server pair instead of calling resolveVideoTool
// directly, since this test needs the full task/cancellation machinery
// (buildServer, HonestCancelStore) that tests/resolveTool.test.ts never
// touches.
//
// Regression test for the post-commit review finding recorded in
// task-6-report.md's "Fix report" section: resolve_video's createTask
// handler originally never marked its task executing, so cancelTask() on a
// live resolve task always SUCCEEDED (status flipped to 'cancelled') while
// the download kept running and quietly finished underneath -- the exact
// dishonesty class spec §8 exists to rule out. Reproduced live by the
// reviewer with the network leaf mocked at a 1.8s delay; this test proves
// the fix the same way.
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const RESOLVE_DELAY_MS = 1800;

vi.mock('../src/resolve/index.js', () => ({
  resolve: async (url: string) => {
    await new Promise((res) => setTimeout(res, RESOLVE_DELAY_MS));
    // Metadata-only shape (returnVideo defaults false in this test's call,
    // so resolveOneVideoAttempt never touches filePath as a real file) --
    // matches ResolvedMedia's required fields exactly, no real video needed.
    return {
      status: 'ok', filePath: url, platform: 'mock', title: 'mock video', duration: 10,
      resolvedBy: 'direct', captions: { manual: null, auto: null }, languageHint: null, rangeApplied: false,
    };
  },
}));

// Dynamic import AFTER the mock is registered, same as
// tests/resolveTool.test.ts -- a static top-of-file import would resolve
// src/mcp.ts's transitive dependency on resolve/index.js before the mock is
// in place.
const { buildServer } = await import('../src/mcp.js');

// connectClient: same helper as tests/taskLifecycle.test.ts (including its
// own listTools() addition over tests/mcp.test.ts's original) -- duplicated
// rather than shared, since this file needs to live separately for the
// vi.mock() isolation reason above.
async function connectClient(server: McpServer): Promise<Client> {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'norma-test-client', version: '0.0.1' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  await client.listTools();
  return client;
}

type StreamMsg = {
  type: string;
  task?: { taskId: string; status: string; statusMessage?: string };
  result?: { content: Array<{ type: string; text: string }> };
};

describe('resolve_video honest cancellation (spec §8 -- post-commit review finding)', () => {
  it('a running resolve task refuses cancellation and still delivers its result', async () => {
    const server = buildServer();
    const client = await connectClient(server);
    const destDir = mkdtempSync(join(tmpdir(), 'norma-lifecycle-resolve-refuse-'));

    const stream = client.experimental.tasks.callToolStream({
      name: 'resolve_video',
      arguments: { destinationPath: destDir, videos: [{ url: 'https://example.test/mock-video' }] },
    }) as AsyncGenerator<StreamMsg>;
    const first = await stream.next();
    expect((first.value as StreamMsg).type).toBe('taskCreated');
    const taskId = (first.value as StreamMsg).task!.taskId;

    // Unlike analyze_video, resolve_video has no queued phase and no
    // per-stage status messages to poll for -- the fix marks it executing
    // synchronously, as the very first statement of its executor, before
    // the client can even learn this taskId (createTask's own handler
    // hasn't returned yet at that point). A short, fixed wait -- well
    // under the mocked resolve's 1800ms delay, comfortably after task
    // creation's own synchronous marking -- is all that is needed here.
    await new Promise((res) => setTimeout(res, 100));

    const outcome = await client.experimental.tasks.cancelTask(taskId).then(
      (r) => ({ ok: true as const, r }),
      (e: unknown) => ({ ok: false as const, e: String(e) }),
    );

    // Same pinned shape as analyze_video's own refuse-cancel test
    // (tests/taskLifecycle.test.ts): cancelTask() REJECTS with an McpError
    // wrapped "Failed to cancel task:" plus HonestCancelStore's own message.
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable: asserted outcome.ok === false above');
    expect(outcome.e).toContain('Failed to cancel task');
    expect(outcome.e).toContain("this task's work has already started and cannot be cancelled");
    expect(outcome.e).toContain('it will finish and deliver its result');

    // The refused attempt left status untouched -- still 'working', not
    // silently reporting 'cancelled' while the mocked download keeps
    // running in the background (the exact dishonesty this fix closes).
    const afterRefusal = await client.experimental.tasks.getTask(taskId);
    expect(afterRefusal.status).toBe('working');

    // Drain to completion: the executor is uninterrupted, and its result is
    // intact and genuinely delivered -- not silently dropped because the
    // (refused) cancel attempt left anything in a broken state.
    let finalContent: Array<{ type: string; text: string }> | undefined;
    let terminalStatus: string | undefined;
    for await (const msg of stream) {
      if (msg.type === 'taskStatus') terminalStatus = msg.task!.status;
      if (msg.type === 'result') finalContent = msg.result!.content;
    }
    expect(terminalStatus).toBe('completed');
    const parsed = JSON.parse(finalContent![0]!.text) as { videos: Array<{ status: string }> };
    expect(parsed.videos[0]!.status).toBe('ok');

    await client.close();
  }, 15_000);
});
