import { describe, it, expect } from 'vitest';
import { extractModelAnswer } from '../benchmark/graders/answer-parser.js';

describe('extraction — inline-math delimiters', () => {
  it('strips \\(...\\) around the answer', () => {
    expect(extractModelAnswer('Therefore the answer is \\(\\frac{1}{1+x^2}\\).'))
      .toBe('\\frac{1}{1+x^2}');
  });
  it('strips \\[...\\] around the answer', () => {
    expect(extractModelAnswer('The result: \\[x^2+1\\]')).toBe('x^2+1');
  });
});
