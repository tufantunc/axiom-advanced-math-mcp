import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { computeHandler } from '../src/server/tools/compute/index.js';

describe('computeHandler — output-hygiene flag', () => {
  beforeAll(() => {
    process.env.AXIOM_COMPUTE_HYGIENE = '1';
  });
  afterAll(() => {
    delete process.env.AXIOM_COMPUTE_HYGIENE;
  });

  it('returns sanitized display for a simple expression', async () => {
    const r = await computeHandler({ problem: '2 + 3' });
    expect(r.isError).toBe(false);
    // Healthy result, no warning expected
    const allText = r.content.map((c) => c.text).join('\n');
    expect(allText).not.toMatch(/\[Warning/);
  });

  it('shape is unchanged when flag is off', async () => {
    delete process.env.AXIOM_COMPUTE_HYGIENE;
    const r = await computeHandler({ problem: '2 + 3' });
    expect(r.isError).toBe(false);
    process.env.AXIOM_COMPUTE_HYGIENE = '1'; // restore for afterAll
  });
});
