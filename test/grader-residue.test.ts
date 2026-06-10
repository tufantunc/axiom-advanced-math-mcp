import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { gradeV2 } from '../benchmark/graders/grader-v2.js';
import {
  stripConstantTail,
  stripBigOTail,
  stripLogAbs,
} from '../benchmark/graders/answer-residue.js';

describe('grader residue patterns (v3-gated)', () => {
  beforeAll(() => { process.env.AXIOM_GRADER_V3 = '1'; });
  afterAll(() => { delete process.env.AXIOM_GRADER_V3; });

  it('strips a trailing ≠ constraint (x + 1, \\quad x \\neq 1 vs x+1)', () => {
    expect(gradeV2('x + 1, \\quad x \\neq 1', 'x+1').match).toBe(true);
  });
  it('guards: different expression with constraint still wrong', () => {
    expect(gradeV2('x + 2, \\quad x \\neq 1', 'x+1').match).toBe(false);
  });

  it('strips labels from fully-labeled multi-values (λ1 = i, λ2 = -i vs i,-i)', () => {
    expect(gradeV2('\\lambda_1 = i, \\quad \\lambda_2 = -i', 'i,-i').match).toBe(true);
  });
  it('guards: wrong labeled values still wrong', () => {
    expect(gradeV2('\\lambda_1 = i, \\lambda_2 = i', 'i,-i').match).toBe(false);
  });

  it('gating: patterns are OFF without AXIOM_GRADER_V3', () => {
    delete process.env.AXIOM_GRADER_V3;
    expect(gradeV2('x + 1, \\quad x \\neq 1', 'x+1').match).toBe(false);
    process.env.AXIOM_GRADER_V3 = '1';
  });
});

describe('residue transforms: +C / big-O / log-abs (pure)', () => {
  it('strips a trailing bare "+ C"', () => {
    expect(stripConstantTail('x^2 + C', 'x^2')).toBe('x^2');
    expect(stripConstantTail('\\frac{e^{2x}}{2} + C', 'exp(2*x)/2')).toBe('\\frac{e^{2x}}{2}');
    expect(stripConstantTail('x^2 + C_1', 'x^2')).toBe('x^2');
  });

  it('does NOT strip when ground truth itself contains C', () => {
    expect(stripConstantTail('C*e^x + C', 'C*exp(x)')).toBeNull();
  });

  it('does NOT strip C-bearing product terms (general vs particular solution)', () => {
    expect(stripConstantTail('e^x/2 + C*e^{-x}', 'exp(x)/2')).toBeNull();
  });

  it('returns null when there is no constant tail', () => {
    expect(stripConstantTail('x^2', 'x^2')).toBeNull();
  });

  it('strips trailing big-O tails, balanced and truncated', () => {
    expect(stripBigOTail('1 + x + \\mathcal{O}(x^5)')).toBe('1 + x');
    expect(stripBigOTail('1 + x + \\mathcal{O}(x^5')).toBe('1 + x');
    expect(stripBigOTail('x - \\frac{x^3}{6} + O(x^6')).toBe('x - \\frac{x^3}{6}');
  });

  it('returns null when there is no big-O tail', () => {
    expect(stripBigOTail('1 + x + x^2/2')).toBeNull();
  });

  it('drops absolute-value bars inside a logarithm only', () => {
    expect(stripLogAbs('\\ln|x| + C')).toBe('\\ln(x) + C');
    expect(stripLogAbs('\\ln\\left|x\\right|')).toBe('\\ln(x)');
    expect(stripLogAbs('|x| + 1')).toBeNull();
    expect(stripLogAbs('ln(x)')).toBeNull();
  });
});
