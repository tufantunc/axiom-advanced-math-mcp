/**
 * Pure string helpers for cleaning raw Giac CAS output before it reaches the
 * model or the structured envelope. No I/O, no Giac calls — easy to unit-test.
 */

/**
 * Split `s` at top-level (depth-0) occurrences of `sep`, respecting (), [], {}.
 * @param sep a single-character separator.
 */
export function splitTopLevel(s: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (depth === 0 && ch === sep) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  return parts;
}

/** Strip a single matched pair of surrounding double-quotes (Giac latex() artifact). */
export function stripQuotes(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * Remove the trailing big-O remainder term (e.g. `+x^5*order_size(x)`) that
 * Giac appends to series/taylor results. The remainder is always the last
 * additive term, so we cut from the last depth-0 +/- operator before the
 * `order_size` token to the end of the string.
 */
export function stripOrderTerm(expr: string): string {
  const idx = expr.indexOf('order_size');
  if (idx === -1) return expr;
  let depth = 0;
  let cut = -1;
  for (let i = 0; i < idx; i++) {
    const ch = expr[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    // Assumes exact (fraction) terms — Giac series output is exact, never floating/scientific notation. A '-' in a hypothetical '1e-5' literal is therefore out of scope.
    else if (depth === 0 && (ch === '+' || ch === '-') && i > 0) cut = i;
  }
  if (cut === -1) return expr;
  const stripped = expr.slice(0, cut).trim();
  return stripped || expr;
}

/**
 * Normalize Giac's `solve` list output into clean set/tuple notation.
 *   list[-2,2]    -> {-2, 2}
 *   list[3]       -> 3
 *   list[[2,1]]   -> (2, 1)
 *   list[i,-i]    -> {i, -i}
 *   []            -> {}
 * Any unparseable input is returned unchanged (never throws).
 */
export function listToSet(raw: string): string {
  const trimmed = raw.trim();
  let inner = trimmed.startsWith('list') ? trimmed.slice(4).trim() : trimmed;
  if (!inner.startsWith('[') || !inner.endsWith(']')) return raw;
  inner = inner.slice(1, -1).trim();
  if (inner === '') return '{}';

  const members = splitTopLevel(inner, ',')
    .map((m) => m.trim())
    .filter((m) => m.length > 0);
  if (members.length === 0) return '{}';

  // System solutions: each member is itself a [a,b,...] tuple.
  const tuples = members.map((m) => {
    if (m.startsWith('[') && m.endsWith(']')) {
      const elems = splitTopLevel(m.slice(1, -1), ',').map((e) => e.trim());
      return `(${elems.join(', ')})`;
    }
    return null;
  });
  if (tuples.every((t) => t !== null)) {
    return tuples.length === 1 ? (tuples[0] as string) : `{${tuples.join(', ')}}`;
  }

  // Mixed tuple/scalar lists (unusual Giac output) fall through here as-is.
  // Scalars.
  if (members.length === 1) return members[0];
  return `{${members.join(', ')}}`;
}
