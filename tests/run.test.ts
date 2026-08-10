import { describe, it, expect } from 'vitest';
import { run } from '../src/util/run.js';

describe('run', () => {
  it('captures stdout and a zero exit code', async () => {
    const r = await run('echo', ['hello']);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('hello');
  });
  it('does not throw on non-zero exit; reports the code', async () => {
    const r = await run('sh', ['-c', 'exit 3']);
    expect(r.code).toBe(3);
  });
});
