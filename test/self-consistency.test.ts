import { describe, it, expect, vi } from 'vitest';
import {
  majorityVote,
  voteBaseline,
  voteToolAugmented,
} from '../benchmark/runners/self-consistency.js';
import type { LLMProvider, BaselineResult, ToolAugmentedResult } from '../benchmark/providers/types.js';
import type { MCPProxy } from '../benchmark/runners/mcp-proxy.js';

describe('majorityVote', () => {
  it('all-same: winner is unanimous', () => {
    const r = majorityVote(['3*x^2', '3*x^2', '3*x^2']);
    expect(r.winnerAnswer).toBe('3*x^2');
    expect(r.winnerIndex).toBe(0);
    expect(r.votes).toEqual({ '3*x^2': 3 });
  });

  it('2-1 split: majority wins, winnerIndex is first occurrence of winner', () => {
    const r = majorityVote(['A', 'B', 'A']);
    expect(r.winnerAnswer).toBe('A');
    expect(r.winnerIndex).toBe(0);
    expect(r.votes).toEqual({ A: 2, B: 1 });
  });

  it('all-different: tie-break by first occurrence', () => {
    const r = majorityVote(['A', 'B', 'C']);
    expect(r.winnerAnswer).toBe('A');
    expect(r.winnerIndex).toBe(0);
    expect(r.votes).toEqual({ A: 1, B: 1, C: 1 });
  });

  it('plurality without strict majority (N=4, 2-1-1): plurality wins', () => {
    const r = majorityVote(['X', 'Y', 'X', 'Z']);
    expect(r.winnerAnswer).toBe('X');
    expect(r.winnerIndex).toBe(0);
    expect(r.votes).toEqual({ X: 2, Y: 1, Z: 1 });
  });

  it('throws on empty input', () => {
    expect(() => majorityVote([])).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Mock helpers for vote* tests
// ---------------------------------------------------------------------------

function makeMockProvider(textsInOrder: string[]): LLMProvider {
  let i = 0;
  return {
    name: 'mock',
    model: 'mock-1',
    async runBaseline(_p, _m, _t): Promise<BaselineResult> {
      const text = textsInOrder[i++ % textsInOrder.length];
      return { text, inputTokens: 10, outputTokens: 5, durationMs: 100 };
    },
    async runWithTools(_p, _tools, _cb, _m, _mt, _t): Promise<ToolAugmentedResult> {
      const text = textsInOrder[i++ % textsInOrder.length];
      return {
        text,
        toolCalls: [{ name: 'compute', args: { problem: 'x' }, result: 'Result: 1', success: true }],
        turns: 2,
        inputTokens: 50,
        outputTokens: 25,
        durationMs: 500,
      };
    },
  };
}

const fakeProxy: MCPProxy = {
  tools: [],
  callTool: async () => 'Result: stub',
  close: async () => {},
};

describe('voteBaseline', () => {
  it('majority wins, returns winner sample with selfConsistency block', async () => {
    const provider = makeMockProvider([
      'The answer is \\boxed{3*x^2}',
      'The answer is \\boxed{3*x^2}',
      'The answer is \\boxed{3}',
    ]);
    const out = await voteBaseline('diff(x^3, x)', provider, 3, 0.7, 4096);
    expect(out.text).toContain('3*x^2'); // winner came from sample 0 or 1
    expect(out.selfConsistency.N).toBe(3);
    expect(out.selfConsistency.temperature).toBe(0.7);
    expect(out.selfConsistency.winnerIndex).toBe(0);
    expect(out.selfConsistency.agreement).toBeCloseTo(2 / 3, 5);
    expect(out.selfConsistency.samples).toHaveLength(3);
    expect(out.selfConsistency.samples[0].extractedAnswer).toBe('3*x^2');
  });

  it('all-different tie-breaks to first sample', async () => {
    const provider = makeMockProvider([
      'The answer is 1',
      'The answer is 2',
      'The answer is 3',
    ]);
    const out = await voteBaseline('p', provider, 3, 0.7, 4096);
    expect(out.selfConsistency.winnerIndex).toBe(0);
    expect(out.selfConsistency.agreement).toBeCloseTo(1 / 3, 5);
  });
});

describe('voteToolAugmented', () => {
  it('majority wins, samples preserved', async () => {
    const provider = makeMockProvider([
      'Final: \\boxed{16/3}',
      'Final: \\boxed{16/3}',
      'Final: \\boxed{8}',
    ]);
    const out = await voteToolAugmented('int(sqrt(x), x, 0, 4)', provider, fakeProxy, 3, 0.7, 4096, 8);
    expect(out.selfConsistency.N).toBe(3);
    expect(out.selfConsistency.winnerIndex).toBe(0);
    expect(out.selfConsistency.agreement).toBeCloseTo(2 / 3, 5);
    expect(out.toolCalls.length).toBeGreaterThan(0); // winner's tool calls preserved
  });
});
