import { giacEngine } from '../giac/index.js';
import { excerpt, splitTopLevel } from './output-cleanup.js';
import { unicodeToAscii } from './unicode-normalize.js';

/**
 * Whether a definite integral's finite answer is the integral, checked by
 * integrating again in pieces split at the integrand's singular points.
 *
 * Giac answers a definite integral across a pole of odd order with the Cauchy
 * principal value, which is not the integral — the integral diverges:
 * `integrate(1/(x-1), x, 0, 2)` answered 0, and so did `1/x` on [-1, 1],
 * `tan(x)` on [0, pi] and [pi, 2pi], `1/sin(x)` and `cot(x)` on [-1, 1];
 * `exp(x)/x` on [-1, 1] answered `Ei(1)-Ei(-1)` and `1/ln(x)` on [1/2, 2]
 * `Ei(ln(2))-Ei(-ln(2))`, all with isError:false. On each side of the pole
 * alone the same engine answers -infinity and +infinity, so the pieces say
 * what the whole hid.
 *
 * The split points are `singular(f, x)`'s real points strictly inside the
 * interval. `singular` gives a periodic function's principal points only —
 * `tan(x)` has [pi/2, -pi/2], so the pole at 3pi/2 in [pi, 2pi] is not among
 * them — so an integrand with a trigonometric function, or one `singular`
 * cannot read (`1/(x*abs(x))`), is also split at a point of no significance,
 * 13/34 of the way along. A pole the split leaves inside a piece is then off
 * that piece's centre, and on an elementary antiderivative Giac answers such
 * a piece `undef` (measured: `tan(x)` on [4, 2pi]) rather than a principal
 * value. Ei-type principal values come back even off centre (`exp(x)/x` on
 * [-1, 1/3]), which is why the singular points, not the extra split, are the
 * check for them.
 *
 * test/divergent-integral.test.ts holds what was measured: 17 divergent
 * integrals, every one refused, and 21 that converge or that the engine
 * already answers with an infinity, none refused — `1/sqrt(abs(x))` on
 * [-1, 1] (4), `sin(x)/x` on [0, inf) (pi/2) and `sign(x)` on [-1, 1] (0)
 * among them.
 *
 * Symbolic bounds, or a singular point the engine cannot place on the real
 * line (`1/(x-a)`), are not checked: where the pole lies is not decided.
 */

/** More singular points inside the interval than this are refused, not split at. */
const MAX_SPLIT_POINTS = 12;

/** Trigonometric functions: their poles repeat, and `singular` lists one period. */
const PERIODIC = /(?<![\p{L}\p{N}_])(?:sin|cos|tan|cot|sec|csc)\s*\(/u;

/** A Giac non-finite token, matched whole so a name like `undefx` is not caught. */
const NON_FINITE = /(?<![\p{L}\p{N}_])(?:undef|infinity|NaN|GIAC_ERROR)(?![\p{L}\p{N}_])/u;

/** An integral the engine left unevaluated. */
const UNEVALUATED = /(?<![\p{L}\p{N}_])(?:integrate|int)\s*\(/u;

/** A Giac real number as printed, `+infinity` and `-infinity` included; NaN otherwise. */
function printedNumber(printed: string): number {
  const t = printed.trim();
  if (t === '+infinity' || t === 'infinity') return Infinity;
  if (t === '-infinity') return -Infinity;
  return /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(t) ? Number(t) : Number.NaN;
}

async function evaluate(command: string): Promise<string | undefined> {
  try {
    return String(await giacEngine.evaluate(command));
  } catch {
    return undefined;
  }
}

/** The members of a printed Giac list, or undefined when `printed` is not one. */
function members(printed: string | undefined): string[] | undefined {
  const t = printed?.trim();
  if (!t?.startsWith('[') || !t.endsWith(']')) return undefined;
  const inner = t.slice(1, -1).trim();
  return inner === '' ? [] : splitTopLevel(inner, ',').map((m) => m.trim());
}

/** How one piece came back: a finite value, an infinity, or something else. */
type PieceReading = 'finite' | 'infinite' | 'unknown';

function readPiece(printed: string | undefined): PieceReading {
  if (printed === undefined) return 'unknown';
  const t = printed.trim();
  if (t === '+infinity' || t === '-infinity' || t === 'infinity') return 'infinite';
  if (t === '' || t.startsWith('[') || NON_FINITE.test(t) || UNEVALUATED.test(t)) return 'unknown';
  return 'finite';
}

/** A point 13/34 of the way from `lo` to `hi` — or that far past a finite end. */
function offCentrePoint(lo: string, hi: string, a: number, b: number): string {
  if (Number.isFinite(a) && Number.isFinite(b)) return `(21*(${lo})+13*(${hi}))/34`;
  if (Number.isFinite(a)) return `(${lo})+13/34`;
  if (Number.isFinite(b)) return `(${hi})-13/34`;
  return '13/34';
}

/**
 * The refusal for a definite integral whose finite answer is not the integral,
 * or undefined when it stands (or cannot be checked — see above).
 */
export async function definiteIntegralRefusal(
  args: Record<string, unknown>,
  answer: string
): Promise<string | undefined> {
  const lo = args.lower_bound;
  const hi = args.upper_bound;
  if (typeof lo !== 'string' || typeof hi !== 'string') return undefined;
  // Only a finite answer can be a principal value passed off as the integral.
  if (NON_FINITE.test(answer) || UNEVALUATED.test(answer)) return undefined;
  const f = unicodeToAscii(String(args.expression));
  const x = unicodeToAscii(String(args.variable));
  const [loText, hiText] = [unicodeToAscii(lo), unicodeToAscii(hi)];
  const bounds = members(await evaluate(`[evalf(${loText}),evalf(${hiText})]`));
  const [a, b] = (bounds ?? []).map(printedNumber);
  if (bounds?.length !== 2 || Number.isNaN(a) || Number.isNaN(b) || a === b) return undefined;
  const inside = (v: number): boolean => v > Math.min(a, b) && v < Math.max(a, b);

  const singular = members(await evaluate(`singular(${f},${x})`));
  const poles: { text: string; at: number }[] = [];
  // Whether the singular points were read at all: an empty list was, an
  // error or a list the engine cannot evaluate numerically was not.
  let located = singular !== undefined;
  if (singular !== undefined && singular.length > 0) {
    const values = members(await evaluate(`evalf([${singular.join(',')}])`));
    located = values?.length === singular.length;
    singular.forEach((text, i) => {
      const at = printedNumber(values?.[i] ?? '');
      if (Number.isFinite(at) && inside(at)) poles.push({ text, at });
    });
  }
  if (poles.length > MAX_SPLIT_POINTS) {
    return (
      `integrate cannot answer this — the integrand is singular at ${poles.length} points ` +
      `inside [${excerpt(lo, 30)}, ${excerpt(hi, 30)}], more than the ${MAX_SPLIT_POINTS} ` +
      'this checks — split the integral at them'
    );
  }
  const splits = [...poles];
  if (!located || PERIODIC.test(f)) {
    const text = offCentrePoint(loText, hiText, a, b);
    const at = printedNumber((await evaluate(`evalf(${text})`)) ?? '');
    if (Number.isFinite(at) && inside(at) && !poles.some((p) => p.at === at)) {
      splits.push({ text, at });
    }
  }
  if (splits.length === 0) return undefined;
  splits.sort((p, q) => (a < b ? p.at - q.at : q.at - p.at));

  const ends = [loText, ...splits.map((p) => p.text), hiText];
  const pieces: (string | undefined)[] = [];
  for (let i = 0; i + 1 < ends.length; i++) {
    pieces.push(await evaluate(`int(${f},${x},${ends[i]},${ends[i + 1]})`));
  }
  const readings = pieces.map(readPiece);
  if (readings.every((r) => r === 'finite')) return undefined;

  const interval = `[${excerpt(lo, 30)}, ${excerpt(hi, 30)}]`;
  const at =
    poles.length > 0 ? ` at ${excerpt(poles.map((p) => `${x} = ${p.text}`).join(', '), 80)}` : '';
  if (readings.includes('infinite')) {
    return (
      `integrate cannot answer this — the integral diverges: the integrand is not ` +
      `integrable${at} inside ${interval}, where the CAS integrates the pieces on either ` +
      `side to an infinity, so its ${excerpt(answer, 40)} is not the integral`
    );
  }
  const failed = pieces[readings.indexOf('unknown')];
  return (
    `integrate cannot answer this — the CAS answered ${excerpt(answer, 40)} over ${interval}, ` +
    `but integrated piece by piece${poles.length > 0 ? ` (split${at})` : ''} one piece came back ` +
    `${excerpt(failed ?? 'with no answer', 40)}, so the answer may be a principal ` +
    'value across a singularity inside the interval rather than the integral'
  );
}
