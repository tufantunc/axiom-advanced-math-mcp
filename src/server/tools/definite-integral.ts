import { giacEngine } from '../giac/index.js';
import { detectFailure } from './compute/silent-failure.js';
import { excerpt, printedList, printedReal } from './output-cleanup.js';
import { NAME_CHAR_PATTERN, unicodeToAscii } from './unicode-normalize.js';

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
 * The split points are the integrand's real singular points strictly inside
 * the interval: `singular(f, x)`'s, or, where `singular` cannot read the
 * integrand ("Unable to isolate function abs" for `1/(x*abs(x))`), the zeros
 * of its denominator. `singular` gives a periodic function's principal points
 * only — `tan(x)` has [pi/2, -pi/2], so the pole at 3pi/2 in [pi, 2pi] is not
 * among them — so an integrand with a trigonometric function, or one neither
 * reading locates, is also split at a point of no significance, 13/34 of the
 * way along. A pole that split leaves inside a piece is then off that piece's
 * centre, and on an elementary antiderivative Giac answers such a piece
 * `undef` (measured: `tan(x)` on [4, 2pi]) rather than a principal value.
 * Ei-type principal values come back even off centre (`exp(x)/x` on
 * [-1, 1/3]), which is why the singular points, not the extra split, are the
 * check for them.
 *
 * What refuses: a piece that integrates to an infinity (the integral
 * diverges), or one the engine marks as failed (`undef`, an error). A piece
 * it merely cannot integrate — left unevaluated, or answered as a list — is
 * evidence only beside a real singular point; split off centre for nothing
 * but periodicity, it is a piece of a convergent integral Giac evaluates whole
 * by residues and not in part: `cos(x)/(1+x^2)` over the real line is
 * pi/exp(1), and its piece up to 13/34 stays unevaluated.
 *
 * test/divergent-integral.test.ts holds what was measured: every divergent
 * integral there is refused and none of the convergent ones is.
 *
 * Symbolic bounds, or a singular point the engine cannot place on the real
 * line (`1/(x-a)`), are not checked: where the pole lies is not decided.
 */

/** More singular points inside the interval than this are refused, not split at. */
const MAX_SPLIT_POINTS = 12;

/** Trigonometric functions: their poles repeat, and `singular` lists one period. */
const PERIODIC = new RegExp(`(?<!${NAME_CHAR_PATTERN})(?:sin|cos|tan|cot|sec|csc)\\s*\\(`, 'u');

/** An integral the engine left unevaluated. */
const UNEVALUATED = new RegExp(`(?<!${NAME_CHAR_PATTERN})(?:integrate|int)\\s*\\(`, 'u');

/** `infinity` as a whole token, signed or not, anywhere in an answer. */
const INFINITY_TOKEN = new RegExp(`(?<!${NAME_CHAR_PATTERN})infinity(?!${NAME_CHAR_PATTERN})`, 'u');

async function evaluate(command: string): Promise<string | undefined> {
  try {
    return String(await giacEngine.evaluate(command));
  } catch {
    return undefined;
  }
}

/** How one piece came back. */
type PieceReading = 'finite' | 'infinite' | 'failed' | 'unintegrated';

function readPiece(printed: string | undefined): PieceReading {
  const t = printed?.trim() ?? '';
  if (t === '+infinity' || t === '-infinity' || t === 'infinity') return 'infinite';
  // Before the token scan: an unevaluated piece over an infinite bound prints
  // `integrate(f,x,-infinity,13/34)`, whose bound is not its value.
  if (t === '' || t.startsWith('[') || UNEVALUATED.test(t)) return 'unintegrated';
  if (detectFailure(`Result: ${t}`) !== null || INFINITY_TOKEN.test(t)) return 'failed';
  return 'finite';
}

/**
 * A point 13/34 of the way from `lo` to `hi`; with an infinite end, 13/34 past
 * the finite one toward it. Either bound may be the larger.
 */
function offCentrePoint(lo: string, hi: string, a: number, b: number): string {
  if (Number.isFinite(a) && Number.isFinite(b)) return `(21*(${lo})+13*(${hi}))/34`;
  if (Number.isFinite(a)) return b > a ? `(${lo})+13/34` : `(${lo})-13/34`;
  if (Number.isFinite(b)) return a > b ? `(${hi})+13/34` : `(${hi})-13/34`;
  return '13/34';
}

/** The integrand's singular points as the engine prints them, or undefined when unread. */
async function singularPoints(f: string, x: string): Promise<string[] | undefined> {
  return (
    printedList(await evaluate(`singular(${f},${x})`)) ??
    printedList(await evaluate(`solve(denom(${f})=0,${x})`))
  );
}

/**
 * The refusal for a definite integral whose finite answer is not the integral,
 * or undefined when it stands (or cannot be checked — see above). A message,
 * not a response: compute refuses with it and verify declines to check a side
 * with it.
 */
export async function definiteIntegralRefusal(
  args: Record<string, unknown>,
  answer: string
): Promise<string | undefined> {
  const lo = args.lower_bound;
  const hi = args.upper_bound;
  if (typeof lo !== 'string' || typeof hi !== 'string') return undefined;
  // Only a finite answer can be a principal value passed off as the integral.
  if (INFINITY_TOKEN.test(answer) || UNEVALUATED.test(answer)) return undefined;
  const f = unicodeToAscii(String(args.expression));
  const x = unicodeToAscii(String(args.variable));
  const [loText, hiText] = [unicodeToAscii(lo), unicodeToAscii(hi)];
  const bounds = printedList(await evaluate(`[evalf(${loText}),evalf(${hiText})]`));
  const [a, b] = (bounds ?? []).map(printedReal);
  if (bounds?.length !== 2 || Number.isNaN(a) || Number.isNaN(b) || a === b) return undefined;
  const inside = (v: number): boolean => v > Math.min(a, b) && v < Math.max(a, b);

  const singular = await singularPoints(f, x);
  const poles: { text: string; at: number }[] = [];
  // Whether the singular points were read at all: an empty list was, an
  // unreadable one, or one the engine cannot evaluate numerically, was not.
  let located = singular !== undefined;
  if (singular !== undefined && singular.length > 0) {
    const values = printedList(await evaluate(`evalf([${singular.join(',')}])`));
    located = values?.length === singular.length;
    singular.forEach((text, i) => {
      const at = printedReal(values?.[i] ?? '');
      if (Number.isFinite(at) && inside(at) && !poles.some((p) => p.at === at)) {
        poles.push({ text, at });
      }
    });
  }
  const interval = `[${excerpt(lo, 30)}, ${excerpt(hi, 30)}]`;
  if (poles.length > MAX_SPLIT_POINTS) {
    return (
      `integrate cannot answer this — the integrand is singular at ${poles.length} points ` +
      `inside ${interval}, more than the ${MAX_SPLIT_POINTS} this checks — split the ` +
      'integral at them'
    );
  }
  const splits = [...poles];
  if (!located || PERIODIC.test(f)) {
    const text = offCentrePoint(loText, hiText, a, b);
    const at = printedReal((await evaluate(`evalf(${text})`)) ?? '');
    if (Number.isFinite(at) && inside(at) && !poles.some((p) => p.at === at)) {
      splits.push({ text, at });
    }
  }
  if (splits.length === 0) return undefined;
  splits.sort((p, q) => (a < b ? p.at - q.at : q.at - p.at));

  // One engine call for every piece, so one timeout bounds them all.
  const ends = [loText, ...splits.map((p) => p.text), hiText];
  const integrals = ends.slice(1).map((end, i) => `int(${f},${x},${ends[i]},${end})`);
  const printed = printedList(await evaluate(`[${integrals.join(',')}]`));
  const pieces = integrals.map((_, i) => printed?.[i]);
  const readings = pieces.map(readPiece);

  const at =
    poles.length > 0 ? ` at ${excerpt(poles.map((p) => `${x} = ${p.text}`).join(', '), 80)}` : '';
  if (readings.includes('infinite')) {
    return (
      `integrate cannot answer this — the integral diverges: the integrand is not ` +
      `integrable${at} inside ${interval}, where the CAS integrates the pieces on either ` +
      `side to an infinity, so its ${excerpt(answer, 40)} is not the integral`
    );
  }
  const unconfirmed = readings.findIndex(
    (r) => r === 'failed' || (r === 'unintegrated' && poles.length > 0)
  );
  if (unconfirmed === -1) return undefined;
  return (
    `integrate cannot answer this — the CAS answered ${excerpt(answer, 40)} over ${interval}, ` +
    `but integrated piece by piece${poles.length > 0 ? ` (split${at})` : ''} one piece came ` +
    `back ${excerpt(pieces[unconfirmed] ?? 'with no answer', 40)}, so the answer may be a ` +
    'principal value across a singularity inside the interval rather than the integral'
  );
}
