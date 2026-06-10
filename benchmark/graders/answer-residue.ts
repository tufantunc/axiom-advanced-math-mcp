import { splitTopLevel } from '../../src/server/tools/output-cleanup.js';

/**
 * Sound residue transforms for grader-v2's v3 stage. Each returns the
 * transformed candidate, or null when the pattern does not apply. Narrow by
 * design — the binding no-false-positive guardrail forbids anything broader.
 */

const CONSTRAINT_TAIL =
  /,\s*(?:\\quad\s*|\\;\s*|\\,\s*)?[A-Za-z](?:_\{?\w+\}?)?\s*(?:\\neq\b|≠|!=)\s*[^,]+\s*$/;

/** Strip a single trailing domain constraint like ", x ≠ 1" / ", \quad x \neq 1".
 *  Returns the remainder, or null when there is no such tail. */
export function stripTrailingConstraint(s: string): string | null {
  const m = s.match(CONSTRAINT_TAIL);
  if (!m || m.index === undefined) return null;
  const stripped = s.slice(0, m.index).trim();
  return stripped.length > 0 ? stripped : null;
}

/** When EVERY top-level comma segment is "<label> = <value>" (e.g.
 *  "\lambda_1 = i, \lambda_2 = -i"), return the bare value list "i, -i".
 *  Mixed labeled/unlabeled input returns null (left untouched). */
export function stripValueLabels(s: string): string | null {
  const cleaned = s.replace(/\\quad\b/g, ' ').trim();
  const parts = splitTopLevel(cleaned, ',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length < 2) return null;
  const values: string[] = [];
  for (const part of parts) {
    const m = part.match(/^\\?[A-Za-z]+(?:_\{?\w+\}?)?\s*=\s*(.+)$/);
    if (!m) return null;
    values.push(m[1].trim());
  }
  return values.join(', ');
}
