import { normalize } from './normalizer.js';
import type { AnswerKind } from './normalizer.js';

export interface GradeResultV2 {
  match: boolean;
  reason: string;
  kind: AnswerKind;
  method:
    | 'exact'
    | 'normalized'
    | 'numeric'
    | 'set'
    | 'interval'
    | 'conditional'
    | 'symbolic'
    | 'none';
}

const NUMERIC_TOLERANCE = 1e-6;

export interface GradeOptions {
  /** Optional Giac evaluator. Returns null if Giac timed out or errored.
   *  When absent, symbolic equivalence is skipped. */
  giacEval?: (expr: string) => Promise<string | null>;
}

/**
 * Strip redundant parentheses around plain numeric/identifier tokens in
 * fraction position: `(82)/(27)` → `82/27`.  Only removes parens that wrap
 * a maximal run of digits, letters, dots, and underscores — never strips
 * parens that group a compound sub-expression (e.g. `(a+b)/c` stays).
 */
function stripRedundantParens(s: string): string {
  return s.replace(/\(([A-Za-z0-9_.]+)\)/g, '$1');
}

export function gradeV2(
  predicted: string,
  ground: string,
  _opts: GradeOptions = {}
): GradeResultV2 {
  // Stage 1: exact string
  if (predicted.trim() === ground.trim()) {
    return finish(true, 'exact-string-match', 'scalar', 'exact');
  }

  const p = normalize(predicted);
  const g = normalize(ground);

  // Stage 2: normalized string (with secondary paren-stripping for fraction forms)
  const pSimple = stripRedundantParens(p.canonical);
  const gSimple = stripRedundantParens(g.canonical);
  if (pSimple && pSimple === gSimple) {
    return finish(true, 'normalized-string-match', g.kind, 'normalized');
  }

  // Stage 3: numeric (only if both reduce to a finite decimal)
  if (p.decimal !== null && g.decimal !== null) {
    if (Math.abs(p.decimal - g.decimal) <= NUMERIC_TOLERANCE) {
      return finish(true, 'numeric-tolerance-match', g.kind, 'numeric');
    }
    return finish(false, 'numeric-mismatch', g.kind, 'numeric');
  }

  return finish(false, 'no-match', g.kind, 'none');
}

function finish(
  match: boolean,
  reason: string,
  kind: AnswerKind,
  method: GradeResultV2['method']
): GradeResultV2 {
  return { match, reason, kind, method };
}
