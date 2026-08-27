import { describe, it, expect, beforeAll } from 'vitest';
import { giacEngine } from '../src/server/giac/index.js';
import { computeHandler } from '../src/server/tools/compute/index.js';

beforeAll(async () => {
  await giacEngine.initialize();
}, 60000);

const text = (r: { content: { text: string }[] }): string =>
  r.content.map((c) => c.text).join('\n');

/**
 * One representative invocation per advertised capability, driven through
 * `compute` — the seam the per-handler unit tests cannot see.
 *
 * Every handler here has unit tests that call it directly with its own field
 * names, and they all passed while five capabilities were unusable end to end:
 * the extractor and the handler had simply agreed on different keys
 * (`signal`/`data`, `expression`/`value`, a bare array vs `x`/`y`), and nothing
 * compared the two sides. `fourier` crashed on every input, including
 * `fft([1,2,3,4])`, for as long as it had existed.
 *
 * A verb named in README's capability table belongs in this table.
 */
const CAPABILITIES: [string, RegExp][] = [
  // Calculus
  ['diff(x^3, x)', /3\*x\^2/],
  ['int(x^2, x, 0, 1)', /1\/3/],
  ['limit(sin(x)/x, x, 0)', /\b1\b/],
  ['taylor(exp(x), x=0, 5)', /x\^2/],
  ["desolve(y'=x, y)", /x\*y|y\^2|c_0/],
  // Algebra
  ['factor(x^2-4)', /\(x-2\)|\(x\+2\)/],
  ['simplify((x^2-1)/(x-1))', /x\+1/],
  ['expand((x+1)^3)', /x\^3/],
  ['partfrac(1/(x^2-1))', /x-1|x\+1/],
  // Linear algebra
  ['det([[1,2],[3,4]])', /-2/],
  ['inv([[1,2],[3,4]])', /-2|3\/2/],
  ['eigenvals([[2,1],[1,2]])', /\b1\b|\b3\b/],
  // Number theory
  ['ifactor(2310)', /2|3|5|7|11/],
  ['analyze(28)', /Perfect|28/],
  // Combinatorics
  ['C(10,3)', /120/],
  ['multinomial(5, [2,2,1])', /\b30\b/],
  // Probability / statistics
  ['normal(mu=0, sigma=1, x=1)', /Normal|0\.24/],
  ['t_test(mu0=5, data=[1,2,3,4,5])', /t-statistic/],
  // Exact values — extractor emitted `expression`, handler read `value`
  ['to_exact(0.5)', /1\/2/],
  ['to_decimal(1/3)', /0\.333/],
  ['simplify_fraction(4/8)', /1\/2/],
  // Regression — extractor emitted a bare array, handler read x/y
  ['linear_regression([[1,2],[2,4],[3,6]])', /Linear|Equation/],
  ['polynomial_regression([[1,2],[2,5],[3,10]], 2)', /Polynomial/],
  // Sequences
  ['sequence(2,4,6,8)', /Arithmetic/],
  // Geometry — named arguments landed in a `raw` field nobody read
  ['area_circle(radius=2)', /12\.56/],
  ['area_triangle(base=4, height=3)', /\b6\b/],
  ['distance([0,0],[3,4])', /\b5\b/],
  // 3D geometry
  ['distance3d([0,0,0],[1,1,1])', /1\.73/],
  ['volume_sphere(2)', /33\.5|Volume/],
  // Multivariable
  ['gradient(x*y, [x,y])', /\[y,x\]|y,x/],
  ['critical_points(x^2+y^2, [x,y])', /minimum/],
  // Transforms — every field name missed; crashed on all input
  ['fft([1,2,3,4])', /n = 4 samples/],
  ['ifft([1,0,1,0])', /Reconstructed/],
  ['laplace(exp(-2*t),t,s)', /s\+2|1\/\(/],
  // Numerical methods
  ['newton(x^2-2, x, 1)', /1\.41/],
  // Arithmetic fast path
  ['2+3*sin(pi/4)', /4\.12|√2/],
];

describe('every advertised capability answers through compute', () => {
  it.each(CAPABILITIES)('%s', async (problem, expected) => {
    const r = await computeHandler({ problem });
    expect(r.isError, `${problem} errored: ${text(r)}`).toBe(false);
    expect(text(r), problem).toMatch(expected);
  });

  it('no capability crashes on a contract mismatch', async () => {
    // The signature of this defect class: the handler dereferences a field the
    // extractor never emitted. It is worth asserting separately from the value
    // checks above, because a crash is what an extractor rename produces.
    const crashes: string[] = [];
    for (const [problem] of CAPABILITIES) {
      const out = text(await computeHandler({ problem }));
      if (/Cannot read properties|is not a function|undefined is not/.test(out)) {
        crashes.push(`${problem} -> ${out.slice(0, 60)}`);
      }
    }
    expect(crashes).toEqual([]);
  });
});

describe('hypothesis tests reach a real verdict', () => {
  // `significance` was declared required on the handler's data type and
  // supplied by nobody, so every comparison was `p < undefined` — false — and
  // every test reported "Fail to reject H₀" regardless of the p-value. A stats
  // tool that can never reject the null is worse than one that errors.
  it('rejects when p < alpha', async () => {
    // [1,2,3,4,5] against mu0=5: t = -2.828, df = 4, p = 0.0474 < 0.05.
    const out = text(await computeHandler({ problem: 't_test(mu0=5, data=[1,2,3,4,5])' }));
    expect(out).toContain('Reject H₀');
    expect(out).toMatch(/α = 0\.05/);
    expect(out).not.toContain('undefined');
  });

  it('fails to reject when p >= alpha', async () => {
    // mu0 equal to the sample mean: p = 1.
    const out = text(await computeHandler({ problem: 't_test(mu0=3, data=[1,2,3,4,5])' }));
    expect(out).toContain('Fail to reject H₀');
  });

  it('honours a caller-supplied alpha', async () => {
    // Same p = 0.0474, but α = 0.01 flips the verdict the other way.
    const out = text(
      await computeHandler({ problem: 't_test(mu0=5, data=[1,2,3,4,5], alpha=0.01)' })
    );
    expect(out).toContain('Fail to reject H₀');
    expect(out).toMatch(/α = 0\.01/);
  });
});
