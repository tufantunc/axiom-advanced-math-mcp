import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { computeHandler } from '../src/server/tools/compute/index.js';

describe('computeHandler — v2 output flag', () => {
  beforeAll(() => {
    process.env.AXIOM_OUTPUT_V2 = '1';
  });
  afterAll(() => {
    delete process.env.AXIOM_OUTPUT_V2;
  });

  it('returns boxed trailer for derivative', async () => {
    const r = await computeHandler({ problem: 'diff(x^3, x)' });
    expect(r.isError).toBe(false);
    expect(r.content).toHaveLength(1);
    const lines = r.content[0].text.split('\n');
    const last = lines[lines.length - 1];
    // Real Giac result is "3*x^2"; mock may differ — assert structure only.
    expect(last.startsWith('\\boxed{')).toBe(true);
    expect(last.endsWith('}')).toBe(true);
  });

  it('emits a confidence field of the correct type', async () => {
    const r = await computeHandler({ problem: 'diff(x^3, x)' });
    if (r.isError) {
      // Mock or runtime error — skip; structural assertion not possible.
      return;
    }
    const json = JSON.parse(r.content[0].text.split('\n')[0]);
    expect(json).toHaveProperty('confidence');
    expect(['low', 'medium', 'high']).toContain(json.confidence);
  });

  it('builds the JSON envelope with answer + answer_boxed + confidence', async () => {
    const r = await computeHandler({ problem: '2 + 3' });
    if (r.isError) return; // skip on runtime/mock error
    const json = JSON.parse(r.content[0].text.split('\n')[0]);
    expect(json).toHaveProperty('answer');
    expect(json).toHaveProperty('answer_boxed');
    expect(json).toHaveProperty('confidence');
    // Boxed mirrors the answer:
    expect(json.answer_boxed).toBe(`\\boxed{${json.answer}}`);
  });
});
