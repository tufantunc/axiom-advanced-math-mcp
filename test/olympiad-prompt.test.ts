import { describe, it, expect } from 'vitest';
import {
  voteToolAugmented,
} from '../benchmark/runners/self-consistency.js';
import { runToolAugmented } from '../benchmark/runners/tool-augmented.js';
import { TOOL_PROMPT_OLYMPIAD } from '../benchmark/providers/prompts.js';
import type { LLMProvider, ToolAugmentedResult } from '../benchmark/providers/types.js';
import type { MCPProxy } from '../benchmark/runners/mcp-proxy.js';

// ---------------------------------------------------------------------------
// Mock provider that captures the systemPrompt arg passed to runWithTools
// ---------------------------------------------------------------------------

function makeCapturingProvider(): {
  provider: LLMProvider;
  capturedPrompts: (string | undefined)[];
} {
  const captured: (string | undefined)[] = [];
  const provider: LLMProvider = {
    name: 'mock',
    model: 'mock-1',
    async runBaseline() {
      return { text: 'baseline', inputTokens: 1, outputTokens: 1, durationMs: 1 };
    },
    async runWithTools(
      _problem,
      _tools,
      _cb,
      _maxTokens,
      _maxTurns,
      _temperature,
      systemPrompt
    ): Promise<ToolAugmentedResult> {
      captured.push(systemPrompt);
      return {
        text: 'The answer is \\boxed{42}',
        toolCalls: [],
        turns: 1,
        inputTokens: 10,
        outputTokens: 5,
        durationMs: 100,
      };
    },
  };
  return { provider, capturedPrompts: captured };
}

const fakeProxy: MCPProxy = {
  tools: [],
  callTool: async () => 'Result: stub',
  close: async () => {},
};

// ---------------------------------------------------------------------------
// Tests — these simulate the dispatch decision in benchmark/index.ts directly,
// not the full benchmark loop. They verify that `systemPrompt` is correctly
// threaded through runToolAugmented and voteToolAugmented when explicitly
// passed, and undefined when not.
// ---------------------------------------------------------------------------

describe('olympiad-prompt routing', () => {
  it('runToolAugmented forwards systemPrompt when provided', async () => {
    const { provider, capturedPrompts } = makeCapturingProvider();
    await runToolAugmented(
      'p',
      provider,
      fakeProxy,
      4096,
      8,
      undefined, // retryOptions
      undefined, // temperature
      TOOL_PROMPT_OLYMPIAD
    );
    expect(capturedPrompts).toEqual([TOOL_PROMPT_OLYMPIAD]);
  });

  it('runToolAugmented passes undefined when systemPrompt absent', async () => {
    const { provider, capturedPrompts } = makeCapturingProvider();
    await runToolAugmented('p', provider, fakeProxy, 4096, 8);
    expect(capturedPrompts).toEqual([undefined]);
  });

  it('voteToolAugmented forwards systemPrompt to all N samples', async () => {
    const { provider, capturedPrompts } = makeCapturingProvider();
    await voteToolAugmented(
      'p',
      provider,
      fakeProxy,
      3, // N
      0.7, // temperature
      4096,
      8,
      undefined, // retryOptions
      TOOL_PROMPT_OLYMPIAD
    );
    expect(capturedPrompts).toEqual([
      TOOL_PROMPT_OLYMPIAD,
      TOOL_PROMPT_OLYMPIAD,
      TOOL_PROMPT_OLYMPIAD,
    ]);
  });

  it('voteToolAugmented passes undefined to all samples when systemPrompt absent', async () => {
    const { provider, capturedPrompts } = makeCapturingProvider();
    await voteToolAugmented('p', provider, fakeProxy, 3, 0.7, 4096, 8);
    expect(capturedPrompts).toEqual([undefined, undefined, undefined]);
  });
});
