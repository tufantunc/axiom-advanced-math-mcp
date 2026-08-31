import { describe, it, expect } from 'vitest';
import { preprocessExpression } from '../src/server/tools/quick-calc-preprocessor.js';

// The preprocessor rewrites model-friendly syntax into the forms mathjs and
// Giac understand. These rules run before any evaluator on every quick_calc
// call — a dropped rule silently misroutes or fails every expression of that
// shape, so each rewrite is pinned here on its own.
describe('preprocessExpression', () => {
  it('converts degree notation to the deg unit', () => {
    expect(preprocessExpression('sin(90°)').expression).toBe('sin(90 deg)');
    expect(preprocessExpression('45.5° + 1').expression).toBe('45.5 deg + 1');
  });

  it('rewrites combinatorics forms to combinations()/permutations()', () => {
    expect(preprocessExpression('C(5, 3)').expression).toBe('combinations(5, 3)');
    expect(preprocessExpression('nCr(5,3)').expression).toBe('combinations(5, 3)');
    expect(preprocessExpression('nPr(5,3)').expression).toBe('permutations(5, 3)');
    expect(preprocessExpression('5 choose 3').expression).toBe('combinations(5, 3)');
    expect(preprocessExpression('binomial(5, 3)').expression).toBe('combinations(5, 3)');
  });

  it('is case-insensitive for the keyword forms', () => {
    expect(preprocessExpression('ncr(5,3)').expression).toBe('combinations(5, 3)');
    expect(preprocessExpression('Binomial(5, 3)').expression).toBe('combinations(5, 3)');
  });

  it('leaves plain arithmetic untouched', () => {
    expect(preprocessExpression('2 + 3 * x').expression).toBe('2 + 3 * x');
  });
});
