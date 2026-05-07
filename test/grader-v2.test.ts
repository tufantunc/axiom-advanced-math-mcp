import { describe, it, expect } from 'vitest';
import { gradeV2 } from '../benchmark/graders/grader-v2.js';

describe('gradeV2 — early stages', () => {
  it('exact match', () => {
    const r = gradeV2('42', '42');
    expect(r.match).toBe(true);
    expect(r.method).toBe('exact');
  });

  it('normalized match across LaTeX', () => {
    const r = gradeV2('-\\frac{82}{27}', '-82/27');
    expect(r.match).toBe(true);
    expect(r.method).toBe('normalized');
  });

  it('numeric tolerance match', () => {
    const r = gradeV2('0.5', '\\frac{1}{2}');
    expect(r.match).toBe(true);
    expect(r.method).toBe('numeric');
  });

  it('plain mismatch', () => {
    const r = gradeV2('3', '5');
    expect(r.match).toBe(false);
  });
});
