import { giacEngine } from '../../giac/index.js';
import { calculusOutcome, type CalculusOutcome } from '../calculus.js';
import { extractDiff, extractIntegrate, extractTaylor } from '../compute/extractors.js';
import { definiteIntegralRefusal } from '../definite-integral.js';
import { readableBack } from '../giac-eval.js';
import { seriesRemainderOrders, stripOrderTerm } from '../output-cleanup.js';
import { inBandFailure } from '../response-formatter.js';
import { DEFAULT_TAYLOR_ORDER, shortfallReason } from '../taylor-answer.js';
import { NAME_CHAR_PATTERN } from '../unicode-normalize.js';
import type { VerifyResult } from './index.js';

/**
 * One side of an identity claim as verify reads it, before either strategy
 * runs: through compute for a series or derivative call, through the engine
 * otherwise, and refused, unread or undefined where it cannot be checked.
 */

/**
 * Giac's undefined marker, wherever it appears in output: bare (`undef`),
 * applied to what produced it (`undef(x)`), or inside a list (`[undef,x]`).
 * Matched on word boundaries because Giac echoes identifiers that merely
 * contain the letters verbatim (`undefx + 1` evaluates to `undefx + 1`,
 * `my_undef*2` to `my_undef*2`), and those must not be refused.
 */
export function containsUndefinedMarker(giacOutput: string): boolean {
  return /\bundef\b/.test(giacOutput);
}

/**
 * The UNKNOWN verdict for a claim whose notation Giac read as undefined.
 * Not FALSE: nothing was compared, and calling it a refutation would tell a
 * script the mathematics failed when the notation was never understood.
 */
export function undefinedReadingResult(whatReadsUndefined: string): VerifyResult {
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
 * One side of an identity claim: read, and handed to the strategies as `expr`
 * (the side itself, or its polynomial part when a series remainder was
 * stripped), or a reason it cannot be checked. One kind per side, because the
 * reasons exclude each other.
 */
export type SideReading =
  | { kind: 'read'; expr: string }
  /** Giac's own reading of this side carries its undefined marker. */
  | { kind: 'undefined'; expr: string }
  /** The reading never came back — the engine errored or answered nothing. */
  | { kind: 'unreadable'; expr: string }
  /** The side is a computation compute refuses; `reason` says why. */
  | { kind: 'refused'; expr: string; reason: string; check: string };

/**
 * The calls verify reads through compute, named as compute's router names
 * them: case-insensitive, with at most one space before the parenthesis.
 */
const SERIES_CALL = /^\s*(?:taylor|series)\s?\(/i;
const DIFF_CALL = /^\s*(?:diff|differentiate|derivative)\s?\(/i;
const INTEGRAL_CALL = /^\s*(?:integrate|int)\s*\(/;
/** taylor or series applied anywhere in a side — not `my_taylor(`, a name of its own. */
const SERIES_APPLIED = new RegExp(`(?<!${NAME_CHAR_PATTERN})(?:taylor|series)\\s*\\(`, 'iu');

/**
 * `side` without the parentheses that enclose all of it: `((taylor(f,x,0,3)))`
 * is the call alone. One pass: the layers stripped are the fewest the
 * interior's depth ever falls to, so `(a)+(b)` keeps its own.
 */
export function unwrapSide(side: string): string {
  const text = side.trim();
  let layers = 0;
  while (text[layers] === '(' && text.at(-1 - layers) === ')') layers++;
  let depth = 0;
  for (let i = 0; i < text.length - layers && layers > 0; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') depth--;
    if (i >= layers) layers = Math.min(layers, depth);
  }
  return layers > 0 ? text.slice(layers, text.length - layers) : text;
}

/**
 * Why a side's reading is not the computation it names, judged by the rules
 * compute applies to the same call, or undefined. Only a side that is exactly
 * one call, read the way compute and Giac both read it: verify certified
 * `integrate(1/(x-1),x,0,2) = 0` — Giac's principal value — which compute
 * refuses.
 */
async function sideComputationRefusal(
  side: string,
  reading: string
): Promise<{ reason: string; check: string } | undefined> {
  if (INTEGRAL_CALL.test(side)) {
    const { args } = extractIntegrate(side);
    if (args.argument_refusal === undefined && args.lower_bound !== undefined) {
      const reason = await definiteIntegralRefusal(args, reading);
      if (reason !== undefined) return { reason, check: 'divergent_integral' };
    }
  }
  // A remainder with no series call to read it through — `order_size(3)`,
  // typed as it is — is O(1) when its order is 0: it says nothing about the
  // function, and the difference simplified to that remainder alone, which
  // the symbolic check takes for zero. Every taylor or series call is read
  // through compute above; this is what remains.
  if (seriesRemainderOrders(reading).includes(0)) {
    return { reason: shortfallReason(0, DEFAULT_TAYLOR_ORDER), check: 'broken_series' };
  }
  return undefined;
}

/**
 * A side that is one series or derivative call, read exactly as compute reads
 * it, or undefined for a side that is neither.
 *
 * Through compute's own calculus path, so the two surfaces share one reading
 * and one set of checks. Giac reads `taylor(f, x, a, n)` as the expansion to
 * order a at the point n, where compute reads the point a and the order n:
 * `taylor(exp(x),x,1,2) = exp(1)+exp(1)*(x-1)+exp(1)/2*(x-1)^2` was refuted
 * although compute answers exactly that, and `taylor(x+x^4*exp(1/x),x=0,3) =
 * x` verified TRUE although compute refuses the series. And a derivative
 * compute refuses as too large, `diff(exp(sin(x*y))*cos(x+y)/(1+x^2+y^2), x,
 * 15)`, trapped the worker when verify handed it to the engine as written.
 *
 * A series side is checked as compute's answer, not the call: the strategies
 * re-evaluate their text, which would read the call Giac's way again. A
 * derivative is read the same way by both, so once compute answers it the
 * call itself is checked, as before.
 *
 * A series inside a larger expression is refused: verify checks one only as
 * the whole side, where it can read it as compute does.
 */
async function calculusSideReading(side: string): Promise<SideReading | undefined> {
  const call = unwrapSide(side);
  const series = SERIES_CALL.test(call);
  if (!series && !DIFF_CALL.test(call)) {
    if (!SERIES_APPLIED.test(side)) return undefined;
    return {
      kind: 'refused',
      expr: side,
      reason:
        'it holds a taylor or series call inside a larger expression, and verify checks a ' +
        'series only as the whole side — write it alone on one side of the claim',
      check: 'series_computation',
    };
  }
  const check = series ? 'series_computation' : 'derivative_computation';
  let outcome: CalculusOutcome;
  try {
    outcome = await calculusOutcome((series ? extractTaylor(call) : extractDiff(call)).args);
  } catch {
    // The engine failed — a timeout, a trap, a lost channel — which says
    // nothing about the call, so the side is unread, not refused.
    return { kind: 'unreadable', expr: side };
  }
  if (outcome.isError) {
    const reason = inBandFailure(outcome.content.map((c) => c.text));
    return { kind: 'refused', expr: side, reason: reason ?? 'compute refuses it', check };
  }
  const result = 'result' in outcome ? outcome.result.trim() : '';
  if (!result) return { kind: 'unreadable', expr: side };
  if (containsUndefinedMarker(result)) return { kind: 'undefined', expr: side };
  if (!series) return { kind: 'read', expr: call };
  const reading = stripOrderTerm(result);
  // The strategies hand the reading back to the engine, whose parser traps on
  // a long one; a series to order 100 can run to half a million characters.
  if (!readableBack(reading)) {
    return {
      kind: 'refused',
      expr: side,
      reason:
        `compute's answer for it has ${reading.length} characters, more than can be ` +
        'checked — compare a lower order',
      check,
    };
  }
  return { kind: 'read', expr: `(${reading})` };
}

/**
 * Pre-normalize one side of an identity claim: when it evaluates to a series
 * result carrying an order_size remainder, substitute the bare polynomial.
 * An evaluation problem marks the side unreadable rather than silently
 * proceeding on it.
 */
export async function normalizeSide(side: string): Promise<SideReading> {
  const calculus = await calculusSideReading(side);
  if (calculus !== undefined) return calculus;
  let r: string | undefined;
  try {
    r = await giacEngine.evaluate(side);
  } catch {
    // A side the engine could not read cannot be checked — and letting the
    // strategies run on it lets a transient failure (worker crash, IPC loss,
    // timeout) fabricate a verdict out of notation that was never read.
    return { kind: 'unreadable', expr: side };
  }
  // An empty answer is not a clean reading; the worker resolved nothing.
  if (!r) return { kind: 'unreadable', expr: side };
  // A side whose reading carries the undefined marker was not understood,
  // not evaluated: Giac answers `(f^(+))(x)` with `undef(x)` instead of an
  // error. Refused here, before either strategy runs, because two
  // identical undefined readings AGREE — the symbolic difference is 0 and
  // every sampled point substitutes to 0 — and would certify the claim.
  if (containsUndefinedMarker(r)) return { kind: 'undefined', expr: side };
  const refused = await sideComputationRefusal(side, r);
  if (refused) return { kind: 'refused', expr: side, ...refused };
  if (r.includes('order_size')) {
    const stripped = stripOrderTerm(r);
    if (stripped && stripped !== r) return { kind: 'read', expr: `(${stripped})` };
  }
  return { kind: 'read', expr: side };
}

/**
 * The verdict for a claim with a side that cannot be checked, or undefined
 * when both were read. Undefined readings first, then unreadable ones, then
 * refused computations: the order the checks were added in, kept so a claim
 * with two such sides keeps the verdict it had.
 */
export function uncheckedSideResult(lhs: SideReading, rhs: SideReading): VerifyResult | undefined {
  const claim = `${lhs.expr} = ${rhs.expr}`;
  // Before either strategy runs: symbolic would simplify two identical
  // undefined readings to 0 and numeric would sample them to 0, so neither
  // may see a claim whose side reads undefined.
  if (lhs.kind === 'undefined' || rhs.kind === 'undefined') {
    return undefinedReadingResult(`a side of ${claim}`);
  }
  // A reading that never came back gets the same verdict class: nothing was
  // read, so nothing can be checked. Proceeding instead would let a
  // transient engine failure silently disable the guard above — the numeric
  // strategy substitutes through the unread side and can report a
  // refutation of notation that was never read.
  if (lhs.kind === 'unreadable' || rhs.kind === 'unreadable') {
    return {
      verified: false,
      evaluated: false,
      confidence: 'low',
      explanation:
        `Could not read a side of ${claim}: ` + `the engine errored or returned no reading.`,
      checks_performed: ['unreadable_side'],
    };
  }
  const refused = lhs.kind === 'refused' ? lhs : rhs.kind === 'refused' ? rhs : undefined;
  if (refused) {
    return {
      verified: false,
      evaluated: false,
      confidence: 'low',
      explanation:
        `Could not check the claim: its side ${refused.expr} is not what it computes — ` +
        `${refused.reason}.`,
      checks_performed: [refused.check],
    };
  }
  return undefined;
}
