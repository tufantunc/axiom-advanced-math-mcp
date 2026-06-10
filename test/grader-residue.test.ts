import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { gradeV2 } from '../benchmark/graders/grader-v2.js';

describe('grader residue patterns (v3-gated)', () => {
  beforeAll(() => { process.env.AXIOM_GRADER_V3 = '1'; });
  afterAll(() => { delete process.env.AXIOM_GRADER_V3; });

  it('strips a trailing ≠ constraint (x + 1, \\quad x \\neq 1 vs x+1)', () => {
    expect(gradeV2('x + 1, \\quad x \\neq 1', 'x+1').match).toBe(true);
  });
  it('guards: different expression with constraint still wrong', () => {
    expect(gradeV2('x + 2, \\quad x \\neq 1', 'x+1').match).toBe(false);
  });

  it('strips labels from fully-labeled multi-values (λ1 = i, λ2 = -i vs i,-i)', () => {
    expect(gradeV2('\\lambda_1 = i, \\quad \\lambda_2 = -i', 'i,-i').match).toBe(true);
  });
  it('guards: wrong labeled values still wrong', () => {
    expect(gradeV2('\\lambda_1 = i, \\lambda_2 = i', 'i,-i').match).toBe(false);
  });

  it('gating: patterns are OFF without AXIOM_GRADER_V3', () => {
    delete process.env.AXIOM_GRADER_V3;
    expect(gradeV2('x + 1, \\quad x \\neq 1', 'x+1').match).toBe(false);
    process.env.AXIOM_GRADER_V3 = '1';
  });
});
