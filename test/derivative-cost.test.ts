import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { giacEngine } from '../src/server/giac/index.js';
import { computeHandler } from '../src/server/tools/compute/index.js';
import {
  derivativeCostRefusal,
  MAX_DERIVATIVE_SIZE,
  predictedSize,
  probeOrders,
} from '../src/server/tools/derivative-cost.js';
import { allText } from './helpers/all-text.js';
import { expectAnswer, expectRefused } from './helpers/compute-answer.js';

beforeAll(async () => {
  await giacEngine.initialize();
}, 60000);

afterEach(() => {
  vi.restoreAllMocks();
});

/** n! exactly. */
function factorial(n: number): bigint {
  let f = 1n;
  for (let k = 2n; k <= BigInt(n); k++) f *= k;
  return f;
}

/** The answer's Result line, after asserting it is an answer. */
async function answerOf(problem: string): Promise<string> {
  const r = await computeHandler({ problem });
  const text = allText(r);
  expect(r.isError, text).toBe(false);
  const result = /^Result: (.*)$/m.exec(text)?.[1];
  expect(result, text).toBeDefined();
  return result!;
}

const BIG = 'exp(sin(x*y))*cos(x+y)/(1+x^2+y^2)';

/**
 * The value at the origin of a printed sum of products, computed here rather
 * than by the engine, whose parser traps on an answer this long. Each name in
 * `ones` is 1 there and each in `zeros` is 0, and so is every power of a
 * variable; a quotient of two sums is read as one. Anything else in a term is
 * an error, so a shape this does not read is never taken for a value.
 */
function valueAtOrigin(printed: string, ones: string[], zeros: string[]): bigint {
  let text = printed;
  for (const one of ones) text = text.replaceAll(one, '1');
  for (const zero of zeros) text = text.replaceAll(zero, 'Z');
  const sum = (part: string): bigint => {
    let total = 0n;
    for (const term of part.split(/(?=[+-])/)) {
      if (/[a-zA-Z]/.test(term)) continue;
      const body = term.replace(/^[+-]/, '');
      let product = 1n;
      for (const factor of body.split('*')) {
        const m = /^(\d+)(?:\^(\d+))?$/.exec(factor);
        if (m === null) throw new Error(`unread factor ${factor} in ${term}`);
        product *= BigInt(m[1]) ** BigInt(m[2] ?? '1');
      }
      total += term.startsWith('-') ? -product : product;
    }
    return total;
  };
  const quotient = /^\((.*)\)\/\((.*)\)$/.exec(text);
  if (quotient === null) return sum(text);
  const [num, den] = [sum(quotient[1]), sum(quotient[2])];
  if (num % den !== 0n) throw new Error(`${num}/${den} is not an integer`);
  return num / den;
}

describe('probeOrders', () => {
  it.each([
    [2, [1]],
    [3, [1, 2]],
    [15, [1, 2, 4, 8]],
    [100, [1, 2, 4, 7, 13, 25, 50]],
  ])('measures order %i at %j', (n, orders) => {
    expect(probeOrders(n)).toEqual(orders);
  });

  it('predicts a size growing as a power of the order', () => {
    expect(predictedSize(1000, 5, 10, 3)).toBe(8000);
    expect(predictedSize(1000, 10, 15, 2)).toBeCloseTo(2250);
  });
});

// MAX_CALCULUS_ORDER bounds the order, not the size a derivative grows to,
// and the size is what traps the worker.
describe('a derivative with respect to one variable is bounded by its size', () => {
  const refusal = (n: number) => `differentiate to order ${n} of this expression is more than`;

  it.each([
    // Trapped the worker ("RuntimeError: unreachable").
    [`diff(${BIG}, x, 15)`, 15],
    [`diff(${BIG}, x, 30)`, 30],
    ['diff(sin(sin(sin(sin(x)))), x, 32)', 32],
    ['diff(sin(sin(sin(x))), x, 50)', 50],
    // Answered on main with 558,407 characters, past what this computes: the
    // order 6 derivative has 38,952 and its growth predicts 831,147.
    [`diff(${BIG}, x, 12)`, 12],
  ])('%s is refused', async (problem, n) => {
    await expectRefused(problem, refusal(n));
    await expectRefused(problem, `past the ${MAX_DERIVATIVE_SIZE.toLocaleString('en-US')}`);
    // The probes stopped before any of them could trap: the worker answers.
    await expectAnswer('diff(x^3, x)', '3*x^2');
  });

  it('says how large the derivative already is and where it would go', async () => {
    const text = allText(await computeHandler({ problem: `diff(${BIG}, x, 15)` }));
    expect(text).toContain(
      'its derivative of order 8 already has 114,678 characters, and to order 15 it would ' +
        'grow to about'
    );
  });

  it.each([
    ['diff(sin(x), x, 100)', 'sin(x)'],
    ['diff(sin(x), x, 99)', '-cos(x)'],
    ['diff(exp(x), x, 100)', 'exp(x)'],
    ['diff(x^50, x, 50)', factorial(50).toString()],
    ['diff(x^100, x, 99)', `${factorial(100)}*x`],
    ['diff(x^3*y, x$2)', '6*x*y'],
  ])('%s is %s', async (problem, expected) => {
    await expectAnswer(problem, expected);
  });

  // The 100th derivative of exp(sin(x)) at 0, from f' = cos(x)*f by Leibniz:
  // f^(n+1)(0) = sum_k C(n,k) * cos^(k)(0) * f^(n-k)(0).
  it('answers diff(exp(sin(x)), x, 100), whose value at 0 is the Leibniz recurrence', async () => {
    const b: bigint[] = [1n];
    const cosAt0 = (k: number): bigint => [1n, 0n, -1n, 0n][k % 4];
    for (let n = 0; n < 100; n++) {
      let next = 0n;
      let binomial = 1n;
      for (let k = 0; k <= n; k++) {
        next += binomial * cosAt0(k) * b[n - k];
        binomial = (binomial * BigInt(n - k)) / BigInt(k + 1);
      }
      b.push(next);
    }
    const result = await answerOf('diff(exp(sin(x)), x, 100)');
    expect(valueAtOrigin(result, ['exp(sin(x))', 'cos(x)'], ['sin(x)'])).toBe(b[100]);
  });

  // The defect's own expression, below the order it grows past the cap. At
  // y = 0 it is cos(x)/(1+x^2), whose 10th derivative at 0 is
  // 10! * -(1 + 1/2! + 1/4! + 1/6! + 1/8! + 1/10!) = -5,599,531.
  it(`answers diff(${BIG}, x, 10)`, async () => {
    const result = await answerOf(`diff(${BIG}, x, 10)`);
    expect(
      valueAtOrigin(result, ['exp(sin(x*y))', 'cos(x*y)', 'cos(x+y)'], ['sin(x*y)', 'sin(x+y)'])
    ).toBe(-5_599_531n);
  });

  it('refuses when a probe fails, rather than computing past it', async () => {
    vi.spyOn(giacEngine, 'evaluate').mockRejectedValue(new Error('Giac evaluation timed out'));
    expect(await derivativeCostRefusal('tan(tan(x))', 'x', 40)).toBe(
      'differentiate to order 40 of this expression is more than this computes: its ' +
        'derivative of order 1 already failed (Giac evaluation timed out)'
    );
  });

  it('does not measure an order the order cap or a first derivative covers', async () => {
    const evaluate = vi.spyOn(giacEngine, 'evaluate');
    expect(await derivativeCostRefusal('tan(tan(x))', 'x', 1)).toBeUndefined();
    expect(evaluate).not.toHaveBeenCalled();
  });
});
