import { describe, it, expect, beforeAll } from 'vitest';
import { giacEngine } from '../src/server/giac/index.js';
import { computeHandler } from '../src/server/tools/compute/index.js';
import { allText } from './helpers/all-text.js';
import { resultLine } from './helpers/result-line.js';

beforeAll(async () => {
  await giacEngine.initialize();
}, 60000);

// Giac answers a definite integral across a pole of odd order with the Cauchy
// principal value. Each row below shipped that finite number with
// isError:false; the integral diverges.
describe('integrate — a divergent integral is refused, not answered', () => {
  const diverges = (at: string, interval: string, answer: string) =>
    `integrate cannot answer this — the integral diverges: the integrand is not integrable ` +
    `${at} inside ${interval}, where the CAS integrates the pieces on either side to an ` +
    `infinity, so its ${answer} is not the integral`;

  it.each([
    ['integrate(1/(x-1), x, 0, 2)', diverges('at x = 1', '[0, 2]', '0')],
    ['integrate(1/x, x, -1, 1)', diverges('at x = 0', '[-1, 1]', '0')],
    ['integrate(1/x^3, x, -1, 1)', diverges('at x = 0', '[-1, 1]', '0')],
    ['integrate(1/(x-1), x, 2, 0)', diverges('at x = 1', '[2, 0]', '0')],
    ['integrate(1/(x-1), x=0..2)', diverges('at x = 1', '[0, 2]', '0')],
    ['integrate(x/(x^2-1), x, -2, 2)', diverges('at x = 1, x = -1', '[-2, 2]', '0')],
    ['integrate(tan(x), x, 0, pi)', diverges('at x = 1/2*pi', '[0, pi]', '0')],
    ['integrate(1/sin(x), x, -1, 1)', diverges('at x = 0', '[-1, 1]', '0')],
    ['integrate(cot(x), x, -1, 1)', diverges('at x = 0', '[-1, 1]', '0')],
    // Special-function antiderivatives: Ei's principal value, even off centre.
    ['integrate(exp(x)/x, x, -1, 1)', diverges('at x = 0', '[-1, 1]', 'Ei(1)-Ei(-1)')],
    ['integrate(exp(x)/x, x, -1, 1/3)', diverges('at x = 0', '[-1, 1/3]', '-Ei(-1)+Ei(1/3)')],
    ['integrate(1/ln(x), x, 1/2, 2)', diverges('at x = 1', '[1/2, 2]', 'Ei(ln(2))-Ei(-ln(2))')],
    // Float bounds: a numeric quadrature that came back as a pair of numbers.
    [
      'integrate(1/ln(x), x, 0.5, 2)',
      diverges('at x = 1', '[0.5, 2]', '[4.99567743294,-0.342064447914]'),
    ],
  ])('%s', async (problem, message) => {
    const r = await computeHandler({ problem });
    const text = allText(r);
    expect(r.isError, text).toBe(true);
    expect(text).toContain(message);
    expect(text).not.toMatch(/^Result:/m);
  });

  // The pole the extra split finds: `singular` lists tan's principal poles,
  // ±pi/2, and not the one at 3pi/2 in [pi, 2pi]. Off centre, the piece holding
  // it comes back undef instead of a principal value.
  it.each([
    ['integrate(tan(x), x, pi, 2*pi)', '[pi, 2*pi]'],
    ['integrate(1/cos(x), x, pi, 2*pi)', '[pi, 2*pi]'],
    ['integrate(tan(3*x), x, pi/3, 2*pi/3)', '[pi/3, 2*pi/3]'],
    // `singular` cannot read abs here, so the split is the only check.
    ['integrate(1/(x*abs(x)), x, -1, 1)', '[-1, 1]'],
  ])('%s is refused as unconfirmed', async (problem, interval) => {
    const r = await computeHandler({ problem });
    const text = allText(r);
    expect(r.isError, text).toBe(true);
    expect(text).toContain(
      `integrate cannot answer this — the CAS answered 0 over ${interval}, but integrated ` +
        'piece by piece one piece came back undef, so the answer may be a principal value ' +
        'across a singularity inside the interval rather than the integral'
    );
    expect(text).not.toMatch(/^Result:/m);
  });
});

describe('integrate — convergent and correctly divergent integrals still answer', () => {
  it.each([
    ['integrate(x, x, 0, 1)', '1/2'],
    ['integrate(sin(x), x, 0, pi)', '2'],
    // A pole on the boundary is an improper integral that converges.
    ['integrate(ln(x), x, 0, 1)', '-1'],
    ['integrate(1/sqrt(x), x, 0, 1)', '2'],
    ['integrate(1/sqrt(1-x^2), x, -1, 1)', 'pi'],
    // A singular point inside the interval that is integrable.
    ['integrate(1/sqrt(abs(x)), x, -1, 1)', '4'],
    ['integrate(sign(x), x, -1, 1)', '0'],
    // An odd integrand with no pole: 0 is the integral.
    ['integrate(x/(x^2+1), x, -1, 1)', '0'],
    ['integrate(tan(x), x, -1, 1)', '0'],
    ['integrate(x^3, x, -1, 1)', '0'],
    // A pole outside the interval.
    ['integrate(1/(x-3), x, 0, 2)', '-ln(3)'],
    ['integrate(1/x, x, 1, 2)', 'ln(2)'],
    // Infinite bounds, including a conditionally convergent one.
    ['integrate(1/(1+x^2), x, -inf, inf)', 'pi'],
    ['integrate(exp(-x^2), x, -inf, inf)', '√pi'],
    ['integrate(sin(x)/x, x, 0, inf)', 'pi/2'],
    ['integrate(1/(2+cos(x)), x, 0, 2*pi)', '2*pi/√3'],
    ['integrate(sin(x), x, 0, 10.5)', '1.475536928'],
    // A divergence the engine already reports is not refused.
    ['integrate(1/(x-1)^2, x, 0, 2)', '+infinity'],
    ['integrate(1/x^2, x, -1, 1)', '+infinity'],
    // Symbolic bounds or a parameter's pole: where the pole lies is not
    // decided, so the engine's answer stands.
    ['integrate(1/(x-a), x, 0, 2)', 'ln(abs(-a+2))-ln(abs(a))'],
    ['integrate(x, x, a, b)', 'b^2/2-a^2/2'],
  ])('%s is %s', async (problem, expected) => {
    const r = await computeHandler({ problem });
    const text = allText(r);
    expect(r.isError, text).toBe(false);
    expect(text).toMatch(resultLine(expected));
  });
});
