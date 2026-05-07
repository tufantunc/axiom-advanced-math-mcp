import { describe, it, expect } from 'vitest';
import { gradeV2Async } from '../../benchmark/graders/grader-v2.js';
import { GRADER_CASES } from './fixtures.js';

// Mock Giac evaluator that handles the symbolic-equivalence cases used in the corpus.
const knownSimplifies: Record<string, string> = {
  'simplify((cos(x)*x^2+sin(x)*2*x) - (2*x*sin(x)+x^2*cos(x)))': '0',
};
const giacEval = async (expr: string): Promise<string | null> => knownSimplifies[expr] ?? null;

describe('golden grader corpus', () => {
  for (const c of GRADER_CASES) {
    it(c.description, async () => {
      const r = await gradeV2Async(c.candidate, c.ground, { giacEval });
      expect(r.match).toBe(c.shouldMatch);
    });
  }
});
