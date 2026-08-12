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
    // O(n) re-report per release: O(n^2) per full drain (~10^5 callbacks for 500-deep queue).
    waiters.forEach((w, i) => w.onQueued?.(i + 1));
  };
  return {
    get running() { return running; },
    get queued() { return waiters.length; },
    run<T>(fn: () => Promise<T>, onQueued?: (ahead: number) => void): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        // Ordering: running-- MUST come before resolve/reject/pump().
        // If pump() ran first and a waiter's onQueued callback threw, the current caller would hang.
        const start = () => fn().then(
          (v) => { running--; resolve(v); pump(); },
          (e) => { running--; reject(e); pump(); },
        );
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
