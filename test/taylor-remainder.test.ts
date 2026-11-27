import { describe, it, expect, beforeAll } from 'vitest';
import { giacEngine } from '../src/server/giac/index.js';
import { computeHandler } from '../src/server/tools/compute/index.js';
import { verifyHandler } from '../src/server/tools/verify/index.js';
import { seriesRemainderOrders } from '../src/server/tools/output-cleanup.js';
import { allText } from './helpers/all-text.js';
import { resultLine } from './helpers/result-line.js';
import { expectAnswer } from './helpers/compute-answer.js';

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

  // It runs on every engine answer, on the main thread and outside the
  // worker's timeout. A version that rescanned the prefix per occurrence took
  // 148 s on this input; `simplify(seq(x^4*order_size(x),k,1,10000))`, 42
  // characters through compute, held the event loop for 6.5 s.
  it('reads 50,000 remainders in linear time', () => {
    const printed = `[${'x^4*order_size(x),'.repeat(50_000)}0]`;
    const started = performance.now();
    const orders = seriesRemainderOrders(printed);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(orders).toHaveLength(50_000);
    expect(new Set(orders)).toEqual(new Set([4]));
  });

  it('reads a remainder behind a long name in linear time', () => {
    const terms = Array.from({ length: 600 }, (_, k) => `y^${k}*order_size(x)`).join('+');
    const started = performance.now();
    const orders = seriesRemainderOrders(`${'a'.repeat(7_000)}+${terms}`);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(orders).toEqual(new Array(600).fill(0));
  });
});

describe('taylor — a series that breaks down is refused', () => {
  const expanding = (expr: string, n: number, at: string) =>
    `taylor cannot answer this — expanding ${expr} to order ${n} at ${at}: `;
  const atOnce =
    'the expansion breaks down at once, leaving nothing but O(1), as it does at an ' +
    'essential singularity such as exp(1/x) at 0 — there is no Taylor series there';

  it.each([
    // Answered `order_size(x)` — the remainder alone — with isError:false.
    ['taylor(exp(1/x), x, 0, 3)', expanding('exp(1/x)', 3, 'x = 0') + atOnce],
    ['series(exp(1/x), x=0, 3)', expanding('exp(1/x)', 3, 'x = 0') + atOnce],
    ['taylor(exp(1/(x-1)), x=1, 2)', expanding('exp(1/(x-1))', 2, 'x = 1') + atOnce],
    ['taylor(cos(x)*exp(1/x), x, 0, 3)', expanding('cos(x)*exp(1/x)', 3, 'x = 0') + atOnce],
    // Answered `1/x`.
    ['taylor(exp(1/x)+1/x, x, 0, 3)', expanding('exp(1/x)+1/x', 3, 'x = 0') + atOnce],
    // The guessed variable and the default order 5.
    ['taylor(exp(1/x))', expanding('exp(1/x)', 5, 'x = 0') + atOnce],
    // Answered `1`: the expansion stopped at order 0 and the remainder was cut off.
    [
      'taylor(1+x*exp(1/x), x, 0, 3)',
      expanding('1+x*exp(1/x)', 3, 'x = 0') +
        'the expansion stops with a remainder of order 1, short of the order 3 asked for',
    ],
    // Answered `1-1/2*x+1/24*x^2`, without the x^3 term asked for. cos(√x) is
    // entire in x; Giac's expansion stops short, so it is no Taylor series to
    // order 3, and the message does not claim a singularity.
    [
      'taylor(cos(sqrt(x)), x, 0, 3)',
      expanding('cos(sqrt(x))', 3, 'x = 0') +
        'the expansion stops with a remainder of order 3, short of the order 3 asked for',
    ],
    // Answered `x^5*order_size(x)`, the same print as taylor(x^5, x, 0, 3),
    // whose answer is 0: the zero is answered only when the engine confirms it.
    [
      'taylor(x^5*exp(1/x), x, 0, 3)',
      expanding('x^5*exp(1/x)', 3, 'x = 0') +
        'the expansion leaves only its remainder, and the expression is not confirmed to ' +
        'vanish faster than (x-0)^3 there',
    ],
  ])('%s is refused', async (problem, message) => {
    const r = await computeHandler({ problem });
    const text = allText(r);
    expect(r.isError, text).toBe(true);
    expect(text).toContain(message);
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
    // At infinity Giac counts the order from the leading power, so a remainder
    // at or below the order asked for closes a correct asymptotic series.
    ['taylor(x^2/(1+x), x, inf, 3)', '(1/x)^-1-1+1/x-(1/x)^2'],
    ['taylor(x^3*exp(1/x), x, inf, 2)', '(1/x)^-3+(1/x)^-2+1/2*(1/x)^-1'],
  ])('%s is %s', async (problem, expected) => {
    const r = await computeHandler({ problem });
    const text = allText(r);
    expect(r.isError, text).toBe(false);
    expect(text).toMatch(resultLine(expected));
    expect(text).not.toContain('order_size');
  });

  // A list keeps its remainders inside its entries, which the strip leaves:
  // answered as printed, as main did — it was refused as having no series.
  it('answers a taylor of a list as the engine prints it', async () => {
    await expectAnswer(
      'taylor([sin(x), cos(x)], x, 0, 3)',
      '[x-1/6*x^3+x^4*order_size(x),1-1/2*x^2+x^4*order_size(x)]'
    );
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
// the engine. A remainder of order 0 left a difference the symbolic check took
// for zero, and a series that stopped short was stripped to what looked like
// a polynomial — both verified with high confidence.
describe('verify — a side compute would refuse cannot be checked', () => {
  it.each([
    ['taylor(exp(1/x), x=0, 3) = 0', 'broken_series', 'breaks down at once'],
    ['taylor(exp(1/x), x=0, 3) = 1', 'broken_series', 'breaks down at once'],
    ['taylor(1+x*exp(1/x), x=0, 3) = 1', 'broken_series', 'a remainder of order 1'],
    // The principal value, which compute refuses: verified TRUE on main.
    ['integrate(1/(x-1), x, 0, 2) = 0', 'divergent_integral', 'the integral diverges'],
    ['int(tan(x), x, 0, pi) = 0', 'divergent_integral', 'the integral diverges'],
  ])('%s cannot be checked', async (claim, check, reason) => {
    const t = allText(await verifyHandler({ claim }));
    expect(t).toContain('Verified: UNKNOWN');
    expect(t).toContain(reason);
    expect(t).toContain(check);
    expect(t).not.toContain('Verified: TRUE');
  });

  it.each([
    'taylor(sin(x), x=0, 3) = x - x^3/6',
    'taylor(x^2+1, x=0, 1) = 1',
    'integrate(x, x, 0, 1) = 1/2',
    'integrate(1/sqrt(abs(x)), x, -1, 1) = 4',
  ])('%s is still verified', async (claim) => {
    const t = allText(await verifyHandler({ claim }));
    expect(t).toContain('Verified: TRUE');
  });
});
