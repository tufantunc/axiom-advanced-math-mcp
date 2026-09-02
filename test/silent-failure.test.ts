import { describe, it, expect } from 'vitest';
import { detectFailure } from '../src/server/tools/compute/silent-failure.js';

describe('detectFailure', () => {
  it('detects empty result', () => {
    expect(detectFailure('Result: []')).toBe('empty result');
    expect(detectFailure('  Result:   []  ')).toBe('empty result');
  });

  it("detects Giac's unevaluated-derivative marker", () => {
    // Not an answer. It reached a Result line through the ODE condition-folding
    // path: `desolve(y'=y, z'(x)=-y(x))` returned
    // `-(function_diff(z))(x)/exp(x)*exp(x)` with isError:false. The extractor no
    // longer folds that argument, so this is tested here rather than end to end —
    // the marker is filtered whatever route puts it there.
    expect(detectFailure('Result: -(function_diff(z))(x)/exp(x)*exp(x)')).toBe(
      'unevaluated derivative'
    );
    // A coefficient whose NAME contains it is not a failure, same rule as the
    // other tokens on this path.
    expect(detectFailure('Result: my_function_diffs*exp(x)')).toBeNull();
  });

  it('detects GIAC_ERROR', () => {
    expect(detectFailure('GIAC_ERROR: bad arg')).toBe('Giac error');
    expect(detectFailure('Result: GIAC_ERROR: desolve(...)')).toBe('Giac error');
  });

  it('detects non-finite numerics', () => {
    expect(detectFailure('Result: NaN')).toBe('non-finite result');
    expect(detectFailure('Result: Inf')).toBe('non-finite result');
    expect(detectFailure('Result: -Inf')).toBe('non-finite result');
    expect(detectFailure('Result: undef')).toBe('non-finite result');
  });

  it('returns null on healthy results', () => {
    expect(detectFailure('Result: 3*x^2')).toBeNull();
    expect(detectFailure('Result: 16/3')).toBeNull();
    expect(detectFailure('Result: sqrt(2)')).toBeNull();
  });

  it('does not false-positive on result containing "Inf" as substring', () => {
    expect(detectFailure('Result: Information theory result: 0.5')).toBeNull();
  });

  it('does not false-positive on result containing "undef" as substring', () => {
    expect(detectFailure('Result: undefined_var')).toBeNull();
  });
});
