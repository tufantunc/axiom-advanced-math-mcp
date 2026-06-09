import { describe, it, expect } from 'vitest';
import { unicodeToAscii } from '../src/server/tools/unicode-normalize.js';

describe('unicodeToAscii', () => {
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
