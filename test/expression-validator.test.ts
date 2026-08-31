import { describe, it, expect } from 'vitest';
import { validateExpression } from '../src/server/tools/expression-validator.js';
import { solveEquationHandler } from '../src/server/tools/solve.js';

/**
 * `validateExpression` is the pre-flight guard on every Giac-bound expression,
 * called from solve, calculus, algebra, matrix and multivariable.
 *
 * Until now its reject branches were only ever exercised through a handler that
 * has since been deleted as dead code, so a regression that dropped the
 * `if (validationError) return formatErrorResponse(...)` guard, or inverted a
 * depth check so balanced input was rejected, would have been invisible.
 */
describe('validateExpression', () => {
  it('accepts balanced expressions', () => {
    for (const ok of [
      'x^2-4',
      'sin(x)*(y+1)',
      'det([[1,2],[3,4]])',
      'f(g(h(x)))',
      '[[1,2],[3,4]]',
    ]) {
      expect(validateExpression(ok), ok).toBeNull();
    }
  });

  it('rejects empty and whitespace-only input', () => {
    expect(validateExpression('')).toEqual({ message: 'Expression is empty' });
    expect(validateExpression('   ')).toEqual({ message: 'Expression is empty' });
  });

  it('reports an unmatched closing parenthesis with its position', () => {
    expect(validateExpression('x)+1')).toEqual({
      message: 'Unmatched closing parenthesis at position 1',
      position: 1,
    });
  });

  it('reports unclosed parentheses, pluralising on count', () => {
    expect(validateExpression('(x + 1')).toEqual({ message: '1 unclosed parenthesis' });
    expect(validateExpression('((x + 1')).toEqual({ message: '2 unclosed parentheses' });
  });

  it('reports an unmatched closing bracket with its position', () => {
    expect(validateExpression('x]')).toEqual({
      message: 'Unmatched closing bracket at position 1',
      position: 1,
    });
  });

  it('reports unclosed brackets, pluralising on count', () => {
    expect(validateExpression('[1,2')).toEqual({ message: '1 unclosed bracket' });
    expect(validateExpression('[[1,2')).toEqual({ message: '2 unclosed brackets' });
  });

  it('accepts crossed delimiters — the two passes use independent counters, not a shared stack (characterization)', () => {
    // Pins current behaviour, not desired behaviour: validator.ts counts '()'
    // and '[]' in two separate passes, so interleaved delimiters have equal
    // counts and validate clean. '[(])' therefore reaches Giac, which rejects
    // it downstream. This assertion flips if the passes are ever merged into a
    // single stack — which is the point of recording it.
    expect(validateExpression('[(])')).toBeNull();
  });

  it('checks parentheses before brackets when both are unbalanced', () => {
    // Pins the ordering: the paren pass runs to completion first, so a mixed
    // failure reports the paren problem rather than the bracket one.
    expect(validateExpression('([x')).toEqual({ message: '1 unclosed parenthesis' });
  });
});

describe('validateExpression surfaces through a handler', () => {
  it('solve_equation rejects an unbalanced equation without calling Giac', async () => {
    // No giacEngine.initialize() in this file on purpose: validation must
    // short-circuit ahead of the engine, so this passes without a CAS session.
    const result = await solveEquationHandler({ equation: '(x + 1', variable: 'x' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('1 unclosed parenthesis');
  });
});
