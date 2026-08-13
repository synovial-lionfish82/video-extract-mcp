// Final whole-branch review, Important finding 3: a real stdio session must
// not linger after stdin EOF just because a task's cleanup timer is still
// counting down. This can ONLY be observed by spawning the REAL compiled
// server as its own process over real stdio -- InMemoryTransport (every
// other MCP test in this repo) never touches process/event-loop lifecycle
// at all, so it cannot exercise this bug or its fix (see
// scratch/onclose-probe.mjs and scratch/probe5-linger.mjs, the reviewer's
// own throwaway probes this test formalizes).
//
// Real-process tests are inherently more timing-sensitive than the rest of
// this suite, so per the task instructions the assertion here is
// deliberately ONE-SIDED (only an upper bound on how long exit is allowed
// to take, never a tight/lower-bound comparison) and generously margined,
// so ordinary system load cannot flake it.
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const bad = join(tmpdir(), 'norma-lifecycle-proc-does-not-exist', 'nope.mp4');

/** Spawns dist/mcp.js, completes exactly one call (a fast, local,
 *  doomed-to-fail resolve -- the same proven fast-failing pattern
 *  tests/mcp.test.ts uses throughout, so this stays fast and
 *  network-independent), then closes stdin and measures how long the
 *  process takes to exit on its own afterward. Completing a call first is
 *  what makes this a genuine regression test rather than a trivial pass:
 *  it is what arms a real terminal-transition cleanup timer at `ttlMs`
 *  (storeTaskResult's own re-arm, src/mcp.ts's HonestCancelStore) --
 *  without it, even pre-fix code exits promptly (nothing was ever armed to
 *  keep the process alive), which is exactly what "no call at all" already
 *  demonstrates in scratch/probe5-linger.mjs and would make this test
 *  useless as a regression guard. */
function spawnCompleteAndCloseStdin(ttlMs: number, deadlineMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    const dest = mkdtempSync(join(tmpdir(), 'norma-lifecycle-proc-'));
    const child = spawn(process.execPath, ['dist/mcp.js'], {
      cwd: process.cwd(),
      env: { ...process.env, VIDEO_EXTRACT_TASK_TTL_MS: String(ttlMs) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let eofSentAt = 0;
    let settled = false;
    const finish = (exitedWithinMs: number | null) => {
      if (settled) return;
      settled = true;
      resolve(exitedWithinMs);
    };

    child.on('exit', () => { if (eofSentAt) finish(Date.now() - eofSentAt); });
    child.on('error', () => finish(null));

    let buf = '';
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg: { id?: number };
        try { msg = JSON.parse(line) as { id?: number }; } catch { continue; }
        if (msg.id === 1) {
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
          child.stdin.write(JSON.stringify({
            jsonrpc: '2.0', id: 2, method: 'tools/call',
            params: { name: 'resolve_video', arguments: { destinationPath: dest, videos: [{ url: bad }] } },
          }) + '\n');
        }
        if (msg.id === 2) {
          // The call completed -- a real terminal-transition cleanup timer
          // is now armed at ttlMs, per the bug this test guards against.
          // Close stdin and start the clock.
          eofSentAt = Date.now();
          child.stdin.end();
        }
      }
    });
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'lifecycle-test', version: '0' } },
    }) + '\n');

    // Generous upper bound: comfortably shorter than ttlMs (so a still-ref'd
    // timer would keep the process alive well past it), but generous enough
    // that ordinary CI/system load cannot flake a genuinely-fixed process
    // into missing it. If it's not gone by deadlineMs + 2000ms, force-kill
    // and report "did not exit" rather than hanging the test run.
    setTimeout(() => { child.kill('SIGKILL'); finish(null); }, deadlineMs + 2000);
  });
}

describe('stdio process lifecycle (final review, Important 3)', () => {
  it('exits within 5s of stdin EOF after completing a call, even with a much longer TTL still pending', async () => {
    // TTL (20s) comfortably longer than the deadline (5s) below: the ONLY
    // way this process can exit before the TTL elapses is if its cleanup
    // timer no longer keeps the event loop alive on its own -- a still-ref'd
    // timer would keep it alive until ~20s, which this test's own 7s
    // hard-kill would catch as "did not exit" (exitedWithinMs === null).
    const DEADLINE_MS = 5000;
    const exitedWithinMs = await spawnCompleteAndCloseStdin(20_000, DEADLINE_MS);
    expect(exitedWithinMs).not.toBeNull();
    expect(exitedWithinMs!).toBeLessThan(DEADLINE_MS);
  }, 15_000);
});
