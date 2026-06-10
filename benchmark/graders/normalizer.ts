/**
 * Canonicalizes math answers from LaTeX/Unicode/mixed forms into a single
 * comparable string. Pure-function module — no I/O.
 */

import { unicodeToAscii } from '../../src/server/tools/unicode-normalize.js';

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
  // Known functions: insert explicit '*' when the command directly follows an
  // operand, then wrap a space-separated single-atom argument in parens.
  const FUNC_NAMES = 'arcsin|arccos|arctan|sinh|cosh|tanh|sin|cos|tan|cot|sec|csc|ln|log|exp';
  r = r.replace(new RegExp(`([A-Za-z0-9)}])\\s*\\\\(${FUNC_NAMES})\\b`, 'g'), '$1*\\$2');
  r = r.replace(
    new RegExp(`\\\\(${FUNC_NAMES})\\s+([A-Za-z0-9]+(?:\\^[A-Za-z0-9]+)?)`, 'g'),
    '$1($2)'
  );
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
  return unicodeToAscii(s);
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

  // Single atomic token keeps the brace-free form (x^{2} → x^2); anything
  // longer needs parens to survive as one exponent (e^{-2x} → e^(-2x)).
  s = s.replace(/\^\{([^{}]+)\}/g, (_m, inner: string) => {
    const tok = inner.trim();
    return /^(\d+|[A-Za-z])$/.test(tok) ? `^${tok}` : `^(${tok})`;
  });
  s = s.replace(/[{}]/g, '');

  // Restore set delimiters that were protected from brace-stripping.
  s = s.replace(new RegExp(SET_OPEN, 'g'), '{');
  s = s.replace(new RegExp(SET_CLOSE, 'g'), '}');

  // Split a fused single-char factor off "e^": "xe^x" → "x*e^x", "3e^(2x)" → "3*e^(2x)".
  s = s.replace(/(?<![A-Za-z0-9_])([A-Za-z0-9])e\^/g, '$1*e^');
  // Standalone Euler base → exp(): "e^x" → "exp(x)", "e^(-2x)" → "exp(-2x)".
  s = s.replace(/(?<![A-Za-z0-9_])e\^(\([^()]*\)|[A-Za-z0-9]+)/g, (_m, ex: string) =>
    `exp(${ex.startsWith('(') ? ex.slice(1, -1) : ex})`
  );

  // Collapse whitespace
  const canonical = s.replace(/\s+/g, '');

  const decimal = tryEval(canonical);
  // is_exact holds only when the decimal IS the exact value — not a float
  // approximation. Excludes irrational roots and transcendental constants.
  const has_irrational = /\bsqrt\b|\bpi\b|\be\b|\bexp\b/.test(canonical);
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
  // Bracketed comma-separated → set or interval
  if (/^[(\[].*[)\]]$/.test(canonical) && /,/.test(canonical)) {
    return 'interval';
  }
  if (/^\{.*\}$/.test(canonical)) return 'set';

  // Comparison operator + a variable letter → conditional
  if (/(>=|<=|>|<|=)/.test(canonical) && /[a-zA-Z]/.test(canonical)) return 'conditional';

  // Pure scalar = numeric expression possibly built from known constants
  // (pi, e, i) and known functions (sqrt). Strip these tokens before checking
  // for residual variable letters.
  const stripped = canonical
    .replace(/\bsqrt\b/g, '')
    .replace(/\bexp\b/g, '')
    .replace(/\bpi\b/g, '')
    .replace(/\binfty\b/gi, '')
    .replace(/\binfinity\b/gi, '')
    .replace(/\be\b/g, '')
    .replace(/\bi\b/g, '');
  if (!/[a-zA-Z]/.test(stripped)) return 'scalar';

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
    .replace(/exp\(([^()]+)\)/g, 'Math.exp($1)')
    .replace(/\be\b/g, String(Math.E))
    .replace(/sqrt\(([^()]+)\)/g, 'Math.sqrt($1)')
    .replace(/\^/g, '**');

  // Strip recognized Math.sqrt(...) calls, then verify the residue is composed
  // exclusively of digits, decimal point, arithmetic operators, parentheses,
  // and whitespace. This rejects array literals, comma operators, identifiers,
  // and anything else.
  const stripped = e.replace(/Math\.(?:sqrt|exp)\([^()]*\)/g, '');
  if (!/^[\d.+\-*/()\s]*$/.test(stripped)) return null;

  try {
    // eslint-disable-next-line no-new-func
    const v = Function(`"use strict"; return (${e})`)() as number;
    return typeof v === 'number' && isFinite(v) ? v : null;
  } catch {
    return null;
  }
}
