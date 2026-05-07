/**
 * Phase 1 structured response formatter.
 *
 * Produces a dual-format text block: a single line of JSON followed by a blank
 * line and a `\boxed{...}` trailer. The JSON is for downstream automation; the
 * trailer is a well-known LaTeX pattern that LLMs reliably repeat verbatim,
 * which fixes the "model writes `3` instead of `3*x^2`" extraction failure.
 */

export type Confidence = 'high' | 'medium' | 'low';

export interface ToolResponseV2Input {
  answer: string;
  answer_latex?: string;
  answer_numeric?: number;
  alternatives?: string[];
  steps?: string[];
  confidence: Confidence;
  warnings?: string[];
  raw?: string;
  /** If set, returned response is marked isError=true and the body becomes the error message. */
  error?: string;
}

interface ToolResponseV2Body {
  answer: string;
  answer_boxed: string;
  answer_latex?: string;
  answer_numeric?: number;
  alternatives?: string[];
  steps?: string[];
  confidence: Confidence;
  warnings?: string[];
  raw?: string;
}

export function formatToolResponseV2(input: ToolResponseV2Input): {
  content: { type: 'text'; text: string }[];
  isError: boolean;
} {
  if (input.error) {
    return {
      content: [{ type: 'text' as const, text: `Error: ${input.error}` }],
      isError: true,
    };
  }

  const body: ToolResponseV2Body = {
    answer: input.answer,
    answer_boxed: `\\boxed{${input.answer}}`,
    confidence: input.confidence,
  };
  if (input.answer_latex !== undefined) body.answer_latex = input.answer_latex;
  if (input.answer_numeric !== undefined && Number.isFinite(input.answer_numeric)) {
    body.answer_numeric = input.answer_numeric;
  }
  if (input.alternatives && input.alternatives.length > 0) body.alternatives = input.alternatives;
  if (input.steps && input.steps.length > 0) body.steps = input.steps;
  if (input.warnings && input.warnings.length > 0) body.warnings = input.warnings;
  if (input.raw !== undefined) body.raw = input.raw;

  // Single-line JSON keeps the trailer on a predictable line for the LLM.
  const text = `${JSON.stringify(body)}\n\n${body.answer_boxed}`;

  return {
    content: [{ type: 'text' as const, text }],
    isError: false,
  };
}
