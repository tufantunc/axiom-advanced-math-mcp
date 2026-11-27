import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { giacEngine } from '../src/server/giac/index.js';
import { computeHandler } from '../src/server/tools/compute/index.js';
import { verifyHandler } from '../src/server/tools/verify/index.js';
import { irregularPointReason } from '../src/server/tools/taylor-answer.js';
import { nonSeriesTerm, seriesRemainderOrders } from '../src/server/tools/output-cleanup.js';
import { allText } from './helpers/all-text.js';
import { resultLine } from './helpers/result-line.js';
import { expectAnswer, expectRefused } from './helpers/compute-answer.js';

beforeAll(async () => {
  await giacEngine.initialize();
}, 60000);

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Every engine call that failed while `run` ran. A trap recycles the worker
 * and the next call succeeds on a fresh one, so the answer alone cannot tell
 * a clean refusal from one that took the shared worker down first.
 */
async function engineFailures(run: () => Promise<void>): Promise<string[]> {
  const evaluate = giacEngine.evaluate.bind(giacEngine);
  const failures: string[] = [];
  vi.spyOn(giacEngine, 'evaluate').mockImplementation(async (expr: string) => {
    try {
      return await evaluate(expr);
    } catch (error) {
      failures.push(String(error));
      throw error;
    }
  });
  await run();
  return failures;
}

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

// What a series may print: integer powers of the variable, coefficients free
// of it, and its remainder. Anything else in the answer means the expansion
// did not happen.
describe('nonSeriesTerm', () => {
  it.each([
    ['x-1/6*x^3+x^4*order_size(x)', 'x'],
    ['-(x-pi/2)^-1+1/3*(x-pi/2)+(x-pi/2)^4*order_size(x-pi/2)', 'x'],
    ['(1/x)^-3+(1/x)^-2+1/2*(1/x)^-1', 'x'],
    ['1/2*pi-1/x+1/3*(1/x)^3+(1/x)^4*order_size(1/x)', 'x'],
    ['exp(1)+exp(1)*(x-1)+exp(1)/2*(x-1)^2', 'x'],
    ['exp(a)+exp(a)*(x-a)+(x-a)^3*order_size(x-a)', 'x'],
    // Roots and powers of constants are coefficients.
    ['√2*x+2^(1/3)*x^2', 'x'],
    ['i/3*2^(-1/2-1)*x+x^(2)', 'x'],
    ['[x-1/6*x^3+x^4*order_size(x),1-1/2*x^2+x^4*order_size(x)]', 'x'],
    // Another name that merely contains the variable's letters.
    ['sin(xy)*x+exp(x1)', 'x'],
    ['θ-1/6*θ^3', 'θ'],
    ['1+x^2', 'x'],
  ])('%s is a series in %s', (printed, variable) => {
    expect(nonSeriesTerm(printed, variable)).toBeUndefined();
  });

  it.each([
    ['sin(1/x)', 'sin(1/x)'],
    ['ln(x)', 'ln(x)'],
    ['1+ln(x)*x+ln(x)^2/2*x^2+x^3*order_size(x)', 'ln(x)'],
    ['√x', '√x'],
    ['1+√(x-1)+x-1', '√(x-1)'],
    ['x^(1/3)', 'x^(1/3)'],
    ['(x^(1/3))^2*x+(x^(1/3))^2*x^3*order_size(x)', 'x^(1/3)'],
    ['exp(n*ln(x))', 'exp(n*ln(x))'],
    ['x^n', 'x^n'],
    ['2^x', '2^x'],
    ['x^2.5', 'x^2.5'],
    ['sin((1/x)^-1)', 'sin((1/x)^-1)'],
    ['(√(1/x))^-1', '√(1/x)'],
    ['sin(1/θ)', 'sin(1/θ)'],
  ])('%s holds %s', (printed, term) => {
    expect(nonSeriesTerm(printed, printed.includes('θ') ? 'θ' : 'x')).toBe(term);
  });

  // What cannot be read is never taken for a series.
  it.each(['sin(x', 'x)+1'])('unbalanced %s is not a series', (printed) => {
    expect(nonSeriesTerm(printed, 'x')).toBeDefined();
  });

  // On the main thread, outside the worker's timeout, over answers that run
  // to half a million characters.
  it.each([
    ['a long series', `${'x^4*order_size(x)+1/7*x^3*exp(1)+'.repeat(15_000)}x`],
    ['deep nesting', `${'exp('.repeat(100_000)}1${')'.repeat(100_000)}*x`],
    ['nested exponents', `${'2^('.repeat(100_000)}3${')'.repeat(100_000)}*x`],
    ['a long exponent', `x^(${'1+'.repeat(200_000)}1)`],
  ])('reads %s in linear time', (_, printed) => {
    const started = performance.now();
    nonSeriesTerm(printed, 'x');
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe('taylor — a series that breaks down is refused', () => {
  const expanding = (expr: string, n: number, at: string) =>
    `taylor cannot answer this — expanding ${expr} to order ${n} at ${at}: `;
  const irregular = (arg: string) =>
    `the expression applies a function to ${arg}, which has no finite limit there (it ` +
    'tends to infinity) — the point is a singularity such as exp(1/x) or sin(1/x) has at ' +
    '0, where there is no Taylor series';
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
    // whose answer is 0. Refused before the zero is considered: exp's argument
    // has no finite limit at 0.
    ['taylor(x^5*exp(1/x), x, 0, 3)', expanding('x^5*exp(1/x)', 3, 'x = 0') + irregular('1/x')],
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
    ['taylor(exp(1/x), x=0, 3) = 0', 'series_computation', 'breaks down at once'],
    ['taylor(exp(1/x), x=0, 3) = 1', 'series_computation', 'breaks down at once'],
    ['taylor(1+x*exp(1/x), x=0, 3) = 1', 'series_computation', 'a remainder of order 1'],
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

// A remainder of order n+1 hid what is not a Taylor series at all. Giac
// writes exp(1/x) at 0 as O(1), bounded, and a factor x^4 turns that into an
// ordinary-looking O(x^4): `x+x^4*exp(1/x)` answered `x`, though
// x^4*exp(1/x) grows without bound as x tends to 0 from the right.
describe('taylor — a point that is not regular is refused', () => {
  const at0 = (expr: string) => `expanding ${expr} to order 3 at x = 0: `;
  const noLimit = (arg: string, value = 'it tends to infinity') =>
    `the expression applies a function to ${arg}, which has no finite limit there (${value})`;

  it.each([
    ['taylor(x+x^4*exp(1/x), x, 0, 3)', at0('x+x^4*exp(1/x)') + noLimit('1/x')],
    ['taylor(x+x^4*exp(1/x), x=0, 3)', at0('x+x^4*exp(1/x)') + noLimit('1/x')],
    ['series(x+x^4*exp(1/x), x, 0, 3)', at0('x+x^4*exp(1/x)') + noLimit('1/x')],
    // e^u is exp(u), and a^u a power whose exponent blows up.
    ['taylor(x+x^4*e^(1/x), x, 0, 3)', at0('x+x^4*e^(1/x)') + noLimit('1/x')],
    ['taylor(x+x^4*2^(1/x), x, 0, 3)', at0('x+x^4*2^(1/x)') + noLimit('1/x')],
    // Every level is read: exp's own argument has a limit, 0, and the sine
    // inside it has none.
    ['taylor(x+x^4*exp(x*sin(1/x)), x, 0, 3)', at0('x+x^4*exp(x*sin(1/x))') + noLimit('1/x')],
    // Answered `sin(1/x)`, unchanged and with no remainder.
    ['taylor(sin(1/x), x, 0, 3)', at0('sin(1/x)') + noLimit('1/x')],
    ['taylor(x*sin(1/x), x, 0, 3)', at0('x*sin(1/x)') + noLimit('1/x')],
    // Answered 0 by the remainder-only check: x^5*sin(1/x) is o(x^3), but it
    // has no third derivative at 0, so it has no Taylor polynomial of order 3.
    ['taylor(x^5*sin(1/x), x, 0, 3)', at0('x^5*sin(1/x)') + noLimit('1/x')],
    [
      'taylor(x+x^4*exp(sin(1/x)), x, 0, 3)',
      at0('x+x^4*exp(sin(1/x))') + noLimit('sin(1/x)', 'it stays bounded but tends to no value'),
    ],
    [
      'taylor(exp(1/(x-1))*(x-1)^5, x, 1, 3)',
      'expanding exp(1/(x-1))*(x-1)^5 to order 3 at x = 1: ' + noLimit('1/(x-1)'),
    ],
  ])('%s is refused', async (problem, message) => {
    await expectRefused(problem, `taylor cannot answer this — ${message}`);
  });

  // The same functions where their arguments have finite limits, and the same
  // shape around a function that is regular at the point.
  it.each([
    ['taylor(x+x^4*exp(x), x, 0, 3)', 'x'],
    ['taylor(sin(1/x), x, 1, 2)', 'sin(1)-cos(1)*(x-1)+(-sin(1)+2*cos(1))/2*(x-1)^2'],
    ['taylor(exp(1/x), x, 1, 2)', 'exp(1)-exp(1)*(x-1)+3*exp(1)/2*(x-1)^2'],
    // An argument with a removable singularity has a finite limit.
    ['taylor(exp(sin(x)/x), x, 0, 3)', 'exp(1)-exp(1)/6*x^2'],
    // ln(x) tends to minus infinity, but it is no function's argument here,
    // and x^4*ln(x) is o(x^3): every term through order 3 is x's.
    ['taylor(x+x^4*log(x), x, 0, 3)', 'x'],
    ['taylor(sqrt(1+x), x, 0, 3)', '1+1/2*x-1/8*x^2+1/16*x^3'],
    ['taylor(log(1+x), x, 0, 4)', 'x-1/2*x^2+1/3*x^3-1/4*x^4'],
    ['taylor(1/x+exp(x), x, 0, 3)', '1/x+1+x+1/2*x^2+1/6*x^3'],
    ['taylor(sin(x)/x, x, 0, 4)', '1-1/6*x^2+1/120*x^4'],
    // A parameter in the argument, and one at the point.
    ['taylor(exp(a*x), x, 0, 2)', '1+a*x+a^2/2*x^2'],
    ['taylor(x^n, x, 1, 2)', '1+n*(x-1)+(n^2-n)/2*(x-1)^2'],
    // At infinity the arguments are not read: 1/x tends to 0 there.
    ['taylor(sin(1/x), x, inf, 3)', '1/x-1/6*(1/x)^3'],
    ['taylor(x*exp(1/x), x, inf, 2)', '(1/x)^-1+1+1/2/x'],
    ['taylor(sin(θ), θ, 0, 3)', 'θ-1/6*θ^3'],
  ])('%s is %s', async (problem, expected) => {
    await expectAnswer(problem, expected);
  });
});

// The regularity check hands the engine pieces it printed, and Giac's parser
// traps on a long one: `op(exp(<9,701 digits>*x))` took the worker down
// before the bound.
it('refuses a point whose pieces are too long to hand back, without a trap', async () => {
  const failures = await engineFailures(() =>
    expectRefused(
      'taylor(exp(10^9700*x), x, 0, 2)',
      'the point could not be confirmed to be a regular point of the expression'
    )
  );
  expect(failures).toEqual([]);
});

// Two readings no input measured here produces, pinned with a stubbed engine
// so neither can go quietly: each would otherwise let the point pass.
describe('irregularPointReason — what it does not take for a finite limit', () => {
  /** The engine, except that a command matching `pattern` answers `printed`. */
  function stub(pattern: RegExp, printed: string): void {
    const evaluate = giacEngine.evaluate.bind(giacEngine);
    vi.spyOn(giacEngine, 'evaluate').mockImplementation(async (expr: string) =>
      pattern.test(expr) ? printed : evaluate(expr)
    );
  }

  it('a limit that still names the variable', async () => {
    stub(/^\[limit\(/, '[x]');
    expect(await irregularPointReason('exp(sin(x))', 'x', '0')).toContain(
      'the expression applies a function to sin(x), which has no finite limit there'
    );
  });

  it('a piece that reads back as undef', async () => {
    stub(/^\[\[op\(/, '[[undef]]');
    expect(await irregularPointReason('exp(sin(x))', 'x', '0')).toContain(
      'the point could not be confirmed to be a regular point'
    );
  });

  it('neither, for the engine itself', async () => {
    expect(await irregularPointReason('exp(sin(x))', 'x', '0')).toBeUndefined();
  });
});

// Giac hands back what it cannot expand as it found it, with no remainder to
// say so: each of these answered with isError:false.
describe('taylor — an answer that is not a series is refused', () => {
  const holds = (term: string) =>
    `the expansion still holds ${term}, which is not an integer power of the variable`;

  it.each([
    // Answered `ln(x)` and `√x`.
    ['taylor(log(x), x, 0, 3)', 'expanding log(x) to order 3 at x = 0: ' + holds('ln(x)')],
    ['taylor(sqrt(x), x, 0, 3)', 'expanding sqrt(x) to order 3 at x = 0: ' + holds('sqrt(x)')],
    // Answered 1+ln(x)*x+ln(x)^2/2*x^2+ln(x)^3/6*x^3.
    ['taylor(x^x, x, 0, 3)', 'expanding x^x to order 3 at x = 0: ' + holds('ln(x)')],
    // Answered `sin((1/x)^-1)` and `1/exp(x)^-1`: no expansion at infinity.
    [
      'taylor(sin(x), x, inf, 3)',
      'expanding sin(x) to order 3 at x = inf: ' + holds('sin((1/x)^-1)'),
    ],
    ['taylor(exp(x), x, inf, 3)', 'expanding exp(x) to order 3 at x = inf: ' + holds('exp(x)')],
    [
      'taylor(1/x+exp(-x), x, inf, 3)',
      'expanding 1/x+exp(-x) to order 3 at x = inf: ' + holds('exp(-x)'),
    ],
  ])('%s is refused', async (problem, message) => {
    await expectRefused(problem, `taylor cannot answer this — ${message}`);
  });

  it.each([
    ['taylor(ln(x), x, 1, 3)', 'x-1-1/2*(x-1)^2+1/3*(x-1)^3'],
    ['taylor(sqrt(x), x, 4, 2)', '2+1/4*(x-4)-1/64*(x-4)^2'],
    ['taylor(atan(x), x, inf, 3)', '1/2*pi-1/x+1/3*(1/x)^3'],
    // Coefficients free of x are coefficients, whatever they hold.
    ['taylor(exp(x), x, 1, 2)', 'exp(1)+exp(1)*(x-1)+exp(1)/2*(x-1)^2'],
  ])('%s is %s', async (problem, expected) => {
    await expectAnswer(problem, expected);
  });
});

// verify read each side through Giac, which takes `taylor(f, x, a, n)` as the
// expansion to order a at the point n and `taylor(f, x, a)` as order a at 0,
// where compute reads the point a and the order n. Each spelling now reads
// as compute reads it, through compute's own path and its checks.
describe('verify — a series side reads as compute reads it', () => {
  const spellings = (f: string, a: string, n: string) => [
    `taylor(${f}, x, ${a}, ${n})`,
    `taylor(${f}, x=${a}, ${n})`,
  ];

  // compute's answer for the call, verified against the same call — and a
  // refusal of compute's, carried into verify's verdict in compute's words.
  it.each([
    ...spellings('exp(x)', '1', '2'),
    ...spellings('sin(x)', '0', '5'),
    ...spellings('1/(1-x)', '0', '3'),
    ...spellings('tan(x)', 'pi/2', '3'),
    ...spellings('x^4', '0', '3'),
    ...spellings('exp(1/x)', 'inf', '3'),
    ...spellings('x+x^4*exp(1/x)', '0', '3'),
    ...spellings('sin(1/x)', '0', '3'),
    ...spellings('log(x)', '0', '3'),
    ...spellings('sin(x)', '0', '200'),
    'taylor(sin(x), x, 3)',
    'series(sin(x), x, 1, 2)',
  ])('%s: compute and verify agree', async (call) => {
    const computed = await computeHandler({ problem: call });
    const answer = allText(computed);
    const result = /^Result: (.*)$/m.exec(answer)?.[1];
    const claim = `${call} = ${result ?? '0'}`;
    const verdict = allText(await verifyHandler({ claim }));
    if (computed.isError) {
      expect(verdict).toContain('Verified: UNKNOWN');
      expect(verdict).toContain(answer.replace(/^Error: /, ''));
      expect(verdict).toContain('series_computation');
    } else {
      expect(result, answer).toBeDefined();
      expect(verdict, claim).toContain('Verified: TRUE');
    }
  });

  it.each([
    // Refuted on main: Giac read the call as exp(2)+exp(2)*(x-2).
    ['taylor(exp(x), x, 1, 2) = exp(1)+exp(1)*(x-1)+exp(1)/2*(x-1)^2', 'Verified: TRUE'],
    ['taylor(exp(x), x=1, 2) = exp(1)+exp(1)*(x-1)+exp(1)/2*(x-1)^2', 'Verified: TRUE'],
    // Giac's reading, which compute does not give.
    ['taylor(exp(x), x, 1, 2) = exp(2)+exp(2)*(x-2)', 'Verified: FALSE'],
    ['taylor(exp(x), x=1, 2) = exp(2)+exp(2)*(x-2)', 'Verified: FALSE'],
    // Verified TRUE on main with high confidence.
    ['taylor(x+x^4*exp(1/x), x=0, 3) = x', 'Verified: UNKNOWN'],
    ['taylor(x+x^4*exp(1/x), x, 0, 3) = x', 'Verified: UNKNOWN'],
    ['x = taylor(x+x^4*exp(1/x), x, 0, 3)', 'Verified: UNKNOWN'],
  ])('%s', async (claim, verdict) => {
    expect(allText(await verifyHandler({ claim }))).toContain(verdict);
  });

  // compute reads a series only as the whole call, so a series inside a
  // larger expression has no reading of compute's to check — and one that
  // starts the side gets compute's own refusal of what follows it.
  const inside = 'it holds a taylor or series call inside a larger expression';
  it.each([
    [
      'taylor(x+x^4*exp(1/x), x=0, 3) + 1 = x + 1',
      'it must be a single taylor(...) with nothing after the closing parenthesis',
    ],
    ['2*taylor(x+x^4*exp(1/x), x, 0, 3) = 2*x', inside],
    ['(taylor(sin(x), x=0, 3)) = x - x^3/6', inside],
  ])('%s cannot be checked', async (claim, reason) => {
    const t = allText(await verifyHandler({ claim }));
    expect(t).toContain('Verified: UNKNOWN');
    expect(t).toContain('series_computation');
    expect(t).toContain(reason);
  });

  // compute answers it with 504,838 characters; the strategies hand a side
  // back to the engine, whose parser traps on a fraction of that.
  it('refuses a series answer too long to hand back, without a trap', async () => {
    const failures = await engineFailures(async () => {
      const t = allText(await verifyHandler({ claim: 'taylor(exp(x*y)*sin(x+y), x, 0, 100) = 0' }));
      expect(t).toContain('Verified: UNKNOWN');
      expect(t).toContain("compute's answer for it has 504838 characters");
    });
    expect(failures).toEqual([]);
  });

  it('reads a name that merely ends in taylor as a name', async () => {
    const t = allText(await verifyHandler({ claim: 'my_taylor(x) = my_taylor(x)' }));
    expect(t).toContain('Verified: TRUE');
  });
});
