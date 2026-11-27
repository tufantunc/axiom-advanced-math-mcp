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
  it('re-extracts even when the response has no boxed answer (documents the tail-fallback tradeoff)', () => {
    // No \boxed and no clear pattern → extractModelAnswer uses its tail fallback.
    // We assert it re-extracts from the response (not the stored answer), documenting
    // that re-extraction is unconditional when a non-empty response is present.
    const out = answerToGrade({ response: 'I think the result is roughly seven', extractedAnswer: '7' });
    expect(out).not.toBe('7'); // came from re-extraction of the response, not the stored answer
    expect(typeof out).toBe('string');
  });
});
