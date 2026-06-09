/**
 * Pure string helpers for cleaning raw Giac CAS output before it reaches the
 * model or the structured envelope. No I/O, no Giac calls — easy to unit-test.
 */

/** Split `s` at top-level (depth-0) occurrences of `sep`, respecting (), [], {}. */
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
