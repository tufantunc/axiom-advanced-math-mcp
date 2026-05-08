/**
 * Detect known failure modes in compute tool result text.
 *
 * Signals:
 *   - Empty solve result: "Result: []"
 *   - Giac error: any substring matching "GIAC_ERROR"
 *   - Non-finite numeric: NaN, Inf, -Inf, undef as standalone tokens
 *
 * Returns the failure kind, or null if the result looks healthy.
 */
export function detectFailure(displayText: string): string | null {
  const t = displayText.trim();
  if (/^Result:\s*\[\]\s*$/m.test(t) || /^Result:\s*\[\]\s*\|/m.test(t)) {
    return 'empty result';
  }
  if (/GIAC_ERROR/.test(t)) {
    return 'Giac error';
  }
  // Match \b(NaN|Inf|-Inf|undef)\b as standalone tokens, not substrings.
  // -Inf needs special handling because '-' isn't a word boundary on the left.
  if (/(?:^|[^A-Za-z])-?Inf(?![A-Za-z])/.test(t)) return 'non-finite result';
  if (/\b(NaN|undef)\b(?!\w)/.test(t)) return 'non-finite result';
  return null;
}
