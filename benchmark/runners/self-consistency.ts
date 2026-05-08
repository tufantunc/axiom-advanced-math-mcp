/**
 * Self-consistency / N-sample voting wrapper.
 *
 * Calls the existing runners N times in series, normalizes each sample's
 * extracted answer via the grader's normalizer, then majority-votes
 * (plurality with first-occurrence tie-break) to pick a winner.
 *
 * Voting target: the canonical form from grader-v2's normalize(). This means
 * `\frac{1}{2}`, `(1)/(2)`, and `0.5` all collapse to the same equivalence
 * class for voting purposes — voting on mathematical equivalence, not surface
 * form.
 */

import type { LLMProvider, BaselineResult, ToolAugmentedResult } from '../providers/types.js';
import type { MCPProxy } from './mcp-proxy.js';
import { runBaseline } from './baseline.js';
import { runToolAugmented } from './tool-augmented.js';
import { extractModelAnswer } from '../graders/answer-parser.js';
import { normalize } from '../graders/normalizer.js';

export interface SelfConsistencyData {
  N: number;
  temperature: number;
  votes: Record<string, number>;
  winnerIndex: number;
  agreement: number;
  samples: { extractedAnswer: string }[];
}

export interface VoteResult {
  winnerIndex: number;
  winnerAnswer: string;
  votes: Record<string, number>;
}

/**
 * Plurality vote with first-occurrence tie-break.
 *
 * Throws on empty input — voting on zero samples is a programmer error.
 */
export function majorityVote(canonicalAnswers: string[]): VoteResult {
  if (canonicalAnswers.length === 0) {
    throw new Error('majorityVote: input must contain at least one element');
  }

  const votes: Record<string, number> = {};
  for (const a of canonicalAnswers) {
    votes[a] = (votes[a] ?? 0) + 1;
  }

  // Find max-count answer. Tie-break: keep the first occurrence (the answer
  // associated with sample 0 is preferred when its count ties any other).
  let winnerAnswer = canonicalAnswers[0];
  let bestCount = votes[winnerAnswer];
  for (const [ans, count] of Object.entries(votes)) {
    if (count > bestCount) {
      winnerAnswer = ans;
      bestCount = count;
    }
  }

  // Index of the FIRST sample that produced the winning answer
  const winnerIndex = canonicalAnswers.indexOf(winnerAnswer);
  return { winnerIndex, winnerAnswer, votes };
}

/**
 * Run baseline N times with the given temperature, then majority-vote.
 * Returns the winner sample extended with a selfConsistency metadata block.
 */
export async function voteBaseline(
  problem: string,
  provider: LLMProvider,
  N: number,
  temperature: number,
  maxTokens: number,
  retryOptions?: import('../providers/retry.js').RetryOptions
): Promise<BaselineResult & { selfConsistency: SelfConsistencyData }> {
  const samples: BaselineResult[] = [];
  for (let i = 0; i < N; i++) {
    samples.push(await runBaseline(problem, provider, maxTokens, retryOptions, temperature));
  }
  return composeWithVote(samples, N, temperature);
}

/**
 * Run tool-augmented N times with the given temperature, then majority-vote.
 * Returns the winner sample extended with a selfConsistency metadata block.
 */
export async function voteToolAugmented(
  problem: string,
  provider: LLMProvider,
  proxy: MCPProxy,
  N: number,
  temperature: number,
  maxTokens: number,
  maxTurns: number,
  retryOptions?: import('../providers/retry.js').RetryOptions,
  systemPrompt?: string
): Promise<ToolAugmentedResult & { selfConsistency: SelfConsistencyData }> {
  const samples: ToolAugmentedResult[] = [];
  for (let i = 0; i < N; i++) {
    samples.push(
      await runToolAugmented(
        problem,
        provider,
        proxy,
        maxTokens,
        maxTurns,
        retryOptions,
        temperature,
        systemPrompt
      )
    );
  }
  return composeWithVote(samples, N, temperature);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Generic vote composer used by both voteBaseline and voteToolAugmented.
 * Extracts answers, normalizes, votes, and packages the winner sample with
 * the selfConsistency metadata.
 */
function composeWithVote<T extends { text: string }>(
  samples: T[],
  N: number,
  temperature: number
): T & { selfConsistency: SelfConsistencyData } {
  const extracted = samples.map((s) => extractModelAnswer(s.text));
  const canonicals = extracted.map((e) => normalize(e).canonical);
  const { winnerIndex, votes } = majorityVote(canonicals);
  const winner = samples[winnerIndex];
  const winnerCanonical = canonicals[winnerIndex];
  const agreement = (votes[winnerCanonical] ?? 0) / N;

  return {
    ...winner,
    selfConsistency: {
      N,
      temperature,
      votes,
      winnerIndex,
      agreement,
      samples: extracted.map((e) => ({ extractedAnswer: e })),
    },
  };
}
