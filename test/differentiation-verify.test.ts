import { describe, it, expect } from 'vitest';
import { VERIFY_SET } from '../benchmark/differentiation/verify-set.js';
import { scoreVerify } from '../benchmark/differentiation/verify-scorer.js';

describe('VERIFY_SET', () => {
  it('is balanced true/false and non-trivial in size', () => {
    expect(VERIFY_SET.length).toBeGreaterThanOrEqual(12);
    const trues = VERIFY_SET.filter((c) => c.isTrue).length;
    const falses = VERIFY_SET.length - trues;
    expect(Math.abs(trues - falses)).toBeLessThanOrEqual(1);
  });
});

describe('scoreVerify', () => {
  it('extracts an explicit TRUE verdict', () => {
    expect(scoreVerify('After checking, the claim is TRUE.', true)).toEqual({ verdict: 'true', correct: true });
    expect(scoreVerify('Verdict: TRUE', false)).toEqual({ verdict: 'true', correct: false });
  });
  it('extracts an explicit FALSE verdict', () => {
    expect(scoreVerify('This is FALSE.', false)).toEqual({ verdict: 'false', correct: true });
  });
  it('reads the tool-style "Verified: TRUE/FALSE" line', () => {
    expect(scoreVerify('Verified: FALSE ✗\nConfidence: high', false)).toEqual({ verdict: 'false', correct: true });
  });
  it('returns ambiguous (incorrect) when no clear verdict', () => {
    expect(scoreVerify('Let me think about this problem.', true)).toEqual({ verdict: 'ambiguous', correct: false });
  });
  it('takes the LAST explicit verdict when both words appear', () => {
    expect(scoreVerify('It might be false, but actually the final answer is TRUE.', true)).toEqual({ verdict: 'true', correct: true });
  });
});
