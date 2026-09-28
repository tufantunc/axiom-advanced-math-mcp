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
    // The ORDER of the replacements, which is load-bearing and was unenforced:
    // `π` has to become `pi` before the `√` rules look at the argument, or `√π`
    // falls through to the bare replacement and becomes the free symbol
    // `sqrtpi` — so `simplify(√π*√π)` answered `sqrtpi^2` instead of pi.
    ['√π', 'sqrt(pi)'],
    ['√π*√π', 'sqrt(pi)*sqrt(pi)'],
    ['√(π)', 'sqrt(pi)'],
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
    expect(unicodeToAscii('x⁴⁵⁶⁷⁸⁹')).toBe('x^456789');
  });

  // Each digit used to be replaced on its own, so a multi-digit superscript
  // became a tower: `10⁸⁰` reached Giac as `10^8^0`, which it reads
  // right-associatively as 10^(8^0), and `simplify(10⁸⁰)` answered 10 as a
  // SUCCESS. Every row above was one digit wide, which is how it went unseen.
  it.each([
    ['10⁸⁰', '10^80'],
    ['2²³', '2^23'],
    ['1000!⁹⁹', '1000!^99'],
    ['x¹⁰⁰', 'x^100'],
    // Two runs stay two exponents: only ADJACENT superscripts are one number.
    ['x²+x³', 'x^2+x^3'],
    ['x²·y¹²', 'x^2*y^12'],
  ])('reads a run of superscript digits as one exponent: %s', (input, expected) => {
    expect(unicodeToAscii(input)).toBe(expected);
  });

  // The rest of the Superscripts block was not mapped at all, so each glyph
  // reached Giac as part of an identifier and came back as a confident answer:
  // `simplify(x⁻¹)` answered the free symbol `x⁻`, `simplify(2ⁱ)` answered
  // `2*i`. A run that is not all digits is parenthesised, because `^` binds
  // tighter than `+`: `xⁿ⁺¹` as `x^n+1` is a different expression.
  it.each([
    ['x⁻¹', 'x^(-1)'],
    ['x⁻¹²', 'x^(-12)'],
    ['xⁿ', 'x^(n)'],
    ['xⁿ⁺¹', 'x^(n+1)'],
    ['2ⁱ', '2^(i)'],
    ['x⁽²⁾', 'x^((2))'],
    // Meaningless as an exponent — mapped so the engine rejects it, rather
    // than left for Giac to read as the identifier `x⁼`.
    ['x⁼', 'x^(=)'],
  ])('reads a mixed superscript run as one parenthesised exponent: %s', (input, expected) => {
    expect(unicodeToAscii(input)).toBe(expected);
  });

  // Deliberately out of scope, pinned so the boundary is a decision rather
  // than an accident: modifier letters (`ˣ`, U+02E3) are an open-ended
  // alphabet outside the Superscripts block, and a subscript names a variable.
  it.each([['eˣ'], ['x₁']])('leaves %s alone', (input) => {
    expect(unicodeToAscii(input)).toBe(input);
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
