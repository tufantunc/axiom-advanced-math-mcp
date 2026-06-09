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

describe('extraction — inline-math does not hijack explicit answers', () => {
  it('prefers an explicit "answer is N" over an intermediate \\[...\\]', () => {
    expect(extractModelAnswer('From \\[x=3\\] we get the answer is 9')).toBe('9');
  });
  it('still extracts a bare \\[...\\] answer when there is no prose', () => {
    expect(extractModelAnswer('The result: \\[x^2+1\\]')).toBe('x^2+1');
  });
});

describe('extraction — bare multi-value lists', () => {
  it('keeps a trailing comma-list of values whole', () => {
    expect(extractModelAnswer('The eigenvalues are 3, 1.')).toBe('3, 1');
  });
  it('keeps a 3-value list whole', () => {
    expect(extractModelAnswer('The roots are -2, 0, 2')).toBe('-2, 0, 2');
  });
  it('does NOT treat prose with a stray comma as a list', () => {
    expect(extractModelAnswer('Step 1, we get 5')).toBe('5');
  });
});
