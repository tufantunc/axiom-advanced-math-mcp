import type { LLMProvider, BaselineResult } from '../providers/types.js';
import type { RetryOptions } from '../providers/retry.js';
import { executeWithRetry } from '../providers/retry.js';

export type { BaselineResult };

export async function runBaseline(
  problem: string,
  provider: LLMProvider,
  maxTokens: number,
  retryOptions?: RetryOptions,
  temperature?: number
): Promise<BaselineResult> {
  return executeWithRetry(
    () => provider.runBaseline(problem, maxTokens, temperature),
    retryOptions
  );
}
