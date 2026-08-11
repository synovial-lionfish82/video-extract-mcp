import { execFileSync } from 'node:child_process';

/**
 * Tracks the peak resident-set size (RSS) of this process and all of its
 * descendants, sampled periodically while running.
 *
 * Why not just `process.memoryUsage().rss`? The tool's memory budget (spec
 * §4) is met by never holding two heavy models resident at once: the ASR
 * worker loads its model in a *child* process, transcribes, writes its
 * output, and exits -- then the vision worker starts the same way. The
 * orchestrator itself stays small the whole time. So by the time anyone
 * reads `process.memoryUsage()` on the orchestrator, the worker that
 * actually used the memory is already gone; a self-only reading would
 * report only the orchestrator's small footprint and call that "the peak"
 * -- a confident, wrong number, which is worse than not measuring at all.
 * The peak has to be observed *while each worker is alive*, which means
 * polling the live process tree over time, not reading one point-in-time
 * value at the end.
 *
 * How descendants are found: each sample takes one snapshot of the whole
 * system process table (`ps -A -o pid=,ppid=,rss=`) and walks it by
 * parent-pid (ppid), starting from `process.pid`, collecting every live
 * descendant at any depth. This deliberately does NOT filter by process
 * *group* (`ps -g <pid>`): that only finds anything when this process is
 * its own process-group leader (pid === pgid), which is not guaranteed --
 * e.g. when spawned under a shell's job control, an MCP client, or a test
 * runner, this process is commonly just a non-leader member of some other
 * process's group, in which case `ps -g <pid>` silently matches nothing
 * and the sampler would undercount every child to zero. (Verified directly
 * while building this file: under the harness used here, `process.pid`
 * was not this process's pgid, and `ps -g <pid>` errored out / matched
 * nothing -- see the task report for the numbers.) A ppid walk has no such
 * precondition: it only relies on `child_process.spawn` setting the
 * child's ppid correctly, which POSIX always does.
 *
 * Honesty about limits: this is polling, not tracing. An allocation spike
 * that both rises and falls between two samples is invisible, so a
 * sampler like this can only ever undercount the true instantaneous peak,
 * never overcount it. Keep `intervalMs` short relative to the shortest
 * phase you care about. It also depends on `ps` being present and being
 * able to see the processes in question -- true for this tool's own
 * worker children, which run as the same user.
 */
export class PeakRssTracker {
  private timer: NodeJS.Timeout | null = null;
  private peakBytes = 0;
  private readonly intervalMs: number;

  constructor(intervalMs = 250) {
    this.intervalMs = intervalMs;
  }

  private sample(): void {
    this.peakBytes = Math.max(this.peakBytes, process.memoryUsage().rss);
    const treeBytes = this.descendantTreeRssBytes();
    if (treeBytes !== null) this.peakBytes = Math.max(this.peakBytes, treeBytes);
  }

  /**
   * Sums RSS (bytes) for this process and every live descendant, by
   * snapshotting the whole process table once and walking it by ppid.
   * Best-effort: returns null (instead of throwing) if `ps` is unavailable
   * or its output can't be parsed, so one failed sample never aborts
   * tracking -- that tick just falls back to the self-only reading already
   * folded in by `sample()`.
   */
  private descendantTreeRssBytes(): number | null {
    try {
      // `=` after each keyword suppresses ps's header row, so every line is
      // purely whitespace-separated numbers -- no command text to trip up
      // parsing. macOS `ps` reports rss in 1024-byte units (confirmed
      // against process.memoryUsage().rss for this same process at a known
      // allocation size; see the task report).
      const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,rss='], { encoding: 'utf8' });
      const childrenOf = new Map<number, number[]>();
      const rssKbOf = new Map<number, number>();

      for (const line of out.split('\n')) {
        const parts = line.trim().split(/\s+/);
        if (parts.length !== 3) continue;
        const [pidStr, ppidStr, rssStr] = parts;
        if (pidStr === undefined || ppidStr === undefined || rssStr === undefined) continue;
        const pid = Number(pidStr);
        const ppid = Number(ppidStr);
        const rssKb = Number(rssStr);
        if (!Number.isFinite(pid) || !Number.isFinite(ppid) || !Number.isFinite(rssKb)) continue;
        rssKbOf.set(pid, rssKb);
        const siblings = childrenOf.get(ppid) ?? [];
        siblings.push(pid);
        childrenOf.set(ppid, siblings);
      }

      const seen = new Set<number>([process.pid]);
      const queue: number[] = [process.pid];
      while (queue.length > 0) {
        const pid = queue.shift();
        if (pid === undefined) break;
        for (const child of childrenOf.get(pid) ?? []) {
          if (!seen.has(child)) {
            seen.add(child);
            queue.push(child);
          }
        }
      }

      let totalKb = 0;
      for (const pid of seen) totalKb += rssKbOf.get(pid) ?? 0;
      return totalKb * 1024;
    } catch {
      return null;
    }
  }

  start(): void {
    if (this.timer) clearInterval(this.timer); // idempotent: a stray double-start can't leak a timer
    this.peakBytes = 0;
    this.sample();
    this.timer = setInterval(() => this.sample(), this.intervalMs);
    this.timer.unref?.();
  }

  /** @returns peak RSS in MB across this process and its descendants, observed since start(). */
  stop(): number {
    this.sample();
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    return Math.round(this.peakBytes / 1048576);
  }
}
