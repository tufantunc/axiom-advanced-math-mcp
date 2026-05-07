/**
 * Canonicalizes math answers from LaTeX/Unicode/mixed forms into a single
 * comparable string. Pure-function module — no I/O.
 */

export type AnswerKind = 'scalar' | 'set' | 'interval' | 'conditional' | 'expression';

export interface NormalizedAnswer {
  canonical: string;
  latex: string;
  decimal: number | null;
  is_exact: boolean;
  kind: AnswerKind;
}

/** Extract the LAST `\boxed{...}` content with balanced braces. Returns null if not present.
 *  We take the last occurrence because models typically place the final answer in the
 *  last `\boxed{}` of their response. */
function extractBoxed(s: string): string | null {
  const idx = s.lastIndexOf('\\boxed{');
  if (idx === -1) return null;
  const start = idx + '\\boxed{'.length;
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') {
      if (depth === 0) return s.slice(start, i);
      depth--;
    }
  }
  return null;
}

// Private-use placeholder characters to protect \{ \} set delimiters from brace-stripping.
const SET_OPEN = '';
const SET_CLOSE = '';

/** Apply LaTeX → plain transformations. */
function latexToPlain(s: string): string {
  let r = s;
  // Protect LaTeX set delimiters \{ and \} before any other processing.
  r = r.replace(/\\\{/g, SET_OPEN);
  r = r.replace(/\\\}/g, SET_CLOSE);
  // Iteratively expand \frac / \dfrac / \tfrac with one-level nesting support.
  for (let i = 0; i < 5; i++) {
    r = r.replace(/\\[dt]?frac\{((?:[^{}]|\{[^}]*\})+)\}\{((?:[^{}]|\{[^}]*\})+)\}/g, '($1)/($2)');
  }
  r = r.replace(/\\sqrt\{((?:[^{}]|\{[^}]*\})+)\}/g, 'sqrt($1)');
  r = r.replace(/\\left\s*/g, '').replace(/\\right\s*/g, '');
  r = r.replace(/\\cdot\b/g, '*').replace(/\\times\b/g, '*');
  r = r.replace(/\\div\b/g, '/');
  r = r.replace(/\\pi\b/g, 'pi');
  r = r.replace(/\\text\{([^}]*)\}/g, '$1');
  r = r.replace(/\\mathrm\{([^}]*)\}/g, '$1');
  r = r.replace(/\\mathbf\{([^}]*)\}/g, '$1');
  r = r.replace(/\\displaystyle\b/g, '');
  // Drop spacing macros: \, \; \: \!
  r = r.replace(/\\[,;:!]/g, '');
  r = r.replace(/\\\\/g, '');
  // \% is an escaped literal percent — preserve it as %
  r = r.replace(/\\%/g, '%');
  // Strip remaining unknown LaTeX commands like \alpha (keep the name).
  r = r.replace(/\\([a-zA-Z]+)/g, '$1');
  return r;
}

/** Apply Unicode → plain transformations. */
function unicodeToPlain(s: string): string {
  return s
    .replace(/π/g, 'pi')
    .replace(/×/g, '*')
    .replace(/÷/g, '/')
    .replace(/²/g, '^2')
    .replace(/³/g, '^3')
    .replace(/⁰/g, '^0')
    .replace(/¹/g, '^1')
    .replace(/⁴/g, '^4')
    .replace(/⁵/g, '^5')
    .replace(/⁶/g, '^6')
    .replace(/⁷/g, '^7')
    .replace(/⁸/g, '^8')
    .replace(/⁹/g, '^9');
}

/**
 * Normalize one answer string into a canonical comparable form.
 * `kind` is set to 'scalar' for now; later tasks override it for sets/intervals/conditionals.
 */
export function normalize(input: string): NormalizedAnswer {
  let s = input.trim();
  s = s.replace(/^\$+|\$+$/g, ''); // strip outer math delimiters

  const boxed = extractBoxed(s);
  if (boxed !== null) s = boxed;

  s = latexToPlain(s);
  s = unicodeToPlain(s);

  // Drop curly braces left over from non-fraction LaTeX: x^{2} → x^2
  s = s.replace(/\^\{([^{}]+)\}/g, '^$1');
  s = s.replace(/[{}]/g, '');

  // Restore set delimiters that were protected from brace-stripping.
  s = s.replace(new RegExp(SET_OPEN, 'g'), '{');
  s = s.replace(new RegExp(SET_CLOSE, 'g'), '}');

  // Collapse whitespace
  const canonical = s.replace(/\s+/g, '');

  const decimal = tryEval(canonical);
  // is_exact holds only when the decimal IS the exact value — not a float
  // approximation. Excludes irrational roots and transcendental constants.
  const has_irrational = /\bsqrt\b|\bpi\b|\be\b/.test(canonical);
  const is_exact = decimal !== null && !has_irrational;

  const kind = detectKind(canonical);

  return {
    canonical,
    latex: input.trim(),
    decimal,
    is_exact,
    kind,
  };
}

function detectKind(canonical: string): AnswerKind {
  // Strip a leading minus that might trip the scalar check
  const trimmed = canonical.replace(/^-/, '');
  if (/^[(\[].*[)\]]$/.test(canonical) && /,/.test(canonical)) {
    // Has surrounding brackets and a comma — interval or set
    if (canonical.startsWith('{') || /^\\\{/.test(canonical)) return 'set';
    return 'interval';
  }
  if (/^\{.*\}$/.test(canonical)) return 'set';
  if (/(>=|<=|>|<|=)/.test(canonical) && /[a-zA-Z]/.test(canonical)) return 'conditional';
  if (/\bor\b/.test(canonical)) return 'conditional';
  // Pure scalar = no letters except the constants pi / e / i
  if (!/[a-df-hj-zA-DF-HJ-Z]/.test(trimmed)) return 'scalar';
  return 'expression';
}

/**
 * Attempt safe numeric eval of an already-canonicalized expression.
 * Returns null if expression contains anything outside the strict allowlist
 * (digits, decimal point, + - * / ^ parentheses, whitespace, pi, e, sqrt(...)).
 *
 * @param expr - must be a canonical string already processed by latexToPlain/unicodeToPlain.
 */
function tryEval(expr: string): number | null {
  if (!expr) return null;
  let e = expr
    .replace(/\bpi\b/g, String(Math.PI))
    .replace(/\be\b/g, String(Math.E))
    .replace(/sqrt\(([^()]+)\)/g, 'Math.sqrt($1)')
    .replace(/\^/g, '**');

  // Strip recognized Math.sqrt(...) calls, then verify the residue is composed
  // exclusively of digits, decimal point, arithmetic operators, parentheses,
  // and whitespace. This rejects array literals, comma operators, identifiers,
  // and anything else.
  const stripped = e.replace(/Math\.sqrt\([^()]*\)/g, '');
  if (!/^[\d.+\-*/()\s]*$/.test(stripped)) return null;

  try {
    // eslint-disable-next-line no-new-func
    const v = Function(`"use strict"; return (${e})`)() as number;
    return typeof v === 'number' && isFinite(v) ? v : null;
  } catch {
    return null;
  }
}
