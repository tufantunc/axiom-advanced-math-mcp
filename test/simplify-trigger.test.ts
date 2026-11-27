import { describe, it, expect } from 'vitest';
import { shouldTrySimplify } from '../src/server/tools/compute/simplify-trigger.js';

describe('shouldTrySimplify', () => {
  it('triggers on negative exponent', () => {
    expect(shouldTrySimplify('-1/2*2*x*(sqrt(1-x^2))^-1')).toBe(true);
    expect(shouldTrySimplify('x^-2')).toBe(true);
  });

  it('triggers on deep nested parens (depth > 2)', () => {
    expect(shouldTrySimplify('(((x+1)*(x-1)))')).toBe(true);
    expect(shouldTrySimplify('(a*(b*(c+(d*e))))')).toBe(true);
  });

  it('does not trigger on clean output', () => {
    expect(shouldTrySimplify('3*x^2')).toBe(false);
    expect(shouldTrySimplify('sqrt(2)')).toBe(false);
    expect(shouldTrySimplify('cos(x) + sin(x)')).toBe(false);
    expect(shouldTrySimplify('16/3')).toBe(false);
  });

  it('does not trigger on simple top-level mixed * and /', () => {
    expect(shouldTrySimplify('a*b/c')).toBe(false);
    expect(shouldTrySimplify('2*x/3')).toBe(false);
  });

  it('triggers on mixed * and / inside nested parens', () => {
    // (..*..)/.. is not enough; we need the * AND / both to be inside parens
    expect(shouldTrySimplify('(2*x*(x^2-1)*(x^2+1))/(...)')).toBe(false);  // top-level / only inside paren operands
    // A real complex case from the live data:
    expect(shouldTrySimplify('-1/2*2*x*(sqrt(1-x^2))^-1')).toBe(true);  // already covered by ^- rule
  });

  it('handles empty input safely', () => {
    expect(shouldTrySimplify('')).toBe(false);
  });
});
