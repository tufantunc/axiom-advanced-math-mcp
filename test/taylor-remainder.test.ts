import { describe, it, expect, beforeAll } from 'vitest';
import { giacEngine } from '../src/server/giac/index.js';
import { computeHandler } from '../src/server/tools/compute/index.js';
import { verifyHandler } from '../src/server/tools/verify/index.js';
import { seriesRemainderOrders } from '../src/server/tools/output-cleanup.js';
import { allText } from './helpers/all-text.js';
import { resultLine } from './helpers/result-line.js';

beforeAll(async () => {
  await giacEngine.initialize();
}, 60000);

// Giac writes a series' remainder as B^k*order_size(B), and writes a series
// that broke down the same way; the order k is what tells them apart.
describe('seriesRemainderOrders', () => {
  it.each([
    ['x-1/6*x^3+x^4*order_size(x)', [4]],
    ['x-1-1/2*(x-1)^2+(x-1)^4*order_size(x-1)', [4]],
    ['1/2*pi-1/x+1/3*(1/x)^3+(1/x)^4*order_size(1/x)', [4]],
    ['-(x-pi/2)^-1+1/3*(x-pi/2)+(x-pi/2)^4*order_size(x-pi/2)', [4]],
    ['1+x*order_size(x)', [1]],
    ['x^10*order_size(x)', [10]],
    // Broken down at once: O(1), however it is written.
    ['order_size(x)', [0]],
    ['1/x+order_size(x)', [0]],
    ['order_size(x)+1', [0]],
    ['2*order_size(x)', [0]],
    // A power of something other than the remainder's own base is not its order.
    ['y^4*order_size(x)', [0]],
    ['cos(x)*order_size(x)', [0]],
    // Inside a product the remainder is still read.
    ['2*(x-1/6*x^3+x^4*order_size(x))', [4]],
    ['x^2+1', []],
    ['my_order_size(x)', []],
  ])('%s has remainder orders %j', (printed, orders) => {
    expect(seriesRemainderOrders(printed)).toEqual(orders);
  });
});

describe('taylor — a series that breaks down is refused', () => {
  const noSeries = (expr: string, n: number, at: string) =>
    `taylor cannot answer this — ${expr} has no Taylor series of order ${n} at ${at}`;

  it.each([
    // Answered `order_size(x)` — the remainder alone — with isError:false.
    ['taylor(exp(1/x), x, 0, 3)', noSeries('exp(1/x)', 3, 'x = 0'), 'nothing but O(1)'],
    ['series(exp(1/x), x=0, 3)', noSeries('exp(1/x)', 3, 'x = 0'), 'nothing but O(1)'],
    ['taylor(exp(1/(x-1)), x=1, 2)', noSeries('exp(1/(x-1))', 2, 'x = 1'), 'nothing but O(1)'],
    ['taylor(cos(x)*exp(1/x), x, 0, 3)', noSeries('cos(x)*exp(1/x)', 3, 'x = 0'), 'O(1)'],
    // Answered `1`: the expansion stopped at order 0 and the remainder was cut off.
    [
      'taylor(1+x*exp(1/x), x, 0, 3)',
      noSeries('1+x*exp(1/x)', 3, 'x = 0'),
      'a remainder of order 1',
    ],
    // Answered `1/x`.
    ['taylor(exp(1/x)+1/x, x, 0, 3)', noSeries('exp(1/x)+1/x', 3, 'x = 0'), 'nothing but O(1)'],
    // Answered `x^5*order_size(x)`, the same print as taylor(x^5, x, 0, 3),
    // whose answer is 0: the zero is answered only when the engine confirms it.
    [
      'taylor(x^5*exp(1/x), x, 0, 3)',
      noSeries('x^5*exp(1/x)', 3, 'x = 0'),
      'not confirmed to vanish to order 3',
    ],
    // The guessed variable and the default order 5.
    ['taylor(exp(1/x))', noSeries('exp(1/x)', 5, 'x = 0'), 'nothing but O(1)'],
  ])('%s is refused', async (problem, message, detail) => {
    const r = await computeHandler({ problem });
    const text = allText(r);
    expect(r.isError, text).toBe(true);
    expect(text).toContain(message);
    expect(text).toContain(detail);
    expect(text).not.toMatch(/^Result:/m);
    expect(text).not.toContain('order_size');
  });
});

describe('taylor — series that reach the order asked for answer', () => {
  it.each([
    ['taylor(sin(x), x, 0, 3)', 'x-1/6*x^3'],
    ['taylor(ln(x), x, 1, 3)', 'x-1-1/2*(x-1)^2+1/3*(x-1)^3'],
    ['taylor(1/(1-x), x, 0, 3)', '1+x+x^2+x^3'],
    // Laurent and asymptotic series keep their remainder of order n+1.
    ['taylor(tan(x), x, pi/2, 3)', '-(x-pi/2)^-1+1/3*(x-pi/2)+1/45*(x-pi/2)^3'],
    ['taylor(exp(1/x), x, inf, 3)', '1+1/x+1/2*(1/x)^2+1/6*(1/x)^3'],
    ['taylor(atan(x), x, inf, 3)', '1/2*pi-1/x+1/3*(1/x)^3'],
    // A remainder past the order asked for: the terms through it are all there.
    ['taylor(x^2+1, x, 0, 1)', '1'],
    // A polynomial comes back with no remainder at all.
    ['taylor(x^2+1, x, 0, 3)', '1+x^2'],
    // Nothing below the remainder, confirmed o(x^3): the polynomial is 0.
    // These printed `x^4*order_size(x)` as the Result.
    ['taylor(x^4, x, 0, 3)', '0'],
    ['taylor(cos(x)-1+x^2/2, x, 0, 3)', '0'],
    ['taylor(sin(x)^5, x, 0, 3)', '0'],
    ['taylor(x^10, x=0, 3)', '0'],
  ])('%s is %s', async (problem, expected) => {
    const r = await computeHandler({ problem });
    const text = allText(r);
    expect(r.isError, text).toBe(false);
    expect(text).toMatch(resultLine(expected));
    expect(text).not.toContain('order_size');
  });

  it('says why a zero series is zero', async () => {
    const text = allText(await computeHandler({ problem: 'taylor(x^4, x, 0, 3)' }));
    expect(text).toContain(
      'Every term through order 3 is zero: the expression vanishes faster at x = 0.'
    );
    expect(text).toContain('Command: taylor(x^4,x=0,3)');
  });
});

// The other place a taylor result is parsed: verify reads each side through
// the engine and took a remainder of order 0 for a series. The difference
// simplified to that remainder alone, which the symbolic check takes for zero.
describe('verify — a side that is a broken-down series', () => {
  it.each(['taylor(exp(1/x), x=0, 3) = 0', 'taylor(exp(1/x), x=0, 3) = 1'])(
    '%s cannot be checked',
    async (claim) => {
      const t = allText(await verifyHandler({ claim }));
      expect(t).toContain('Verified: UNKNOWN');
      expect(t).toContain('is a series that breaks down');
      expect(t).not.toContain('Verified: TRUE');
    }
  );

  it('a series that reaches its order is still verified', async () => {
    const t = allText(await verifyHandler({ claim: 'taylor(sin(x), x=0, 3) = x - x^3/6' }));
    expect(t).toContain('Verified: TRUE');
  });
});
