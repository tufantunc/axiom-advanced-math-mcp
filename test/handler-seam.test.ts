import { describe, it, expect, beforeAll } from 'vitest';
import { giacEngine } from '../src/server/giac/index.js';
import { computeHandler } from '../src/server/tools/compute/index.js';
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
      expect((t.match(/result is infinite/g) ?? []).length).toBe(1);
    });

    it('reaches a JSON consumer through envelope.warnings', async () => {
      const env = JSON.parse(text(await computeHandler({ problem: '1/0', format: 'json' })));
      expect(env.success).toBe(true);
      expect(env.warnings?.join(' ')).toMatch(/result is infinite/);
    });

    it('does not relabel another handler\'s advisory note as a warning', async () => {
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
});

