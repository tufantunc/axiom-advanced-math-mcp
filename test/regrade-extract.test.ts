import { describe, it, expect } from 'vitest';
import { answerToGrade } from '../benchmark/regrade-extract.js';

describe('answerToGrade', () => {
  it('re-extracts from the raw response when present', () => {
    expect(answerToGrade({ response: 'work... \\boxed{3x^2}', extractedAnswer: '3' })).toBe('3x^2');
  });
  it('falls back to the stored extractedAnswer when no response', () => {
    expect(answerToGrade({ extractedAnswer: '3' })).toBe('3');
  });
  it('falls back when response is empty', () => {
    expect(answerToGrade({ response: '', extractedAnswer: '7' })).toBe('7');
  });
});
