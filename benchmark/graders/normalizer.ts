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

/** Extract `\boxed{...}` content (innermost, balanced braces). Returns null if not present. */
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

/** Apply LaTeX → plain transformations. */
function latexToPlain(s: string): string {
  let r = s;
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
  // Drop spacing macros: \, \; \: \! \\ \%
  r = r.replace(/\\[,;:!%]/g, '');
  r = r.replace(/\\\\/g, '');
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

  // Collapse whitespace
  const canonical = s.replace(/\s+/g, '');

  return {
    canonical,
    latex: input.trim(),
    decimal: null,
    is_exact: false,
    kind: 'scalar',
  };
}
