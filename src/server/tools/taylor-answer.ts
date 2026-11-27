import { giacEngine } from '../giac/index.js';
import type { EvaluatedResponse } from './giac-eval.js';
import { excerpt } from './output-cleanup.js';
import { formatErrorResponse, formatToolResponse } from './response-formatter.js';
import { unicodeToAscii } from './unicode-normalize.js';

/** The order taylor expands to when the caller names none — the command's own default. */
export const DEFAULT_TAYLOR_ORDER = 5;

/** A point at infinity, as a caller writes one. */
const INFINITE_POINT = /^([+-]?)(?:inf|infinity)$/;

/**
 * A taylor answer read against the order the caller asked for: the answer as
 * it stands (undefined), a refusal, or the zero polynomial in place of a bare
 * remainder.
 *
 * Giac writes the remainder of a series as `B^k*order_size(B)`, O(B^k), and
 * writes a series that broke down the same way. An expansion that reached
 * order n leaves a remainder of order n+1 or more; one that met a point with
 * no Taylor series leaves less, and stripping the remainder hid it.
 * `taylor(exp(1/x), x, 0, 3)` answered `order_size(x)` — the remainder alone,
 * O(1) — and `taylor(1+x*exp(1/x), x, 0, 3)` answered `1`, both with
 * isError:false. So a remainder of order n or less is refused.
 *
 * A remainder of order above n with nothing in front of it is an answer:
 * every term through order n is zero (`taylor(x^4, x, 0, 3)` printed
 * `x^4*order_size(x)` where the polynomial is 0). Not on the token alone,
 * though, because a broken expansion can look the same:
 * `taylor(x^5*exp(1/x), x, 0, 3)` prints `x^5*order_size(x)` exactly as
 * `taylor(x^5, x, 0, 3)` does. The zero is answered only when the engine
 * confirms the expression is o(B^n) there — then every Taylor coefficient
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
  if (orders === undefined || orders.length === 0) return undefined;
  const n = args.order === undefined ? DEFAULT_TAYLOR_ORDER : Number(args.order);
  const variable = String(args.variable);
  const point = String(args.point ?? '0').trim();
  const lowest = Math.min(...orders);
  const where = `${variable} = ${excerpt(point, 40)}`;
  const noSeries =
    `taylor cannot answer this — ${excerpt(String(args.expression), 60)} has no Taylor ` +
    `series of order ${n} at ${where}`;
  if (lowest <= n) {
    const left = lowest === 0 ? 'nothing but O(1)' : `a remainder of order ${lowest}`;
    return formatErrorResponse(
      `${noSeries}: the CAS's expansion breaks down there, leaving ${left}, ` +
        'as it does at an essential singularity such as exp(1/x) at 0'
    );
  }
  // A remainder cut off cleanly leaves the polynomial in front of it.
  if (!/(?<![\p{L}\p{N}_])order_size\(/u.test(response.result)) return undefined;
  const infinite = INFINITE_POINT.exec(point);
  const base = infinite ? `(1/${variable})` : `(${variable}-(${point}))`;
  const limitPoint = infinite ? `${infinite[1] === '-' ? '-' : '+'}infinity` : point;
  const expression = unicodeToAscii(String(args.expression));
  let limit: string;
  try {
    limit = String(
      await giacEngine.evaluate(`limit((${expression})/${base}^${n},${variable},${limitPoint})`)
    ).trim();
  } catch {
    limit = '';
  }
  if (limit !== '0') {
    return formatErrorResponse(
      `${noSeries}: the CAS's expansion leaves only its remainder, and the expression ` +
        `is not confirmed to vanish to order ${n} there`
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
