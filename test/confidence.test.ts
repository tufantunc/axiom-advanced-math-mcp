import { describe, it, expect } from 'vitest';
import { inferConfidence } from '../src/server/tools/confidence.js';

describe('inferConfidence', () => {
  it('returns low for empty solve result', () => {
    expect(inferConfidence({ result: '[]', input: 'solve(x^2+1=0,x)' })).toBe('low');
  });

  it('returns low for GIAC_ERROR', () => {
    expect(inferConfidence({ result: 'GIAC_ERROR: bad arg', input: 'foo' })).toBe('low');
  });

  it('returns low for NaN/Inf/undef', () => {
    expect(inferConfidence({ result: 'NaN', input: '1/0' })).toBe('low');
    expect(inferConfidence({ result: 'Inf', input: '1/0' })).toBe('low');
    expect(inferConfidence({ result: 'undef', input: 'foo' })).toBe('low');
  });

  it('returns low when result equals input verbatim (no simplification)', () => {
    expect(inferConfidence({ result: 'x+1', input: 'x+1' })).toBe('low');
  });

  it('returns medium for normal successful result', () => {
    expect(inferConfidence({ result: '3*x^2', input: 'diff(x^3,x)' })).toBe('medium');
  });

  it('returns medium when result equals input but they are clearly numeric', () => {
    // "42" → "42" is fine — the user asked for the value of 42, got 42.
    expect(inferConfidence({ result: '42', input: '42' })).toBe('medium');
  });

  it('honors verified=true bumping confidence to high', () => {
    expect(inferConfidence({ result: '3*x^2', input: 'diff(x^3,x)', verified: true })).toBe('high');
  });

  it('honors verified=false demoting to low', () => {
    expect(inferConfidence({ result: '3*x^2', input: 'diff(x^3,x)', verified: false })).toBe('low');
  });
});
