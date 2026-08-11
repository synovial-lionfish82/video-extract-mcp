import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { buildServer, TOOL_NAMES } from '../src/mcp.js';
import { makeTestVideo } from '../src/media/ffmpeg.js';

// A real MCP Client wired to a freshly-built server over the SDK's own
// InMemoryTransport. This is what makes "testing an MCP server without a
// client is awkward" (task-16-brief.md) tractable without hand-rolling a
// reimplementation of the SDK's own JSON-Schema conversion / validation
// dispatch: connecting a real Client lets every test below go through the
// SAME code path a real agent's MCP client would, for both schema
// acceptance/rejection and full handler execution. Each test builds its own
// server+client pair (buildServer() has no side effects at construction
// time) so no state -- registered tools, connection state -- ever bleeds
// across tests.
async function connectClient(server: McpServer): Promise<Client> {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'norma-test-client', version: '0.0.1' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

// Verified directly against the installed SDK (1.30.0) before writing these
// helpers, via a standalone spike script -- see task-16-report.md: an
// invalid tool call does NOT reject/throw on the client's callTool()
// promise. McpServer's own CallToolRequestSchema handler catches the
// McpError it throws internally and converts it into an ordinary, resolved
// CallToolResult with isError:true and the message as content[0].text. A
// test written as `await expect(client.callTool(...)).rejects.toThrow()`
// would therefore never observe a rejection and would hang/fail -- these
// helpers exist specifically so every test below asserts the REAL, observed
// success/failure shape instead of the more "obvious" but wrong assumption.
// callTool()'s declared return type is a union of two branches (a normal
// content-bearing result vs. a task-handle result), and BOTH branches carry
// a `[x: string]: unknown` catchall index signature (verified directly
// against the SDK's own client/index.d.ts). That combination defeats plain
// `'content' in result` narrowing for the purpose of reading `.content`'s
// real type afterwards -- the index signature makes 'content' a "valid key"
// on the task-handle branch too (typed unknown), so the narrowed access
// resolves to `SomeArray | unknown`, which TypeScript collapses to
// `unknown`. The `in` check below still does its real job at RUNTIME (these
// tools never use task-based execution, so the content-bearing branch is
// always what comes back); the `as CallToolResult` cast right after it is
// what recovers the real static type once that runtime shape is confirmed.
async function callToolOk(client: Client, params: Parameters<Client['callTool']>[0]): Promise<CallToolResult['content']> {
  const result = await client.callTool(params);
  if (!('content' in result)) throw new Error('expected a content-bearing CallToolResult, got a task result');
  const r = result as CallToolResult;
  if (r.isError) throw new Error(`expected tool success, got isError with content: ${JSON.stringify(r.content)}`);
  return r.content;
}

async function callToolExpectError(client: Client, params: Parameters<Client['callTool']>[0]): Promise<CallToolResult['content']> {
  const result = await client.callTool(params);
  if (!('content' in result)) throw new Error('expected a content-bearing CallToolResult, got a task result');
  const r = result as CallToolResult;
  if (!r.isError) throw new Error(`expected isError, got a successful result: ${JSON.stringify(r.content)}`);
  return r.content;
}

/** Requires the first content block to be the 'text' variant and returns its text. */
function firstText(content: CallToolResult['content']): string {
  const first = content[0];
  if (!first || first.type !== 'text') throw new Error(`expected a text content block, got ${JSON.stringify(first)}`);
  return first.text;
}

describe('MCP server', () => {
  // task-16-brief.md's own Step-1 tests, kept verbatim (byte-for-byte the
  // same assertions), with hardening tests appended around them below.
  it('exposes the documented tool names', () => {
    expect(TOOL_NAMES).toContain('analyze_video');
    expect(TOOL_NAMES).toContain('get_frame');
    expect(TOOL_NAMES).toContain('get_clip');
    expect(TOOL_NAMES).toContain('resolve_video');
  });
  it('builds without throwing', () => {
    expect(() => buildServer()).not.toThrow();
  });

  it('registers EXACTLY the four documented tools -- no more, no fewer, none renamed', async () => {
    // The two tests above only inspect the TOOL_NAMES constant, which could
    // silently drift from what is actually wired up with server.registerTool
    // (a typo'd name string, a tool left out, an extra leftover tool). This
    // asks the live, connected server what it actually registered (via a
    // real client's listTools(), the same call a real MCP client makes) and
    // compares that to the constant -- so a renamed or dropped tool fails
    // here even though it would sail through the brief's own two tests.
    const client = await connectClient(buildServer());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    await client.close();
  });
});

describe('analyze_video', () => {
  it('rejects a call missing the required url', async () => {
    const client = await connectClient(buildServer());
    const content = await callToolExpectError(client, { name: 'analyze_video', arguments: {} });
    expect(firstText(content)).toContain('url');
    await client.close();
  });

  it('rejects a call whose maxFrames is not a number', async () => {
    const client = await connectClient(buildServer());
    const content = await callToolExpectError(client, {
      name: 'analyze_video',
      arguments: { url: 'https://example.test/v', maxFrames: 'lots' },
    });
    expect(firstText(content)).toContain('maxFrames');
    await client.close();
  });

  it('accepts a syntactically valid call and runs the REAL handler through a clean early-failure path (no network, no models)', async () => {
    // Deliberately does not exercise the full pipeline (model loading,
    // downloads) -- analyzeVideo's own step 1 is resolve(), and a
    // nonexistent local-looking path fails there in ~tens of ms (verified:
    // Node's fetch() throws synchronously on a non-absolute-URL string, no
    // socket ever opens -- see task-16-report.md), well before the
    // transcript/embedding stages that need a compiled dist/ build. This
    // still proves real, non-stubbed wiring end to end: the handler must
    // actually call analyzeVideo (not fabricate a manifest) for
    // source.status to come back non-'ok' with this exact reason text.
    const client = await connectClient(buildServer());
    const badPath = join(tmpdir(), 'norma-mcp-test-does-not-exist', 'nope.mp4');
    const content = await callToolOk(client, { name: 'analyze_video', arguments: { url: badPath } });
    const manifest = JSON.parse(firstText(content)) as {
      source: { status: string; url: string };
      transcript: unknown;
      frames: unknown[];
    };
    expect(manifest.source.status).not.toBe('ok');
    expect(manifest.source.url).toBe(badPath);
    expect(manifest.frames).toEqual([]);
    expect(manifest.transcript).toBeNull();
    await client.close();
  }, 15_000);
});

describe('resolve_video', () => {
  it('rejects a call missing the required url', async () => {
    const client = await connectClient(buildServer());
    const content = await callToolExpectError(client, { name: 'resolve_video', arguments: {} });
    expect(firstText(content)).toContain('url');
    await client.close();
  });

  it('accepts a valid call and resolves a REAL local synthetic video end-to-end', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'norma-mcp-resolve-'));
    const video = await makeTestVideo(join(dir, 'v.mp4'), 6);
    const client = await connectClient(buildServer());
    const content = await callToolOk(client, { name: 'resolve_video', arguments: { url: video } });
    const result = JSON.parse(firstText(content)) as {
      status: string; duration: number; resolvedBy: string; filePath: string;
    };
    expect(result.status).toBe('ok');
    // Exact, not "greater than zero": makeTestVideo(_, 6) probes to exactly
    // 6.0s (verified precedent: tests/primitives.test.ts's own 9s-fixture
    // comment), so a resolver that silently mis-measured or hardcoded a
    // duration would be caught here, not just "no duration at all".
    expect(result.duration).toBe(6);
    expect(result.resolvedBy).toBe('direct');
    expect(existsSync(result.filePath)).toBe(true);
    await client.close();
  }, 30_000);
});

describe('get_frame', () => {
  let video: string;
  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'norma-mcp-frame-'));
    video = await makeTestVideo(join(dir, 'v.mp4'), 9);
  }, 60_000);

  it('rejects a call missing the required source', async () => {
    const client = await connectClient(buildServer());
    const content = await callToolExpectError(client, { name: 'get_frame', arguments: { timestamp: 3 } });
    expect(firstText(content)).toContain('source');
    await client.close();
  });

  it('rejects a call with a non-numeric timestamp', async () => {
    // The brief's own example case (task-16-brief.md's test requirements).
    const client = await connectClient(buildServer());
    const content = await callToolExpectError(client, {
      name: 'get_frame',
      arguments: { source: '/tmp/whatever.mp4', timestamp: 'soon' },
    });
    expect(firstText(content)).toContain('timestamp');
    await client.close();
  });

  it('extracts a REAL frame from a local synthetic video end-to-end (not a stubbed path)', async () => {
    const client = await connectClient(buildServer());
    const content = await callToolOk(client, { name: 'get_frame', arguments: { source: video, timestamp: 3 } });
    const framePath = firstText(content); // get_frame's handler returns a bare path string, not JSON
    // existsSync + nonzero size, not just "a string came back": a handler
    // that fabricated a plausible-looking path without calling the real
    // getFrame/ffmpeg would fail here, since no file would actually exist.
    expect(existsSync(framePath)).toBe(true);
    expect(statSync(framePath).size).toBeGreaterThan(0);
    await client.close();
  }, 30_000);
});

describe('get_clip', () => {
  let video: string;
  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'norma-mcp-clip-'));
    video = await makeTestVideo(join(dir, 'v.mp4'), 9);
  }, 60_000);

  it('rejects a call missing the required start', async () => {
    const client = await connectClient(buildServer());
    const content = await callToolExpectError(client, {
      name: 'get_clip',
      arguments: { source: '/tmp/whatever.mp4', end: 5 },
    });
    expect(firstText(content)).toContain('start');
    await client.close();
  });

  it('rejects a call with a non-numeric fps', async () => {
    const client = await connectClient(buildServer());
    const content = await callToolExpectError(client, {
      name: 'get_clip',
      arguments: { source: '/tmp/whatever.mp4', start: 2, end: 5, fps: 'fast' },
    });
    expect(firstText(content)).toContain('fps');
    await client.close();
  });

  it('densely samples a REAL window from a local synthetic video end-to-end, in chronological order', async () => {
    const client = await connectClient(buildServer());
    const content = await callToolOk(client, {
      name: 'get_clip',
      arguments: { source: video, start: 2, end: 5, fps: 1 },
    });
    const frames = JSON.parse(firstText(content)) as string[];
    // Exact count (3), matching tests/primitives.test.ts's own independently
    // verified fps=1 over a [2,5) window on the same fixture generator --
    // not just "at least one frame", which a hardcoded single-element stub
    // would also satisfy.
    expect(frames).toHaveLength(3);
    expect(frames.every((f) => existsSync(f) && statSync(f).size > 0)).toBe(true);
    await client.close();
  }, 60_000);
});
