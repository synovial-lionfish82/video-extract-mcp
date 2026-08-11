import { describe, it, expect, vi } from 'vitest';

// vi.mock is hoisted above these imports by vitest's transform, but the
// factory itself cannot close over a plain local `const` at that point --
// vi.hoisted runs even earlier so `spawnMock` exists when the factory below
// executes.
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

describe('embedImages (unit -- no build or model required)', () => {
  it('returns [] for an empty input array without spawning a worker process', async () => {
    // Imports the SOURCE module directly (not dist/), so this test needs
    // neither `npm run build` nor the SigLIP model/network: embedImages([])
    // must short-circuit before ever calling run()/spawn(). A mutant that
    // deletes the `paths.length === 0` guard would reach spawn() here --
    // caught by the assertion below, not merely by "it happened not to
    // crash".
    const { embedImages } = await import('../src/vision/embed.js');
    const result = await embedImages([]);
    expect(result).toEqual([]);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
