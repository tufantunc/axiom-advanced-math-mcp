/**
 * Parse a bare comma-separated list of atomic members.
 *
 * Returns the trimmed members, or null when the input does not look like a list.
 *
 * Rejects:
 *   - Strings containing '=' or comparison operators ('>', '<', '>=', '<=').
 *   - Strings whose top-level contains a '+' (suggests one expression, not list).
 *   - Single-member lists.
 *   - Empty input or empty members.
 */
export function bareCommaList(input: string): string[] | null {
  if (!input || !input.trim()) return null;

  // Reject equations and comparisons up front (top-level only — but checking
  // any-occurrence is fine because nested commas in a real list rarely include
  // these tokens at all).
  if (/=/.test(input)) return null;
  if (/(>=|<=|<|>)/.test(input)) return null;

  // Split top-level commas (depth 0)
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of input) {
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);

  const trimmed = parts.map((p) => p.trim());
  if (trimmed.length < 2) return null;
  if (trimmed.some((p) => p.length === 0)) return null;

  // Reject if any member has a top-level '+' (suggests it's all one expression
  // that happens to contain commas inside subexpressions — very unusual but
  // we want to be conservative).
  for (const m of trimmed) {
    let d = 0;
    for (const ch of m) {
      if (ch === '(' || ch === '[' || ch === '{') d++;
      else if (ch === ')' || ch === ']' || ch === '}') d--;
      else if (ch === '+' && d === 0) return null;
    }
  }

  return trimmed;
}
