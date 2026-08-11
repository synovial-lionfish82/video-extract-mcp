import { describe, it, expect } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PeakRssTracker } from '../src/util/rss.js';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('PeakRssTracker', () => {
  // Weak on its own (baseline Node RSS alone clears these bounds), kept as a basic
  // smoke test that self-sampling works at all. The test below it is the one that
  // actually proves the sampler earns its keep.
  it('reports a plausible non-zero peak in MB from a self allocation', async () => {
    const t = new PeakRssTracker(20);
    t.start();
    const junk = new Array(2_000_000).fill(7);
    await sleep(120);
    const peak = t.stop();
    expect(junk.length).toBe(2_000_000);
    expect(peak).toBeGreaterThan(10);
    expect(peak).toBeLessThan(20_000);
  });

  it('stop() is safe without start()', () => {
    expect(new PeakRssTracker().stop()).toBeGreaterThanOrEqual(0);
  });

  // The decisive test. The whole <2GB architecture (spec §4) rests on the ASR and
  // vision workers loading their models in short-lived child processes that exit
  // before the orchestrator finishes -- so by the time anyone could inspect
  // `process.memoryUsage()` on the orchestrator, the process that actually used the
  // memory is gone. A tracker that only reads its own memoryUsage() would report a
  // small, confident, WRONG number here. This spawns a child that allocates a known,
  // large amount, waits for it to fully exit, independently confirms via the OS
  // process table that it is really gone (not just that the 'exit' event fired), and
  // only then asks the tracker for its peak -- proving the peak was captured while
  // the child was alive and survived past the child's death.
  it('detects memory used by a child process that has already exited', async () => {
    const t = new PeakRssTracker(25); // fast poll: many chances to sample the child alive
    t.start();

    const allocMiB = 200;
    const child = spawn(process.execPath, [
      '-e',
      `const buf = Buffer.alloc(${allocMiB} * 1024 * 1024, 7);
       setTimeout(() => { process.exit(0); }, 400);`,
    ]);

    await new Promise<void>((resolve, reject) => {
      child.on('exit', () => resolve());
      child.on('error', reject);
    });

    // Independent proof the child is gone at the OS level, not just that Node's
    // 'exit' event fired: `ps -p <pid>` on an unknown pid exits non-zero.
    expect(() => execFileSync('ps', ['-p', String(child.pid)], { stdio: 'pipe' })).toThrow();

    await sleep(75); // let stop() land well after the child's death
    const peak = t.stop();
    const baseline = Math.round(process.memoryUsage().rss / 1048576);

    // Lower bound: most of the allocation must show up (catches a sampler that
    // silently misses children, e.g. process.memoryUsage()-only, or a process-group
    // filter that doesn't match because this process isn't its own group leader).
    expect(peak).toBeGreaterThan(baseline + allocMiB * 0.5);
    // Upper bound: guards against a confidently-wrong-in-the-other-direction bug,
    // e.g. a KB/bytes units error inflating the number by 1024x.
    expect(peak).toBeLessThan(baseline + allocMiB * 3);
  });

  it('does not keep the Node process alive after stop()', async () => {
    // Black-box, not white-box: rather than reaching into the private timer field,
    // spawn a real child whose entire job is start() -> wait -> stop() -> fall off
    // the end with no process.exit(). If stop() leaves any ref'd or uncleared
    // interval behind, Node's event loop never drains and this process hangs until
    // killed -- which is exactly the failure this test is designed to catch.
    //
    // Note the import specifier below points at rss.ts directly (not rss.js): there
    // is no build step here, and a plain .mjs importer does not get the TS-style
    // .js-resolves-to-.ts fallback that NodeNext/tsc give .ts importers. Getting this
    // wrong was caught during development -- with a .js specifier the child crashed
    // on ERR_MODULE_NOT_FOUND and exited quickly for the *wrong* reason, which a
    // fast-exit-only assertion would not have told apart from success. The stdout/
    // stderr checks below exist specifically to catch that failure mode again.
    const dir = mkdtempSync(join(tmpdir(), 'rss-timer-test-'));
    const scriptPath = join(dir, 'child.mjs');
    const modulePath = fileURLToPath(new URL('../src/util/rss.ts', import.meta.url));
    try {
      writeFileSync(
        scriptPath,
        `import { PeakRssTracker } from ${JSON.stringify(modulePath)};
         const t = new PeakRssTracker(20);
         t.start();
         await new Promise((r) => setTimeout(r, 60));
         t.stop();
         console.log('LIFECYCLE_COMPLETE');
         // no process.exit() here -- a leaked timer is the only thing that could
         // keep this process from exiting on its own.`,
      );

      const start = Date.now();
      const child = spawn(process.execPath, [scriptPath], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
      const exitedOnItsOwn = await new Promise<boolean>((resolve) => {
        const killTimer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve(false);
        }, 5000);
        child.on('exit', () => {
          clearTimeout(killTimer);
          resolve(true);
        });
      });
      const elapsed = Date.now() - start;

      // Prove the child ran the real lifecycle to completion rather than exiting
      // quickly for an unrelated reason (e.g. a crash) -- a fast, clean-looking exit
      // is not by itself proof of anything.
      expect(stderr).toBe('');
      expect(stdout).toContain('LIFECYCLE_COMPLETE');
      expect(exitedOnItsOwn).toBe(true);
      expect(elapsed).toBeGreaterThanOrEqual(60); // didn't skip the in-script sleep
      expect(elapsed).toBeLessThan(5000); // and nothing held it open past that
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('repeated start()/stop() cycles behave sanely', async () => {
    const t = new PeakRssTracker(15);

    t.start();
    const junkA = new Array(1_000_000).fill(1);
    await sleep(60);
    const peakA = t.stop();
    expect(junkA.length).toBe(1_000_000);
    expect(peakA).toBeGreaterThan(0);

    // A second cycle on the same instance must not throw, hang, hold state from the
    // first cycle in a way that breaks, or accumulate a second live interval.
    t.start();
    await sleep(60);
    const peakB = t.stop();
    expect(peakB).toBeGreaterThan(0);

    // Calling start() again without an intervening stop() must not leak the
    // previous interval (i.e. must not end up with two timers sampling at once).
    t.start();
    t.start();
    await sleep(60);
    expect(() => t.stop()).not.toThrow();

    // Calling stop() twice in a row must also not throw.
    expect(() => t.stop()).not.toThrow();
  });
});
