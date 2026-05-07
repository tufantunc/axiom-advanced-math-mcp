import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { computeHandler } from '../../src/server/tools/compute/index.js';
import { OUTPUT_CASES } from './fixtures.js';

describe('golden output corpus (real Giac, v2 envelope)', () => {
  beforeAll(() => {
    process.env.AXIOM_OUTPUT_V2 = '1';
  });
  afterAll(() => {
    delete process.env.AXIOM_OUTPUT_V2;
  });

  for (const c of OUTPUT_CASES) {
    it(c.description, async () => {
      const r = await computeHandler({ problem: c.computeProblem });
      expect(r.isError).toBe(false);
      expect(r.content).toHaveLength(1);
      const text = r.content[0].text;
      const lines = text.split('\n');
      const last = lines[lines.length - 1];

      // Always: trailer is a boxed line.
      expect(last.startsWith('\\boxed{')).toBe(true);
      expect(last.endsWith('}')).toBe(true);

      // The JSON body's `answer` field must contain the expected substring.
      const json = JSON.parse(lines[0]);
      expect(typeof json.answer).toBe('string');
      expect(json.answer).toContain(c.expectedAnswerSubstring);

      // If an exact boxed string is given, assert it.
      if (c.expectedBoxed) {
        expect(last).toBe(c.expectedBoxed);
      }
    }, 15000);
  }
});
