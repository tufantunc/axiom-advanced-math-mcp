import { describe, it, expect } from 'vitest';
import { extractRHS } from '../benchmark/graders/extract-rhs.js';

describe('extractRHS', () => {
  it('extracts RHS of a function-call equation', () => {
    expect(extractRHS('sin(x) = x - x^3/6 + x^5/120')).toBe('x - x^3/6 + x^5/120');
    expect(extractRHS('f(x) = 2*x+1')).toBe('2*x+1');
  });

  it('extracts RHS of a LaTeX function-call equation', () => {
    expect(extractRHS('\\sin(x) = x - \\frac{x^3}{6}')).toBe('x - \\frac{x^3}{6}');
  });

  it('rejects bare variable assignment "x = N"', () => {
    expect(extractRHS('x = 5')).toBeNull();
    expect(extractRHS('y = 2*x+1')).toBeNull();
  });

  it('rejects strings without =', () => {
    expect(extractRHS('3*x^2')).toBeNull();
    expect(extractRHS('x + y')).toBeNull();
  });

  it('rejects multiple top-level =', () => {
    expect(extractRHS('a = b = c')).toBeNull();
  });

  it('does not split inside parens', () => {
    // "f(a=b)" has = inside parens; not a top-level equation.
    expect(extractRHS('f(a=b)')).toBeNull();
  });

  it('strips leading/trailing whitespace from RHS', () => {
    expect(extractRHS('f(x) =   2*x+1   ')).toBe('2*x+1');
  });

  it('strips outer \\boxed{} before extraction', () => {
    expect(extractRHS('\\boxed{sin(x) = x - x^3/6}')).toBe('x - x^3/6');
  });

  it('strips outer $...$ math delimiters', () => {
    expect(extractRHS('$f(x) = 2x+1$')).toBe('2x+1');
  });

  it('LHS must contain function call OR multiple letters', () => {
    // Single variable LHS rejected ("x = 5"); function call accepted.
    expect(extractRHS('a = 5')).toBeNull();
    // Multi-letter symbol like "log(x) = ..." accepted.
    expect(extractRHS('log(x) = ln(x)/ln(10)')).toBe('ln(x)/ln(10)');
  });
});
