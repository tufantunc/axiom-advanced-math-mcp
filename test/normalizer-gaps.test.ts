import { describe, it, expect } from 'vitest';
import { normalize } from '../benchmark/graders/normalizer.js';

describe('normalizer: exponent braces and Euler base', () => {
  it('keeps single-token exponents brace-free (regression guard)', () => {
    expect(normalize('x^{2}').canonical).toBe('x^2');
    expect(normalize('x^{10}').canonical).toBe('x^10');
  });

  it('parenthesizes multi-token exponents', () => {
    expect(normalize('x^{2y}').canonical).toBe('x^(2y)');
  });

  it('converts a standalone e base to exp()', () => {
    expect(normalize('e^x').canonical).toBe('exp(x)');
    expect(normalize('e^{-2x}').canonical).toBe('exp(-2x)');
  });

  it('splits fused single-char factors off e^', () => {
    expect(normalize('xe^x').canonical).toBe('x*exp(x)');
    expect(normalize('3e^{2x}').canonical).toBe('3*exp(2x)');
    expect(normalize('Ce^{x}').canonical).toBe('C*exp(x)');
  });

  it('leaves longer identifiers fused (conservative)', () => {
    expect(normalize('lambdae^x').canonical).toBe('lambdae^x');
  });

  it('does not touch non-e bases', () => {
    expect(normalize('2^x').canonical).toBe('2^x');
  });
});

describe('normalizer: unparenthesized function arguments', () => {
  it('wraps space-separated args of known functions', () => {
    expect(normalize('\\cos x').canonical).toBe('cos(x)');
    expect(normalize('\\ln x').canonical).toBe('ln(x)');
  });

  it('inserts explicit multiplication before LaTeX function commands', () => {
    expect(normalize('x^{2}\\cos x + 2x\\sin x').canonical).toBe('x^2*cos(x)+2x*sin(x)');
  });

  it('already-parenthesized args are unchanged apart from the * insertion', () => {
    expect(normalize('x\\cos(x)').canonical).toBe('x*cos(x)');
    expect(normalize('\\cos(x)').canonical).toBe('cos(x)');
  });
});

describe('normalizer: direct match payoff on real failure shapes', () => {
  it('"e^x + xe^x" normalizes to the ground-truth form', () => {
    expect(normalize('e^x + xe^x').canonical).toBe('exp(x)+x*exp(x)');
  });
});
