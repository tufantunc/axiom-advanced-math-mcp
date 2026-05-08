/**
 * Decide whether a Giac result is structurally complex enough to be worth
 * a follow-up simplify() call.
 *
 * Conservative — avoids spending Giac time on already-clean output.
 *
 * Trigger signals (any one is enough):
 *   1. Contains a negative exponent (`^-`) — often a sign of unsimplified
 *      reciprocals like `(...)^-1`.
 *   2. Maximum paren-nesting depth > 2 — suggests an intermediate form Giac
 *      did not collapse.
 */
export function shouldTrySimplify(result: string): boolean {
  if (!result) return false;
  if (/\^-/.test(result)) return true;
  if (maxParenDepth(result) > 2) return true;
  return false;
}

function maxParenDepth(s: string): number {
  let depth = 0;
  let max = 0;
  for (const ch of s) {
    if (ch === '(' || ch === '[' || ch === '{') {
      depth++;
      if (depth > max) max = depth;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
    }
  }
  return max;
}
