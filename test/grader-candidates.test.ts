import { describe, it, expect } from 'vitest';
import { generateCandidates } from '../benchmark/graders/candidates.js';

describe('generateCandidates', () => {
  it('always returns the original string first', () => {
    const c = generateCandidates('x^2', 'x^2');
    expect(c[0]).toEqual({ value: 'x^2', viaEquationRHS: false });
  });

  it('produces depth-2 chains (RHS extraction then +C strip)', () => {
    const values = generateCandidates('y = x^2 + C', 'x^2').map((c) => c.value);
    expect(values).toContain('x^2');
  });

  it('marks RHS-derived candidates', () => {
    const c = generateCandidates("f'(x) = 3x^2", '3*x^2');
    const rhs = c.find((k) => k.value === '3x^2');
    expect(rhs?.viaEquationRHS).toBe(true);
  });

  it('does NOT extract bare "x = 5" when ground truth is a scalar', () => {
    const values = generateCandidates('x = 5', '5').map((c) => c.value);
    expect(values).toEqual(['x = 5']);
  });

  it('allows single-letter LHS when ground truth is an expression', () => {
    const values = generateCandidates('y = 3e^{-2x}', '3*exp(-2*x)').map((c) => c.value);
    expect(values).toContain('3e^{-2x}');
  });

  it('dedupes and respects the cap', () => {
    const c = generateCandidates('x + 1, \\quad x \\neq 1', 'x+1');
    const values = c.map((k) => k.value);
    expect(new Set(values).size).toBe(values.length);
    expect(c.length).toBeLessThanOrEqual(12);
  });

  it('chains constraint strip then RHS extraction', () => {
    const values = generateCandidates('y(x) = Ce^{x}, \\quad C \\in \\mathbb{R}', 'C*exp(x)').map(
      (c) => c.value
    );
    expect(values).toContain('Ce^{x}');
  });
});
