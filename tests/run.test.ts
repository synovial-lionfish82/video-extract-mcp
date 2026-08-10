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
  it('rejects on spawn error when binary does not exist', async () => {
    await expect(run('definitely-not-a-real-binary-xyz', [])).rejects.toThrow();
  });
  it('handles multi-byte UTF-8 correctly across chunk boundaries', async () => {
    // Emit a large amount of CJK text to force chunk boundaries during streaming
    const cjkText = '你好世界'.repeat(5000);
    const r = await run('echo', [cjkText]);
    expect(r.code).toBe(0);
    // Verify no replacement characters from botched UTF-8 decoding
    expect(r.stdout).not.toContain('�');
    // Verify the output contains the expected text (accounting for echo adding newline)
    expect(r.stdout.trim()).toBe(cjkText);
  });
});
