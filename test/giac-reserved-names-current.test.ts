import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';

/**
 * The generated GIAC_RESERVED_NAMES is what the generator would write today,
 * against the BUILT engine. The unit suite pins the engine's hash, which
 * catches a new engine; this catches an edit to the list by hand — a name
 * deleted from it is an equation call the bound no longer refuses — and a
 * generator whose output has drifted from the committed file.
 *
 * Integration, because the generator loads dist/server/giac.
 */
describe('the reserved-name list', () => {
  it('is what the generator writes from the built engine', () => {
    const run = spawnSync('node', ['scripts/generate-giac-reserved-names.mjs', '--check'], {
      encoding: 'utf8',
      timeout: 120_000,
    });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stderr).toMatch(/is current: \d+ reserved of \d+/);
  }, 150_000);
});
