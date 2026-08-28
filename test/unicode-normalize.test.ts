import { describe, it, expect } from 'vitest';
import { unicodeToAscii } from '../src/server/tools/unicode-normalize.js';

describe('unicodeToAscii', () => {
  it.each([
    // Every existing case parenthesised its argument, so the bare form was
    // never exercised: `√2` became the free symbol `sqrt2`, and
    // `simplify(√2*√2)` answered `sqrt2^2` instead of 2.
    ['√2', 'sqrt(2)'],
    ['√x', 'sqrt(x)'],
    ['√2*√2', 'sqrt(2)*sqrt(2)'],
    ['√2+√3', 'sqrt(2)+sqrt(3)'],
    ['x²+√5', 'x^2+sqrt(5)'],
    // Nothing to take an argument from: left as the word, so the engine
    // reports it rather than this inventing an operand.
    ['√', 'sqrt'],
    // The parenthesised rule also normalises the space away, which the bare
    // rule cannot do — it only matches an identifier or a number.
    ['√ (x+1)', 'sqrt(x+1)'],
  ])('gives a bare √ its argument: %s', (input, expected) => {
    expect(unicodeToAscii(input)).toBe(expected);
  });

  it('replaces √ with sqrt', () => {
    expect(unicodeToAscii('√(1-x^2)')).toBe('sqrt(1-x^2)');
    expect(unicodeToAscii('-1/2*2*x*(√(1-x^2))^-1')).toBe('-1/2*2*x*(sqrt(1-x^2))^-1');
  });

  it('replaces π with pi', () => {
    expect(unicodeToAscii('π/2')).toBe('pi/2');
  });

  it('replaces unicode superscripts ⁰-⁹', () => {
    expect(unicodeToAscii('x²')).toBe('x^2');
    expect(unicodeToAscii('x³+x²+x¹+x⁰')).toBe('x^3+x^2+x^1+x^0');
    expect(unicodeToAscii('x⁴⁵⁶⁷⁸⁹')).toBe('x^4^5^6^7^8^9');
  });

  it('replaces × with * and ÷ with /', () => {
    expect(unicodeToAscii('2 × 3 ÷ 4')).toBe('2 * 3 / 4');
  });

  it('returns string unchanged when no Unicode math chars present', () => {
    expect(unicodeToAscii('sqrt(2)*x^2 + 3')).toBe('sqrt(2)*x^2 + 3');
  });

  it('handles multiple Unicode chars in one string', () => {
    expect(unicodeToAscii('√(π × x²)')).toBe('sqrt(pi * x^2)');
  });

  it('maps the middot · to multiplication', () => {
    expect(unicodeToAscii('2·x')).toBe('2*x');
  });
  it('still maps superscript ² to ^2 (regression)', () => {
    expect(unicodeToAscii('x²-4')).toBe('x^2-4');
  });
  it('leaves ASCII input unchanged', () => {
    expect(unicodeToAscii('factor(x^2-4)')).toBe('factor(x^2-4)');
  });
});
