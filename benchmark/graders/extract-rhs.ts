/**
 * Extract the right-hand side of a top-level equation.
 *
 * Returns the RHS trimmed, or null when the input is not a suitable equation.
 *
 * Rules:
 *   - Strips outer `\boxed{...}` and outer `$...$` math delimiters.
 *   - Finds a top-level '=' (depth 0 — not inside any brackets).
 *   - Requires exactly one top-level '=' (rejects chains like a=b=c).
 *   - LHS must contain a function call (e.g. `sin(x)`, `f(x)`) — single
 *     variable names are rejected because `x = 5` is itself the answer,
 *     not a renaming.
 */
export interface ExtractRHSOptions {
  /** Accept a single-letter LHS like "y = …". Callers must enable this ONLY
   *  when the ground truth is an expression (not a scalar) — "x = 5" vs "5"
   *  must keep failing (golden corpus). */
  allowSingleLetterLHS?: boolean;
}

export function extractRHS(input: string, opts: ExtractRHSOptions = {}): string | null {
  let s = input.trim();

  // Strip surrounding math delimiters
  s = s.replace(/^\$+|\$+$/g, '').trim();

  // Strip a single outer \boxed{...} if it wraps the entire string
  const boxedMatch = s.match(/^\\boxed\{(.*)\}$/);
  if (boxedMatch) s = boxedMatch[1].trim();

  // Find top-level '=' — collect all occurrences
  const positions: number[] = [];
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === '=' && depth === 0) positions.push(i);
  }
  if (positions.length !== 1) return null;

  const eq = positions[0];
  const lhs = s.slice(0, eq).trim();
  const rhs = s.slice(eq + 1).trim();

  if (!lhs || !rhs) return null;

  // LHS must look like a function call OR a multi-character symbolic name.
  // Single bare variables ("x", "y", "a") are rejected unless explicitly allowed.
  const looksLikeFunctionCall = /\(/.test(lhs);
  const isMultiCharSymbol = /[A-Za-z]{2,}/.test(lhs);
  // An LHS carrying an exponent (e.g. "e^x") is an expression restatement,
  // not a bare variable — safe to treat like the function-call form.
  const isExponentExpression = /\^/.test(lhs);
  const isSingleLetter = /^[A-Za-z]'?$/.test(lhs);
  if (
    !looksLikeFunctionCall &&
    !isMultiCharSymbol &&
    !isExponentExpression &&
    !(opts.allowSingleLetterLHS && isSingleLetter)
  ) {
    return null;
  }

  return rhs;
}
