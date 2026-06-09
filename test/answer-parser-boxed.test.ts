import { describe, it, expect } from 'vitest';
import { extractModelAnswer } from '../benchmark/graders/answer-parser.js';

describe('extractModelAnswer — boxed fail-safe', () => {
  it('prefers the last COMPLETE box when the trailing box is truncated', () => {
    const text =
      'First the clean form \\boxed{42}. Then a long truncated copy \\boxed{1+x+\\frac{1}{2';
    expect(extractModelAnswer(text)).toBe('42');
  });
  it('returns the single complete box', () => {
    expect(extractModelAnswer('the result is \\boxed{x = 5}')).toBe('x = 5');
  });
  it('handles nested braces inside a box', () => {
    expect(extractModelAnswer('answer: \\boxed{\\frac{a}{b} + 1}')).toBe('\\frac{a}{b} + 1');
  });
  it('uses the last complete box when several are complete', () => {
    expect(extractModelAnswer('\\boxed{1} then \\boxed{2}')).toBe('2');
  });
  it('falls through to text patterns when no box is complete', () => {
    expect(extractModelAnswer('The answer is 7. \\boxed{unterminated')).toBe('7');
  });
});
