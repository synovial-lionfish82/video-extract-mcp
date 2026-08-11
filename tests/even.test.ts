import { describe, it, expect } from 'vitest';
import { evenTimestamps } from '../src/vision/even.js';

describe('evenTimestamps', () => {
  it('returns exactly the requested count', () => {
    expect(evenTimestamps(0, 10, 5)).toHaveLength(5);
  });
  it('returns a single instant when start equals end', () => {
    expect(evenTimestamps(7, 7, 1)).toEqual([7]);
  });
  it('collapses to one sample when start equals end regardless of budget', () => {
    expect(evenTimestamps(7, 7, 20)).toEqual([7]);
  });
  it('spreads samples strictly inside the window, never at the exclusive end', () => {
    const ts = evenTimestamps(0, 10, 5);
    expect(ts[0]).toBeGreaterThanOrEqual(0);
    expect(Math.max(...ts)).toBeLessThan(10);
  });
  it('is evenly spaced', () => {
    const ts = evenTimestamps(0, 10, 5);
    const gaps = ts.slice(1).map((t, i) => t - ts[i]!);
    for (const g of gaps) expect(g).toBeCloseTo(gaps[0]!, 6);
  });
  it('yields 2fps for a 30s window with a 60 budget (spec §2.2)', () => {
    const ts = evenTimestamps(60, 90, 60);
    expect(ts).toHaveLength(60);
    expect(ts[1]! - ts[0]!).toBeCloseTo(0.5, 6);
  });
  it('returns nothing for a non-positive count', () => {
    expect(evenTimestamps(0, 10, 0)).toEqual([]);
  });
  it('never returns a negative timestamp', () => {
    expect(evenTimestamps(0, 1, 3).every((t) => t >= 0)).toBe(true);
  });
  it('clamps single-instant with zero budget to empty array (convention: zero budget means no frames)', () => {
    expect(evenTimestamps(7, 7, 0)).toEqual([]);
  });
  it('clamps negative timestamps to zero when window starts below zero', () => {
    expect(evenTimestamps(-5, 5, 4).every((t) => t >= 0)).toBe(true);
  });
});
