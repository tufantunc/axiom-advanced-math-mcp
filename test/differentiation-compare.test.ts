import { describe, it, expect } from 'vitest';
import { rollupArm, renderComparison } from '../benchmark/differentiation/compare.js';
import type { ArmProblemRecord, ArmVerifyRecord } from '../benchmark/differentiation/compare.js';

const problems: ArmProblemRecord[] = [
  { correct: true, toolCalls: [{ name: 'mcp__axiom__compute', success: true }], turns: 2, outputTokens: 100, extractionClean: true },
  { correct: false, toolCalls: [{ name: 'mcp__axiom__compute', success: false }], turns: 3, outputTokens: 200, extractionClean: false },
];
const verifies: ArmVerifyRecord[] = [
  { isTrue: true, correct: true },
  { isTrue: false, correct: true },
  { isTrue: false, correct: false },
];

describe('rollupArm', () => {
  it('computes accuracy, tool-success, avg turns/tokens, extraction-clean', () => {
    const r = rollupArm('axiom', problems, verifies);
    expect(r.accuracy).toBeCloseTo(0.5);
    expect(r.toolSuccessRate).toBeCloseTo(0.5);
    expect(r.avgTurns).toBeCloseTo(2.5);
    expect(r.avgOutputTokens).toBeCloseTo(150);
    expect(r.extractionCleanRate).toBeCloseTo(0.5);
  });
  it('computes confirm-true and reject-false separately', () => {
    const r = rollupArm('axiom', problems, verifies);
    expect(r.confirmTrueRate).toBeCloseTo(1);
    expect(r.rejectFalseRate).toBeCloseTo(0.5);
    expect(r.verifyAccuracy).toBeCloseTo(2 / 3);
  });
  it('handles zero tool calls without NaN', () => {
    const r = rollupArm('pure-model', [{ correct: true, toolCalls: [], turns: 1, outputTokens: 50, extractionClean: true }], []);
    expect(r.toolSuccessRate).toBe(0);
    expect(r.verifyAccuracy).toBe(0);
  });
});

describe('renderComparison', () => {
  it('renders a markdown table with one row per arm', () => {
    const a = rollupArm('axiom', problems, verifies);
    const b = rollupArm('code-exec', problems, verifies);
    const md = renderComparison([a, b]);
    expect(md).toContain('| axiom |');
    expect(md).toContain('| code-exec |');
    expect(md).toContain('Reject-false');
  });
});
