import { describe, it, expect, beforeAll } from 'vitest';
import { giacEngine } from '../src/server/giac/index.js';
import { computeHandler } from '../src/server/tools/compute/index.js';
import { detectFailure } from '../src/server/tools/compute/silent-failure.js';
import { exactValueHandler } from '../src/server/tools/exact-value.js';

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
  ['taylor(exp(x), x=0, 5)', /^Result: 1\+x\+1\/2\*x\^2\+1\/6\*x\^3\+1\/24\*x\^4\+1\/120\*x\^5$/m],
  ["desolve(y'=x, y)", /^Result: \(2\*c_0\+x\^2\)\/2$/m],
  // Algebra
  ['factor(x^2-4)', /^Result: \(x-2\)\*\(x\+2\)$/m],
  ['simplify((x^2-1)/(x-1))', /^Result: x\+1$/m],
  ['expand((x+1)^3)', /^Result: x\^3\+3\*x\^2\+3\*x\+1$/m],
  ['partfrac(1/(x^2-1))', /^Result: 1\/2\/\(x-1\)-1\/2\/\(x\+1\)$/m],
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
  ['normal(mu=0, sigma=1, x=1)', /^Result: 0\.24197072451/m],
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
  ['to_exact(0.5)', /^Result: 1\/2$/m],
  ['to_decimal(1/3)', /^Result: 0\.3333333333333333$/m],
  ['simplify_fraction(4/8)', /^Result: 1\/2$/m],
  // Regression — extractor emitted a bare array, handler read x/y
  ['linear_regression([[1,2],[2,4],[3,6]])', /^Equation: ŷ = 2\.00000x$/m],
  ['polynomial_regression([[1,2],[2,5],[3,10]], 2)', /^Equation: ŷ = x\^2 \+ 1\.00000$/m],
  // Sequences
  ['sequence(2,4,6,8)', /^Next 3 terms: 10, 12, 14$/m],
  // Geometry — named arguments landed in a `raw` field nobody read
  ['area_circle(radius=2)', /^Result: 12\.5663706144$/m],
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
  ['distance3d([0,0,0],[1,1,1])', /^Result: 1\.7320508076$/m],
  ['volume_sphere(2)', /^Result: 33\.5103216383$/m],
  // Multivariable
  ['gradient(x*y, [x,y])', /^Result: \[y,x\]$/m],
  ['critical_points(x^2+y^2, [x,y])', /^Result: \(0, 0\): local minimum \[D=4, f_xx=2\]$/m],
  ['lagrange(x*y, x+y, 1, [x, y])', /^Result: \(1\/2, 1\/2\): f = 1\/4$/m],
  // Transforms — every field name missed; crashed on all input
  ['fft([1,2,3,4])', /^\s+\[1\] f=0\.2500\s+-2\.000000 \+2\.000000i$/m],
  ['ifft([1,0,1,0])', /^\s+\[0\]\s+0\.50000000$/m],
  ['laplace(exp(-2*t),t,s)', /^Result: 1\/\(s\+2\)$/m],
  // Numerical methods
  ['newton(x^2-2, x, 1)', /^Result: x = 1\.41421356/m],
  // bisection and secant need a bracket; the extractor only emitted
  // `initial_guess`, and took the bracket's lower bound as the variable name.
  ['bisection(x^2-2, 1, 2)', /^Result: x = 1\.41421356/m],
  ['bisection(x^2-2, x, 1, 2)', /^Result: x = 1\.41421356/m],
  ['secant(x^2-2, 1, 2)', /^Result: x = 1\.41421356/m],
  ['secant(x^2-2, x, 1, 2)', /^Result: x = 1\.41421356/m],
  // Giac's Beta function is capital-B; the lowercase spelling is the
  // distribution, and a positional call must say what it needs rather than
  // coming back as its own answer.
  ['Beta(2,3)', /^Result: 1\/12$/m],
  // Arithmetic fast path
  ['2+3*sin(pi/4)', /^Result: 2\+3\*√2\/2$/m],
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
    // `/(^|: )Error:/m` missed " Error:" with a leading space, which is how a
    // GIAC_ERROR reply reads.
    expect(text(r), problem).not.toMatch(/Error:|GIAC_ERROR/i);

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

describe('spellings the router has to tell apart', () => {
  // hasKeyword treats a trailing underscore as a boundary so `bell` reaches
  // `bell_number`. The leading side must still block, or an unrelated verb
  // ending in a known keyword would be claimed.
  it.each(['my_bell(5)', 'sub_partitions(5)'])('does not claim %s', async (problem) => {
    const r = await computeHandler({ problem });
    // Either an honest error or the raw CAS — the one thing it must not be is a
    // combinatorics answer computed for a verb nobody published.
    expect(text(r)).not.toMatch(/Bell number|partitions of/);
  });

  // The three-argument ODE branch had no test in either direction: the only
  // fixtures were two-argument, where the branch never runs.
  it.each([
    ["desolve(y'=x, y)", /^Result: \(2\*c_0\+x\^2\)\/2$/m],
    ["desolve(y'=x, x)", /^Result: \(2\*c_0\+x\^2\)\/2$/m],
    ["desolve(y'=x, x, y)", /^Result: \(2\*c_0\+x\^2\)\/2$/m],
    // The spelling prompts/index.ts tells callers to write, minus its last
    // argument — read as the function, it answered `[1/2]`.
    ["desolve(y'=2*x, x)", /^Result: c_0\+x\^2$/m],
    ["desolve(y'=2*x, y)", /^Result: c_0\+x\^2$/m],
  ])('%s resolves variable and function correctly', async (problem, expected) => {
    const r = await computeHandler({ problem });
    expect(r.isError, text(r)).toBe(false);
    expect(text(r)).toMatch(expected);
  });

  // A condition written as its own argument was filtered out with everything
  // that was not a bare identifier, so the general solution shipped as the
  // answer to an IVP with isError:false. `desolve(y'=y, y(0)=1)` answered
  // `c_0*exp(x)`; the answer is exp(x). The whole suite passed before this fix,
  // which is why the rows below assert the ABSENCE of the constant rather than
  // just a successful call — a general solution matches "contains exp(x)" too.
  it.each([
    ["desolve(y'=y, y(0)=1)", /^Result: exp\(x\)$/m],
    ["desolve(y'=y, y(0)=1, x, y)", /^Result: exp\(x\)$/m],
    ["odesolve(y'=y, y(0)=1)", /^Result: exp\(x\)$/m],
    ["desolve(y'=2*x, y(0)=5, x, y)", /^Result: 5\+x\^2$/m],
    // Second order, and the derivative condition `y'(0)=0` is why this shape
    // needs its own regex rather than the system path's CONDITION_FORM.
    ["desolve(y''=-y, y(0)=1, y'(0)=0, x, y)", /^Result: cos\(x\)$/m],
    ["desolve(y''+y=0, y(0)=1, y'(0)=0, x, y)", /^Result: cos\(x\)$/m],
    // A condition at a point other than 0.
    ["desolve(y'=y+1, y(2)=3, x, y)", /^Result: 4\/exp\(2\)\*exp\(x\)-1$/m],
  ])('%s applies the condition instead of dropping it', async (problem, expected) => {
    const r = await computeHandler({ problem });
    expect(r.isError, text(r)).toBe(false);
    expect(text(r)).toMatch(expected);
    // No arbitrary constant survives a fully determined IVP.
    expect(text(r)).not.toMatch(/c_0/);
  });

  it('still answers the general solution when no condition is given', async () => {
    // The other direction of the same change: folding must not invent a
    // condition where the caller gave none.
    const r = await computeHandler({ problem: "desolve(y'=y, x, y)" });
    expect(r.isError, text(r)).toBe(false);
    expect(text(r)).toMatch(/^Result: c_0\*exp\(x\)$/m);
  });

  it('folds conditions into a bracketed system instead of appending after it', async () => {
    // calculus.ts decides "is this a system" by handing `equation` to
    // parseOdeSystem, and `[y'=z, z'=-y] and y(0)=1` does not parse as one. The
    // first version of the fold appended, which pushed the request off the
    // Y' = A*Y + b path entirely — no matrix rewrite, no components note, and no
    // `[]` guard, because that guard runs only when `functions` came back. It
    // answered `[]` with isError:false, which is worse than the bug being fixed.
    const r = await computeHandler({ problem: "desolve([y'=z, z'=-y], y(0)=1, z(0)=0, x)" });
    expect(r.isError, text(r)).toBe(false);
    expect(text(r)).toMatch(/^Result: \[\[cos\(x\),-sin\(x\)\]\]$/m);
    // Same answer as writing the conditions inside the brackets, which is the
    // spelling this now builds.
    const bracketed = await computeHandler({
      problem: "desolve([y'=z, z'=-y, y(0)=1, z(0)=0], x)",
    });
    expect(text(bracketed)).toMatch(/^Result: \[\[cos\(x\),-sin\(x\)\]\]$/m);
    // The system path really was taken: this note only exists on it.
    expect(text(r)).toMatch(/Components are in the order: y, z/);
  });

  it.each([
    ["desolve(y'=y, y(x))", /^Result: c_0\*exp\(x\)$/m],
    ["desolve(y'=y, x, y(x))", /^Result: c_0\*exp\(x\)$/m],
    ["desolve(y'=y, y(0)=1, x, y(x))", /^Result: exp\(x\)$/m],
  ])('accepts the applied-function spelling %s', async (problem, expected) => {
    // `y(x)` is the canonical unknown-function spelling in the dialects whose
    // verbs this router advertises, and it worked on main by accident: the old
    // filter dropped it and inference recovered the same name from the equation.
    // Classifying it as unrecognised turned a correct answer into a refusal.
    //
    // These rows pin the refusal only: for `y'=y`, recognising `y(x)` and silently
    // dropping it both give this answer, because inference reaches the same name
    // either way. An earlier version of this comment concluded from that that no
    // input worth a row separates the two — false, and it is why the regression in
    // the `diff(y(x),x)` rows below shipped. That spelling separates them with
    // opposite outcomes.
    const r = await computeHandler({ problem });
    expect(r.isError, text(r)).toBe(false);
    expect(text(r)).toMatch(expected);
  });

  it.each([
    ['desolve(diff(y(x),x)=y(x), y(x))', /^Result: c_0\*exp\(x\)$/m],
    ['dsolve(diff(y(x),x)=y(x), y(x))', /^Result: c_0\*exp\(x\)$/m],
    ['desolve(diff(y(t),t)=y(t), y(t))', /^Result: c_0\*exp\(t\)$/m],
    ['desolve(diff(y(x),x)=2*x, y(x))', /^Result: c_0\+x\^2$/m],
  ])('%s names the function, not the variable', async (problem, expected) => {
    // differentiatedName knows `y'` and `dy/dx` only, so for the `diff(y(x),x)`
    // spelling it finds nothing. Recognising `y(x)` and then asking the equation
    // which role it plays therefore read `y` as the independent VARIABLE, built
    // `desolve(...,y,y)`, and Giac answered `[]` — which the new empty-result
    // guard then reported as an unsatisfiable IVP, on a call with no conditions.
    // An applied argument names the function by construction; that is carried
    // rather than re-derived.
    const r = await computeHandler({ problem });
    expect(r.isError, text(r)).toBe(false);
    expect(text(r)).toMatch(expected);
  });

  it.each([
    ["desolve([y'=z, z'=-y], t, [y,z])", /^Result: \[\[c_0\*cos\(t\)/m],
    ["desolve([y'=z, z'=-y], x, y, z)", /^Result: \[\[c_0\*cos\(x\)/m],
    ["desolve([y'=z, z'=-y], x, [y(x),z(x)])", /^Result: \[\[c_0\*cos\(x\)/m],
    ["desolve([y'=z, z'=-y, y(0)=1, z(0)=0], t, [y,z])", /^Result: \[\[cos\(t\),-sin\(t\)\]\]$/m],
  ])('%s may name its unknowns', async (problem, expected) => {
    // A SYSTEM ignores function_name entirely — parseOdeSystem derives the
    // function list from the equations — so naming the unknowns is redundant, not
    // wrong, and prompts/index.ts steers callers at exactly this spelling. The
    // strict single-equation rule refused four calls that main answered AND
    // self-verified — the four rows here.
    const r = await computeHandler({ problem });
    expect(r.isError, text(r)).toBe(false);
    expect(text(r)).toMatch(expected);
  });

  it.each([
    ["desolve([y'=z, z'=-y], x, z(x))", /^Result: \[\[c_0\*cos\(x\)/m],
    ["desolve([y'=z, z'=-y], t, z(t))", /^Result: \[\[c_0\*cos\(t\)/m],
    ["desolve([y'=z, z'=-y], x, y(x), z(x))", /^Result: \[\[c_0\*cos\(x\)/m],
  ])('%s may name a non-first unknown applied', async (problem, expected) => {
    // differentiatedName returns only the FIRST differentiated name, so comparing
    // an applied argument against it made every unknown but `y` look like a
    // contradiction: `x, y(x)` was accepted and `x, z(x)` refused for the same
    // system, which no caller can predict. Membership in the system's own
    // function list is the test.
    const r = await computeHandler({ problem });
    expect(r.isError, text(r)).toBe(false);
    expect(text(r)).toMatch(expected);
  });

  it('refuses an applied name that is not an unknown of the system', async () => {
    const r = await computeHandler({ problem: "desolve([y'=z, z'=-y], x, q(x))" });
    expect(r.isError, text(r)).toBe(true);
    expect(text(r)).toMatch(/does not understand the argument "q\(x\)"/);
  });

  it.each([["desolve([y'=y, y(0)=1], x, y, zzz)"], ["desolve([y'=y], x, y, zzz)"]])(
    '%s refuses the surplus argument even though it is bracketed',
    async (problem) => {
      // Brackets are not a system. parseOdeSystem needs two derivative members —
      // `[y'=2*x, y(0)=1]` is a single equation, its docblock says so — so keying
      // the trailing-argument rules off the punctuation gave these the system's
      // permissiveness with the single-equation path's consequences: `zzz` was
      // dropped and the answer shipped, while the unbracketed same request was
      // refused and pinned by a row above.
      const r = await computeHandler({ problem });
      expect(r.isError, text(r)).toBe(true);
      expect(text(r)).toMatch(/does not understand the argument "zzz"/);
    }
  );

  it.each([["desolve(y'=y, [y])"], ["desolve(y'=y, y(0)=1, [y])"]])(
    '%s accepts an unknowns list on a single equation',
    async (problem) => {
      // Recognising the list only for systems made `desolve(y'=y, [y])` a refusal
      // while `desolve([y'=y], [y])` was accepted — same mathematics, opposite
      // outcomes decided by whether the caller bracketed the equation.
      const r = await computeHandler({ problem });
      expect(r.isError, text(r)).toBe(false);
      expect(text(r)).toMatch(/exp\(x\)/);
    }
  );

  it.each([
    ["desolve([y'=y], y(0)=1, x, y)", /Command: desolve\(\(y'=y\) and \(y\(0\)=1\)/],
    ["desolve((y'=z, z'=-y), y(0)=1, z(0)=0, x)", /Command: desolve\(\[Y'=/],
  ])('%s folds onto the members, not the outer punctuation', async (problem, expectedCommand) => {
    // stripEnclosingBrackets peels `(` and `[` alike and repeatedly, so the member
    // list parseOdeSystem reads is not always the one the outer punctuation names.
    // Keying the fold off `startsWith('[')` appended ` and …` after
    // `(y'=z, z'=-y)` — a real system — and inserted inside the outer bracket of
    // `[[y'=z, z'=-y]]`, a level above the members. Both then parsed as
    // non-systems downstream and were refused, where main answered them verified.
    //
    // A single-member list is a lone equation, so it takes the `and` form. The
    // reason a real list must stay a list is parseOdeSystem, not Giac: it only
    // reads conditions that are members, so an `and`-appended system parses as no
    // system. Giac itself accepts either spelling — two earlier versions of this
    // comment claimed a CAS constraint here and both measured false.
    const r = await computeHandler({ problem });
    expect(r.isError, text(r)).toBe(false);
    expect(text(r)).toMatch(expectedCommand);
  });

  it.each([
    ["desolve((y'=z, z'=-y), y(0)=1, z(0)=0, x)"],
    ["desolve((y'=z, z'=-y), x, y(0)=1, z(0)=0)"],
    ["desolve(((y'=z, z'=-y)), y(0)=1, z(0)=0, x)"],
    ["desolve([[y'=z, z'=-y]], y(0)=1, z(0)=0, x)"],
  ])('%s reaches the system path despite its wrapping', async (problem) => {
    const r = await computeHandler({ problem });
    expect(r.isError, text(r)).toBe(false);
    expect(text(r)).toMatch(/^Result: \[\[cos\(x\),-sin\(x\)\]\]$/m);
  });

  it.each([
    ["desolve(y'=y, y(x)=5)"],
    ["desolve(y''=-y, y'(x)=0)"],
    ["desolve(y'=2*x, y'(x)=y(x))"],
    ["desolve(y'=y, z'(x)=-y(x))"],
    ['desolve(diff(y(t),t)=y(t), y(t)=5, t, y)'],
    // The point does not have to BE the variable — it only has to mention it.
    // Testing equality closed the reported input and nothing else: `y(x+0)=5` is
    // the same request one character longer and answered `5/exp(x)*exp(x)` with
    // residual -5, as did `y(2*x)`, `y(x-1)`, `y(x/2)`, `y(-x)` and `y(x^2)` — 41
    // measured calls that a round specifically looking for this family still
    // shipped.
    ["desolve(y'=y, y(x+0)=5)"],
    ["desolve(y'=y, y(2*x)=5)"],
    ["desolve(y'=y, y(x-1)=5)"],
    ["desolve(y'=y, y(x/2)=5)"],
    ["desolve(y'=2*x, y(-x)=5)"],
    ["desolve(y'=y*x, y(x^2)=5)"],
    ["desolve(y'=y, y((x))=5)"],
    // The VALUE field, found one probe into a residual audit after two rounds of
    // widening the POINT check. `y(0)=x^2` answered `x^2*exp(x)` with residual
    // 2*x*exp(x) — 55 of 60 calls, and worse than main, which dropped the
    // condition and returned a correct general solution. Giac reads a folded
    // condition mentioning the integration variable ANYWHERE as a second equation.
    ["desolve(y'=y, y(0)=x^2, x, y)"],
    ["desolve(y'=y, y(0)=x, x, y)"],
    ["desolve(y'=y, y(0)=1+x^2, x, y)"],
    ["desolve(y'=2*x, y(0)=x^2, x, y)"],
    ["desolve(y'=y*x, y(0)=x^2, x, y)"],
    ["desolve(y''=-y, y(0)=0, y'(0)=x^2, x, y)"],
    ['desolve(diff(y(t),t)=y(t), y(0)=t^2, t, y)'],
  ])('%s is refused, not answered with a non-solution', async (problem) => {
    // The condition shape's point group matches the independent VARIABLE as
    // happily as a number, so these were folded in as conditions — and Giac reads
    // them as equations. `desolve(y'=y, y(x)=5)` answered `5/exp(x)*exp(x)`, whose
    // residual in the caller's own equation is -5, with isError:false. 25 measured
    // calls shipped a non-solution that way.
    //
    // Neither isDerivativeEquation nor the invariant it replaced could catch this:
    // parseOdeSystem also calls `y'(x)=0` a condition, so the extractor and the
    // parser agree and are both wrong about what Giac will do. The test has to be
    // about the caller's variable, which is why it runs after inference.
    const r = await computeHandler({ problem });
    expect(r.isError, text(r)).toBe(true);
    expect(text(r)).toMatch(/does not understand the argument/);
  });

  it.each([
    ["desolve(y''+y=0, y(pi)=0, x, y)", /c_1\*sin\(x\)/],
    ["desolve(y''+y=0, y(L)=0, x, y)", /tan\(L\/2\)/],
    ["desolve(y'=y, y(a)=1, x, y)", /exp\(a\)/],
    // Word-bounded, so a name that merely CONTAINS the variable is still a point.
    ["desolve(y'=y, y(x_0)=5, x, y)", /exp\(x_0\)/],
    ["desolve(y'=y, y(x0)=5, x, y)", /exp\(x0\)/],
    ["desolve(y'=y, y(X)=5, x, y)", /exp\(X\)/],
    ["desolve(y'=y, y(xx)=5, x, y)", /exp\(xx\)/],
    // A VALUE that does not mention the variable is still a value.
    ["desolve(y'=y, y(0)=a, x, y)", /a\*exp\(x\)/],
    ["desolve(y'=y, y(0)=L^2, x, y)", /L\^2\*exp\(x\)/],
  ])('%s keeps working — a symbolic endpoint is still a point', async (problem, expected) => {
    const r = await computeHandler({ problem });
    expect(r.isError, text(r)).toBe(false);
    expect(text(r)).toMatch(expected);
  });

  it.each([
    ["desolve(y''=-y, y(pi/2)=1, y'(0)=0)"],
    ["desolve(y''+y=0, y(pi/2)=2, y'(0)=0)"],
    ["desolve(y''=-4*y, y(pi/4)=1, y'(0)=0)"],
  ])('%s refuses rather than shipping infinity as the answer', async (problem) => {
    // Ordinary-looking BVPs that are in fact unsatisfiable — y'(0)=0 forces the
    // sine term out and cos vanishes at the stated endpoint — so Giac answers
    // `infinity`. detectFailure matches capitalised `Inf` and deliberately lets
    // lowercase `infinity` through, because integrate legitimately diverges. The
    // solution-vector guard has had this arm all along; the single-equation path
    // did not, and it became reachable when conditions written as separate
    // arguments stopped being dropped.
    const r = await computeHandler({ problem });
    expect(r.isError, text(r)).toBe(true);
    expect(text(r)).not.toMatch(/^Result: infinity$/m);
  });

  it.each([
    ["desolve(y''=-y, y(pi/4)=1, y'(0)=0)", /cos\(x\)/],
    ["desolve(y''=-y, y(0)=0, y(pi)=0, x, y)", /c_1\*sin\(x\)/],
  ])('%s still answers — the infinity guard is not a BVP ban', async (problem, expected) => {
    const r = await computeHandler({ problem });
    expect(r.isError, text(r)).toBe(false);
    expect(text(r)).toMatch(expected);
  });

  it.each([
    ["desolve(y'=y and(y(0)=1), x, y)", /^Result: exp\(x\)$/m],
    ["desolve((y'=y)and(y(0)=1), x, y)", /^Result: exp\(x\)$/m],
    ["desolve(y''=-y and(y(0)=1) and (y'(0)=0), x, y)", /^Result: cos\(x\)$/m],
    // `&&` and `AND` are Giac's too, and it answers all three identically.
    ["desolve(y'=y && y(0)=1, x, y)", /^Result: exp\(x\)$/m],
    ["desolve(y'=y AND y(0)=1, x, y)", /^Result: exp\(x\)$/m],
    ["desolve(y'=y ∧ y(0)=1, x, y)", /^Result: exp\(x\)$/m],
    // UNSPACED. `&&` and `∧` are operators and need no separator — the spaced rows
    // above are green either way and prove nothing about the operator path.
    ["desolve(y'=y&&y(0)=1, x, y)", /^Result: exp\(x\)$/m],
    ["desolve(y'=y∧y(0)=1, x, y)", /^Result: exp\(x\)$/m],
    // The word form still needs its boundary, or `and` matches inside an identifier.
    ["desolve(y'=command_k*y, x, y)", /command_k/],
  ])('%s is answered, not accused by the residual check', async (problem, expected) => {
    // Giac's own IVP syntax without a space. The residual check cuts the equation
    // at the first top-level `and` before substituting, and its detector required
    // whitespace BEFORE the token — so `and(` was missed, the condition stayed in
    // the equation, and a correct answer was refused as not satisfying it. A
    // verifier that can manufacture a disproof is worse than none, and this pins
    // the direction that matters.
    const r = await computeHandler({ problem });
    expect(r.isError, text(r)).toBe(false);
    expect(text(r)).toMatch(expected);
  });

  it.each([
    ["desolve(y'=y and y(x)=5, x, y)"],
    ["desolve([y'=y, y(x)=5], x, y)"],
    ["desolve(y'=y and y(0)=x^2, x, y)"],
    ["desolve([y'=y, y(0)=x^2], x, y)"],
    // The bare spelling looksLikeOde accepts, with no verb at all. It reached the
    // handler without `original_equation`, so the check was inert on it and the
    // same non-solutions shipped that `desolve(...)` refused.
    ["y'=y and y(x)=5"],
    ["y'=y and y(0)=x^2"],
    // Certified as correct before the join spellings were widened — the check
    // affirming the family it exists to refuse.
    ["desolve(y'=y && y(x)=5, x, y)"],
    ["desolve(y'=y AND y(x)=5, x, y)"],
    // The join the previous round's widening missed. It shipped 5/exp(x)*exp(x) at
    // isError:false — a non-solution — while the verifier correctly declined rather
    // than certifying, which is the difference the one-bare-equation invariant made.
    ["desolve(y'=y ∧ y(x)=5, x, y)"],
    ["desolve(y'=y ∧ y(0)=x^2, x, y)"],
    // The whole family, unspaced. 26 of 26 measured results shipped a non-solution
    // at isError:false, separated from a refusal by one space character.
    ["desolve(y'=y&&y(x)=5, x, y)"],
    ["desolve(y'=y&& y(x)=5, x, y)"],
    ["desolve(y'=y&&y(0)=x^2, x, y)"],
    ["desolve(y'=y&&&y(x)=5, x, y)"],
    ["desolve(y'=y∧y(x)=5, x, y)"],
    ["desolve(y''=-y&&y(x)=5, x, y)"],
    ["y'=y&&y(x)=5"],
  ])('%s is refused by the residual check', async (problem) => {
    // A condition written INSIDE the equation walks past the argument guard, which
    // only scans the trailing arguments. These are the families the residual check
    // exists for, and main answers every one of them with a non-solution.
    const r = await computeHandler({ problem });
    expect(r.isError, text(r)).toBe(true);
    expect(text(r)).toMatch(/does not satisfy/);
  });

  it.each([
    ["desolve(y'=sqrt(y), x, y)", /\(-1\/2\*c_0\+1\/2\*x\)\^2/],
    ["desolve(y'=y^(3/2), x, y)", /2\/\(c_0-x\)/],
    // The IVP form is the one that stung: the branch's own condition folding
    // produces the correct particular solution and the verifier then destroyed it.
    ["desolve(y'=sqrt(y), y(4)=1, x, y)", /\(-1\+1\/2\*x\)\^2/],
  ])(
    '%s is answered, not refuted for holding outside the probe point',
    async (problem, expected) => {
      // The residual of a branch solution is nonzero wherever the answer does not
      // claim to hold, and the numeric probe pins x while moving the constant — which
      // for a separable ODE through a square root moves the domain out from under it.
      // A verifier that can invent a disproof is worse than no verifier.
      const r = await computeHandler({ problem });
      expect(r.isError, text(r)).toBe(false);
      expect(text(r)).toMatch(expected);
    }
  );

  it('keeps the finite branches when one branch is infinity', async () => {
    // Scanning the whole printed result refused `2*y*y'=1` outright and threw away
    // the two correct +/-sqrt(x-c_1) branches with the one infinite one.
    const r = await computeHandler({ problem: "desolve(2*y*y'=1, x, y)" });
    expect(r.isError, text(r)).toBe(false);
    expect(text(r)).toMatch(/sqrt\(x-c_1\)|√\(x-c_1\)/);
  });

  it.each([
    ["desolve(y'=log(y), x, y)", /no solution for this equation/],
    ["desolve(y'=y, y(0)=1, y(1)=5, x, y)", /conditions cannot all be satisfied/],
  ])('%s diagnoses only what the caller wrote', async (problem, expected) => {
    // The IVP wording fired on every empty result, so a caller who supplied no
    // conditions at all was told theirs could not be satisfied.
    const r = await computeHandler({ problem });
    expect(r.isError, text(r)).toBe(true);
    expect(text(r)).toMatch(expected);
  });

  it.each([['derive'], ['deriver']])('refuses %s(z)=5 by name, like diff', async (operator) => {
    // derivativeOnRight already recorded that these are Giac's own aliases for
    // diff; isBareDiffCall listed only `diff`, so replacing the extractor's own
    // operator list with the shared predicate silently dropped them and 57
    // arguments went from a precise refusal to "your conditions cannot all be
    // satisfied". One list now.
    const r = await computeHandler({ problem: `desolve(y'=y, ${operator}(z)=5, x, y)` });
    expect(r.isError, text(r)).toBe(true);
    expect(text(r)).toMatch(/does not understand the argument/);
  });

  it.each([["desolve([y'=z, z'=-y], diff(w)=5, x)"], ["desolve([y'=y], diff(z)=5, x, y)"]])(
    '%s refuses an argument that would add an equation',
    async (problem) => {
      // The system direction is the one a systemhood-only check cannot see: adding
      // an equation to a system leaves it a system, so `[y'=z, z'=-y]` plus
      // `diff(w)=5` came back as a THREE-component answer for a two-equation
      // system. Comparing the equation SET catches both directions.
      const r = await computeHandler({ problem });
      expect(r.isError, text(r)).toBe(true);
      expect(text(r)).toMatch(/does not understand the argument "diff\(/);
    }
  );

  it.each([
    ['desolve(diff(y(x),x)=y(x), [q])'],
    ['desolve(diff(y(x),x)=y(x), [y,z,w])'],
    ['desolve(diff(y(x),x)=y(x), q(x))'],
  ])('%s applies the membership rule to the diff spelling too', async (problem) => {
    // The extractor had its own reader for "which function is differentiated"
    // that knew `y'` and `dy/dx` but not `diff(y(x),x)`, so for the spelling
    // prompts/index.ts advertises it returned undefined and every rule keyed on
    // it silently stopped applying: `desolve(y'=y, [q])` was refused while
    // `desolve(diff(y(x),x)=y(x), [q])` was accepted and the list dropped. Both
    // readers are now one, exported from ode-system-shape.ts.
    const r = await computeHandler({ problem });
    expect(r.isError, text(r)).toBe(true);
    expect(text(r)).toMatch(/does not understand the argument/);
  });

  it('refuses a condition-shaped argument that is really an equation', async () => {
    // `diff(z)=5` satisfies the condition shape and IS an equation. Folded in as a
    // member it turned `[y'=y]` into a two-equation system answering
    // [[c_0*exp(x),c_1+5*x]] — with a verification check mark, because the mark is
    // honest about the rewritten system and the rewritten system is not the one
    // the caller wrote. main answered c_0*exp(x), the correct general solution.
    const r = await computeHandler({ problem: "desolve([y'=y], diff(z)=5, x, y)" });
    expect(r.isError, text(r)).toBe(true);
    expect(text(r)).toMatch(/does not understand the argument "diff\(z\)=5"/);
  });

  it.each([["desolve([y'=z, z'=-y], x, [q])"], ["desolve([y'=z, z'=-y], x, [y,z,w])"]])(
    '%s refuses an unknowns list that does not match the system',
    async (problem) => {
      // `q(x)` was refused while `[q]` was accepted and ignored — the same claim
      // spelled two ways getting opposite verdicts, which is what the applied-name
      // membership rule was added to remove. `[y,z,w]` states an arity the system
      // does not have.
      const r = await computeHandler({ problem });
      expect(r.isError, text(r)).toBe(true);
      expect(text(r)).toMatch(/does not understand the argument/);
    }
  );

  it.each([["desolve(y'=y, y(0)=1 or y(0)=2, x, y)"], ["desolve(y'=y, y(0)=1==1, x, y)"]])(
    'refuses %s rather than folding a proposition',
    async (problem) => {
      // Parenthesising each side of the join is correct for precedence, and it
      // opened this: Giac ACCEPTS `(y'=y) and (y(0)=1 or y(0)=2)`, ignores the
      // condition, and `c_0*exp(x)` ships with isError:false — the general solution
      // as the answer to an IVP, which is the shape this whole change exists to
      // remove. Unparenthesised, Giac errored and the call was refused, so the fix
      // for one hazard uncovered another. A condition's right-hand side has to be a
      // value.
      const r = await computeHandler({ problem });
      expect(r.isError, text(r)).toBe(true);
      expect(text(r)).toMatch(/does not understand the argument/);
      expect(text(r)).not.toMatch(/c_0/);
    }
  );

  it('refuses an applied name the equation contradicts', async () => {
    // Deliberate deviation from main, which answered `c_0*exp(x)` here — by
    // dropping `z(x)` and inferring `y` from the equation. The input is
    // self-contradictory: the equation differentiates `y` and the caller names
    // `z` as the unknown. Preferring either side silently is how this file's
    // older bugs read, and the previous commit's version answered `c_0*exp(z)` —
    // a wrong answer rather than a refusal. Same treatment as a condition on a
    // function the equation never mentions.
    const r = await computeHandler({ problem: "desolve(y'=y, z(x))" });
    expect(r.isError, text(r)).toBe(true);
    expect(text(r)).toMatch(/does not understand the argument "z\(x\)"/);
  });

  it("reports the caller's first unrecognised argument, not the filters'", async () => {
    const r = await computeHandler({ problem: "desolve(y'=y, x, y, zzz, 42)" });
    expect(r.isError, text(r)).toBe(true);
    expect(text(r)).toMatch(/argument "zzz"/);
  });

  it('still refuses an empty equation before any engine call', async () => {
    // Folding built a non-empty string from an empty equation, so the
    // "'equation' is required" check never fired and a precise usage error became
    // a CAS-blaming one, paid for with a Giac round-trip.
    const r = await computeHandler({ problem: 'desolve(, y(0)=1)' });
    expect(r.isError, text(r)).toBe(true);
    expect(text(r)).toMatch(/'equation' is required/);
  });

  it('refuses a third identifier rather than discarding it', async () => {
    // Only the first two identifiers are read. `zzz` was classified and then
    // dropped — the same silent drop this change exists to remove, one bucket
    // over, while a comment claimed every argument was accounted for.
    const r = await computeHandler({ problem: "desolve(y'=y, y(0)=1, x, y, zzz)" });
    expect(r.isError, text(r)).toBe(true);
    expect(text(r)).toMatch(/does not understand the argument "zzz"/);
  });

  it.each([
    ["desolve(y'=y, y(0)=1, y(1)=2, x, y)"],
    ["desolve(y'=y, y(0)=1, y(0)=2, x, y)"],
    ["desolve(y'=y, z(0)=1, x, y)"],
  ])('refuses %s rather than answering []', async (problem) => {
    // Newly reachable: while conditions were being dropped, Giac was never asked
    // an unsatisfiable question. The single-equation path had no guard at all —
    // the `[]`/`undef` one runs only for a rewritten system — so `Result: []`
    // went out with isError:false.
    const r = await computeHandler({ problem });
    expect(r.isError, text(r)).toBe(true);
    expect(text(r)).not.toMatch(/^Result: \[\]$/m);
  });

  it('refuses a two-argument point instead of folding it', async () => {
    // The condition's point group was `\([^)]*\)`, which accepted `y(0,1)=1`;
    // Giac then answered as though the caller had written `y(0)=1` — a confident
    // answer to a different problem.
    const r = await computeHandler({ problem: "desolve(y'=y, y(0,1)=1, x, y)" });
    expect(r.isError, text(r)).toBe(true);
    expect(text(r)).toMatch(/does not understand the argument/);
  });

  it.each([['ifactor(2^257-1)'], ['42']])(
    'refuses the unrecognised argument %s instead of discarding it',
    async (extra) => {
      // Dropping was the bug; this is the same class. `ifactor(2^257-1)` also
      // must not be FOLDED — it would be evaluated on the shared worker for the
      // full budget. Requiring `=` in the condition shape is what excludes it,
      // so this refusal is immediate.
      const started = Date.now();
      const r = await computeHandler({ problem: `desolve(y'=y, ${extra}, x, y)` });
      expect(r.isError, text(r)).toBe(true);
      expect(text(r)).toMatch(/does not understand the argument/);
      expect(text(r)).toContain(extra);
      expect(Date.now() - started).toBeLessThan(1000);
    }
  );

  describe('non-finite arithmetic through the published compute tool', () => {
    it('0/0 is an error, not an answer', async () => {
      const r = await computeHandler({ problem: '0/0' });
      expect(r.isError).toBe(true);
      // The regression: it answered "The answer is NaN" with isError:false.
      expect(text(r)).not.toMatch(/The answer is NaN/);
    });

    it('1/0 answers Infinity but never bare', async () => {
      const r = await computeHandler({ problem: '1/0' });
      expect(r.isError).toBe(false);
      expect(text(r)).toContain('Infinity');
      // 1/0 and an overflow of a finite value are indistinguishable here, so the
      // answer has to say so rather than present them as the same number.
      expect(text(r)).toMatch(/result is infinite/);
    });

    it('an overflow of a finite quantity carries the same caveat', async () => {
      // The true value of 1e308*10 is 1e309 — finite. Reporting a bare
      // "Infinity" for it is a wrong answer, not a large one.
      const r = await computeHandler({ problem: '1e308*10' });
      expect(text(r)).toMatch(/result is infinite/);
    });

    it.each(['[[1,2],[3,4]]', '2>1', '1:5'])(
      'a finite result gains no caveat: %s',
      async (problem) => {
        // These reach the non-finite flag. Scalar arithmetic does NOT: quick-calc
        // returns at the exact-result branch first, so '2+3*4' and even '0.1+0.2'
        // (which has the exact form 3/10) passed this control while the caveat was
        // hard-coded ON. parseFloat of a matrix/boolean/range is NaN, which is what
        // skips that branch and lets the flag be read.
        const r = await computeHandler({ problem });
        expect(r.isError).toBe(false);
        expect(text(r)).not.toMatch(/result is infinite/);
      }
    );

    it('a NaN inside a container is refused too', async () => {
      // The guard used to compare the whole rendered string, so wrapping the
      // same undefined quantity in a list walked straight past it: `[1, 0/0]`
      // answered "[1, NaN]" on exit 0.
      const r = await computeHandler({ problem: '[1, 0/0]' });
      expect(r.isError).toBe(true);
      expect(text(r)).not.toMatch(/NaN\]/);
    });

    it('an infinity inside a container still earns the caveat', async () => {
      const r = await computeHandler({ problem: '[1, 1/0]' });
      expect(r.isError).toBe(false);
      expect(text(r)).toMatch(/result is infinite/);
    });

    it('a string that spells NaN is not an undefined result', async () => {
      // The rendered-string check refused this with "it evaluated to NaN". It is
      // a three-character string; nothing evaluated to anything undefined.
      const r = await computeHandler({ problem: '"NaN"' });
      expect(r.isError).toBe(false);
    });

    it('the caveat reaches a structured caller, not only the text', async () => {
      // The motivating failure was a machine caller getting a bare value. The
      // scalar branch of buildData drops notes, so the caveat has to travel as an
      // envelope warning or a JSON consumer never sees it.
      const r = await computeHandler({ problem: '1e308*10', format: 'json' });
      const envelope = JSON.parse(text(r)) as { warnings?: string[] };
      expect(envelope.warnings?.join(' ')).toMatch(/result is infinite/);
    });
  });

  describe('the non-finite caveat reaches every surface, and only where it belongs', () => {
    it('exact_value to_decimal carries the caveat for an infinite result', async () => {
      // Neither direction of this branch was tested: it could stop emitting the
      // caveat, or stamp it on every exact_value answer, unnoticed.
      const r = await exactValueHandler({ operation: 'to_decimal', value: '1e308*10' });
      expect(r.isError).toBe(false);
      expect(r.content.map((c) => c.text).join('\n')).toMatch(/result is infinite/);
    });

    it('exact_value to_decimal does not carry it for a finite result', async () => {
      const r = await exactValueHandler({ operation: 'to_decimal', value: '2/3' });
      expect(r.content.map((c) => c.text).join('\n')).not.toMatch(/result is infinite/);
    });

    it('the caveat appears once in text, not twice', async () => {
      // normalize lifts the line into envelope.warnings and compute/index.ts
      // prepends warnings, so the same 190-character sentence printed twice.
      const t = text(await computeHandler({ problem: '1/0' }));
      expect(t.match(/result is infinite/g) ?? []).toHaveLength(1);
    });

    it('reaches a JSON consumer through envelope.warnings', async () => {
      const env = JSON.parse(text(await computeHandler({ problem: '1/0', format: 'json' })));
      expect(env.success).toBe(true);
      expect(env.warnings?.join(' ')).toMatch(/result is infinite/);
    });

    it("does not relabel another handler's advisory note as a warning", async () => {
      // Matching on `Note:` swept up multivariable/optimization.ts's Lagrange
      // footnote, so a correct answer arrived flagged as unreliable.
      const env = JSON.parse(
        text(await computeHandler({ problem: 'lagrange(x*y, x+y, 10, [x,y])', format: 'json' }))
      );
      expect(env.success).toBe(true);
      expect(env.warnings).toBeUndefined();
    });
  });

  describe('containers do not hide a NaN from the published tool', () => {
    it.each(['[{a: 0/0}]', '1;0/0', '[[[[[[[[0/0]]]]]]]]'])(
      '%s is an error, not an answer',
      async (problem) => {
        const r = await computeHandler({ problem });
        expect(r.isError).toBe(true);
        expect(text(r)).not.toMatch(/The answer is/);
      }
    );
  });

  describe('a value is read as a value, not by string-sniffing its rendering', () => {
    it.each([
      ['0.5 kg', /0\.5 kg/],
      ['2 m', /2 m/],
      ['5 cm to inch', /inch/],
    ])('quick_calc keeps the unit on %s', async (problem, expected) => {
      // parseFloat(String(result)) read the leading term, so "0.5 kg" answered
      // "1/2" — the unit silently gone.
      expect(text(await computeHandler({ problem }))).toMatch(expected);
    });

    it('to_decimal keeps the unit too', async () => {
      const r = await exactValueHandler({ operation: 'to_decimal', value: '1/2 m' });
      expect(text(r)).toMatch(/0\.5 m/);
    });

    it('plain numbers still reach their exact form', async () => {
      expect(text(await computeHandler({ problem: '0.1+0.2' }))).toMatch(/3\/10/);
    });
  });

  describe('a deep or oversized result is refused, a merely deep one is not', () => {
    it('answers a finite value nested well past the old cap of 64', async () => {
      // The cap counted walk recursion, not value nesting, so a 33-term sum at 74
      // characters was refused. mathjs itself cannot build an array literal deeper
      // than 255, which is what the cap is now measured against.
      const problem = '['.repeat(120) + '1' + ']'.repeat(120);
      const r = await computeHandler({ problem });
      expect(r.isError).toBe(false);
    });

    it('refuses a matrix reached through a wrapper instead of exhausting the heap', async () => {
      // refuseIfTooManyElements only inspects the top level, so one container in
      // the way reached toArray() and densified 4e8 elements.
      const r = await computeHandler({
        problem: "to_decimal({a: zeros(20000,20000,'sparse')})",
      });
      expect(r.isError).toBe(true);
      expect(text(r)).not.toMatch(/memory budget/);
    });
  });

  describe('the warning text channel', () => {
    it('surfaces a warning the body does not already carry', async () => {
      // The dedup filter had only its suppress direction pinned. The hygiene
      // layer's warning is never in the response text, so a filter that dropped
      // everything would silently delete it — with the suite green.
      const previous = process.env.AXIOM_COMPUTE_HYGIENE;
      process.env.AXIOM_COMPUTE_HYGIENE = '1';
      try {
        const r = await computeHandler({ problem: 'sign(0/0)' });
        expect(text(r)).toMatch(/\[Warning:/);
      } finally {
        if (previous === undefined) delete process.env.AXIOM_COMPUTE_HYGIENE;
        else process.env.AXIOM_COMPUTE_HYGIENE = previous;
      }
    });
  });

  describe('a list-form ODE system is solved, not answered with []', () => {
    it('names the components in every format that shows the vector', async () => {
      // --json carries `components` and the text formats carry the note line;
      // --latex renders the vector most prominently and was the only one saying
      // nothing about which component is which.
      const latex = await computeHandler({ problem: "desolve([y'=z, z'=-y], x)", format: 'latex' });
      expect(text(latex)).toMatch(/Components are in the order: y, z/);
    });

    it.each([
      // Rewritten into the matrix form the CAS solves. Answering `[]` was an
      // empty result presented as a solution; refusing it, as a first attempt
      // did, asserted a capability was missing that is not.
      // Each row pins the WHOLE result. A fragment does not distinguish a
      // matrix from its transpose: the intended [[3,4],[-4,3]] and its
      // transpose both contain exp(3*t), and the homogeneous system contains
      // the sin(x) that was supposed to witness the +1 forcing term.
      [
        "desolve([y'=z, z'=-y], x)",
        /^Result: \[\[c_0\*cos\(x\)\+c_1\*sin\(x\),-c_0\*sin\(x\)\+c_1\*cos\(x\)\]\]$/m,
      ],
      ["desolve([y'=y, z'=2*z], t)", /^Result: \[\[c_0\*exp\(t\),c_1\*exp\(2\*t\)\]\]$/m],
      [
        "desolve([x'=3*x+4*y, y'=-4*x+3*y], t)",
        /^Result: \[\[c_0\*cos\(4\*t\)\*exp\(3\*t\)\+c_1\*exp\(3\*t\)\*sin\(4\*t\),-c_0\*exp\(3\*t\)\*sin\(4\*t\)\+c_1\*cos\(4\*t\)\*exp\(3\*t\)\]\]$/m,
      ],
      [
        "desolve([y'=z+1, z'=-y], x)",
        /^Result: \[\[c_0\*cos\(x\)\+c_1\*sin\(x\)\+sin\(x\),-c_0\*sin\(x\)\+c_1\*cos\(x\)\+cos\(x\)-1\]\]$/m,
      ],
      // Leibniz notation. The other two forms the module reads are pinned
      // above and below; without this row, a regression that stopped
      // recognising dy/dx would classify both members as CONDITIONS, fall back
      // to the raw list, and bring back the very [] this block exists to stop.
      [
        'desolve([dy/dx=z, dz/dx=-y], x)',
        /^Result: \[\[c_0\*cos\(x\)\+c_1\*sin\(x\),-c_0\*sin\(x\)\+c_1\*cos\(x\)\]\]$/m,
      ],
    ])('solves %s', async (problem, expected) => {
      const r = await computeHandler({ problem });
      expect(r.isError).toBe(false);
      expect(text(r)).toMatch(expected);
      expect(text(r)).not.toMatch(/The answer is \[\]/);
    });

    it('applies initial conditions given for every function', async () => {
      // Asymmetric conditions, whole result pinned. With y(0)=1, z(0)=0 and a
      // fragment assertion, reversing the condition order still answered
      // "cos(x)" — from the SECOND component — so a solution violating the
      // stated y(0) passed as correct.
      const r = await computeHandler({ problem: "desolve([y'=z, z'=-y, y(0)=2, z(0)=3], x)" });
      expect(r.isError).toBe(false);
      expect(text(r)).toMatch(
        /^Result: \[\[2\*cos\(x\)\+3\*sin\(x\),3\*cos\(x\)-2\*sin\(x\)\]\]$/m
      );
      expect(text(r)).not.toMatch(/c_0/);
    });

    it('keeps an initial-condition point other than zero', async () => {
      // Every other condition test uses point 0, so `point = at.trim()` could be
      // replaced by `point = '0'` and the suite still passed — silently solving
      // a different initial-value problem.
      const r = await computeHandler({ problem: "desolve([y'=z, z'=-y, y(1)=2, z(1)=3], x)" });
      expect(r.isError).toBe(false);
      expect(text(r)).toMatch(/Command: .*Y\(1\)=\[2,3\]/);
      expect(text(r)).toMatch(/2\*cos\(1\)\*cos\(x\)/);
    });

    it('does not display a zero inhomogeneous term it never had', async () => {
      const r = await computeHandler({ problem: "desolve([y'=z, z'=-y], x)" });
      expect(text(r)).toMatch(/Command: desolve\(Y'=\[\[0,1\],\[-1,0\]\]\*Y,x,Y\)/);
      expect(text(r)).not.toMatch(/\+\[0,0\]/);
    });

    it('does display a real inhomogeneous term', async () => {
      const r = await computeHandler({ problem: "desolve([y'=z+1, z'=-y], x)" });
      expect(text(r)).toMatch(/\+\[1,0\]/);
      // The verdict, not just the command: verification checks Y' = A*Y + b, and
      // dropping the `+ b` half leaves every inhomogeneous system unverified
      // while certifying nothing — or, with a wrong b, certifying against the
      // wrong system.
      expect(text(r)).toContain('Verified: ✓');
    });

    it.each([
      // The probe is quadratic in the equation count and linear in each
      // right-hand side, so both are bounded. 26 equations in 227 bytes trapped
      // the WASM engine and took the shared worker down with it.
      [26, /at most 9/],
      [10, /at most 9/],
    ])('refuses a system of %i equations', async (n, expected) => {
      const problem =
        'desolve([' +
        Array.from({ length: n }, (_, i) => `v${i}'=v${(i + 1) % n}`).join(',') +
        '], x)';
      const r = await computeHandler({ problem });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(expected);
    });

    it('refuses a system whose coefficient extraction would be enormous', async () => {
      const problem = `desolve([y'=z+${'x*'.repeat(2000)}1, z'=-y], x)`;
      const r = await computeHandler({ problem });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/character limit/);
    });

    it('does not let a symbol on a right-hand side collide with the vector', async () => {
      // The vector symbol is chosen to appear nowhere in the problem. Checking
      // only the differentiated names let `Y` on a right-hand side be captured,
      // which answered `[]` for this input.
      const r = await computeHandler({ problem: "desolve([y'=Y*z, z'=-y], x)" });
      expect(r.isError).toBe(false);
      expect(text(r)).not.toMatch(/The answer is \[\]/);
      // The parameter survives into the solution instead of being captured.
      expect(text(r)).toMatch(/√Y|sqrt\(Y\)/);
    });

    it('reads applied function notation as the same unknown', async () => {
      // grad() sees `z(x)` as opaque, so the matrix came back all zeros and the
      // system was "solved" as Y'=0 — the constant [[c_0,c_1]], a wrong ANSWER.
      const applied = await computeHandler({
        problem: 'desolve([diff(y(x),x)=z(x), diff(z(x),x)=-y(x)], x)',
      });
      const plain = await computeHandler({ problem: "desolve([y'=z, z'=-y], x)" });
      expect(applied.isError).toBe(false);
      expect(text(applied)).toMatch(/c_0\*cos\(x\)\+c_1\*sin\(x\)/);
      expect(text(applied)).not.toMatch(/\[\[c_0,c_1\]\]/);
      expect(text(applied)).toBe(text(plain));
    });

    it('reads a unicode multiplication sign the same as an ascii one', async () => {
      // The probe does not go through evalWithLatex, so it does not get the
      // normalization every other Giac call gets. Without it this was refused as
      // "not linear" while the ascii spelling solved.
      const dot = await computeHandler({ problem: "desolve([y'=2·z, z'=-y], x)" });
      const star = await computeHandler({ problem: "desolve([y'=2*z, z'=-y], x)" });
      expect(dot.isError).toBe(false);
      expect(text(dot)).toBe(text(star));
    });

    it('does not ship [] when the rewritten form has no solution', async () => {
      const r = await computeHandler({
        problem: "desolve([y'=z, z'=-y, y(0)=undef, z(0)=undef], x)",
      });
      expect(r.isError).toBe(true);
      expect(text(r)).not.toMatch(/The answer is \[\]/);
    });

    it('carries the component order in the envelope, not only in the text', async () => {
      // `--json`, `--quiet` and `--latex` all discard notes, so prose alone left
      // a structured caller with an ordered vector and no way to read it. The
      // equations are listed in REVERSE order here, so the mapping is the only
      // thing that makes the answer interpretable.
      const r = await computeHandler({
        problem: "desolve([z'=-y, y'=z, y(0)=1, z(0)=0], x)",
        format: 'json',
      });
      const envelope = JSON.parse(text(r)) as { components?: string[]; display: string };
      expect(envelope.components).toEqual(['z', 'y']);
      expect(envelope.display).toMatch(/-sin\(x\)/);
    });

    it('does not refuse a coefficient whose NAME contains undef', async () => {
      // The unfinished-result check matched the whole formatted block, so the
      // `Command:` echo of the caller's own coefficient tripped it. Giac solves
      // this correctly.
      const r = await computeHandler({ problem: "desolve([y'=k_undefined*z, z'=-y], x)" });
      expect(r.isError).toBe(false);
      expect(text(r)).toMatch(/k_undefined/);
    });

    it.each([['T_Inf'], ['V_Inf'], ['Inf_k'], ['a1Inf']])(
      'does not refuse a coefficient whose NAME contains Inf (%s)',
      async (name) => {
        // Same defect as the row above, on a different token, and reintroduced by
        // sharing detectFailure: its `Inf` rule bounded the token with [^A-Za-z] and
        // (?![A-Za-z]), so _ and digits counted as boundaries. `T_Inf` is free-stream
        // notation. Giac solves these and the substitution check verifies them, and
        // they were being refused with a message blaming the CAS.
        const r = await computeHandler({ problem: `desolve([y'=${name}*z, z'=-y], x)` });
        expect(r.isError).toBe(false);
        // The Result line specifically. Matching anywhere also matches the
        // `Command:` echo of the caller's own text, which cannot fail independently
        // of the assertion above.
        const result = /^Result:\s*(.*)$/m.exec(text(r))?.[1] ?? '';
        expect(result).toContain(name);
      }
    );

    it('refuses an infinite solution component', async () => {
      // The `infinity` arm, which a comment here once called unreachable. No other
      // arm fires on this: detectFailure passes `infinity` (correct divergence, as
      // in integrate(1/x^2,x,0,1)) and there is no poly1[ or ilaplace(. The pole
      // rule cannot refuse it either — denom(x^x) does not mention x.
      const r = await computeHandler({ problem: "desolve([y'=z, z'=-y+x^x], x)" });
      expect(r.isError).toBe(true);
      // The message too, not just isError: `disproved` and the pole rule also
      // refuse, with different wording, so isError alone would stay green if this
      // input started being refused for some other reason and the arm rotted.
      expect(text(r)).toMatch(/the CAS could not finish it/);
    });

    // One row per arm of the unfinished-answer guard that CAN be discriminated,
    // each an input that ships something other than an answer when its arm is
    // removed. Before these, only the `[]` arm had a test and the others could be
    // deleted with the suite green. The exception is `ilaplace(`, which has never
    // been observed without `poly1[` beside it, so no input separates them.
    it.each([
      // Y(0)=[undef,undef] -> Result: []
      ["desolve([y'=z, z'=-y, y(0)=undef, z(0)=undef], x)", '[]'],
      // An initial-condition VALUE is the one part of the command the probe
      // never sees, so a bad one reaches desolve intact -> Result: GIAC_ERROR: ...
      ["desolve([y'=z, z'=-y, y(0)=sqrt, z(0)=0], x)", 'GIAC_ERROR'],
    ])('refuses %s rather than shipping %s as the answer', async (problem, leftover) => {
      const r = await computeHandler({ problem });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/could not finish it/);
      expect(text(r)).not.toContain(leftover);
    });

    it.each([
      // Decimal coefficients: Giac prints the affine residual as the FLOAT zero
      // `0.0`, which is not the string '0'. Comparing textually refused every
      // one of these ordinary linear systems as "not linear". Exact rationals
      // print as `0`, which is why a suite full of them missed it.
      ["desolve([y'=0.5*z, z'=-1.5*y], x)", /^Result: \[\[\(c_0\*1\.73205080757\*cos/m],
      ["desolve([x1'=x2, x2'=-4\*x1-0.5\*x2], t)", /^Result: \[\[\(3\.0\*c_0\*2\.64575131106/m],
      ["desolve([y'=z+0.5, z'=-y], x)", /^Result: \[\[\(2\.0\*c_0\*cos\(x\)/m],
      // A coefficient that is constant but written naming the variable. The
      // gradient is scanned as Giac printed it, so it needs normalising too.
      ["desolve([y'=(x+1-x)*z, z'=-y], x)", /^Result: \[\[c_0\*cos\(x\)\+c_1\*sin\(x\)/m],
    ])('solves %s', async (problem, expected) => {
      const r = await computeHandler({ problem });
      expect(r.isError).toBe(false);
      expect(text(r)).toMatch(expected);
    });

    it('does not name the vector after the independent variable', async () => {
      // Solving in a variable named Y collided with the generated vector symbol:
      // `desolve(Y'=[[0,1],[-1,0]]*Y,Y,Y)` returned isError:false with an answer
      // whose residual is [0,-1] — it satisfies z'=-y-1, not the system asked
      // for. The IVP form hid it entirely, since the conditions still held.
      const r = await computeHandler({ problem: "desolve([y'=z, z'=-y], Y)" });
      expect(r.isError).toBe(false);
      expect(text(r)).toMatch(/Command: desolve\(Y_'=\[\[0,1\],\[-1,0\]\]\*Y_,Y,Y_\)/);
      expect(text(r)).toMatch(
        /^Result: \[\[c_0\*cos\(Y\)\+c_1\*sin\(Y\),-c_0\*sin\(Y\)\+c_1\*cos\(Y\)\]\]$/m
      );
    });

    it('refuses a deeply composed right-hand side quickly, without wedging the engine', async () => {
      // `simplify` is exponential in composition depth, and no character bound
      // can express that: this input is 50 characters and builds a 292-character
      // probe, 6.8x inside the cap, yet it burnt the whole 10s per-call budget
      // in the shared worker — a denial of service against every other caller.
      const problem = `desolve([y'=${'sin('.repeat(5)}z${')'.repeat(5)}, z'=-y], x)`;
      const started = Date.now();
      const [attacker, victim] = await Promise.all([
        computeHandler({ problem }),
        computeHandler({ problem: 'integrate(sin(x)^5*cos(x)^3, x)' }),
      ]);
      expect(attacker.isError).toBe(true);
      expect(victim.isError).toBe(false);
      expect(Date.now() - started).toBeLessThan(5_000);
    });

    it('refuses an oversized condition value before the engine expands it', async () => {
      // An initial-condition VALUE never enters the probe, so no gradient is taken
      // of it and no guard here had seen it. A 540-deep product trapped the engine
      // fatally, which recycles the worker, rejects whatever else was pending, and
      // returned the raw "RuntimeError: memory access out of bounds" to the
      // caller. It is now refused for its LENGTH, before any engine call — the
      // channel had nothing measuring it, since the probe and command bounds both
      // run later.
      const problem = `desolve([y'=z, z'=-y, y(0)=${'x*'.repeat(540)}1, z(0)=0], x)`;
      const [attacker, victim] = await Promise.all([
        computeHandler({ problem }),
        computeHandler({ problem: 'integrate(sin(x)^2, x)' }),
      ]);
      expect(attacker.isError).toBe(true);
      expect(text(attacker)).toMatch(/initial condition of \d+ characters, above the \d+/);
      expect(text(attacker)).not.toMatch(/RuntimeError/);
      expect(victim.isError).toBe(false);
    });

    // Both caps pinned at their boundary AND by value. Without the accept side
    // and the number, MAX_PROBE_CHARS could be raised to 3,600 — the length the
    // module's own comment records as fatally trapping the shared worker — and
    // MAX_COMMAND_CHARS to 1,100, past the 1,085 that still answers, with the
    // whole suite green.
    it('accepts a probe just under the cap and refuses just over, naming the limit', async () => {
      // A sum of exponentials, not a product: a long product is degree-capped
      // first, so it cannot exercise this bound.
      const forcing = (n: number) =>
        `desolve([y'=z+${Array.from({ length: n }, (_, i) => `${i + 1}*exp(${i + 1}*x)`).join('+')}, z'=-y], x)`;

      const solvable = await computeHandler({ problem: forcing(29) });
      expect(solvable.isError).toBe(false);

      const refused = await computeHandler({ problem: forcing(30) });
      expect(text(refused)).toMatch(/expands to 2039 characters .*2000-character limit/);
    });

    it('names the 800-character limit on the shape that reaches it', async () => {
      // The cap is pinned on the engine's own expansion, which is what it is
      // actually for: `10^900` is six characters and comes back as 901 digits.
      // A long condition VALUE no longer gets this far — the condition scan
      // evaluates it and refuses first — so pinning the cap there would be
      // pinning a path that no longer exists.
      const refused = await computeHandler({ problem: "desolve([y'=z+10^900, z'=-y], x)" });
      expect(refused.isError).toBe(true);
      expect(text(refused)).toMatch(/becomes 938 characters .*800-character limit/);
      expect(text(refused)).toMatch(/use a shorter forcing term/);

      const solvable = await computeHandler({ problem: "desolve([y'=z+10^90, z'=-y], x)" });
      expect(solvable.isError).toBe(false);
    });

    it('refuses a forcing term whose degree, not length, is what costs', async () => {
      // 35 characters, a 229-character probe and a 46-character command — inside
      // every text bound — and it trapped the engine fatally, after which the
      // next unrelated caller got "Giac worker exited (code 1)".
      const [attacker, victim] = await Promise.all([
        computeHandler({ problem: "desolve([y'=z+(x+1)^300, z'=-y], x)" }),
        computeHandler({ problem: 'integrate(sin(x)*exp(x), x)' }),
      ]);
      expect(attacker.isError).toBe(true);
      expect(text(attacker)).toMatch(/forcing term of degree 300 in x, above the 60/);
      expect(text(attacker)).not.toMatch(/RuntimeError/);
      expect(victim.isError).toBe(false);
      // The accept side, so the cap cannot be lowered into ordinary work.
      const solvable = await computeHandler({ problem: "desolve([y'=z+(x+1)^60, z'=-y], x)" });
      expect(solvable.isError).toBe(false);
    });

    it.each([
      // Text length says nothing about the magnitude a condition denotes.
      // 10^100000 is nine characters and trapped desolve itself; 10^10000 did
      // not trap but produced an 80,000-character result, which then trapped the
      // engine when it was fed back in as latex(...).
      ["desolve([y'=z, z'=-y, y(10^100000)=1, z(10^100000)=0], x)", /an exponent of 100000/],
      ["desolve([y'=z, z'=-y, y(10^10000)=1, z(10^10000)=0], x)", /an exponent of 10000/],
      // The VALUE side, not just the point: with that half removed, this reaches
      // the fatal trap inside desolve that the guard exists to prevent.
      ["desolve([y'=z, z'=-y, y(0)=10^100000, z(0)=0], x)", /an exponent of 100000/],
      ["desolve([y'=z, z'=-y, y(0)=10^10000, z(0)=0], x)", /an exponent of 10000/],
      // Just over the limit, so the limit itself is pinned and cannot drift up.
      ["desolve([y'=z, z'=-y, y(0)=10^1001, z(0)=0], x)", /an exponent of 1001/],
    ])('refuses %s for magnitude', async (problem, expected) => {
      const [attacker, victim] = await Promise.all([
        computeHandler({ problem }),
        computeHandler({ problem: 'solve(x^2-5*x+6=0, x)' }),
      ]);
      expect(attacker.isError).toBe(true);
      expect(text(attacker)).toMatch(expected);
      expect(text(attacker)).not.toMatch(/RuntimeError/);
      expect(victim.isError).toBe(false);
      expect(text(victim)).toContain('Verified: ✓');
    });

    it.each([
      // The notation states its own differentiation variable, and dropping it
      // answered a system written in t as though it were written in x.
      [
        'desolve([dy/dt=z, dz/dt=-y], x)',
        /differentiates y with respect to t, but was asked to solve in x/,
      ],
      [
        'desolve([diff(y(t),t)=z, diff(z(t),t)=-y], x)',
        /differentiates y with respect to t, but was asked to solve in x/,
      ],
    ])('refuses %s', async (problem, expected) => {
      const r = await computeHandler({ problem });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(expected);
    });

    it('solves a d/dt system when asked for t', async () => {
      const r = await computeHandler({ problem: 'desolve([dy/dt=z, dz/dt=-y], t)' });
      expect(r.isError).toBe(false);
      expect(text(r)).toMatch(
        /^Result: \[\[c_0\*cos\(t\)\+c_1\*sin\(t\),-c_0\*sin\(t\)\+c_1\*cos\(t\)\]\]$/m
      );
    });

    it('names `i` rather than echoing the engine error it causes', async () => {
      // `i` is the imaginary unit, so it cannot be a gradient-basis entry —
      // which makes the standard SIR naming refuse with a raw GIAC_ERROR.
      const r = await computeHandler({
        problem: "desolve([s'=-0.3*s, i'=0.3*s-0.1*i, r'=0.1*i], x)",
      });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/imaginary unit/);
      expect(text(r)).not.toMatch(/GIAC_ERROR/);
      // and the suggested rename actually works
      const renamed = await computeHandler({
        problem: "desolve([s'=-0.3*s, ii'=0.3*s-0.1*ii, r'=0.1*ii], x)",
      });
      expect(renamed.isError).toBe(false);
    });

    it.each([
      // A coefficient that merely CONTAINS an unknown's name is not a mention
      // of it. Same substring-vs-token bug already fixed for `undef`.
      ["desolve([y'=ky*z, z'=-y], x)", 'ky'],
      ["desolve([y'=kx*z, z'=-y], x)", 'kx'],
    ])('solves %s, whose coefficient only contains a name', async (problem, coefficient) => {
      const r = await computeHandler({ problem });
      expect(r.isError).toBe(false);
      // Where the coefficient lands, not just that it appears somewhere: the
      // name survives a transposed matrix too.
      expect(text(r)).toMatch(
        new RegExp(`Command: desolve\\(Y'=\\[\\[0,${coefficient}\\],\\[-1,0\\]\\]`)
      );
    });

    it('blames the forcing term, not conditions the caller never wrote', async () => {
      // All 938 characters are the engine's expansion of 10^900; there are no
      // initial conditions to shorten.
      const r = await computeHandler({ problem: "desolve([y'=z+10^900, z'=-y], x)" });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/use a shorter forcing term/);
    });

    it('does not refuse a coefficient merely named after a sentinel', async () => {
      // Same substring-vs-token trap already fixed for `undef`: the guard must
      // match `infinity` as a word, not inside `infinity_k`.
      const r = await computeHandler({ problem: "desolve([y'=infinity_k*z, z'=-y], x)" });
      expect(r.isError).toBe(false);
      expect(text(r)).toContain('infinity_k');
    });

    it('does not feed an oversized result back into the engine as latex', async () => {
      // toLatex sends the RESULT back in, so the result's size is an input size.
      // `latex(<10,000 chars>)` traps the worker fatally, and toLatex's `catch`
      // turns that into a quiet `undefined` — the caller who triggered it still
      // gets a successful-looking answer while the worker is gone. Asserted on
      // the engine rather than through computeHandler because the handler's
      // recycle-and-redispatch hides the death from a sequential caller; only a
      // concurrent one is rejected. Reachable from a plain expand, not just from
      // an ODE system: removing the bound leaves the engine dead here.
      const big = await computeHandler({ problem: 'expand((x+1)^400)' });
      expect(big.isError).toBe(false);
      await expect(giacEngine.evaluate('integrate(x^2,x)')).resolves.toContain('x^3');
    });

    it.each([
      // A matrix mixing a float with an exact transcendental made Giac return an
      // ordinary-looking vector of functions whose residual was 2.1, not 0 — a
      // wrong answer no shape guard could see. Giving the matrix ONE numeric
      // domain fixes it at the source: the residual against the original system
      // is 7.7e-12 and 5.0e-13, i.e. right to the precision the caller's own
      // decimal implies.
      ["desolve([y'=z, z'=-1.5*y+ln(2)*z], x)", /0\.69314718056/],
      ["desolve([y'=2*z, z'=-0.5*y+cos(1)*z], x)", /0\.540302305868/],
      // The IVP form was the worst case: the conditions still held, so it read
      // as correct.
      ["desolve([y'=z, z'=-1.5*y+ln(2)*z, y(0)=1, z(0)=0], x)", /0\.69314718056/],
    ])('solves %s in one numeric domain', async (problem, expected) => {
      const r = await computeHandler({ problem });
      expect(r.isError).toBe(false);
      // The evalf'd coefficient appears in the command actually sent.
      expect(text(r)).toMatch(expected);
      expect(text(r)).not.toMatch(/ln\(2\)\]\]\*Y|cos\(1\)\]\]\*Y/);
    });

    it.each([
      // Giac prints a high-precision negative float zero as the malformed token
      // `0.-0000000000000000`, which `Number` reads as NaN — so the residual was
      // not recognised as zero and pi, e and sqrt(2) at double precision were all
      // refused as "not linear". The same constants at 14 digits solved, so the
      // boundary was purely how the zero happened to be printed.
      ['3.141592653589793'],
      ['2.718281828459045'],
      ['1.4142135623730951'],
      ['0.333333333333333'],
    ])('solves a system whose coefficient is %s', async (coefficient) => {
      const r = await computeHandler({ problem: `desolve([y'=${coefficient}*z, z'=-y], x)` });
      expect(r.isError).toBe(false);
      expect(text(r)).not.toMatch(/not linear/);
      // The mathematics, not only the absence of a refusal. Asserting
      // non-refusal alone passes while the module solves a DIFFERENT system:
      // emitting `tran(matrix)*Y` fails 54 tests in this file and none of these.
      // The coefficient sits at [0][1], so the transpose is what this catches.
      expect(text(r)).toMatch(
        new RegExp(`Command: desolve\\(Y'=\\[\\[0,${coefficient}\\],\\[-1,0\\]\\]`)
      );
    });

    it.each([
      // The domain fix must not reach systems with nothing to normalise. Both of
      // these have an exact matrix and a decimal only in the FORCING term, and
      // both have a repeated root that a 12-digit float matrix splits: the
      // triple root failed outright, and writing `1/2` for `0.5` made the
      // identical system solve — not a distinction a caller should have to know.
      [
        "desolve([y'=z, z'=w, w'=(2/7)^3*y-3*(2/7)^2*z+3*(2/7)*w+0.5, y(0)=1, z(0)=0, w(0)=0], x)",
        /\[\[0,1,0\],\[0,0,1\],\[8\/343,-12\/49,6\/7\]\]/,
      ],
      ["desolve([y'=z, z'=-pi^2/4*y+pi*z+0.5, y(0)=1, z(0)=0], x)", /-1\/4\*pi\^2,pi\]\]/],
    ])('keeps the matrix exact for %s', async (problem, expected) => {
      const r = await computeHandler({ problem });
      expect(r.isError).toBe(false);
      expect(text(r)).toMatch(expected);
    });

    it.each([
      // Giac promotes a literal with 15+ decimal places to extended precision
      // and then does not cancel it out of the residual, leaving
      // `0.100000000000000e-14` — refused as "not linear", while the same value
      // written `1e-15` cancelled and solved.
      ['0.000000000000001'],
      ['0.0000000000000001'],
      ['1e-15'],
    ])('solves a system whose constant term is %s', async (constant) => {
      const r = await computeHandler({ problem: `desolve([y'=z, z'=-y+${constant}], x)` });
      expect(r.isError).toBe(false);
      expect(text(r)).not.toMatch(/not linear/);
    });

    it('still refuses a residue too large to be a rounding artifact', async () => {
      // The negligible rule is bounded, not a blanket pass: a nonlinear term
      // survives as something symbolic, which is never a bare number.
      const r = await computeHandler({ problem: "desolve([y'=y*z, z'=-y], x)" });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/not linear/);
    });

    it.each([
      // Giac prints radicals with U+221A, not `sqrt`, so a matrix mixing a float
      // with an exact radical held no ASCII letter, was never given one numeric
      // domain, and shipped an answer whose residual against its own system is
      // 2.6 — with isError:false and no sentinel firing. Seven of these were
      // wrong by O(1); pi and ln(2) happened to work, which is why a suite full
      // of them passed.
      ['sqrt(2)'],
      ['sqrt(3)'],
      ['sqrt(3)/2'],
      ['1/sqrt(2)'],
      ['2^(1/3)'],
      ['(1+sqrt(5))/2'],
      ['pi'],
      ['ln(2)'],
      // A single bare letter: the module's comment called exp(1) a case that
      // "happened to normalise correctly", which is the same reasoning that
      // missed U+221A. Excluding `e` from the class ships the wrong answer again.
      ['e'],
      ['exp(1)'],
    ])('gives a float matrix holding %s one numeric domain', async (coefficient) => {
      const r = await computeHandler({
        problem: `desolve([y'=z, z'=-1.5*y+(${coefficient})*z], x)`,
      });
      expect(r.isError).toBe(false);
      // Normalised: the exact constant is gone from the emitted matrix.
      expect(text(r)).toMatch(/Command: desolve\(Y'=\[\[0\.0,1\.0\]/);
    });

    it.each([
      // Giac prints a single-significant-digit float at 1e15 and above WITHOUT a
      // decimal point, so `[[0,1],[-3e+15,√3]]` read as holding no float and was
      // never normalised — the same wrong answer as before, just reached through
      // the other half of the condition. Writing `-3.5e15` normalised and
      // answered correctly, which is not a distinction a caller should have to
      // know. Relative residual goes from 1e-1 to 1.1e-12.
      ["desolve([y'=z, z'=-3e15*y+sqrt(3)*z], x)"],
      ["desolve([y'=z, z'=-3e16*y+ln(2)*z], x)"],
      ["desolve([y'=z, z'=-5e15*y+pi*z], x)"],
    ])('normalises %s, whose float has no decimal point', async (problem) => {
      const r = await computeHandler({ problem });
      expect(r.isError).toBe(false);
      // Normalised: the exact constant is gone from the emitted matrix.
      expect(text(r)).toMatch(/Command: desolve\(Y'=\[\[0\.0,1\.0\]/);
      expect(text(r)).not.toMatch(/sqrt\(3\)\]\]|ln\(2\)\]\]|,pi\]\]/);
    });

    it.each([
      // Rationals are the one exact family spellable entirely in the float
      // alphabet, so they are the one thing `symbolic` cannot see — which makes
      // them the gap this condition has by construction. Giac pairs them with
      // floats correctly: measured relative residuals 4.5e-13 to 3.5e-12 across
      // these, so there is genuinely nothing to normalise.
      ['-1.5', '2/7'],
      ['-0.5', '1/3'],
      ['-1.5', '355/113'],
      ['-1e15', '1/7'],
    ])('leaves a float beside the exact rational %s, %s alone', async (a, b) => {
      const r = await computeHandler({ problem: `desolve([y'=z, z'=(${a})*y+(${b})*z], x)` });
      expect(r.isError).toBe(false);
      // Both entries in their own positions, so a transposed or evaluated-away
      // matrix fails. `toContain(b)` alone passed on a genuinely different system.
      expect(text(r)).toMatch(
        new RegExp(
          `Command: desolve\\(Y'=\\[\\[0,1\\],\\[${a.replace('.', '\\.').replace('e', 'e\\+?')},${b}\\]\\]`
        )
      );
    });

    it('does not re-evalf a matrix printed in exponent notation', async () => {
      // Giac prints a small float as `1.2345e-07`, and reading that `e` as an
      // exact constant re-evaluated an all-float matrix for nothing.
      const r = await computeHandler({ problem: "desolve([y'=0.00000012345*z, z'=-y], x)" });
      expect(text(r)).toMatch(/\[\[0,1\.2345e-07\]/);
    });

    it('does not re-evalf a matrix that is already all floats', async () => {
      // Digits is 12, so normalising an all-float matrix would silently truncate
      // a caller's double-precision coefficient to 12 significant figures.
      const r = await computeHandler({ problem: "desolve([y'=z, z'=-1.4142135623730951*y], x)" });
      expect(text(r)).toMatch(/\[-1\.4142135623730951,0\]/);
    });

    it.each([
      // A float in the right-hand side makes `subst` numericalise the constant,
      // so an exact one survives as `pi-3.14159265359` — symbolic, so the
      // bare-number tolerance could not see it, and a linear system was refused
      // as not linear. The engine settles it: the artifact is 2.1e-13.
      ["desolve([y'=z, z'=-1.5*y+pi], x)"],
      ["desolve([y'=z, z'=-1.5*y+e], x)"],
      ["desolve([y'=z, z'=-1.5*y+sqrt(2)], x)"],
    ])('solves %s', async (problem) => {
      const r = await computeHandler({ problem });
      expect(r.isError).toBe(false);
      expect(text(r)).not.toMatch(/not linear/);
    });

    it('still refuses a nonlinearity that only appears beside a float', async () => {
      const r = await computeHandler({ problem: "desolve([y'=1.5*z*sign(z), z'=-y], x)" });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/not linear/);
    });

    it('accepts an ordinary exponent in a condition', async () => {
      // Lowering the exponent bound would refuse everyday conditions with no
      // test noticing — the over-refusal direction the 0.333... rows cover for
      // the digit rule.
      const r = await computeHandler({
        problem: "desolve([y'=z, z'=-y, y(0)=10^1000, z(0)=0], x)",
      });
      expect(r.isError).toBe(false);
      const small = await computeHandler({
        problem: "desolve([y'=z, z'=-y, y(0)=2^10, z(0)=0], x)",
      });
      expect(text(small)).toMatch(/1024\*cos\(x\)/);
    });

    it.each([
      // An EXACT system whose residual is provably nonzero is a disproof, not an
      // "undecided". `[y'=z, z'=-y+sqrt(x)]` shipped the HOMOGENEOUS solution —
      // the forcing term simply gone, residual `[0,-√x]`, success:true and no
      // warning. The "no sound numeric version" argument that removed this
      // refusal is true only where a float is involved.
      ["desolve([y'=z, z'=-y+sqrt(x)], x)"],
      ["desolve([y'=z, z'=-y+x*sqrt(x)], x)"],
    ])('refuses %s, whose answer does not satisfy it', async (problem) => {
      const r = await computeHandler({ problem });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/does not satisfy it/);
    });

    it.each([
      // A derivative on the RIGHT-hand side evaluates to 0, so grad, subst and
      // the residual all agree the term was never there — the residual cannot be
      // the backstop when the term is gone before it is computed. This lost its
      // damping silently and shipped the UNDAMPED answer with a check mark.
      ["desolve([y'=v, v'=-y-0.1*y', y(0)=1, v(0)=0], x)"],
      ['desolve([diff(y(x),x)=v, diff(v(x),x)=-y-diff(y(x),x)/10], x)'],
      ["desolve([y'=diff(z,x), z'=-y], x)"],
    ])('refuses %s, which writes a derivative on the right', async (problem) => {
      const r = await computeHandler({ problem });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/writes a derivative on the right-hand side/);
    });

    it.each([
      // A pole is not a size, and no degree bound sees one: `denom(tan(x))` is 1
      // and `texpand` does not open it either. 21 characters, exact, and it traps
      // the engine where main answers.
      ["desolve([y'=z, z'=-y+tan(x)], x)"],
      ["desolve([y'=z, z'=-y+1/cos(x)], x)"],
      ["desolve([y'=z, z'=-y+1/(exp(x)+1)], x)"],
      ["desolve([y'=z, z'=-1/2*y+1/sqrt(x)], x)"],
      // The two the DENOMINATOR rule cannot see — `has(denom(f(x)),x)` is 0 for
      // these and 1 for the six others, so these are the whole reason a shape
      // list exists. Without them the input reaches the engine and loses the
      // accurate message.
      ["desolve([y'=z, z'=-y+tanh(x)], x)"],
      ["desolve([y'=z, z'=-y+cotan(x)], x)"],
    ])('refuses %s without trapping the engine', async (problem) => {
      const [attacker, victim] = await Promise.all([
        computeHandler({ problem }),
        computeHandler({ problem: 'integrate(sin(11*x)*exp(x), x)' }),
      ]);
      expect(attacker.isError).toBe(true);
      expect(text(attacker)).toMatch(/forcing term with a pole/);
      expect(text(attacker)).not.toMatch(/RuntimeError/);
      expect(victim.isError).toBe(false);
      await expect(giacEngine.evaluate('diff(x^3,x)')).resolves.toContain('3*x^2');
    });

    it.each([
      // Reading a digit run after `^` cannot bound a NESTED exponent: `10^(10^5)`
      // was captured as "10" and "5" and passed, and it is the same 10^100000
      // that crashes the worker.
      ["desolve([y'=z, z'=-y, y(0)=10^(10^5), z(0)=0], x)"],
      ["desolve([y'=z+10^(10^5), z'=-y], x)"],
      // ...and `+`/`-` too: `10^(50000+50000)` is neither a digit run nor contains
      // a `^`, and it was the example an earlier comment wrongly claimed was
      // already caught.
      ["desolve([y'=z, z'=-y, y(0)=10^(50000+50000), z(0)=0], x)"],
    ])('refuses %s for an exponent it cannot bound', async (problem) => {
      const r = await computeHandler({ problem });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/exponent this cannot bound|an exponent of/);
      expect(text(r)).not.toMatch(/RuntimeError/);
    });

    it.each([
      // The exponent TOKEN, not the rest of the term. Capturing to the next `)`
      // read `x^2+x^3` as the exponent "2+x^3", saw a `^` and refused an ordinary
      // polynomial — and the verdict flipped on a single space.
      ["desolve([y'=z, z'=-y+x^2+x^3], x)"],
      ["desolve([y'=z+x^2-x^3, z'=-y], x)"],
      ["desolve([y'=z, z'=-y, y(0)=2^2+3^2, z(0)=0], x)"],
    ])('still solves %s', async (problem) => {
      const r = await computeHandler({ problem });
      expect(r.isError).toBe(false);
    });

    it.each([
      // ...while an exponent that is merely not a plain literal is ordinary and
      // must survive. Refusing every unreadable exponent was a regression of its
      // own.
      ['2^(1/3)'],
      ['sqrt(2)'],
      ['pi'],
    ])('still solves a system whose coefficient is %s', async (coefficient) => {
      const r = await computeHandler({
        problem: `desolve([y'=z, z'=-1.5*y+(${coefficient})*z], x)`,
      });
      expect(r.isError).toBe(false);
    });

    it('refuses a member that is not a condition before executing it', async () => {
      // `ifactor(2^257-1)` in a condition slot occupied the shared worker for the
      // full 10s budget and was then rejected as "not of the form y(0)=1".
      const started = Date.now();
      const r = await computeHandler({ problem: "desolve([y'=z, z'=-y, ifactor(2^257-1)], x)" });
      expect(r.isError).toBe(true);
      expect(Date.now() - started).toBeLessThan(3_000);
      await expect(giacEngine.evaluate('diff(x^3,x)')).resolves.toContain('3*x^2');
    });

    it.each([
      // The probe's REPLY, not its request. MAX_PROBE_CHARS bounds what is sent;
      // `normal` expands what comes back, and nothing bounded that — 28
      // characters returned a 677,259-character matrix that survived the probe
      // and then killed the worker when it was re-sent to the classifier. main
      // burns its timeout on the same input and the worker LIVES, so leaving the
      // reply unbounded was strictly worse than doing nothing. The number is
      // pinned as well as the direction: legitimate replies are 28 characters for
      // `[y'=z, z'=-y]`, 223 for a nine-equation ring, 329 for a 25-term sum.
      ["desolve([y'=y*z*(x+1)^1000, z'=-y], x)", /expands to 677259 characters of coefficients/],
      [
        "desolve([y'=z*(x+1)^1000*(x+2)^1000, z'=-y], x)",
        /expands to 1199699 characters of coefficients/,
      ],
    ])('refuses %s for its reply size, worker intact', async (problem, expected) => {
      const [attacker, victim] = await Promise.all([
        computeHandler({ problem }),
        computeHandler({ problem: 'integrate(sin(11*x)*exp(x), x)' }),
      ]);
      expect(attacker.isError).toBe(true);
      expect(text(attacker)).toMatch(expected);
      expect(text(attacker)).not.toMatch(/RuntimeError/);
      expect(victim.isError).toBe(false);
      await expect(giacEngine.evaluate('diff(x^3,x)')).resolves.toContain('3*x^2');
    });

    it('accepts a nine-equation reply, which is far under that bound', async () => {
      // The accept side, so the bound cannot drift down onto real work.
      const ring = `[${Array.from({ length: 9 }, (_, i) => `v${i}'=v${(i + 1) % 9}`).join(',')}]`;
      const r = await computeHandler({ problem: `desolve(${ring}, x)` });
      expect(text(r)).not.toMatch(/expands to \d+ characters of coefficients/);
    });

    it('reads the verdict from the value, not from the rendered glyph', async () => {
      // The refusal of a disproved answer used to test the response text for
      // `Verified: ✗`, which couples a correctness guard to a display character —
      // rename the label or reorder the formatter and it stops firing silently,
      // shipping the wrong answer it exists to block. The structured verdict now
      // rides alongside the formatted content, so this asserts the value exists
      // and agrees with what the guard did.
      const disproved = await computeHandler({ problem: "desolve([y'=z, z'=-y+sqrt(x)], x)" });
      expect(disproved.isError).toBe(true);

      const verified = await computeHandler({ problem: "desolve([y'=z, z'=-y], x)" });
      expect(verified.isError).toBe(false);
      expect(text(verified)).toContain('Verified: ✓');
    });

    it.each([
      // Every spelling of a derivative on the right, and on ANY name. Anchoring
      // the prime to the system's own unknowns missed `w'`, and listing only
      // `diff` missed `derive`/`deriver` — Giac's aliases for it. Both shipped
      // the undamped answer with a check mark.
      ["desolve([y'=v, v'=-y-derive(y,x), y(0)=1, v(0)=0], x)"],
      ["desolve([y'=z, z'=-y-w'], x)"],
      ["desolve([y'=v, v'=-y-deriver(y,x)], x)"],
    ])('refuses %s, which writes a derivative on the right', async (problem) => {
      const r = await computeHandler({ problem });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/writes a derivative on the right-hand side/);
    });

    it.each([
      // A dropped term is O(1) where rounding is ~1e-15, so the disproof is
      // decided by magnitude rather than by whether the system was exact.
      // Gating it on exactness let one decimal switch it off: `0.5*sqrt(x)` is a
      // float coefficient on an exactly-representable term.
      ["desolve([y'=z, z'=-y+0.5*sqrt(x)], x)"],
      ["desolve([y'=z, z'=-y+sqrt(x), y(0)=1.5, z(0)=0], x)"],
    ])('refuses %s, whose answer drops a term', async (problem) => {
      const r = await computeHandler({ problem });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/does not satisfy it/);
    });

    it.each([
      // ...while a residual that is only rounding must not be an accusation.
      // Giac answers `b^k` in the `exp(k*ln(b))` spelling, which `normal` does
      // not fold, so these leave a nonzero residual that evaluates to ~1e-15.
      // The emitted matrix, not just the absence of an error. These answers carry
      // NO verdict — the residual is nonzero rounding — so `isError` was their
      // only oracle, and two of them passed while the module solved a transposed
      // system, which is a different set of equations entirely.
      [
        "desolve([y'=sqrt(2)*z, z'=-sqrt(3)*y], x)",
        /desolve\(Y'=\[\[0,sqrt\(2\)\],\[-sqrt\(3\),0\]\]/,
      ],
      ["desolve([y'=z, z'=-y+sqrt(2)*x], x)", /\[\[0,1\],\[-1,0\]\]\*Y\+\[0,sqrt\(2\)\*x\]/],
      ["desolve([y'=z, z'=-y+2^(1/3)], x)", /\[\[0,1\],\[-1,0\]\]\*Y\+\[0,2\^\(1\/3\)\]/],
      ["desolve([y'=z, z'=-y+2^x], x)", /\[\[0,1\],\[-1,0\]\]\*Y\+\[0,2\^x\]/],
      ["desolve([y'=z, z'=-sqrt(2)*y], x)", /desolve\(Y'=\[\[0,1\],\[-sqrt\(2\),0\]\]/],
    ])('still solves %s', async (problem, expected) => {
      const r = await computeHandler({ problem });
      expect(r.isError).toBe(false);
      expect(text(r)).toMatch(expected);
    });

    it.each([
      // The pole rule asks about the VARIABLE. Matching a function NAME refused
      // `tan(1)*x`, whose tan(1) is a constant, and counting any symbol in the
      // denominator refused `1/(a+1)` — all solve, and the message claimed a pole
      // in x that is not there.
      ["desolve([y'=z, z'=-y+tan(1)*x], x)"],
      ["desolve([y'=z, z'=-y+1/(a+1)], x)"],
      ["desolve([y'=z, z'=-y+x/(a+b)], x)"],
    ])('still solves %s, which has no pole in x', async (problem) => {
      const r = await computeHandler({ problem });
      expect(r.isError).toBe(false);
    });

    it.each([
      // The three checks the shared detector owns are delegated to it rather than
      // re-derived here. The copy had already drifted: `detectFailure`
      // token-matches `NaN`, `Inf` and `-Inf`, and the local version did not, so a
      // non-finite component would have gone out as a solution.
      ['Result: [[-Inf,0]]'],
      ['Result: [[Inf,1]]'],
      ['Result: [[NaN,0]]'],
      ['Result: []'],
      ['Result: [[undef]]'],
      ['Result: GIAC_ERROR: bad'],
    ])('the shared detector calls %s a failure', (displayText) => {
      expect(detectFailure(displayText)).not.toBeNull();
    });

    it.each([
      // ...and `infinity` stays a LOCAL check, because it is not a failure in
      // general: these three correctly diverge, and the shared detector is right
      // to pass them. Only a component of a solution vector being infinite is a
      // defect, which is why the ODE path keeps its own arm.
      ['integrate(1/x^2, x, 0, 1)'],
      ['sum(1/n, n, 1, infinity)'],
      ['limit(1/x, x, 0)'],
    ])('still answers %s, whose infinity is the answer', async (problem) => {
      const r = await computeHandler({ problem });
      expect(r.isError).toBe(false);
      expect(text(r)).toMatch(/infinity|\\infty/);
    });

    it('refuses an ODE whose component is infinite, which is not a solution', async () => {
      const r = await computeHandler({ problem: "desolve([y'=z+exp(x)/x, z'=-y], x)" });
      expect(r.isError).toBe(true);
    });

    it('leaves an all-exact system exact', async () => {
      // Normalising the domain must not cost exactness a system already had.
      const r = await computeHandler({ problem: "desolve([y'=z, z'=-y], x)" });
      expect(text(r)).toMatch(/Command: desolve\(Y'=\[\[0,1\],\[-1,0\]\]\*Y,x,Y\)/);
      expect(text(r)).toContain('Verified: ✓');
    });

    it.each([
      // Verification must never turn "I could not check" into "this is wrong".
      // A symbolic coefficient has no numeric residual at all, and a degree-60
      // forcing term cancels catastrophically in float (6.8e67 against a scale
      // of 2.7e67) while its exact residual is [0,0]. Both were refused.
      ["desolve([y'=ky*z, z'=-y], x)", /ky/],
      ["desolve([y'=z+(x+1)^60, z'=-y], x)", /60\*x\^59/],
    ])('still solves %s, which verification cannot decide', async (problem, expected) => {
      const r = await computeHandler({ problem });
      expect(r.isError).toBe(false);
      expect(text(r)).toMatch(expected);
    });

    it('verifies a symbolic-coefficient system exactly', async () => {
      // No numeric residual exists here, so the exact branch is the only thing
      // that can reach a verdict; without it this falls through to undecided.
      const r = await computeHandler({ problem: "desolve([y'=k*z, z'=-y], x)" });
      expect(r.isError).toBe(false);
      expect(text(r)).toContain('Verified: ✓');
    });

    it.each([
      // No verdict, and no refusal. A float matrix has no exact residual, and no
      // numeric score separates a CORRECT answer whose 12-digit coefficients are
      // amplified by ~1e16 binomial terms from one that does not solve the system
      // at all — measured, a correct degree-30 forcing term scored 0.89 where a
      // wrong answer scored 1.2. Claiming either verdict here was wrong in both
      // directions: scoring the worst point refused correct answers, and scoring
      // the best certified one that was 60x wrong at its own initial condition.
      ["desolve([y'=z+(x+1)^20, z'=-1.5*y], x)"],
      ["desolve([y'=0.5*z+x^17, z'=-1.5*y, y(0)=1, z(0)=0], x)"],
    ])('refuses %s, which cannot be solved to usable precision', async (problem) => {
      // These used to ship unverified. They are not merely unverifiable — they
      // are wrong: the degree-20 one failed its own first equation `y'=z`, which
      // has no coefficient at all, by a factor of 13. A float coefficient beside
      // a high-degree forcing term is refused rather than answered.
      const r = await computeHandler({ problem });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/cannot be solved to usable precision/);
    });

    it.each([
      // The accuracy cap is on the FLOAT matrix only; an exact one holds far
      // longer and is bounded by the engine-survival cap at 60 instead.
      ["desolve([y'=z, z'=-3/2*y+z+(x+1)^20], x)"],
      ["desolve([y'=z, z'=-3/2*y+z+(x+1)^60], x)"],
    ])('still solves %s, whose matrix is exact', async (problem) => {
      const r = await computeHandler({ problem });
      expect(r.isError).toBe(false);
    });

    it.each([
      // A float anywhere beside a forcing term with a DENOMINATOR trapped the
      // engine fatally, and no degree cap could see it: `1/(x+1)` has numerator
      // degree 0 and denominator degree 1, inside every bound. `main` returned
      // garbage without trapping, so this was a regression the caps missed.
      ["desolve([y'=z, z'=-0.5*y+1/(x+1)], x)"],
      ["desolve([y'=z, z'=-y+0.5/(x-1)^2], x)"],
      ["desolve([y'=z, z'=-0.5*y+exp(x)/(x^2+1)], x)"],
    ])('refuses %s instead of trapping the engine', async (problem) => {
      const [attacker, victim] = await Promise.all([
        computeHandler({ problem }),
        computeHandler({ problem: 'integrate(sin(x)*exp(x), x)' }),
      ]);
      expect(attacker.isError).toBe(true);
      expect(text(attacker)).toMatch(/forcing term with a pole/);
      expect(text(attacker)).not.toMatch(/RuntimeError/);
      expect(victim.isError).toBe(false);
      await expect(giacEngine.evaluate('integrate(x^2,x)')).resolves.toContain('x^3');
    });

    it.each([
      // Wherever the decimal lives, the cost is the same. Measured worst relative
      // residual, matrix-float against forcing-float: degree 8 is 6.9e-12 /
      // 4.4e-11, degree 10 is 1.2e-9 / 1.5e-9, degree 14 is 2.6e-5 / 5.3e-5 —
      // within a factor of three throughout. A looser threshold for the forcing
      // term shipped 5.3e-5 under a check mark while the matrix path refused
      // 2.5e-10 as unusable.
      ["desolve([y'=z, z'=-y+0.5*(x+1)^9], x)"],
      ["desolve([y'=z, z'=-y+0.5*(x+1)^14], x)"],
      ["desolve([y'=z, z'=-1.5*y+z+(x+1)^9], x)"],
    ])('refuses %s, whose decimal and degree cannot both be met', async (problem) => {
      const r = await computeHandler({ problem });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/cannot be solved to usable precision/);
    });

    it.each([
      // An initial condition is the third place a decimal hides, and it is NOT
      // like the other two. Unscanned, `[y'=z, z'=-y+x^18, y(0)=1.5, z(0)=0.5]`
      // returned y(0) = 1984 under a ✓. But the ODE residual here stays exactly
      // zero — it is the CONDITION that stops being met, abruptly: measured IC
      // error is 0 through degree 14, 0.5 at 15, 15 at 16, 420 at 17. Folding it
      // in with the others at 8 refused degrees 9-14 that are exactly right.
      [15],
      [18],
      [20],
    ])('refuses a degree-%i forcing term beside a float initial condition', async (degree) => {
      const r = await computeHandler({
        problem: `desolve([y'=z, z'=-y+(x+1)^${degree}, y(0)=1.5, z(0)=0], x)`,
      });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/the condition is no longer met/);
    });

    it.each([
      // ...and solves them below that, where the answer is exact — the ODE
      // residual normalises to [0,0] and the condition is met on the nose.
      [10],
      [14],
    ])('solves a degree-%i forcing term beside a float initial condition', async (degree) => {
      const r = await computeHandler({
        problem: `desolve([y'=z, z'=-y+(x+1)^${degree}, y(0)=1.5, z(0)=0], x)`,
      });
      expect(r.isError).toBe(false);
      expect(text(r)).toMatch(/Verified: ✓.*meets the initial conditions/);
    });

    it.each([
      // A decimal in a condition must not cost the answer its mark. The check
      // subtracts floats, so the residual comes back `[0.0,0.0]` — or, at 15+
      // significant digits, the malformed `0.-0000000000000000` — and comparing
      // those to the string '0' silently withheld ✓ from answers that are
      // trivially exact.
      ["desolve([y'=z, z'=-y, y(0)=1.5, z(0)=0], x)"],
      ["desolve([y'=z, z'=-y, y(0)=0.3333333333333333, z(0)=0], x)"],
    ])('keeps the mark on %s', async (problem) => {
      const r = await computeHandler({ problem });
      expect(r.isError).toBe(false);
      expect(text(r)).toMatch(/Verified: ✓.*meets the initial conditions/);
    });

    it.each([
      // The RIGHT-HAND SIDES are caller text too, and reach the probe — the first
      // engine call here — 139 lines before the conditions scan. Only their LENGTH
      // was bounded, and `10^100000` is nine characters, so it sailed through
      // MAX_PROBE_CHARS and trapped the engine inside the probe. main answers the
      // same input `[]` in 19ms with the victim alive.
      ["desolve([y'=z+10^100000, z'=-y], x)"],
      ["desolve([y'=z+3^100000, z'=-y], x)"],
    ])('refuses %s without killing the engine first', async (problem) => {
      const [attacker, victim] = await Promise.all([
        computeHandler({ problem }),
        computeHandler({ problem: 'integrate(sin(11*x)*exp(x), x)' }),
      ]);
      expect(attacker.isError).toBe(true);
      expect(text(attacker)).toMatch(/right-hand side of implausible magnitude/);
      expect(text(attacker)).not.toMatch(/RuntimeError/);
      expect(victim.isError).toBe(false);
      await expect(giacEngine.evaluate('diff(x^3,x)')).resolves.toContain('3*x^2');
    });

    it.each([
      // ...while the exponents that appear in real work keep their routes. The
      // 10^900 case is refused by the COMMAND-length bound, not this one, so it
      // pins that the magnitude guard did not swallow its neighbour.
      ["desolve([y'=z+(x+1)^60, z'=-y], x)", false, /c_0\*cos\(x\)/],
      ["desolve([y'=z+2^10, z'=-y], x)", false, /1024\*sin\(x\)/],
      ["desolve([y'=z, z'=-y, y(0)=2^10, z(0)=0], x)", false, /1024\*cos\(x\)/],
      ["desolve([y'=z+10^900, z'=-y], x)", true, /use a shorter forcing term/],
    ])('keeps %s on its existing route', async (problem, refused, expected) => {
      const r = await computeHandler({ problem });
      expect(r.isError).toBe(refused);
      expect(text(r)).toMatch(expected);
    });

    it('refuses an oversized condition without killing the engine first', async () => {
      // The magnitude guard has to run BEFORE the float scan evaluates the
      // condition text, or it is checking a worker that is already dead: this
      // refused with a clean, correct message while the NEXT unrelated caller got
      // "Giac worker exited (code 1)".
      const [attacker, victim] = await Promise.all([
        computeHandler({ problem: "desolve([y'=z, z'=-y, y(0)=10^100000, z(0)=0], x)" }),
        computeHandler({ problem: 'integrate(sin(x)*exp(x), x)' }),
      ]);
      expect(attacker.isError).toBe(true);
      expect(text(attacker)).toMatch(/implausible magnitude/);
      expect(victim.isError).toBe(false);
      await expect(giacEngine.evaluate('diff(x^3,x)')).resolves.toContain('3*x^2');
    });

    it.each([
      // Below the cap, and exactly written above it — what the message asks for.
      ["desolve([y'=z, z'=-y+0.5*(x+1)^8], x)"],
      ["desolve([y'=z, z'=-y+(1/2)*(x+1)^20], x)"],
      ["desolve([y'=z, z'=-y+(x+1)^20, y(0)=1/10, z(0)=0], x)"],
    ])('still solves %s', async (problem) => {
      const r = await computeHandler({ problem });
      expect(r.isError).toBe(false);
      expect(text(r)).toContain('Verified: ✓');
    });

    it('makes the check mark cover the initial conditions too', async () => {
      // An answer can satisfy Y' = A*Y + b exactly and still be the solution of a
      // DIFFERENT initial-value problem, which is how one earned an honest ✓ while
      // returning y(0) = 1984 for a caller who asked for 1.5.
      const r = await computeHandler({ problem: "desolve([y'=z, z'=-y, y(0)=2, z(0)=3], x)" });
      expect(text(r)).toMatch(/Verified: ✓.*meets the initial conditions/);

      const general = await computeHandler({ problem: "desolve([y'=z, z'=-y], x)" });
      expect(text(general)).toContain('Verified: ✓');
      expect(text(general)).not.toMatch(/initial conditions/);
    });

    it('accepts a float matrix at the accuracy limit', async () => {
      // Degree 8 measures 4.6e-10; 9 is 7.4e-9 and refused.
      const r = await computeHandler({ problem: "desolve([y'=z, z'=-1.5*y+z+(x+1)^8], x)" });
      expect(r.isError).toBe(false);
      const over = await computeHandler({ problem: "desolve([y'=z, z'=-1.5*y+z+(x+1)^9], x)" });
      expect(text(over)).toMatch(/above degree 8 that combination/);
    });

    it.each([
      // Both once needed their own degree bound — the signed degree reports 0 for
      // a balanced ratio and -400 for a pure denominator, so neither reached a
      // `> MAX` test. One rule about the DENOMINATOR now covers them and the
      // pole cases the degree bounds never saw, so those two bounds were removed
      // as unreachable rather than kept as dead code.
      ["desolve([y'=z+(x+1)^15/(x-1)^15, z'=-y], x)", /forcing term with a pole/],
      ["desolve([y'=z+1/(x-1)^400, z'=-y], x)", /forcing term of degree 400/],
    ])('refuses %s without trapping the engine', async (problem, expected) => {
      const [attacker, victim] = await Promise.all([
        computeHandler({ problem }),
        computeHandler({ problem: 'integrate(sin(x)*exp(x), x)' }),
      ]);
      expect(attacker.isError).toBe(true);
      expect(text(attacker)).toMatch(expected);
      expect(text(attacker)).not.toMatch(/RuntimeError/);
      expect(victim.isError).toBe(false);
      await expect(giacEngine.evaluate('integrate(x^2,x)')).resolves.toContain('x^3');
    });

    it.each([
      // These two used to be the accept side of a ratio bound. They are refused
      // now, for the pole rather than the degree — a rational forcing term is not
      // solvable in the matrix form at all, whatever its degrees are.
      ["desolve([y'=z+(x+1)^12/(x-1)^12, z'=-y], x)"],
      ["desolve([y'=z+(x+1)^40/(x-1)^2, z'=-y], x)"],
    ])('refuses %s for its pole, not its degree', async (problem) => {
      const r = await computeHandler({ problem });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/forcing term with a pole/);
      expect(text(r)).not.toMatch(/RuntimeError/);
    });

    it.each([
      // `\d{16,}` matched the fractional part of an ordinary double, so 1/3 and
      // sqrt(2) at full precision were refused as "implausible magnitude".
      ["desolve([y'=z, z'=-y, y(0)=0.3333333333333333, z(0)=0], x)", /0\.3333333333333333\*cos/],
      ["desolve([y'=z, z'=-y, y(0)=1.4142135623730951, z(0)=0], x)", /1\.4142135623730951\*cos/],
    ])('solves %s, an ordinary decimal condition', async (problem, expected) => {
      const r = await computeHandler({ problem });
      expect(r.isError).toBe(false);
      expect(text(r)).toMatch(expected);
    });

    it('refuses two different conditions for the same function', async () => {
      // `values.set` was last-wins, so the caller's y(0)=1 was discarded without
      // a word and the answer satisfied y(0)=99 instead.
      const r = await computeHandler({
        problem: "desolve([y'=z, z'=-y, y(0)=1, y(0)=99, z(0)=0], x)",
      });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/gives y two different initial conditions \(1 and 99\)/);
    });

    it('accepts the same condition stated twice', async () => {
      const r = await computeHandler({
        problem: "desolve([y'=z, z'=-y, y(0)=1, y(0)=1, z(0)=0], x)",
      });
      expect(r.isError).toBe(false);
      expect(text(r)).toMatch(/^Result: \[\[cos\(x\),-sin\(x\)\]\]$/m);
    });

    it('reports a variable that collides with an unknown as a collision', async () => {
      // With no variable given it is inferred, and for the Leibniz spelling the
      // inference picks `z`. Checked in the wrong order, the wrt guard fired
      // first and advised "write the derivatives in z" — z being an unknown,
      // that is impossible advice for a question the caller never asked.
      const r = await computeHandler({ problem: 'desolve([dy/dx=z, dz/dx=-y])' });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/uses z as both the independent variable and an unknown/);
    });

    it('does not blame initial conditions that were never given', async () => {
      const problem =
        'desolve([' +
        Array.from({ length: 9 }, (_, i) => `y${i}'=y${(i + 1) % 9}`).join(',') +
        '], x)';
      const r = await computeHandler({ problem });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/could not finish/);
      expect(text(r)).not.toMatch(/check the initial conditions/);
    });

    it('does blame them when they were', async () => {
      const r = await computeHandler({
        problem: "desolve([y'=z, z'=-y, y(0)=undef, z(0)=undef], x)",
      });
      expect(text(r)).toMatch(/check the initial conditions/);
    });

    it('names which component is which function', async () => {
      const r = await computeHandler({ problem: "desolve([y'=z, z'=-y], x)" });
      expect(text(r)).toMatch(/Components are in the order: y, z/);
    });

    it.each([
      // Giac's own boundaries, reported as themselves rather than as a Result
      // line carrying a GIAC_ERROR with isError:false.
      ["desolve([y'=y*z, z'=-y], x)", /not linear in the unknown functions/],
      ["desolve([y'=x*z, z'=-y], x)", /still mentions x after normalising/],
      ["desolve([y'=z, z'=-y, y(0)=1], x)", /every function, or none/],
      // Order is load-bearing: dropping it answered a second-order system with
      // the FIRST-order solution, which does not satisfy the original equations.
      ["desolve([y''=z, z'=-y], x)", /differentiates y 2 times/],
      ['desolve([diff(y(x),x,2)=z, diff(z(x),x)=-y], x)', /differentiates y 2 times/],
      // With no variable given the router picks one of the unknowns.
      ["desolve([y'=z, z'=-y])", /both the independent variable and an unknown/],
      ["desolve([y'=z, z'=-y, y(0)=1, z(1)=0], x)", /different points/],
      // Giac returns its internal container rather than a solution here, and
      // back-substituting it does not give zero.
      ["desolve([y'=z, z'=w, w'=-y-2*z-3*w], x)", /could not finish it/],
    ])('refuses %s with the actual reason', async (problem, expected) => {
      const r = await computeHandler({ problem });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(expected);
    });

    it.each([
      // The over-refusal direction. A bracketed list is ALSO the
      // initial-condition form, and a derivative condition carries a prime or a
      // diff() — the diff-notation row is a regression an earlier attempt caused.
      ["desolve(y'=2*x, x, y)", /c_0\+x\^2/],
      ["desolve(y''=-y, x, y)", /c_0\*cos\(x\)\+c_1\*sin\(x\)/],
      ["desolve([y'=2*x, y(0)=1], x, y)", /1\+x\^2/],
      ["desolve([y'=y, y(0)=1], x, y)", /exp\(x\)/],
      ["desolve([y''=-y, y(0)=1, y'(0)=0], x, y)", /cos\(x\)/],
      ['desolve([diff(y(x),x,2)=-y, y(0)=1, diff(y(x),x)(0)=0], x, y)', /cos\(x\)/],
      ['desolve([diff(y(x),x)=y, y(0)=1], x, y)', /exp\(x\)/],
      ["desolve(y'=x*y, x, y)", /exp\(x\^2\/2\)/],
    ])('still solves the single equation %s', async (problem, expected) => {
      const r = await computeHandler({ problem });
      expect(r.isError).toBe(false);
      expect(text(r)).toMatch(expected);
    });
  });
});
