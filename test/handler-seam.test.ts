import { describe, it, expect, beforeAll } from 'vitest';
import { giacEngine } from '../src/server/giac/index.js';
import { computeHandler } from '../src/server/tools/compute/index.js';

beforeAll(async () => {
  await giacEngine.initialize();
}, 60000);

const text = (r: { content: { text: string }[] }): string =>
  r.content.map((c) => c.text).join('\n');

/**
 * The response with the `Command:` line removed.
 *
 * That line echoes the input verbatim, so an unanchored regex over the full
 * text can be satisfied by the problem string instead of the answer:
 * `/\b1\b/` for eigenvals matched the "1" in the echoed matrix rather than an
 * eigenvalue. Assertions below are also anchored with /m so they cannot match
 * prose that quotes the input ("Prime factorization of 2310: ...").
 */
const answer = (r: { content: { text: string }[] }): string =>
  text(r)
    .split('\n')
    .filter((l) => !l.startsWith('Command: '))
    .join('\n');

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
  // Solving — the two most-used verbs had no row at all
  ['solve(x^2-4=0)', /^Result: \{-2, 2\}$/m],
  ['solve_system(x+y=3, x-y=1)', /^Result: \(2, 1\)$/m],
  ['solve_system([x+y=3, x-y=1], [x, y])', /^Result: \(2, 1\)$/m],
  ['solve_system(x+y=3; x-y=1)', /^Result: \(2, 1\)$/m],
  // Calculus
  ['diff(x^3, x)', /^Result: 3\*x\^2$/m],
  ['int(x^2, x, 0, 1)', /^Result: 1\/3$/m],
  ['limit(sin(x)/x, x, 0)', /^Result: 1$/m],
  ['taylor(exp(x), x=0, 5)', /x\^2/],
  ["desolve(y'=x, y)", /x\*y|y\^2|c_0/],
  // Algebra
  ['factor(x^2-4)', /^Result: \(x-2\)\*\(x\+2\)$/m],
  ['simplify((x^2-1)/(x-1))', /^Result: x\+1$/m],
  ['expand((x+1)^3)', /x\^3/],
  ['partfrac(1/(x^2-1))', /x-1|x\+1/],
  // Linear algebra
  ['det([[1,2],[3,4]])', /^Result: -2$/m],
  ['inv([[1,2],[3,4]])', /^Result: \[\[-2,1\],\[3\/2,-1\/2\]\]$/m],
  ['eigenvals([[2,1],[1,2]])', /^Result: 3,1$/m],
  // Number theory
  ['ifactor(2310)', /^Result: 2\*3\*5\*7\*11$/m],
  ['analyze(28)', /Divisor sum: 56/],
  // Combinatorics
  ['C(10,3)', /^Result: 120$/m],
  ['multinomial(5, [2,2,1])', /^Result: 30$/m],
  // Probability / statistics
  ['normal(mu=0, sigma=1, x=1)', /Normal|0\.24/],
  ['t_test(mu0=5, data=[1,2,3,4,5])', /^t-statistic = -2\.828427$/m],
  ['two_sample_t([1,2,3],[4,5,6])', /^t-statistic = -3\.674235$/m],
  ['paired_t([10,12,14],[12,15,16])', /^t-statistic = -7\.000000$/m],
  ['anova([1,2,3],[4,5,6],[7,8,9])', /^F = 27\.000000$/m],
  ['chi_square_test([[10,20],[30,40]])', /^χ² = 0\.793651$/m],
  // `_test`-suffixed aliases fell through to the raw CAS, which returned the
  // input as its own answer with isError:false.
  ['two_sample_t_test([1,2,3],[4,5,6])', /^t-statistic = -3\.674235$/m],
  ['paired_t_test([10,12,14],[12,15,16])', /^t-statistic = -7\.000000$/m],
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
  ['area_triangle(base=4, height=3)', /^Result: 6$/m],
  ['distance([0,0],[3,4])', /^Result: 5$/m],
  // A polygon given as one bracketed list arrived double-nested — read as a
  // single vertex, so a four-vertex call was "fewer than 3 vertices".
  ['area_polygon([[0,0],[4,0],[4,3],[0,3]])', /^Result: 12$/m],
  ['area_polygon([0,0],[4,0],[4,3],[0,3])', /^Result: 12$/m],
  ['area_polygon(vertices=[[0,0],[4,0],[4,3],[0,3]])', /^Result: 12$/m],
  ['perimeter_polygon([[0,0],[4,0],[4,3],[0,3]])', /^Result: 14$/m],
  // Nothing ever set `line1`: |3·0 + 4·0 − 5| / 5 = 1.
  ['point_line_distance([0,0],[3,4,-5])', /^Result: 1$/m],
  ['point_line_distance([0,0], 3, 4, -5)', /^Result: 1$/m],
  // 3D geometry
  ['distance3d([0,0,0],[1,1,1])', /1\.73/],
  ['volume_sphere(2)', /33\.5|Volume/],
  // Multivariable
  ['gradient(x*y, [x,y])', /^Result: \[y,x\]$/m],
  ['critical_points(x^2+y^2, [x,y])', /minimum/],
  ['lagrange(x*y, x+y, 1, [x, y])', /^Result: \(1\/2, 1\/2\): f = 1\/4$/m],
  // Transforms — every field name missed; crashed on all input
  ['fft([1,2,3,4])', /n = 4 samples/],
  ['ifft([1,0,1,0])', /Reconstructed/],
  ['laplace(exp(-2*t),t,s)', /^Result: 1\/\(s\+2\)$/m],
  // Numerical methods
  ['newton(x^2-2, x, 1)', /^Root: x = 1\.41421356/m],
  // bisection and secant need a bracket; the extractor only emitted
  // `initial_guess`, and took the bracket's lower bound as the variable name.
  ['bisection(x^2-2, 1, 2)', /^Root: x = 1\.41421356/m],
  ['bisection(x^2-2, x, 1, 2)', /^Root: x = 1\.41421356/m],
  ['secant(x^2-2, 1, 2)', /^Root: x = 1\.41421356/m],
  ['secant(x^2-2, x, 1, 2)', /^Root: x = 1\.41421356/m],
  // Arithmetic fast path
  ['2+3*sin(pi/4)', /4\.12|√2/],
];

/**
 * `paired_t` is a one-sample test on the differences — correct arithmetic, but
 * it reported `Test: One-sample t-test / H₀: μ = 0`, telling a user who asked
 * for a paired test that a different test had run.
 */
describe('each test reports the test that actually ran', () => {
  it.each([
    ['t_test(mu0=5, data=[1,2,3,4,5])', 'One-sample t-test'],
    ['two_sample_t([1,2,3],[4,5,6])', "Two-sample Welch's t-test"],
    ['paired_t([10,12,14],[12,15,16])', 'Paired t-test'],
    ['anova([1,2,3],[4,5,6],[7,8,9])', 'One-way ANOVA'],
    ['chi_square_test([[10,20],[30,40]])', 'Chi-square test of independence'],
  ])('%s reports %s', async (problem, name) => {
    const out = text(await computeHandler({ problem }));
    expect(out).toContain(`Test: ${name}`);
  });

  it('a paired test states its hypothesis about the mean difference', async () => {
    const out = text(await computeHandler({ problem: 'paired_t([10,12,14],[12,15,16])' }));
    expect(out).toContain('H₀: μ_d = 0');
  });
});

describe('every advertised capability answers through compute', () => {
  it.each(CAPABILITIES)('%s', async (problem, expected) => {
    const r = await computeHandler({ problem });
    expect(r.isError, `${problem} errored: ${text(r)}`).toBe(false);

    // isError is not enough on its own: hypothesis-testing returns validation
    // failures as ordinary output lines, so a seam mismatch there surfaces as
    // isError:false with an `Error:` body. This is the dominant failure
    // signature in this codebase, not a thrown TypeError.
    expect(text(r), problem).not.toMatch(/(^|: )Error:/m);

    // Match the answer, not the whole response. The `Command:` line echoes the
    // input, so an unanchored regex can be satisfied by the problem string —
    // `/\b1\b/` for eigenvals matched the "1" in the echoed matrix, and
    // `/2|3|5|7|11/` for ifactor matched the "2" in "2310".
    expect(answer(r), `${problem} -> ${text(r)}`).toMatch(expected);
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
    expect(out).toMatch(/✗ Reject H₀ \(p = 0\.0474 < α = 0\.05\)/);
    expect(out).toMatch(/^p-value = 0\.047421$/m);
    expect(out).not.toContain('undefined');
  });

  it('fails to reject when p >= alpha', async () => {
    // mu0 equal to the sample mean: p = 1.
    const out = text(await computeHandler({ problem: 't_test(mu0=3, data=[1,2,3,4,5])' }));
    // The verdict alone is not falsifiable here: the bug made *every* test say
    // "Fail to reject". Pin the comparison the verdict claims to have made.
    expect(out).toMatch(/Fail to reject H₀ \(p = 1\.0000 ≥ α = 0\.05\)/);
    expect(out).toMatch(/^p-value = 1\.000000$/m);
  });

  it('honours a caller-supplied alpha', async () => {
    // Same p = 0.0474, but α = 0.01 flips the verdict the other way.
    const out = text(
      await computeHandler({ problem: 't_test(mu0=5, data=[1,2,3,4,5], alpha=0.01)' })
    );
    // Same p as the rejecting case above — only α differs, so this pins that
    // the caller's α reached the comparison rather than the 0.05 default.
    expect(out).toMatch(/Fail to reject H₀ \(p = 0\.0474 ≥ α = 0\.01\)/);
    expect(out).toMatch(/^p-value = 0\.047421$/m);
  });
});

describe('ANOVA reports a real p-value', () => {
  // Giac returns the unevaluated symbolic `Beta(1,3,9/10,1)` for
  // `fisher_cdf(2,6,27)` when F is an INTEGER, so parseFloat gave NaN and the
  // fallback — `F > 10 ? 0 : NaN` — asserted p = 0. Any ANOVA whose F landed on
  // a whole number reported certainty it had not computed.
  it('computes p from the F distribution rather than a threshold guess', async () => {
    // F = 27 exactly, df = (2,6). Reference p = 0.00101.
    const out = text(await computeHandler({ problem: 'anova([[1,2,3],[4,5,6],[7,8,9]])' }));
    expect(out).toMatch(/F = 27\.000000/);
    expect(out).not.toMatch(/p-value = 0\.000000/);
    expect(out).toMatch(/p-value = 0\.001/);
    expect(out).toContain('Reject H₀');
  });

  it('fails to reject when the groups barely differ', async () => {
    // The direction the old fallback could never produce for a large F, and the
    // control that the fix did not simply invert the comparison.
    const out = text(
      await computeHandler({ problem: 'anova([[1,2,3],[1.1,2.1,3.1],[0.9,1.9,2.9]])' })
    );
    expect(out).toContain('Fail to reject H₀');
    expect(out).toMatch(/p-value = 0\.9/);
  });
});
