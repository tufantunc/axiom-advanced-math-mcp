import { giacEngine } from '../giac/index.js';

/**
 * What a high-order derivative with respect to one variable costs the worker,
 * measured on the way up rather than guessed from the text.
 *
 * MAX_CALCULUS_ORDER bounds the order, not what the derivative grows to, and
 * the second is what traps the worker: `diff(exp(sin(x*y))*cos(x+y)/(1+x^2+y^2),
 * x, 15)` traps ("RuntimeError: unreachable") where order 12 answers with
 * 558,407 characters. Every trap measured came after an answer of about 1.3
 * to 1.7 million characters — the trap follows the size of the answer, as it
 * does for the derivative tensor (MAX_DERIVATIVE_COST).
 *
 * The text does not predict that size. With one variable the size grows like a
 * power of the order, n^p, and both p and the constant depend on how the
 * expression composes, not on its length: `sin(x)` stays 6 characters to order
 * 100, `exp(sin(x))` reaches 159,096 there, and the 16 characters of
 * `tan(tan(tan(x)))` reach 1,284,783 at order 20 and trap at 25. So the
 * derivative is measured: at orders 1, 2, 4, … up to n/2, each one computed
 * only when the size predicted for it is under the cap. From the last two the
 * growth exponent is read off, and the next size is predicted with one more
 * power than that, since the exponent itself rises with the order (about 0.85
 * per doubling at most, for `sin(sin(sin(sin(x))))`).
 *
 * Calibrated on 62 expressions of one to four symbols, to order 100 or the
 * first failure (the measurements are in the PR that added this). The
 * steepest doubling measured multiplied the size by 24.5
 * (`sin(sin(sin(sin(x))))`, order 8 to 16, slope 4.6); a cap of half a million
 * predicted characters leaves a factor of about three below the smallest size
 * that trapped a fresh worker. Checked end to end on 65 expressions at 16
 * orders each, 783 calls on one worker: the two that this let through and
 * that trapped came late in the run, and neither traps on a fresh worker. The
 * probes cost little next to the derivative: each is a doubling below it.
 *
 * Not covered, because no bound on one call can: a long-lived worker traps
 * on less after many large answers — `diff(1/(1+x^2+y^2+z^2), x, 25)`, 107,095
 * characters in 0.9 s on a fresh worker, trapped after thirty derivatives of
 * 100,000 to 800,000 characters had run on the same one. And a timeout is a
 * matter of time, not size: rational functions of several symbols spend it
 * normalising (`1/(1+x^2+y^2)` timed out at order 60 with an answer far under
 * the cap).
 */
export const MAX_DERIVATIVE_SIZE = 500_000;

/** The growth exponent assumed before two probes have been measured. */
const FIRST_EXPONENT = 3;

/** A character count as a reader reads one: 1,284,783. */
function count(size: number): string {
  return Math.round(size).toLocaleString('en-US');
}

/** The orders measured on the way to `n`: n/2, n/4, … down to 1, ascending. */
export function probeOrders(n: number): number[] {
  const orders: number[] = [];
  for (let m = Math.ceil(n / 2); m >= 1; m = Math.ceil(m / 2)) {
    if (orders[0] !== m) orders.unshift(m);
    if (m === 1) break;
  }
  return orders;
}

/** The size predicted at order `to` from `size` at order `from`, growing as n^exponent. */
export function predictedSize(size: number, from: number, to: number, exponent: number): number {
  return size * (to / from) ** exponent;
}

/**
 * Why differentiating `expression` with respect to `variable` to order `n`
 * costs more than this computes, or undefined. Measures the derivative at
 * the probe orders on the engine; the caller has already bounded the order
 * (MAX_CALCULUS_ORDER), the expression's length and its variable.
 *
 * A probe the engine fails on is a refusal: the derivative at twice the order
 * would fail too.
 */
export async function derivativeCostRefusal(
  expression: string,
  variable: string,
  n: number
): Promise<string | undefined> {
  if (!(n >= 2)) return undefined;
  const sizes: { order: number; size: number }[] = [];
  for (const order of [...probeOrders(n), n]) {
    const last = sizes.at(-1);
    if (last !== undefined) {
      const before = sizes.at(-2);
      const slope =
        before === undefined || before.size <= 0 || last.size <= 0
          ? FIRST_EXPONENT
          : Math.log(last.size / before.size) / Math.log(last.order / before.order);
      const exponent = Math.max(slope, 2) + 1;
      const predicted = predictedSize(last.size, last.order, order, exponent);
      if (predicted > MAX_DERIVATIVE_SIZE) {
        return (
          `differentiate to order ${n} of this expression is more than this computes: its ` +
          `derivative of order ${last.order} already has ${count(last.size)} characters, and ` +
          `to order ${order} it would grow to about ${count(predicted)}, past the ` +
          `${count(MAX_DERIVATIVE_SIZE)} this computes — lower the order or differentiate a ` +
          'simpler expression'
        );
      }
    }
    if (order === n) return undefined;
    let printed: string;
    try {
      printed = String(await giacEngine.evaluate(`diff(${expression},${variable},${order})`));
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      return (
        `differentiate to order ${n} of this expression is more than this computes: its ` +
        `derivative of order ${order} already failed (${why})`
      );
    }
    sizes.push({ order, size: printed.length });
  }
  return undefined;
}
