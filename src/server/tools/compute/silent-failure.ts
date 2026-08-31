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
  // Match (NaN|Inf|-Inf|undef) as standalone tokens, not substrings.
  //
  // The boundary excludes _ and digits on BOTH sides, matching the NaN/undef rule
  // below. It used to be [^A-Za-z] on the left and (?![A-Za-z]) on the right, which
  // admitted _ and digits as boundaries: `T_Inf` — free-stream notation, not a
  // contrived name — read as a non-finite result, so a solved and self-verified ODE
  // system was refused with a message blaming the CAS.
  //
  // `-Inf` needs no `-?` of its own: the left class admits `-`, so the sign is
  // consumed as the boundary. It carried one for a while, justified by '-' not
  // being a word boundary — true of the `\b` matching this line no longer does.
  if (/(^|[^A-Za-z_0-9])Inf([^A-Za-z_0-9]|$)/.test(t)) return 'non-finite result';
  if (/\b(NaN|undef)\b(?!\w)/.test(t)) return 'non-finite result';
  return null;
}
