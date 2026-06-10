import { splitTopLevel } from '../../src/server/tools/output-cleanup.js';

/**
 * Sound residue transforms for grader-v2's v3 stage. Each returns the
 * transformed candidate, or null when the pattern does not apply. Narrow by
 * design — the binding no-false-positive guardrail forbids anything broader.
 */

const CONSTRAINT_TAIL =
  /,\s*(?:\\quad\s*|\\;\s*|\\,\s*)?[A-Za-z](?:_\{?\w+\}?)?\s*(?:\\neq\b|≠|!=)\s*[^,]+\s*$/;
const TEXT_FOR_TAIL =
  /\s*,?\s*\\text\{\s*for\s*\}\s*[A-Za-z](?:_\{?\w+\}?)?\s*(?:\\neq\b|≠|!=)\s*\S[^,]*\s*$/;
const IN_SET_TAIL =
  /,\s*(?:\\quad\s*|\\;\s*|\\,\s*)?[A-Za-z](?:_\{?\w+\}?)?\s*\\in\s*\\mathbb\{[A-Z]\}\s*$/;

/** Strip a single trailing domain constraint — ", x ≠ 1", "\text{ for } x \neq 1",
 *  or ", C \in \mathbb{R}". Returns the remainder, or null when no tail matches. */
export function stripTrailingConstraint(s: string): string | null {
  for (const re of [CONSTRAINT_TAIL, TEXT_FOR_TAIL, IN_SET_TAIL]) {
    const m = s.match(re);
    if (m && m.index !== undefined) {
      const stripped = s.slice(0, m.index).trim();
      if (stripped.length > 0) return stripped;
    }
  }
  return null;
}

/** When EVERY top-level comma segment is "<label> = <value>" (e.g.
 *  "\lambda_1 = i, \lambda_2 = -i"), return the bare value list "i, -i".
 *  Mixed labeled/unlabeled input returns null (left untouched). */
export function stripValueLabels(s: string): string | null {
  const cleaned = s
    .replace(/\\text\{\s*and\s*\}/g, ', ')
    .replace(/\s+\band\b\s+/g, ', ')
    .replace(/\\quad\b/g, ' ')
    .trim();
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

const CONSTANT_TAIL = /\s*\+\s*C(?:_\{?\d+\}?)?\s*$/;

/** Strip a trailing bare integration constant "+ C" / "+ C_1". Refuses when
 *  the ground truth itself contains a C (the constant is then meaningful)
 *  or when the C is part of a product term (general-solution shape). */
export function stripConstantTail(s: string, ground: string): string | null {
  if (/C/.test(ground)) return null;
  const m = s.match(CONSTANT_TAIL);
  if (!m || m.index === undefined) return null;
  const stripped = s.slice(0, m.index).trim();
  return stripped.length > 0 ? stripped : null;
}

const BIG_O_TAIL = /\s*\+\s*(?:\\mathcal\{O\}|O)\s*\(\s*x\s*(?:\^\s*\{?\d+\}?)?\s*\)?\s*$/;

/** Strip a trailing big-O remainder "+ \mathcal{O}(x^5)" / "+ O(x^6)",
 *  including the truncated form with a missing closing paren. */
export function stripBigOTail(s: string): string | null {
  const m = s.match(BIG_O_TAIL);
  if (!m || m.index === undefined) return null;
  const stripped = s.slice(0, m.index).trim();
  return stripped.length > 0 ? stripped : null;
}

/** Replace absolute-value bars DIRECTLY inside a logarithm: "ln|x|" → "ln(x)".
 *  Textbook-convention mismatch only; bars anywhere else are left alone. */
export function stripLogAbs(s: string): string | null {
  const cleaned = s.replace(/\\left\|/g, '|').replace(/\\right\|/g, '|');
  const out = cleaned.replace(/(\\?(?:ln|log))\s*\|([^|]+)\|/g, '$1($2)');
  return out !== cleaned ? out : null;
}

const PERCENT_TAIL = /\s*\\?%\s*$/;

/** Strip a trailing percent sign ("7\%" → "7") when the ground truth carries
 *  none — pure unit-notation mismatch (e.g. interest-rate answers). */
export function stripPercentTail(s: string, ground: string): string | null {
  if (/%/.test(ground)) return null;
  const m = s.match(PERCENT_TAIL);
  if (!m || m.index === undefined) return null;
  const stripped = s.slice(0, m.index).trim();
  return stripped.length > 0 ? stripped : null;
}

/** For a chained equality "a = b = c", return the final (most refined)
 *  segment as a candidate. Refuses multi-solution and listed forms — any
 *  top-level comma or an or/and connective means the equals signs belong to
 *  separate statements, not one chain. */
export function lastChainSegment(s: string): string | null {
  if (/\bor\b|\band\b/i.test(s)) return null;
  if (splitTopLevel(s, ',').length > 1) return null;
  const parts = splitTopLevel(s, '=')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length < 3) return null;
  return parts[parts.length - 1];
}
