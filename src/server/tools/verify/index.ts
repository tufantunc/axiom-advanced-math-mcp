import { z } from 'zod';
import { MAX_EXPRESSION_LENGTH } from '../limits.js';
import { giacEngine } from '../../giac/index.js';
import { superscriptRefusal, unicodeToAscii } from '../unicode-normalize.js';
import { rewriteCombinatorics } from '../combinatorics-rewrite.js';
import { stripOrderTerm } from '../output-cleanup.js';

export const verifySchema = z.object({
  claim: z
    .string()
    .min(1)
    .max(MAX_EXPRESSION_LENGTH, `claim must be at most ${MAX_EXPRESSION_LENGTH} characters`)
    .describe(
      'Mathematical claim to verify. Examples:\n' +
        '  "sin(x)^2 + cos(x)^2 = 1"     — identity check\n' +
        '  "x=2 satisfies x^2-4=0"        — solution check\n' +
        '  "diff(x^3, x) = 3*x^2"         — computation check'
    ),
  method: z
    .enum(['numeric', 'symbolic', 'both'])
    .optional()
    .describe('Verification method (default: "both")'),
  format: z
    .enum(['text', 'json'])
    .optional()
    .describe(
      'Output format:\n' +
        '  text (default) — human-readable verdict\n' +
        '  json — structured VerifyResult'
    ),
});

export interface VerifyResult {
  verified: boolean;
  confidence: 'high' | 'medium' | 'low';
  explanation: string;
  checks_performed: string[];
  /**
   * Whether the claim was actually checked.
   *
   * `false` means no check produced a usable answer — the claim did not parse,
   * or every strategy failed on it. That is NOT the same as "checked and found
   * false", and collapsing the two is a wrong answer: `verify '((('` and
   * `verify 'x + = 1'` both used to report `verified: false`, which the CLI
   * turned into exit 2 ("ran and disproved"). A script reading that exit code
   * treats a syntax error as a refuted theorem.
   *
   * `verified: true` implies `evaluated: true` — a check that returned true
   * necessarily ran.
   */
  evaluated: boolean;
}

// ---------------------------------------------------------------------------
// Verification strategies
// ---------------------------------------------------------------------------

/**
 * Split an expression into top-level additive terms, keeping each term's
 * leading sign with what follows it. Boundaries are `+`/`-` at depth 0 only,
 * and a term that is empty or a lone dash is dropped.
 */
function splitAdditiveTerms(expr: string): string[] {
  const terms: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of expr) {
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (depth === 0 && (ch === '+' || ch === '-') && cur.trim() !== '') {
      terms.push(cur);
      cur = ch === '-' ? '-' : '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim() !== '' && cur.trim() !== '-') terms.push(cur);
  return terms;
}

/**
 * True when `expr` consists ONLY of top-level additive terms that carry an
 * order_size factor — i.e. it is a series remainder, zero for verification
 * purposes. (stripOrderTerm cannot be used here: it returns the ORIGINAL
 * string when stripping would leave nothing.)
 */
function isOrderResidueOnly(expr: string): boolean {
  if (!expr.includes('order_size')) return false;
  const terms = splitAdditiveTerms(expr);
  return terms.length > 0 && terms.every((t) => t.includes('order_size'));
}

/**
 * Giac's undefined marker, wherever it appears in output: bare (`undef`),
 * applied to what produced it (`undef(x)`), or inside a list (`[undef,x]`).
 * Matched on word boundaries because Giac echoes identifiers that merely
 * contain the letters verbatim (`undefx + 1` evaluates to `undefx + 1`,
 * `my_undef*2` to `my_undef*2`), and those must not be refused.
 */
function containsUndefinedMarker(giacOutput: string): boolean {
  return /\bundef\b/.test(giacOutput);
}

/**
 * The UNKNOWN verdict for a claim whose notation Giac read as undefined.
 * Not FALSE: nothing was compared, and calling it a refutation would tell a
 * script the mathematics failed when the notation was never understood.
 */
function undefinedReadingResult(whatReadsUndefined: string): VerifyResult {
  return {
    verified: false,
    evaluated: false,
    confidence: 'low',
    explanation:
      `Could not check the claim: Giac read ${whatReadsUndefined} as its ` +
      `undefined marker (undef) — the notation was not understood.`,
    checks_performed: ['undefined_reading'],
  };
}

/**
 * Whether Giac's reading of `expr` carries its undefined marker. An
 * evaluation error is not an undefined reading — the existing error paths
 * handle those — so this answers false there. (Deliberately a weaker policy
 * than the identity path's unreadable-side refusal: the solution strategies
 * re-evaluate these same strings and degrade to UNKNOWN on their own, so a
 * rejected read here costs time, never a verdict.)
 */
async function readsAsUndefined(expr: string): Promise<boolean> {
  try {
    const r = await giacEngine.evaluate(expr);
    return !!r && containsUndefinedMarker(r);
  } catch {
    return false;
  }
}

/** One side of an identity claim, as it will be handed to the strategies. */
interface SideReading {
  /** The side itself, or its polynomial part when a series remainder was stripped. */
  expr: string;
  /** Giac's own reading of this side carries its undefined marker. */
  readsUndefined: boolean;
  /** The reading never came back — the engine errored or answered nothing. */
  unreadable: boolean;
}

/**
 * Pre-normalize one side of an identity claim: when it evaluates to a series
 * result carrying an order_size remainder, substitute the bare polynomial.
 * An evaluation problem marks the side unreadable rather than silently
 * proceeding on it.
 */
async function normalizeSide(side: string): Promise<SideReading> {
  try {
    const r = await giacEngine.evaluate(side);
    if (r) {
      // A side whose reading carries the undefined marker was not understood,
      // not evaluated: Giac answers `(f^(+))(x)` with `undef(x)` instead of an
      // error. Refused here, before either strategy runs, because two
      // identical undefined readings AGREE — the symbolic difference is 0 and
      // every sampled point substitutes to 0 — and would certify the claim.
      if (containsUndefinedMarker(r)) {
        return { expr: side, readsUndefined: true, unreadable: false };
      }
      if (r.includes('order_size')) {
        const stripped = stripOrderTerm(r);
        if (stripped && stripped !== r) {
          return { expr: `(${stripped})`, readsUndefined: false, unreadable: false };
        }
      }
    } else {
      // An empty answer is not a clean reading; the worker resolved nothing.
      return { expr: side, readsUndefined: false, unreadable: true };
    }
  } catch {
    // A side the engine could not read cannot be checked — and letting the
    // strategies run on it lets a transient failure (worker crash, IPC loss,
    // timeout) fabricate a verdict out of notation that was never read.
    return { expr: side, readsUndefined: false, unreadable: true };
  }
  return { expr: side, readsUndefined: false, unreadable: false };
}

/**
 * Symbolic verification: simplify(LHS - RHS) and check if result is 0.
 */
async function verifySymbolic(
  lhs: string,
  rhs: string
): Promise<{
  verified: boolean;
  evaluated: boolean;
  detail: string;
}> {
  try {
    const expr = `simplify((${lhs}) - (${rhs}))`;
    const result = await giacEngine.evaluate(expr);

    // The marker anywhere in the reading — not only as the whole result —
    // means the difference is undefined, so nothing was compared. The sides
    // are refused upstream when THEY read undefined; this parse site keeps
    // the same invariant for a marker the simplification itself produces
    // (`undef(…)`-shaped output would otherwise report a refutation instead
    // of a non-answer).
    if (!result || containsUndefinedMarker(result)) {
      return { verified: false, evaluated: false, detail: 'Simplification returned undefined' };
    }

    const trimmed = result.trim();
    const isZero = trimmed === '0' || trimmed === '0.0' || isOrderResidueOnly(trimmed);

    return {
      verified: isZero,
      evaluated: true,
      detail: isZero
        ? `simplify(LHS - RHS) = 0 ✓`
        : `simplify(LHS - RHS) = ${trimmed} (expected 0)`,
    };
  } catch (error) {
    // A Giac error here is a malformed claim, not a false one.
    return {
      verified: false,
      evaluated: false,
      detail: `Symbolic check failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Numeric verification: substitute random values for all variables
 * and check if LHS ≈ RHS.
 */
interface CheckOutcome {
  verified: boolean;
  evaluated: boolean;
  detail: string;
}

async function verifyNumericDirect(lhs: string, rhs: string): Promise<CheckOutcome> {
  // No variables — direct numeric evaluation
  const lhsVal = await giacEngine.evaluate(`evalf(${lhs})`);
  const rhsVal = await giacEngine.evaluate(`evalf(${rhs})`);
  const diff = Math.abs(Number.parseFloat(lhsVal) - Number.parseFloat(rhsVal));
  // A non-numeric side leaves diff NaN: nothing was compared, so this is
  // "could not check", not "checked and unequal".
  if (Number.isNaN(diff)) {
    return {
      verified: false,
      evaluated: false,
      detail: `Direct evaluation produced no number: ${lhsVal} / ${rhsVal}`,
    };
  }
  const verified = diff < 1e-8;
  return {
    verified,
    evaluated: true,
    detail: verified
      ? `Direct evaluation: ${lhsVal} ≈ ${rhsVal} ✓`
      : `Direct evaluation: ${lhsVal} ≠ ${rhsVal} (diff = ${diff})`,
  };
}

async function verifyNumericSampled(
  lhs: string,
  rhs: string,
  vars: string[]
): Promise<CheckOutcome> {
  // Test with multiple random values
  const testPoints = [0.5, 1.0, 1.5, 2.0, -1.0];
  let passCount = 0;
  let totalTested = 0;
  const failures: string[] = [];

  for (const val of testPoints) {
    try {
      let substExpr = `(${lhs}) - (${rhs})`;
      for (const v of vars) {
        substExpr = `subst(${substExpr}, ${v}=${val})`;
      }
      const result = await giacEngine.evaluate(`evalf(${substExpr})`);
      const numResult = Number.parseFloat(result);

      if (!Number.isFinite(numResult)) {
        continue; // Skip undefined points
      }

      totalTested++;
      if (Math.abs(numResult) < 1e-6) {
        passCount++;
      } else {
        const where = vars.map((v) => `${v}=${val}`).join(', ');
        failures.push(`At ${where}: diff = ${numResult}`);
      }
    } catch {
      // Skip points that cause evaluation errors
    }
  }

  if (totalTested === 0) {
    return { verified: false, evaluated: false, detail: 'Could not evaluate at any test point' };
  }

  const verified = passCount === totalTested;
  return {
    verified,
    evaluated: true,
    detail: verified
      ? `Passed ${passCount}/${totalTested} numeric checks ✓`
      : `Failed: ${failures.join('; ')}`,
  };
}

async function verifyNumeric(lhs: string, rhs: string): Promise<CheckOutcome> {
  try {
    // Extract variables
    const varsResult = await giacEngine.evaluate(`lname(${lhs})`);
    const vars = parseVariableList(varsResult);

    // awaited, not bare-returned: a rejection inside an arm must land in this
    // catch, not escape it as an unhandled rejection.
    if (vars.length === 0) {
      return await verifyNumericDirect(lhs, rhs);
    }
    return await verifyNumericSampled(lhs, rhs, vars);
  } catch (error) {
    return {
      verified: false,
      evaluated: false,
      detail: `Numeric check failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Solution verification: check if a value satisfies an equation.
 * e.g., "x=2 satisfies x^2-4=0"
 */
async function verifySolution(
  variable: string,
  value: string,
  equation: string
): Promise<{ verified: boolean; evaluated: boolean; detail: string }> {
  try {
    // Parse equation into expression = 0 form
    let expr: string;
    if (equation.includes('=')) {
      const [lhs, rhs] = splitEquation(equation);
      expr = `(${lhs}) - (${rhs})`;
    } else {
      expr = equation;
    }

    const substituted = `evalf(subst(${expr}, ${variable}=${value}))`;
    const result = await giacEngine.evaluate(substituted);
    const numResult = Number.parseFloat(result);

    // No number back means the substitution did not produce something
    // comparable to zero — nothing was checked.
    if (Number.isNaN(numResult)) {
      return {
        verified: false,
        evaluated: false,
        detail: `Substituting ${variable}=${value} produced no number: ${result}`,
      };
    }

    const verified = Math.abs(numResult) < 1e-8;
    return {
      verified,
      evaluated: true,
      detail: verified
        ? `Substituting ${variable}=${value}: equation evaluates to ${result} ≈ 0 ✓`
        : `Substituting ${variable}=${value}: equation evaluates to ${result} ≠ 0`,
    };
  } catch (error) {
    return {
      verified: false,
      evaluated: false,
      detail: `Solution check failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Claim parsing
// ---------------------------------------------------------------------------

function parseVariableList(giacOutput: string): string[] {
  if (!giacOutput || giacOutput === 'undef' || giacOutput.trim() === '[]') {
    return [];
  }
  // Parse [x, y, z] or list(x, y, z)
  const inner = /^\[(.+)\]$/.exec(giacOutput)?.[1] || /^list\((.+)\)$/.exec(giacOutput)?.[1] || '';
  return (
    inner
      .split(',')
      .map((s) => s.trim())
      // `undef` is Giac's undefined marker, not an identifier. It comes back
      // inside a list when Giac swallows a syntax error — `lname(x +)` returns
      // `[undef]` — and treating it as a free variable makes the numeric check
      // substitute values into nonsense and report real-looking differences,
      // turning a malformed claim into a refuted one.
      .filter((s) => s.length > 0 && s !== 'undef' && /^[a-zA-Z_]\w*$/.test(s))
  );
}

interface ParsedClaim {
  type: 'identity' | 'solution' | 'unknown';
  lhs?: string;
  rhs?: string;
  variable?: string;
  value?: string;
  equation?: string;
}

/**
 * Split an equation string at its `=` separators into the two sides the
 * solution check reads. Exactly two sides are read: anything past a second
 * top-level `=` is dropped — which is why countTopLevelEquals refuses chains
 * before anything reads them. Shared by the reading guard, the substitution
 * and the symbolic follow-up so their notions of "the equation's sides"
 * cannot drift apart.
 */
function splitEquation(equation: string): [lhs: string, rhs?: string] {
  const [lhs, rhs] = equation.split('=').map((s) => s.trim());
  return [lhs, rhs];
}

/** Top-level `=` characters of a string, split into equation `=` and comparison tails. */
interface TopLevelEquals {
  singles: number;
  doubles: number;
  bangs: number;
}

/**
 * Count the string's top-level `=` characters — at paren/bracket depth zero,
 * mirroring findMainEquals. `==` counts as a comparison pair; the `=` of a
 * `!=` counts as a bang (the naive splitEquation breaks at every `=`
 * CHARACTER, and the piece before a bang-equal re-reads as a FACTORIAL, so
 * its mangle can come back a number — `24=4!=x` certified TRUE that way);
 * the `=` of `<=`/`>=` counts as nothing (a dangling `<`/`>` never
 * evaluates). A chain `a=b=c` carries more than one single.
 */
function countTopLevelEquals(equation: string): TopLevelEquals {
  let depth = 0;
  let bracketDepth = 0;
  const counts: TopLevelEquals = { singles: 0, doubles: 0, bangs: 0 };
  for (let i = 0; i < equation.length; i++) {
    const ch = equation[i];
    [depth, bracketDepth] = trackDepth(ch, depth, bracketDepth);
    if (ch === '=' && depth === 0 && bracketDepth === 0) {
      if (equation[i + 1] === '=') {
        counts.doubles++;
        i++;
        continue;
      }
      if (equation[i - 1] === '!') {
        counts.bangs++;
        continue;
      }
      if (!isTrailingComparisonEquals(equation, i)) counts.singles++;
    }
  }
  return counts;
}

/**
 * Whether a two-part reading of the equation (splitEquation) covers every
 * top-level `=` character: a chain `a=b=c` (more than one single) or an
 * equation glued to a comparison — `a=b==c`, `a=b!=c` — leaves notation the
 * two parts never reach, notation that would be certified unread.
 */
function hasUnreadTopLevelEquals(equation: string): boolean {
  const { singles, doubles, bangs } = countTopLevelEquals(equation);
  return singles > 1 || (singles >= 1 && doubles + bangs >= 1);
}

/**
 * The UNKNOWN verdict for an equation whose shape the solution check cannot
 * read: the substitution reads only two parts split at the first `=`
 * CHARACTER, so chained, comparison-mixed or nested-`=` equations would be
 * ruled on with part of the notation unread. Not FALSE — nothing was
 * compared.
 */
function equationShapeRefusal(what: string, why: string): VerifyResult {
  return {
    verified: false,
    evaluated: false,
    confidence: 'low',
    explanation: `Could not check the claim: ${what} ${why}`,
    checks_performed: ['equation_shape'],
  };
}

function parseClaim(claim: string): ParsedClaim {
  // Solution check: "x=2 satisfies x^2-4=0" or "x=2 is a solution of x^2-4=0"
  // Checked BEFORE the point-evaluation pattern so claims containing "at" with
  // solution phrasing are not hijacked by the lazy at-pattern.
  const solutionMatch =
    /(\w+)\s*=\s*([^,\s]+)\s+(?:satisfies|is\s+(?:a\s+)?solution\s+(?:of|to))\s+(.+)/i.exec(claim);
  if (solutionMatch) {
    return {
      type: 'solution',
      variable: solutionMatch[1],
      value: solutionMatch[2],
      equation: solutionMatch[3].trim(),
    };
  }

  // Point-evaluation claim: "EXPR at x=a = b" → identity subst(EXPR, x=a) = b
  const atMatch = /^(.+?)\s+at\s+([a-z]\w*)\s*=\s*([^=\s,]+)\s*=\s*(.+)$/i.exec(claim);
  if (atMatch) {
    return {
      type: 'identity',
      lhs: `subst(${atMatch[1].trim()}, ${atMatch[2]}=${atMatch[3]})`,
      rhs: atMatch[4].trim(),
    };
  }

  // Identity check: "LHS = RHS"
  // Find the main "=" that splits LHS and RHS (not inside parens/brackets)
  const eqIdx = findMainEquals(claim);
  if (eqIdx !== -1) {
    return {
      type: 'identity',
      lhs: claim.slice(0, eqIdx).trim(),
      rhs: claim.slice(eqIdx + 1).trim(),
    };
  }

  return { type: 'unknown' };
}

/**
 * Depth bookkeeping for one character: how many parens and brackets it opens
 * or closes. Split out of findMainEquals so the loop body reads as one rule
 * per character class.
 */
function trackDepth(ch: string, depth: number, bracketDepth: number): [number, number] {
  if (ch === '(') return [depth + 1, bracketDepth];
  if (ch === '[') return [depth, bracketDepth + 1];
  if (ch === ')') return [depth - 1, bracketDepth];
  if (ch === ']') return [depth, bracketDepth - 1];
  return [depth, bracketDepth];
}

function findMainEquals(expr: string): number {
  let depth = 0;
  let bracketDepth = 0;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    [depth, bracketDepth] = trackDepth(ch, depth, bracketDepth);
    if (ch === '=' && depth === 0 && bracketDepth === 0) {
      // Skip == (comparison operator) — BOTH characters, by advancing past
      // the second '=' here; consuming only the first would leave the second
      // as a candidate for the main equals (an extraction regression this
      // file has already shipped once).
      if (expr[i + 1] === '=') {
        i++;
        continue;
      }
      // Skip != or <=, >=
      if (!isTrailingComparisonEquals(expr, i)) return i;
    }
  }
  return -1;
}

/** Whether this `=` is the tail of `!=`, `<=`, or `>=` rather than a main equals. */
function isTrailingComparisonEquals(expr: string, i: number): boolean {
  return i > 0 && (expr[i - 1] === '!' || expr[i - 1] === '<' || expr[i - 1] === '>');
}

// ---------------------------------------------------------------------------
// Public handler
// ---------------------------------------------------------------------------

export async function verifyHandler(
  args: Record<string, unknown>
): Promise<{ content: { type: 'text'; text: string }[]; isError: boolean }> {
  const raw = typeof args.claim === 'string' ? args.claim : '';
  const method = (args.method as string) || 'both';
  const format = args.format === 'json' ? 'json' : 'text';

  // On the RAW claim, since normalised text has no superscripts left to judge.
  // Unevaluated rather than an error: the verdict a claim that cannot be read
  // gets, and what the CLI exits 1 on.
  const refusal = superscriptRefusal(raw);
  if (refusal !== undefined) {
    return formatVerifyResponse(
      {
        verified: false,
        evaluated: false,
        confidence: 'low',
        explanation: `Could not check the claim: ${refusal}.`,
        checks_performed: ['superscript_reading'],
      },
      format
    );
  }
  const claim = rewriteCombinatorics(unicodeToAscii(raw));

  try {
    const parsed = parseClaim(claim);
    let result: VerifyResult;

    switch (parsed.type) {
      case 'solution':
        result = await handleSolutionVerification(parsed, method);
        break;
      case 'identity':
        result = await handleIdentityVerification(parsed, method);
        break;
      default:
        result = {
          verified: false,
          evaluated: false,
          confidence: 'low',
          explanation:
            'Could not parse the claim. Use format: "LHS = RHS" for identities, or "x=2 satisfies equation" for solutions.',
          checks_performed: ['parse_attempt'],
        };
    }

    return formatVerifyResponse(result, format);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text' as const, text: `Error: ${message}` }],
      isError: true,
    };
  }
}

async function handleIdentityVerification(
  parsed: ParsedClaim,
  method: string
): Promise<VerifyResult> {
  // A side that still carries a top-level `=` is chain residue: `1=1=2`
  // parses as lhs='1', rhs='1=2', and the strategies ruled on the first
  // pair only — the numeric arm once certified it TRUE because parseFloat
  // stops at '=' (review-measured; with method=numeric `verify '1=1=2'`
  // exited 0). The at-pattern's two structural `=` land inside subst(...)
  // parens and never reach here. Refused before any engine call.
  for (const side of [parsed.lhs ?? '', parsed.rhs ?? '']) {
    const { singles, doubles, bangs } = countTopLevelEquals(side);
    if (singles + doubles + bangs > 0) {
      return equationShapeRefusal(
        `the side '${side}' of the claim`,
        `carries a top-level '=' — write a single equation.`
      );
    }
  }
  const lhsReading = await normalizeSide(parsed.lhs ?? '');
  const rhsReading = await normalizeSide(parsed.rhs ?? '');
  // Before either strategy runs: symbolic would simplify two identical
  // undefined readings to 0 and numeric would sample them to 0, so neither
  // may see a claim whose side reads undefined.
  if (lhsReading.readsUndefined || rhsReading.readsUndefined) {
    return undefinedReadingResult(`a side of ${lhsReading.expr} = ${rhsReading.expr}`);
  }
  // A reading that never came back gets the same verdict class: nothing was
  // read, so nothing can be checked. Proceeding instead would let a
  // transient engine failure silently disable the guard above — the numeric
  // strategy substitutes through the unread side and can report a
  // refutation of notation that was never read.
  if (lhsReading.unreadable || rhsReading.unreadable) {
    return {
      verified: false,
      evaluated: false,
      confidence: 'low',
      explanation:
        `Could not read a side of ${lhsReading.expr} = ${rhsReading.expr}: ` +
        `the engine errored or returned no reading.`,
      checks_performed: ['unreadable_side'],
    };
  }
  const lhs = lhsReading.expr;
  const rhs = rhsReading.expr;
  const checks: string[] = [];
  let symbolicOk: boolean | null = null;
  let numericOk: boolean | null = null;
  let symbolicEvaluated = false;
  let numericEvaluated = false;
  let anyEvaluated = false;

  if (method === 'symbolic' || method === 'both') {
    const symbolic = await verifySymbolic(lhs, rhs);
    symbolicOk = symbolic.verified;
    symbolicEvaluated = symbolic.evaluated;
    anyEvaluated ||= symbolic.evaluated;
    checks.push(`Symbolic: ${symbolic.detail}`);
  }

  if (method === 'numeric' || method === 'both') {
    const numeric = await verifyNumeric(lhs, rhs);
    numericOk = numeric.verified;
    numericEvaluated = numeric.evaluated;
    anyEvaluated ||= numeric.evaluated;
    checks.push(`Numeric: ${numeric.detail}`);
  }

  // A run that produced no usable answer is missing evidence, not a
  // counterexample. `2^1100 = 2^1100` once reported NOT verified with HIGH
  // confidence while its own checks carried the symbolic proof, because
  // parseFloat overflowed both sides to Infinity and the direct difference
  // came back NaN; symmetrically, a symbolic run that timed out let a
  // numerically-settled claim report itself disproved. Only a run that
  // actually compared — a nonzero symbolic difference, a sampled numeric
  // mismatch — may dispute the other arm's answer.
  const numericDisputes = numericOk === false && numericEvaluated;
  const symbolicDisputes = symbolicOk === false && symbolicEvaluated;

  const verified =
    symbolicOk === true || numericOk === true ? !symbolicDisputes && !numericDisputes : false;

  let confidence: 'high' | 'medium' | 'low';
  if (symbolicOk === true) confidence = numericDisputes ? 'low' : 'high';
  else if (numericOk === true && symbolicDisputes) confidence = 'low';
  else if (numericOk === true) confidence = 'medium';
  else confidence = 'low';

  // One strategy succeeding is enough to call the claim checked: with
  // `method: 'both'`, symbolic can legitimately fail on a claim numeric
  // settles. Only when neither produced anything is the verdict meaningless.
  let explanation: string;
  if (!anyEvaluated) {
    explanation = `Could not evaluate the claim: ${lhs} = ${rhs}`;
  } else if (verified) {
    explanation = `Identity verified: ${lhs} = ${rhs}`;
  } else if (symbolicOk === true && numericDisputes) {
    // Printing "≠" here would contradict the proof line in checks_performed.
    explanation =
      `Identity in conflict: the symbolic difference simplifies to 0, but the ` +
      `numeric check found a counterexample (${lhs} = ${rhs})`;
  } else {
    explanation = `Identity NOT verified: ${lhs} ≠ ${rhs}`;
  }
  return {
    verified,
    evaluated: anyEvaluated,
    confidence,
    explanation,
    checks_performed: checks,
  };
}

async function handleSolutionVerification(
  parsed: ParsedClaim,
  method: string
): Promise<VerifyResult> {
  const { variable, value, equation } = parsed;
  if (!variable || !value || !equation) {
    return {
      verified: false,
      evaluated: false,
      confidence: 'low',
      explanation: 'Missing variable, value, or equation in solution claim.',
      checks_performed: [],
    };
  }
  const checks: string[] = [];

  // A chain `a=b=c` is ambiguous notation, not an equation: the substitution
  // check reads only the first two parts and used to certify claims whose
  // remaining notation it never looked at (measured: `x^2-4=0=(f^(+))(x)`
  // verified TRUE with an unreadable tail). A `==` or `!=` glued to the
  // equation's own `=` is the same hole one operator wide (review found
  // `x^2-4=0==(f^(+))(x)` and `24=4!=(f^(+))(x)` certifying TRUE). Refused
  // before any engine call.
  if (hasUnreadTopLevelEquals(equation)) {
    return equationShapeRefusal(
      equation,
      `chains or mixes more than one top-level '=' — write a single equation.`
    );
  }
  // An `=` nested inside the equation's own sides cannot be split apart:
  // the split breaks at the first `=` CHARACTER, landing inside the nested
  // notation and ruling on the mangled remainder (`abs(x=1) = 1` verified
  // TRUE on the reading `abs(x) - 1`, measured). Depth-aware splitting was
  // declined — it hands piecewise notation to a substitution that answers
  // ifte(x=2,1,0) - 1 at x=2 with -1, a wrong refutation. The identity path
  // evaluates sides whole, so piecewise claims belong there.
  const mainEquals = findMainEquals(equation);
  if (mainEquals !== -1 && mainEquals !== equation.indexOf('=')) {
    return equationShapeRefusal(
      equation,
      `nests '=' inside its sides, which the solution check cannot split ` +
        `apart — write it as an identity (LHS = RHS) instead.`
    );
  }

  // Same refusal as the identity path, on the pieces the substitution check
  // actually reads: the asserted value and the equation's two sides
  // (verifySolution reads exactly two). An equation both sides of which read
  // undefined collapses to 0 under substitution, and a value that reads
  // undefined asserts a notation that was never read. Parts past the second
  // are never used downstream — walking them would be a user-controlled loop
  // of Giac round trips (an 8 KB claim carries thousands of `=`), each under
  // the session mutex with its own timeout.
  if (await readsAsUndefined(value)) {
    return undefinedReadingResult(`the value ${value}`);
  }
  const [eqLhs, eqRhs] = splitEquation(equation);
  for (const part of [eqLhs, eqRhs]) {
    if (part && (await readsAsUndefined(part))) {
      return undefinedReadingResult(`a side of ${equation}`);
    }
  }

  const solution = await verifySolution(variable, value, equation);
  checks.push(`Substitution: ${solution.detail}`);

  if ((method === 'symbolic' || method === 'both') && equation.includes('=')) {
    const substLhs = `subst(${eqLhs}, ${variable}=${value})`;
    const substRhs = `subst(${eqRhs}, ${variable}=${value})`;
    const symbolic = await verifySymbolic(substLhs, substRhs);
    checks.push(`Symbolic after substitution: ${symbolic.detail}`);
  }

  let explanation: string;
  if (!solution.evaluated) {
    explanation = `Could not evaluate ${equation} at ${variable}=${value}`;
  } else if (solution.verified) {
    explanation = `Verified: ${variable}=${value} satisfies ${equation}`;
  } else {
    explanation = `NOT verified: ${variable}=${value} does not satisfy ${equation}`;
  }
  return {
    verified: solution.verified,
    evaluated: solution.evaluated,
    confidence: solution.verified ? 'high' : 'medium',
    explanation,
    checks_performed: checks,
  };
}

export function formatVerifyResponse(
  result: VerifyResult,
  format: 'text' | 'json'
): {
  content: { type: 'text'; text: string }[];
  isError: boolean;
} {
  if (format === 'json') {
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      isError: false,
    };
  }

  // UNKNOWN, not FALSE, when nothing could be checked: reporting a malformed
  // claim as FALSE tells a reader the mathematics was refuted.
  let verdict: string;
  if (!result.evaluated) {
    verdict = 'UNKNOWN — could not be checked';
  } else if (result.verified) {
    verdict = 'TRUE ✓';
  } else {
    verdict = 'FALSE ✗';
  }

  const lines: string[] = [
    `Verified: ${verdict}`,
    `Confidence: ${result.confidence}`,
    `Explanation: ${result.explanation}`,
    '',
    'Checks performed:',
    ...result.checks_performed.map((c) => `  - ${c}`),
  ];
  return {
    content: lines.map((l) => ({ type: 'text' as const, text: l })),
    isError: false,
  };
}
