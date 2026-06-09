/**
 * Self-consistency voting metadata attached to a single run.
 * Mirrors the shape produced by the self-consistency runner (Task 3).
 * Declared here independently so that problem-detail.ts describes the JSONL
 * schema without coupling to runner internals.
 */
export interface SelfConsistencyData {
  N: number;
  temperature: number;
  votes: Record<string, number>;
  winnerIndex: number;
  agreement: number;
  samples: { extractedAnswer: string }[];
}

/**
 * Per-problem detail for debug analysis.
 * Written to JSONL after every run; regression analysis in markdown report.
 */
export interface ProblemDetail {
  dataset: string;
  index: number;
  question: string;
  groundTruth: string;

  baseline: {
    extractedAnswer: string;
    correct: boolean;
    method: string; // 'numeric' | 'string' | 'fallback'
    error?: string; // if API call threw
    response?: string; // raw model response text (for offline re-extraction)
    selfConsistency?: SelfConsistencyData;
  };

  toolAugmented: {
    extractedAnswer: string;
    correct: boolean;
    method: string;
    toolCalls: {
      name: string;
      args: Record<string, unknown>;
      result: string;
      success: boolean;
    }[];
    turns: number;
    error?: string;
    response?: string; // raw model response text (for offline re-extraction)
    selfConsistency?: SelfConsistencyData;
  };

  // Derived flags
  regression: boolean; // baseline ✓  →  tool ✗
  improvement: boolean; // baseline ✗  →  tool ✓
}

/**
 * Diagnose WHY a regression happened.
 */
export type RegressionCause =
  | 'tool_error'
  | 'wrong_tool_result'
  | 'no_tools_used'
  | 'extraction_mismatch'
  | 'wrong_formula'
  | 'wrong_tool_selected';

export function diagnoseRegression(d: ProblemDetail): RegressionCause {
  const tc = d.toolAugmented.toolCalls;

  if (tc.length === 0) return 'no_tools_used';
  if (tc.some((c) => !c.success)) return 'tool_error';

  // Check if any tool result actually contains the correct answer
  const gt = d.groundTruth.trim();
  const toolResultsContainAnswer = tc.some(
    (c) => c.result.includes(gt) || c.result.includes(String(parseFloat(gt)))
  );
  if (toolResultsContainAnswer) return 'extraction_mismatch';

  return 'wrong_tool_result';
}
