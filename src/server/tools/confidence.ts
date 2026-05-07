import type { Confidence } from './response-formatter-v2.js';

export interface ConfidenceInput {
  /** The Giac-formatted result string. */
  result: string;
  /** The original problem string the tool was called with. */
  input: string;
  /** If a verification step ran, its outcome. Overrides default inference. */
  verified?: boolean;
}

/**
 * Infer a confidence level from a tool's raw result.
 *
 * The rules are intentionally conservative: a result is `medium` by default,
 * `low` when there are concrete signals of failure, and `high` only when an
 * explicit verification step confirmed the result.
 *
 * Empty solve results, Giac errors, and non-finite numerics all fall to `low`.
 * Results identical to the input string indicate Giac couldn't simplify — also
 * `low`, EXCEPT when the input is a pure numeric scalar (the identity case).
 */
export function inferConfidence({ result, input, verified }: ConfidenceInput): Confidence {
  if (verified === true) return 'high';
  if (verified === false) return 'low';

  const trimmed = result.trim();

  // Hard failure signals
  if (/^\[\]$/.test(trimmed)) return 'low';
  if (/^GIAC_ERROR/.test(trimmed)) return 'low';
  if (/^(NaN|Inf|-Inf|undef)$/.test(trimmed)) return 'low';

  // No-simplification heuristic: result === input AND input contains operators.
  // Pure numeric scalars (e.g., "42" → "42") are not treated as failures.
  const inputNorm = input.replace(/\s+/g, '');
  const resultNorm = trimmed.replace(/\s+/g, '');
  if (inputNorm === resultNorm && /[+\-*/^()=]/.test(inputNorm)) {
    return 'low';
  }

  return 'medium';
}
