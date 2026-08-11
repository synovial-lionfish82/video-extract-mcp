import { describe, it, expect } from 'vitest';
import { resolveFrameMode } from '../src/types.js';

describe('resolveFrameMode', () => {
  it('defaults to key when nothing is specified', () => {
    expect(resolveFrameMode(undefined, undefined)).toBe('key');
  });
  it('treats maxFrames 0 as an alias for none (spec §2.2)', () => {
    expect(resolveFrameMode(undefined, 0)).toBe('none');
  });
  it('lets an explicit frames value win over a zero budget', () => {
    expect(resolveFrameMode('even', 0)).toBe('even');
  });
  it('passes explicit modes through', () => {
    expect(resolveFrameMode('even', 10)).toBe('even');
    expect(resolveFrameMode('none', 10)).toBe('none');
    expect(resolveFrameMode('key', 10)).toBe('key');
  });
  it('does not treat a negative budget as key', () => {
    expect(resolveFrameMode(undefined, -1)).toBe('none');
  });
});
