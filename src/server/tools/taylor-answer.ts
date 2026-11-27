import { giacEngine } from '../giac/index.js';
import type { EvaluatedResponse } from './giac-eval.js';
import { excerpt, stripOrderTerm } from './output-cleanup.js';
import { formatErrorResponse, formatToolResponse } from './response-formatter.js';
import { unicodeToAscii } from './unicode-normalize.js';

/** The order taylor expands to when the caller names none — the command's own default. */
export const DEFAULT_TAYLOR_ORDER = 5;

/** A point at infinity, as a caller writes one. */
const INFINITE_POINT = /^[+-]?(?:inf|infinity)$/;

/**
 * Why a series Giac expanded to order `n` at a finite point does not reach
 * that order, or undefined when it does: the order its remainder leaves.
 *
 * Giac writes the remainder of a series as `B^k*order_size(B)`, O(B^k), and
 * writes a series that broke down the same way. An expansion that reached
 * order n at a finite point leaves a remainder of order n+1 or more; one that
 * stopped short leaves less, and stripping the remainder hid it.
 * `taylor(exp(1/x), x, 0, 3)` answered `order_size(x)` — the remainder alone,
 * O(1) — and `taylor(1+x*exp(1/x), x, 0, 3)` answered `1`, both with
 * isError:false.
 *
 * At infinity Giac counts the order from the leading power, so a remainder of
 * any order can close a correct expansion there (`taylor(x^3*exp(1/x), x, inf,
 * 2)` is x^3+x^2+x/2+O(1)); callers apply this at finite points only.
 */
export function seriesShortfall(orders: readonly number[], n: number): number | undefined {
  if (orders.length === 0) return undefined;
  const lowest = Math.min(...orders);
  return lowest <= n ? lowest : undefined;
}

/** The words for a series that stops at remainder order `k`, short of order `n`. */
export function shortfallReason(k: number, n: number): string {
  return k === 0
    ? 'the expansion breaks down at once, leaving nothing but O(1), as it does at an ' +
        'essential singularity such as exp(1/x) at 0 — there is no Taylor series there'
    : `the expansion stops with a remainder of order ${k}, short of the order ${n} asked ` +
        'for, so it does not give every term through that order — as at an essential ' +
        'singularity, or where the expansion runs in fractional powers';
}

/**
 * A taylor answer read against the order the caller asked for: the answer as
 * it stands (undefined), a refusal, or the zero polynomial in place of a bare
 * remainder.
 *
 * A remainder of order above n with nothing in front of it is an answer:
 * every term through order n is zero (`taylor(x^4, x, 0, 3)` printed
 * `x^4*order_size(x)` where the polynomial is 0). Not on the token alone,
 * though, because a broken expansion can look the same:
 * `taylor(x^5*exp(1/x), x, 0, 3)` prints `x^5*order_size(x)` exactly as
 * `taylor(x^5, x, 0, 3)` does. The zero is answered only when the engine
 * confirms the expression is o((x-a)^n) there — then every Taylor coefficient
 * through n is 0, whatever the expansion printed.
 *
 * A series whose terms look ordinary and whose remainder is of order n+1 is
 * answered as the engine gives it: `taylor(x+x^4*exp(1/x), x, 0, 3)` still
 * answers x. Confirming every series the same way was measured and rejected:
 * Giac's limit gives up at about order 50 ("Max order reached") on series
 * that are correct, and `taylor(f(x), x, 0, 2)` trapped the worker.
 */
export async function taylorAnswer(
  response: EvaluatedResponse,
  args: Record<string, unknown>,
  giacCommand: string
): Promise<EvaluatedResponse | ReturnType<typeof formatErrorResponse> | undefined> {
  const orders = response.seriesRemainderOrders;
  const point = String(args.point ?? '0').trim();
  if (orders === undefined || INFINITE_POINT.test(point)) return undefined;
  const n = args.order === undefined ? DEFAULT_TAYLOR_ORDER : Number(args.order);
  const variable = String(args.variable);
  const where = `${variable} = ${excerpt(point, 40)}`;
  const refusal = (why: string) =>
    formatErrorResponse(
      `taylor cannot answer this — expanding ${excerpt(String(args.expression), 60)} to ` +
        `order ${n} at ${where}: ${why}`
    );
  const shortfall = seriesShortfall(orders, n);
  if (shortfall !== undefined) return refusal(shortfallReason(shortfall, n));
  // The remainder alone, with no polynomial in front of it to cut back to. A
  // list (`taylor([sin(x), cos(x)], ...)`) keeps its remainders inside its
  // entries, which stripOrderTerm leaves, and is answered as printed.
  const result = response.result.trim();
  if (result.startsWith('[') || stripOrderTerm(result) !== result) return undefined;
  if (!result.includes('order_size(')) return undefined;
  const expression = unicodeToAscii(String(args.expression));
  let limit: string;
  try {
    limit = String(
      await giacEngine.evaluate(
        `limit((${expression})/(${variable}-(${point}))^${n},${variable},${point})`
      )
    ).trim();
  } catch {
    limit = '';
  }
  if (limit !== '0') {
    return refusal(
      'the expansion leaves only its remainder, and the expression is not confirmed to ' +
        `vanish faster than (${variable}-${excerpt(point, 20)})^${n} there`
    );
  }
  return Object.assign(
    formatToolResponse({
      result: '0',
      latex: '0',
      giacCommand,
      notes: [`Every term through order ${n} is zero: the expression vanishes faster at ${where}.`],
    }),
    { result: '0' }
  );
}
