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
  fix_attempt?: { next_call: { tool: string; args: Record<string, unknown> }; rationale: string };
  explanation?: string;
  /** If set, returned response is marked isError=true and the body becomes the error message. */
  error?: string;
  /** When true, the response is JSON-only — no trailing blank line + boxed.
   *  Use for tools whose "answer" is meta-information (verify TRUE/FALSE)
   *  rather than the user's substantive answer. Prevents the trailer from
   *  hijacking lastIndexOf('\\boxed{') in downstream answer parsers. */
  omit_boxed_trailer?: boolean;
}

interface ToolResponseV2Body {
  answer: string;
  answer_boxed?: string;
  answer_latex?: string;
  answer_numeric?: number;
  alternatives?: string[];
  steps?: string[];
  confidence: Confidence;
  warnings?: string[];
  raw?: string;
  fix_attempt?: { next_call: { tool: string; args: Record<string, unknown> }; rationale: string };
  explanation?: string;
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

  // Collapse whitespace in the boxed trailer so it's always single-line —
  // the LLM and the answer parser both rely on \boxed{...} being on the last line.
  const boxedAnswer = input.answer.replace(/\s+/g, ' ').trim();
  const body: ToolResponseV2Body = {
    answer: input.answer,
    confidence: input.confidence,
  };
  if (!input.omit_boxed_trailer) {
    body.answer_boxed = `\\boxed{${boxedAnswer}}`;
  }
  if (input.answer_latex !== undefined) body.answer_latex = input.answer_latex;
  if (input.answer_numeric !== undefined && Number.isFinite(input.answer_numeric)) {
    body.answer_numeric = input.answer_numeric;
  }
  if (input.alternatives && input.alternatives.length > 0) body.alternatives = input.alternatives;
  if (input.steps && input.steps.length > 0) body.steps = input.steps;
  if (input.warnings && input.warnings.length > 0) body.warnings = input.warnings;
  if (input.raw !== undefined) body.raw = input.raw;
  if (input.fix_attempt) body.fix_attempt = input.fix_attempt;
  if (input.explanation !== undefined) body.explanation = input.explanation;

  // Trailer on a predictable line for the LLM — but only when we're emitting
  // a substantive answer. Verify-style "TRUE/FALSE" tools opt out via omit_boxed_trailer.
  const text = body.answer_boxed
    ? `${JSON.stringify(body)}\n\n${body.answer_boxed}`
    : JSON.stringify(body);

  return {
    content: [{ type: 'text' as const, text }],
    isError: false,
  };
}
