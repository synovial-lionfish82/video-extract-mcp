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

  it('counters are accurate immediately after bare await (resolve path)', async () => {
    const pool = createSlotPool(1);
    await pool.run(async () => 'x');
    // No microtask lag: running/queued must be 0 right now, not on the next tick.
    expect(pool.running).toBe(0);
    expect(pool.queued).toBe(0);
  });

  it('counters are accurate immediately after bare await (reject path)', async () => {
    const pool = createSlotPool(1);
    try {
      await pool.run(async () => { throw new Error('test'); });
    } catch {
      // ignore
    }
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
    vi.stubEnv('VIDEO_EXTRACT_TASK_TTL_MS', '0');
    expect(taskTtlMsFromEnv()).toBe(1);   // explicit but nonsensical -> floor
    vi.stubEnv('VIDEO_EXTRACT_TASK_TTL_MS', 'soon');
    expect(taskTtlMsFromEnv()).toBe(1_800_000);
  });
});
