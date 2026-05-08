import type { LLMProvider, ToolAugmentedResult } from '../providers/types.js';
import type { MCPProxy } from './mcp-proxy.js';
import type { RetryOptions } from '../providers/retry.js';
import { executeWithRetry } from '../providers/retry.js';

export type { ToolAugmentedResult };

export async function runToolAugmented(
  problem: string,
  provider: LLMProvider,
  proxy: MCPProxy,
  maxTokens: number,
  maxTurns: number,
  retryOptions?: RetryOptions,
  temperature?: number
): Promise<ToolAugmentedResult> {
  return executeWithRetry(
    () =>
      provider.runWithTools(
        problem,
        proxy.tools,
        (name, args) => proxy.callTool(name, args),
        maxTokens,
        maxTurns,
        temperature
      ),
    retryOptions
  );
}
