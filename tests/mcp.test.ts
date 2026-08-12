import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
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

// task-8-brief.md's own Step-1 tests, kept verbatim (byte-for-byte the same
// assertions). The four-tool surface this replaces (analyze_video,
// resolve_video, get_frame, get_clip) is gone; get_frame/get_clip remain as
// internal helpers in src/primitives.ts (see task-9) but are no longer
// reachable through this server at all.
describe('v2 surface', () => {
  it('exposes exactly two tools', () => {
    expect([...TOOL_NAMES].sort()).toEqual(['analyze_video', 'resolve_video']);
  });
  it('no longer exposes get_frame or get_clip', () => {
    expect(TOOL_NAMES).not.toContain('get_frame');
    expect(TOOL_NAMES).not.toContain('get_clip');
  });
  it('builds without throwing', () => {
    expect(() => buildServer()).not.toThrow();
  });

  it('registers EXACTLY the two documented tools -- no more, no fewer, none renamed', async () => {
    // The three tests above only inspect the TOOL_NAMES constant, which
    // could silently drift from what is actually wired up with
    // server.registerTool (a typo'd name string, a tool left out, an extra
    // leftover tool). This asks the live, connected server what it actually
    // registered (via a real client's listTools(), the same call a real MCP
    // client makes) and compares that to the constant -- so a renamed or
    // dropped tool fails here even though it would sail through the
    // constant-only checks above.
    const client = await connectClient(buildServer());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    await client.close();
  });

  it('marks both tools as NOT read-only (Fix 4c): both write to the filesystem, and resolve_video moves a caller-owned file in one branch', async () => {
    // The SDK defines readOnlyHint as "the tool does not modify its
    // environment" -- both tools write metadata/manifest/transcript/frame
    // files to destinationPath, so readOnlyHint:true was a false claim
    // clients make trust decisions on. Reads the LIVE schema via
    // listTools(), not a hardcoded constant compared to itself.
    const client = await connectClient(buildServer());
    const { tools } = await client.listTools();
    for (const name of TOOL_NAMES) {
      const tool = tools.find((t) => t.name === name);
      if (!tool) throw new Error(`${name} not found in listTools()`);
      expect(tool.annotations?.readOnlyHint).toBe(false);
    }
    await client.close();
  });
});

describe('resolve_video', () => {
  it('rejects a call missing the required url', async () => {
    const client = await connectClient(buildServer());
    const dir = mkdtempSync(join(tmpdir(), 'norma-mcp-rv-'));
    const content = await callToolExpectError(client, { name: 'resolve_video', arguments: { destinationPath: dir } });
    expect(firstText(content)).toContain('url');
    await client.close();
  });

  it('rejects a call missing the required destinationPath', async () => {
    const client = await connectClient(buildServer());
    const content = await callToolExpectError(client, { name: 'resolve_video', arguments: { url: 'https://x/v' } });
    expect(firstText(content)).toContain('destinationPath');
    await client.close();
  });

  it("start/end descriptions state the both-or-neither requirement (task-9 Step 6): passing only one is ignored and fetches the whole video", async () => {
    // Task 8's review found neither tool's description said what happens
    // when a range is only half-specified. resolve_video's own range gate
    // (src/resolve/ytdlp.ts:241 -- wantsRange requires BOTH opts.start and
    // opts.end -- and src/agent/resolveTool.ts:82's local-trim fallback,
    // gated the same way) silently treats a lone start or end as no range
    // at all and returns the whole video. Reads the description straight
    // off the LIVE registered schema via listTools(), NOT a hardcoded
    // string also written in this file -- a constant compared to itself
    // would pass regardless of what src/mcp.ts actually says, which is
    // exactly the trap this test is written to avoid.
    const client = await connectClient(buildServer());
    const { tools } = await client.listTools();
    const resolveVideo = tools.find((t) => t.name === 'resolve_video');
    if (!resolveVideo) throw new Error('resolve_video not found in listTools()');
    const props = resolveVideo.inputSchema.properties as Record<string, { description?: string }> | undefined;
    const startDesc = props?.start?.description ?? '';
    const endDesc = props?.end?.description ?? '';
    expect(startDesc).toMatch(/either alone is ignored/i);
    expect(startDesc.toLowerCase()).toContain('whole video');
    expect(endDesc).toMatch(/either alone is ignored/i);
    expect(endDesc.toLowerCase()).toContain('whole video');
    await client.close();
  });

  it('accepts a valid call and resolves a REAL local synthetic video end-to-end, downloading it when returnVideo is requested', async () => {
    const srcDir = mkdtempSync(join(tmpdir(), 'norma-mcp-resolve-src-'));
    const video = await makeTestVideo(join(srcDir, 'v.mp4'), 6);
    const destDir = mkdtempSync(join(tmpdir(), 'norma-mcp-resolve-dest-'));
    const client = await connectClient(buildServer());
    const content = await callToolOk(client, {
      name: 'resolve_video',
      arguments: { url: video, destinationPath: destDir, returnVideo: true },
    });
    const result = JSON.parse(firstText(content)) as {
      status: string; duration: number; platform: string; videoPath: string; metadataPath: string;
    };
    expect(result.status).toBe('ok');
    // Exact, not "greater than zero": makeTestVideo(_, 6) probes to exactly
    // 6.0s (verified precedent: tests/primitives.test.ts's own 9s-fixture
    // comment), so a resolver that silently mis-measured or hardcoded a
    // duration would be caught here, not just "no duration at all".
    expect(result.duration).toBe(6);
    // 'local', not e.g. a fabricated 'direct' or 'youtube': proves resolve()'s
    // real bare-filesystem-path branch actually ran, rather than a stub that
    // fabricated a plausible-looking platform string.
    expect(result.platform).toBe('local');
    expect(existsSync(result.videoPath)).toBe(true);
    expect(existsSync(result.metadataPath)).toBe(true);
    await client.close();
  }, 30_000);

  it('does NOT download media by default -- metadata only (spec §2.1, the tool description\'s central claim)', async () => {
    // Same real video as above, but returnVideo is omitted. This exercises
    // the schema's own `returnVideo` default reaching resolveVideoTool
    // through a live client call -- tests/resolveTool.test.ts already proves
    // resolveVideoTool's own default at the function-call level, but not
    // that the MCP schema actually wires it through unchanged.
    const srcDir = mkdtempSync(join(tmpdir(), 'norma-mcp-resolve-src-'));
    const video = await makeTestVideo(join(srcDir, 'v.mp4'), 6);
    const destDir = mkdtempSync(join(tmpdir(), 'norma-mcp-resolve-dest2-'));
    const client = await connectClient(buildServer());
    const content = await callToolOk(client, {
      name: 'resolve_video',
      arguments: { url: video, destinationPath: destDir },
    });
    const result = JSON.parse(firstText(content)) as { status: string; videoPath?: string; nextSteps?: string };
    expect(result.status).toBe('ok');
    expect(result.videoPath).toBeUndefined();
    expect(result.nextSteps).toMatch(/returnVideo/);
    await client.close();
  }, 30_000);
});

describe('analyze_video', () => {
  it('rejects a call missing the required pathOrUrl', async () => {
    const client = await connectClient(buildServer());
    const dir = mkdtempSync(join(tmpdir(), 'norma-mcp-av-'));
    const content = await callToolExpectError(client, { name: 'analyze_video', arguments: { destinationPath: dir } });
    expect(firstText(content)).toContain('pathOrUrl');
    await client.close();
  });

  it('rejects a call missing the required destinationPath', async () => {
    const client = await connectClient(buildServer());
    const content = await callToolExpectError(client, { name: 'analyze_video', arguments: { pathOrUrl: 'https://x/v' } });
    expect(firstText(content)).toContain('destinationPath');
    await client.close();
  });

  it('accepts frames: "even"', async () => {
    // "Accepts" means the SCHEMA lets the call through (isError:false from
    // the MCP layer) -- not that the underlying analysis succeeds. The path
    // below is deliberately unresolvable so the handler fails fast, which is
    // exactly what proves this wasn't rejected at validation: a schema
    // bounce and a handler-level failure return different isError shapes,
    // and only callToolOk (isError:false) is consistent with the former
    // never happening.
    const client = await connectClient(buildServer());
    const dir = mkdtempSync(join(tmpdir(), 'norma-mcp-av-even-'));
    const badPath = join(tmpdir(), 'norma-mcp-test-does-not-exist', 'nope.mp4');
    const content = await callToolOk(client, {
      name: 'analyze_video',
      arguments: { pathOrUrl: badPath, destinationPath: dir, frames: 'even' },
    });
    const result = JSON.parse(firstText(content)) as { status: string };
    expect(result.status).not.toBe('ok');
    await client.close();
  }, 15_000);

  it('rejects frames: "dense" (not one of the enum values)', async () => {
    const client = await connectClient(buildServer());
    const dir = mkdtempSync(join(tmpdir(), 'norma-mcp-av-dense-'));
    const content = await callToolExpectError(client, {
      name: 'analyze_video',
      arguments: { pathOrUrl: 'https://x/v', destinationPath: dir, frames: 'dense' },
    });
    expect(firstText(content)).toContain('frames');
    await client.close();
  });

  it('maxFrames: 0 with no frames given aliases to frames: "none" (Fix 3)', async () => {
    // Pre-fix, mcp.ts's frames field carried `.default('key')`, so `frames`
    // was NEVER undefined by the time resolveFrameMode ran and the
    // zero-budget alias (spec §2.2) could never be reached through this
    // server at all -- even though resolveFrameMode itself has always
    // handled it correctly (tests/typesV2.test.ts:8). Asserted at the claim
    // level, through a REAL call and the manifest actually written to disk,
    // not by calling resolveFrameMode directly.
    const srcDir = mkdtempSync(join(tmpdir(), 'norma-mcp-av-zero-src-'));
    const video = await makeTestVideo(join(srcDir, 'v.mp4'), 6);
    const destDir = mkdtempSync(join(tmpdir(), 'norma-mcp-av-zero-'));
    const client = await connectClient(buildServer());
    const content = await callToolOk(client, {
      name: 'analyze_video',
      arguments: { pathOrUrl: video, destinationPath: destDir, maxFrames: 0, transcript: false },
    });
    const result = JSON.parse(firstText(content)) as { status: string; frameCount: number; manifestPath: string };
    expect(result.status).toBe('ok');
    expect(result.frameCount).toBe(0);
    const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf8')) as { processing: { frameMode: string } };
    expect(manifest.processing.frameMode).toBe('none');
    await client.close();
  }, 30_000);

  it('an explicit frames value wins over maxFrames: 0 (Fix 3 nuance): "even" is not silently downgraded to "none"', async () => {
    const srcDir = mkdtempSync(join(tmpdir(), 'norma-mcp-av-explicit-src-'));
    const video = await makeTestVideo(join(srcDir, 'v.mp4'), 6);
    const destDir = mkdtempSync(join(tmpdir(), 'norma-mcp-av-explicit-'));
    const client = await connectClient(buildServer());
    const content = await callToolOk(client, {
      name: 'analyze_video',
      arguments: { pathOrUrl: video, destinationPath: destDir, frames: 'even', maxFrames: 0, transcript: false },
    });
    const result = JSON.parse(firstText(content)) as { status: string; manifestPath: string };
    expect(result.status).toBe('ok');
    const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf8')) as { processing: { frameMode: string } };
    expect(manifest.processing.frameMode).toBe('even');
    await client.close();
  }, 30_000);

  it('accepts a syntactically valid call and runs the REAL handler through a clean early-failure path (no network, no models)', async () => {
    // Deliberately does not exercise the full pipeline (model loading,
    // downloads) -- analyzeVideo's own step 1 is resolve(), and a
    // nonexistent local-looking path (ending in a media extension, so
    // DirectMediaResolver claims it) fails there in ~tens of ms: Node's
    // fetch() throws synchronously on a non-absolute-URL string, no socket
    // ever opens (verified: see task-16-report.md). This still proves real,
    // non-stubbed wiring end to end: the handler must actually call
    // analyzeVideoTool/analyzeVideo (not fabricate a result) for the
    // manifest written to disk to carry this exact pathOrUrl back out as
    // source.url.
    const client = await connectClient(buildServer());
    const dir = mkdtempSync(join(tmpdir(), 'norma-mcp-av-fail-'));
    const badPath = join(tmpdir(), 'norma-mcp-test-does-not-exist', 'nope.mp4');
    const content = await callToolOk(client, {
      name: 'analyze_video',
      arguments: { pathOrUrl: badPath, destinationPath: dir },
    });
    const result = JSON.parse(firstText(content)) as {
      status: string; frameCount: number; framePaths: unknown[]; warnings: unknown[]; manifestPath: string;
    };
    expect(result.status).not.toBe('ok');
    expect(result.frameCount).toBe(0);
    expect(result.framePaths).toEqual([]);
    expect(result.warnings).toEqual([]);
    const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf8')) as { source: { url: string } };
    expect(manifest.source.url).toBe(badPath);
    await client.close();
  }, 15_000);

  it('cleans up the working directory without breaking the coarse-to-fine handoff (Fix 6, deferred #18 leak half)', async () => {
    // A REAL local-source, default-frame-mode ('key') call end to end --
    // exactly the scenario deferred #18 describes: analyzeVideo runs against
    // its own private mkdtempSync'd directory (outDir left unset for a local
    // source) and leaves a re-encoded work.mp4 behind there once done. This
    // is the brief's own explicit test: every path the REPLY and the
    // MANIFEST point at must still exist afterward -- that is what stops
    // the cleanup from deleting a file either one still references. The
    // "leak is actually fixed" half (the ephemeral copy itself is gone) is
    // proven at the unit level in tests/analyzeTool.test.ts, which has
    // visibility into the ephemeral path a real end-to-end call does not.
    const srcDir = mkdtempSync(join(tmpdir(), 'norma-mcp-av-cleanup-src-'));
    const video = await makeTestVideo(join(srcDir, 'v.mp4'), 6);
    const destDir = mkdtempSync(join(tmpdir(), 'norma-mcp-av-cleanup-'));
    const client = await connectClient(buildServer());
    const content = await callToolOk(client, {
      name: 'analyze_video',
      arguments: { pathOrUrl: video, destinationPath: destDir, maxFrames: 2, transcript: false },
    });
    const result = JSON.parse(firstText(content)) as {
      status: string; videoPath?: string; framePaths: string[]; manifestPath: string;
    };
    expect(result.status).toBe('ok');
    // The local source itself: never duplicated, never destroyed.
    expect(result.videoPath).toBe(video);
    expect(existsSync(result.videoPath!)).toBe(true);
    // Every frame thumbnail the reply names.
    expect(result.framePaths.length).toBeGreaterThan(0);
    for (const p of result.framePaths) expect(existsSync(p)).toBe(true);
    // And the manifest on disk agrees with the reply, not just the reply
    // with itself.
    expect(existsSync(result.manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf8')) as {
      source: { filePath?: string }; frames: Array<{ image: string }>;
    };
    expect(manifest.source.filePath).toBe(video);
    for (const f of manifest.frames) expect(existsSync(f.image)).toBe(true);
    await client.close();
  }, 60_000);
});
