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

/** Split a comma-separated list at top level (depth 0). */
function splitTopLevel(s: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of s) {
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (depth === 0 && ch === sep) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current) parts.push(current);
  return parts.map((p) => p.trim());
}

/** Extract set members from "{a, b, c}". Returns null if input is not a brace-enclosed set. */
function setMembers(s: string): string[] | null {
  const trimmed = s.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  const inner = trimmed.slice(1, -1);
  return splitTopLevel(inner, ',');
}

interface Interval {
  lo: string;
  hi: string;
  loOpen: boolean;
  hiOpen: boolean;
}

/** Parse "[a, b]", "(a, b]", "[a, ∞)" → Interval. Null if not parseable. */
function parseInterval(s: string): Interval | null {
  const m = s.match(/^([(\[])\s*(.+?)\s*,\s*(.+?)\s*([)\]])$/);
  if (!m) return null;
  return { lo: m[2], hi: m[3], loOpen: m[1] === '(', hiOpen: m[4] === ')' };
}

/** Convert a conditional like "x >= a" or "x > a" or "x <= a" into an Interval. */
function conditionalToInterval(s: string): Interval | null {
  const ge = s.match(/^[a-zA-Z]\s*>=\s*(.+)$/);
  if (ge) return { lo: ge[1].trim(), hi: 'inf', loOpen: false, hiOpen: true };
  const gt = s.match(/^[a-zA-Z]\s*>\s*(.+)$/);
  if (gt) return { lo: gt[1].trim(), hi: 'inf', loOpen: true, hiOpen: true };
  const le = s.match(/^[a-zA-Z]\s*<=\s*(.+)$/);
  if (le) return { lo: '-inf', hi: le[1].trim(), loOpen: true, hiOpen: false };
  const lt = s.match(/^[a-zA-Z]\s*<\s*(.+)$/);
  if (lt) return { lo: '-inf', hi: lt[1].trim(), loOpen: true, hiOpen: true };
  return null;
}

/** Convert "x = a or x = b" → ['a','b']. Null if not in this form. */
function conditionalToSet(s: string): string[] | null {
  const parts = s.split(/\s+or\s+/i);
  if (parts.length < 2) return null;
  const out: string[] = [];
  for (const p of parts) {
    const m = p.match(/^[a-zA-Z]\s*=\s*(.+)$/);
    if (!m) return null;
    out.push(m[1].trim());
  }
  return out;
}

/** Normalize an interval bound — converts ∞/infty/inf variants and runs full normalize(). */
function normalizeBound(s: string): string {
  return stripRedundantParens(normalize(s).canonical)
    .replace(/\binfty\b/gi, 'inf')
    .replace(/\binfinity\b/gi, 'inf');
}

/**
 * Collapse redundant parens around atomic tokens, e.g. `(82)` → `82`.
 * Skips function-call parens by requiring the preceding character to NOT be
 * a letter/digit/underscore: `sqrt(2)` is left alone because `t` precedes `(`.
 */
function stripRedundantParens(s: string): string {
  // Repeatedly strip parens around an atomic alphanumeric token when the
  // opening paren is at start-of-string or preceded by a non-identifier char.
  let prev: string;
  let cur = s;
  do {
    prev = cur;
    cur = cur.replace(/(^|[^A-Za-z0-9_])\(([A-Za-z0-9_.]+)\)/g, '$1$2');
  } while (cur !== prev);
  return cur;
}

export function gradeV2(
  predicted: string,
  ground: string,
  _opts: GradeOptions = {}
): GradeResultV2 {
  if (predicted.trim() === ground.trim()) {
    return finish(true, 'exact-string-match', 'scalar', 'exact');
  }

  const p = normalize(predicted);
  const g = normalize(ground);

  // Stage 2: normalized string (with redundant-parens fold)
  const pCanon = stripRedundantParens(p.canonical);
  const gCanon = stripRedundantParens(g.canonical);
  if (pCanon && pCanon === gCanon) {
    return finish(true, 'normalized-string-match', g.kind, 'normalized');
  }

  // Stage 3: numeric tolerance
  if (p.decimal !== null && g.decimal !== null) {
    if (Math.abs(p.decimal - g.decimal) <= NUMERIC_TOLERANCE) {
      return finish(true, 'numeric-tolerance-match', g.kind, 'numeric');
    }
    // Fall through — set/interval matching may still apply.
  }

  // Stage 4: set match (order-insensitive)
  // Note: plain {a,b} has braces stripped by normalize; detect from canonical OR original input.
  // Also, conditionalToSet must be called on the raw input (whitespace preserved) because
  // the canonical collapses all whitespace, eating the spaces around "or".
  const pSetRaw = extractSetFromInput(predicted);
  const gSetRaw = extractSetFromInput(ground);
  const pSet = pSetRaw ?? setMembers(p.canonical) ?? conditionalToSet(predicted.trim());
  const gSet = gSetRaw ?? setMembers(g.canonical) ?? conditionalToSet(ground.trim());
  if (pSet && gSet && pSet.length === gSet.length) {
    const pn = pSet.map((m) => normalize(m).canonical).sort();
    const gn = gSet.map((m) => normalize(m).canonical).sort();
    if (pn.every((v, i) => v === gn[i])) {
      return finish(true, 'set-equal', 'set', 'set');
    }
  }

  // Stage 5: interval match (incl. conditional → interval lift)
  const pI = parseInterval(p.canonical) ?? conditionalToInterval(p.canonical);
  const gI = parseInterval(g.canonical) ?? conditionalToInterval(g.canonical);
  if (pI && gI) {
    if (
      normalizeBound(pI.lo) === normalizeBound(gI.lo) &&
      normalizeBound(pI.hi) === normalizeBound(gI.hi) &&
      pI.loOpen === gI.loOpen &&
      pI.hiOpen === gI.hiOpen
    ) {
      return finish(true, 'interval-equal', 'interval', 'interval');
    }
  }

  return finish(false, 'no-match', g.kind, 'none');
}

/**
 * Detect a brace-enclosed set from the raw (pre-normalize) input string.
 * Handles both plain `{a, b}` and LaTeX `\{a, b\}`.
 * Returns members array or null if input is not a set.
 */
function extractSetFromInput(input: string): string[] | null {
  const s = input.trim();
  // LaTeX: \{...\}
  const latexMatch = s.match(/^\\\{(.+)\\\}$/);
  if (latexMatch) {
    return splitTopLevel(latexMatch[1], ',');
  }
  // Plain: {...}
  const plainMatch = s.match(/^\{(.+)\}$/);
  if (plainMatch) {
    return splitTopLevel(plainMatch[1], ',');
  }
  return null;
}

function finish(
  match: boolean,
  reason: string,
  kind: AnswerKind,
  method: GradeResultV2['method']
): GradeResultV2 {
  return { match, reason, kind, method };
}

/**
 * Async variant: same as gradeV2 but adds a final symbolic-equivalence stage
 * via Giac when an evaluator is provided.
 */
export async function gradeV2Async(
  predicted: string,
  ground: string,
  opts: GradeOptions = {}
): Promise<GradeResultV2> {
  const sync = gradeV2(predicted, ground, opts);
  if (sync.match) return sync;

  if (!opts.giacEval) return sync;

  // Only attempt symbolic equivalence when both sides are symbolic-ish.
  const p = normalize(predicted);
  const g = normalize(ground);
  if (!p.canonical || !g.canonical) return sync;
  if (p.kind === 'scalar' && g.kind === 'scalar') return sync;
  if (p.kind === 'set' || g.kind === 'set') return sync;
  if (p.kind === 'interval' || g.kind === 'interval') return sync;

  const expr = `simplify((${p.canonical}) - (${g.canonical}))`;
  let result: string | null;
  try {
    result = await opts.giacEval(expr);
  } catch {
    return sync;
  }
  if (result === null) return sync;

  const trimmed = result.trim().replace(/\s+/g, '');
  if (trimmed === '0' || trimmed === '0.0') {
    return finish(true, 'symbolic-equivalence', g.kind, 'symbolic');
  }
  return sync;
}
