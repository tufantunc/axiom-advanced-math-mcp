import { describe, it, expect, beforeAll, vi, afterEach } from 'vitest';
import { giacEngine } from '../src/server/giac/index.js';
import { hypothesisTestingHandler } from '../src/server/tools/hypothesis-testing.js';

beforeAll(async () => {
  await giacEngine.initialize();
}, 60000);

function allText(r: { content: { text: string }[] }): string {
  return r.content.map((c) => c.text).join('\n');
}

describe('hypothesis_testing', () => {
  describe('one_sample_t', () => {
    it('should reject H0 when sample mean differs significantly from mu0', async () => {
      // Sample clearly not from mu0=0
      const sample1 = [10, 11, 12, 10.5, 11.5, 12.5, 10.2, 11.8, 12.1, 10.8];
      const result = await hypothesisTestingHandler({
        test: 'one_sample_t',
        data: { sample1, mu0: 0, significance: 0.05 },
        alternative: 'two_sided',
      });
      expect(result.isError).toBe(false);
      expect(allText(result)).toContain('Reject H₀');
      expect(allText(result)).toContain('t-statistic');
      expect(allText(result)).toContain('p-value');
    });

    it('should fail to reject H0 when sample is consistent with mu0', async () => {
      // Sample around mu0=5
      const sample1 = [4.9, 5.1, 5.0, 4.95, 5.05, 5.02, 4.98, 5.01];
      const result = await hypothesisTestingHandler({
        test: 'one_sample_t',
        data: { sample1, mu0: 5, significance: 0.05 },
        alternative: 'two_sided',
      });
      expect(result.isError).toBe(false);
      expect(allText(result)).toContain('Fail to reject H₀');
    });

    it('should return error without mu0', async () => {
      const result = await hypothesisTestingHandler({
        test: 'one_sample_t',
        data: { sample1: [1, 2, 3], significance: 0.05 },
        alternative: 'two_sided',
      });
      // Was `isError: false` with an `Error:` body — a failure the MCP client
      // reads as a successful answer. The handler now flags it.
      expect(result.isError).toBe(true);
      expect(allText(result)).toContain('requires mu0');
    });
  });

  describe('two_sample_t', () => {
    it('should detect significant difference between groups', async () => {
      const sample1 = [2, 3, 2.5, 2.8, 3.2, 2.7];
      const sample2 = [8, 9, 8.5, 9.2, 7.8, 8.7];
      const result = await hypothesisTestingHandler({
        test: 'two_sample_t',
        data: { sample1, sample2, significance: 0.05 },
        alternative: 'two_sided',
      });
      expect(result.isError).toBe(false);
      expect(allText(result)).toContain('Reject H₀');
    });

    it('should not detect difference between similar groups', async () => {
      const sample1 = [5.0, 5.1, 4.9, 5.0, 5.2];
      const sample2 = [5.1, 4.9, 5.0, 5.1, 4.8];
      const result = await hypothesisTestingHandler({
        test: 'two_sample_t',
        data: { sample1, sample2, significance: 0.05 },
        alternative: 'two_sided',
      });
      expect(result.isError).toBe(false);
      expect(allText(result)).toContain('Fail to reject H₀');
    });
  });

  describe('paired_t', () => {
    it('should detect significant before/after effect', async () => {
      const before = [70, 75, 68, 72, 80];
      // Around 10 units lower, but NOT identically so. An exactly-constant drop
      // makes the differences zero-variance, which divides the t-statistic by a
      // zero standard error — the old fixture asserted a verdict from t = Infinity.
      const after = [60, 66, 57, 63, 69];
      const result = await hypothesisTestingHandler({
        test: 'paired_t',
        data: { sample1: before, sample2: after, significance: 0.05 },
        alternative: 'two_sided',
      });
      expect(result.isError).toBe(false);
      expect(allText(result)).toContain('Reject H₀');
    });
  });

  describe('chi_square_independence', () => {
    it('should detect dependence in 2x2 contingency table', async () => {
      // Clear dependence
      const table = [
        [50, 5],
        [5, 50],
      ];
      const result = await hypothesisTestingHandler({
        test: 'chi_square_independence',
        data: { contingency_table: table, significance: 0.05 },
        alternative: 'two_sided',
      });
      expect(result.isError).toBe(false);
      expect(allText(result)).toContain('χ²');
      expect(allText(result)).toContain('p-value');
      expect(allText(result)).toContain('Reject H₀');
    });

    it('should not detect dependence in independent table', async () => {
      // Expected frequencies proportional → no dependence
      const table = [
        [25, 25],
        [25, 25],
      ];
      const result = await hypothesisTestingHandler({
        test: 'chi_square_independence',
        data: { contingency_table: table, significance: 0.05 },
        alternative: 'two_sided',
      });
      expect(result.isError).toBe(false);
      expect(allText(result)).toContain('Fail to reject H₀');
    });
  });

  describe('one_way_anova', () => {
    it('should detect significant group difference', async () => {
      const groups = [
        [2, 3, 2.5, 2.8],
        [8, 9, 8.5, 9.2],
        [15, 16, 14.5, 15.8],
      ];
      const result = await hypothesisTestingHandler({
        test: 'one_way_anova',
        data: { groups, significance: 0.05 },
        alternative: 'two_sided',
      });
      expect(result.isError).toBe(false);
      expect(allText(result)).toContain('F =');
      expect(allText(result)).toContain('Reject H₀');
    });

    it('should require at least 3 groups', async () => {
      const result = await hypothesisTestingHandler({
        test: 'one_way_anova',
        data: {
          groups: [
            [1, 2],
            [3, 4],
          ],
          significance: 0.05,
        },
        alternative: 'two_sided',
      });
      expect(result.isError).toBe(true);
      expect(allText(result)).toContain('at least 3 groups');
    });
  });

  describe('a non-finite statistic is never reported as a verdict', () => {
    // The p-value guard in formatTestConclusion could not catch these: the
    // statistic is NaN, but Giac turns a NaN argument into a finite cdf, so the
    // p-value that reaches the guard is an ordinary number. Each of these
    // reported a confident conclusion before the statistic itself was checked.
    it('refuses an empty contingency table instead of finding dependence', async () => {
      const r = await hypothesisTestingHandler({
        test: 'chi_square_independence',
        data: { contingency_table: [[0, 0], [0, 0]] },
      });
      expect(r.isError).toBe(true);
      // Pins WHICH guard is expected to win. Asserting only 'no observations'
      // left this passing when either the row or the column guard was removed,
      // because the other caught it with the same wording — so it proved nothing.
      expect(allText(r)).toMatch(/row 1 .* no observations/);
    });

    it('refuses a negative count instead of finding dependence', async () => {
      // Reachable with no empty row or column, so it needs its own guard:
      // [[10,-2],[3,4]] reported "✗ Reject H₀ — evidence of dependence".
      const r = await hypothesisTestingHandler({
        test: 'chi_square_independence',
        data: { contingency_table: [[10, -2], [3, 4]] },
      });
      expect(r.isError).toBe(true);
      expect(allText(r)).toMatch(/cannot be negative/);
      expect(allText(r)).not.toContain('evidence of dependence');
    });

    it('refuses a contingency table with an empty row', async () => {
      const r = await hypothesisTestingHandler({
        test: 'chi_square_independence',
        data: { contingency_table: [[0, 0], [5, 7]] },
      });
      expect(r.isError).toBe(true);
      expect(allText(r)).toMatch(/row 1 .* no observations/);
      expect(allText(r)).not.toContain('evidence of dependence');
    });

    it('refuses a contingency table with an empty column', async () => {
      const r = await hypothesisTestingHandler({
        test: 'chi_square_independence',
        data: { contingency_table: [[0, 5], [0, 7]] },
      });
      expect(r.isError).toBe(true);
      expect(allText(r)).toMatch(/column 1 .* no observations/);
    });

    it('refuses ANOVA when no group varies', async () => {
      const r = await hypothesisTestingHandler({
        test: 'one_way_anova',
        data: { groups: [[5, 5, 5], [5, 5, 5], [5, 5, 5]] },
      });
      expect(r.isError).toBe(true);
      expect(allText(r)).toContain('zero variance');
      expect(allText(r)).not.toContain('Fail to reject');
    });

    it('refuses ANOVA when the groups are constant but differ', async () => {
      // ss_within is 0 while ss_between is not, so F is Infinity rather than NaN.
      const r = await hypothesisTestingHandler({
        test: 'one_way_anova',
        data: { groups: [[1, 1], [2, 2], [3, 3]] },
      });
      expect(r.isError).toBe(true);
      expect(allText(r)).toContain('zero variance');
    });

    it('still reports a real verdict on data that varies', async () => {
      // The guard must not swallow working input: this is the control.
      const r = await hypothesisTestingHandler({
        test: 'one_way_anova',
        data: { groups: [[1, 2, 3], [4, 5, 6], [7, 8, 9]] },
      });
      expect(r.isError).toBe(false);
      expect(allText(r)).toContain('Reject H₀');
    });

    it('still reports a real verdict on a populated table', async () => {
      const r = await hypothesisTestingHandler({
        test: 'chi_square_independence',
        data: { contingency_table: [[10, 20], [30, 40]] },
      });
      expect(r.isError).toBe(false);
      expect(allText(r)).toContain('Fail to reject H₀');
    });

    it('still tests three identical groups rather than refusing them', async () => {
      // Identical groups have real within-group variance, so F = 0 is a genuine
      // answer, not a degenerate one.
      const r = await hypothesisTestingHandler({
        test: 'one_way_anova',
        data: { groups: [[1, 2, 3], [1, 2, 3], [1, 2, 3]] },
      });
      expect(r.isError).toBe(false);
      expect(allText(r)).toContain('Fail to reject H₀');
    });
  });

  describe('degenerate t-tests are refused where the statistic is formed', () => {
    // paired_t tests the DIFFERENCES, so a guard on sample1/sample2 never saw
    // these: both reported "✗ Reject H₀ (p = 0.0000)" — the strongest possible
    // claim of a difference, one of them between two identical inputs.
    it('refuses paired_t on two identical samples', async () => {
      const r = await hypothesisTestingHandler({
        test: 'paired_t',
        data: { sample1: [1, 2, 3], sample2: [1, 2, 3] },
      });
      expect(r.isError).toBe(true);
      expect(allText(r)).not.toContain('Reject H₀');
    });

    it('refuses paired_t when every difference is identical', async () => {
      const r = await hypothesisTestingHandler({
        test: 'paired_t',
        data: { sample1: [1, 2, 3], sample2: [2, 3, 4] },
      });
      expect(r.isError).toBe(true);
    });

    it('allows Welch t when only ONE sample is constant', async () => {
      // Welch divides by the pooled standard error, so this is well defined. The
      // handler-level guard this replaced refused it.
      const r = await hypothesisTestingHandler({
        test: 'two_sample_t',
        data: { sample1: [2, 2, 2], sample2: [5, 7, 9] },
      });
      expect(r.isError).toBe(false);
      expect(allText(r)).toContain('t-statistic');
    });

    it('refuses Welch t when neither sample varies', async () => {
      const r = await hypothesisTestingHandler({
        test: 'two_sample_t',
        data: { sample1: [2, 2, 2], sample2: [5, 5, 5] },
      });
      expect(r.isError).toBe(true);
      expect(allText(r)).toMatch(/neither sample varies/);
    });
  });

  describe('guards that only overflow or degenerate shapes reach', () => {
    it('refuses a ragged contingency table', async () => {
      // The extra cell was counted in the row sums and in N but never entered the
      // χ² sum, so [[1,2],[3,4,5]] reported "Table: 2×2, N = 15" — marginals that
      // sum to 10 — and a confident verdict. χ² stays finite, so no finiteness
      // check could catch it.
      const r = await hypothesisTestingHandler({
        test: 'chi_square_independence',
        data: { contingency_table: [[1, 2], [3, 4, 5]] },
      });
      expect(r.isError).toBe(true);
      expect(allText(r)).toMatch(/row 2 has 3 entries but row 1 has 2/);
    });

    it('allows an unbalanced ANOVA — groups need not be equal length', async () => {
      const r = await hypothesisTestingHandler({
        test: 'one_way_anova',
        data: { groups: [[1], [2, 3], [4, 5]] },
      });
      expect(r.isError).toBe(false);
      // A one-element group has no sample std; it must not render as NaN beside
      // a real verdict.
      expect(allText(r)).toContain('std=n/a');
      expect(allText(r)).not.toContain('NaN');
    });

    it('refuses a contingency table with no degrees of freedom', async () => {
      const r = await hypothesisTestingHandler({
        test: 'chi_square_independence',
        data: { contingency_table: [[5], [7]] },
      });
      expect(r.isError).toBe(true);
      expect(allText(r)).toMatch(/df = 0/);
    });

    it('refuses ANOVA with no within-group degrees of freedom', async () => {
      const r = await hypothesisTestingHandler({
        test: 'one_way_anova',
        data: { groups: [[1], [2], [3]] },
      });
      expect(r.isError).toBe(true);
      expect(allText(r)).toMatch(/within-group degrees of freedom/);
    });

    it('refuses ANOVA when an intermediate overflows, not just F', async () => {
      // F is a ratio, so an infinite denominator collapses to a FINITE 0. This
      // cleared an F-only check and reported "✓ Fail to reject H₀".
      const r = await hypothesisTestingHandler({
        test: 'one_way_anova',
        data: { groups: [[1e200, -1e200], [1, 2], [3, 4]] },
      });
      expect(r.isError).toBe(true);
      expect(allText(r)).toMatch(/overflow/);
      expect(allText(r)).not.toContain('Fail to reject');
    });

    it('refuses a chi-square table whose counts overflow', async () => {
      const r = await hypothesisTestingHandler({
        test: 'chi_square_independence',
        data: { contingency_table: [[1e308, 1e308], [1e308, 1e308]] },
      });
      expect(r.isError).toBe(true);
      expect(allText(r)).toMatch(/overflow/);
    });
  });

  describe('the guards do not over-refuse', () => {
    it('accepts genuinely small within-group variance', async () => {
      // Pins the threshold. A guard widened to `msWithin <= 1e-6` would refuse
      // real replicate measurements while the rest of the suite stayed green.
      const r = await hypothesisTestingHandler({
        test: 'one_way_anova',
        data: {
          groups: [
            [1.0001, 1.0002, 1.0003],
            [2.0001, 2.0002, 2.0003],
            [3.0001, 3.0002, 3.0003],
          ],
        },
      });
      expect(r.isError).toBe(false);
    });

    it('accepts a table with a single zero cell', async () => {
      // A zero CELL is ordinary; only a zero row or column total is degenerate.
      // Pins `v < 0` against a drift to `v <= 0`.
      const r = await hypothesisTestingHandler({
        test: 'chi_square_independence',
        data: { contingency_table: [[0, 5], [7, 3]] },
      });
      expect(r.isError).toBe(false);
      expect(allText(r)).toContain('Reject H₀');
    });
  });

  describe('a statistic that overflowed is not a statistic', () => {
    // t and F are both quotients, so an overflowed denominator collapses them to
    // a FINITE 0 and slips past a finiteness check on the quotient alone. ANOVA
    // was fixed for this first; the t-tests had the identical hole, and for
    // paired_t it was a regression — main refused these inputs via a
    // handler-level rule that moved.
    it.each([
      ['one_sample_t', { test: 'one_sample_t', data: { sample1: [1e200, -1e200, 3, 4], mu0: 1 } }],
      ['paired_t', { test: 'paired_t', data: { sample1: [1e200, -1e200], sample2: [0, 0] } }],
      [
        'two_sample_t',
        { test: 'two_sample_t', data: { sample1: [1, 2, 3], sample2: [1e200, -1e200] } },
      ],
    ])('%s refuses an overflowed sample statistic', async (_name, args) => {
      const r = await hypothesisTestingHandler(args);
      expect(r.isError).toBe(true);
      expect(allText(r)).toMatch(/too large/);
      expect(allText(r)).not.toMatch(/Reject H₀/);
    });

    it('says "too large", not "no variation", when a sample plainly varies', async () => {
      // The single combined condition reported "neither sample varies" here,
      // which is false of [1,2,3] and sends a caller to fix the wrong input.
      const r = await hypothesisTestingHandler({
        test: 'two_sample_t',
        data: { sample1: [1, 2, 3], sample2: [1e200, -1e200] },
      });
      expect(allText(r)).not.toMatch(/neither sample varies/);
    });

    it('chi-square refuses counts large enough to overflow', async () => {
      const r = await hypothesisTestingHandler({
        test: 'chi_square_independence',
        data: { contingency_table: [[1e308, 1], [1, 1e308]] },
      });
      expect(r.isError).toBe(true);
      expect(allText(r)).toMatch(/overflow/);
    });

    it('ANOVA refuses groups large enough to overflow', async () => {
      const r = await hypothesisTestingHandler({
        test: 'one_way_anova',
        data: { groups: [[1e200, -1e200], [1, 2], [3, 4]] },
      });
      expect(r.isError).toBe(true);
      expect(allText(r)).toMatch(/overflow/);
    });
  });

  describe('degenerate degrees of freedom', () => {
    it('refuses a single-column contingency table (df = 0)', async () => {
      const r = await hypothesisTestingHandler({
        test: 'chi_square_independence',
        data: { contingency_table: [[5], [7]] },
      });
      expect(r.isError).toBe(true);
      expect(allText(r)).toMatch(/df = 0/);
    });

    it('refuses ANOVA with no more observations than groups', async () => {
      const r = await hypothesisTestingHandler({
        test: 'one_way_anova',
        data: { groups: [[1], [2], [3]] },
      });
      expect(r.isError).toBe(true);
      expect(allText(r)).toMatch(/within-group degrees of freedom/);
    });
  });

  describe('the reported per-group standard deviation', () => {
    it('renders a real number for groups that have one, and n/a only for singletons', async () => {
      // Only the 'n/a' side was asserted, so the ternary could degrade to 'n/a'
      // for every group — erasing a published statistic — with the suite green.
      const r = await hypothesisTestingHandler({
        test: 'one_way_anova',
        data: { groups: [[1], [2, 3], [4, 5]] },
      });
      expect(r.isError).toBe(false);
      expect(allText(r)).toContain('n=1, mean=1.0000, std=n/a');
      expect(allText(r)).toMatch(/n=2, mean=2\.5000, std=0\.7071/);
      expect(allText(r)).not.toMatch(/std=NaN/);
    });
  });

  describe('when the CAS cannot return a p-value', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    // Not reachable through handler arguments — Giac answers every finite
    // statistic I could construct, including chisquare_cdf(1, 1e300) and
    // evalf(1-fisher_cdf(2,6,1e300),12). It IS reachable when the engine is
    // unavailable, which is the operational state this guard exists for, so the
    // engine is what the test makes fail.
    it.each([
      [
        'chi_square_independence',
        { test: 'chi_square_independence', data: { contingency_table: [[10, 20], [30, 40]] } },
      ],
      [
        'one_way_anova',
        { test: 'one_way_anova', data: { groups: [[1, 2, 3], [4, 5, 6], [7, 8, 9]] } },
      ],
    ])('%s reports a failure rather than a result', async (_name, args) => {
      vi.spyOn(giacEngine, 'evaluate').mockRejectedValue(new Error('engine unavailable'));
      const r = await hypothesisTestingHandler(args);
      // Previously this shipped "Could not determine significance" as the answer
      // with isError:false, so --json said {"success": true} and --quiet exited 0
      // on a computation that never happened.
      expect(r.isError).toBe(true);
      expect(allText(r)).toMatch(/p-value could not be computed/);
      expect(allText(r)).not.toMatch(/Could not determine significance/);
    });
  });

  describe("Welch's t uses the t distribution, not a normal approximation", () => {
    // Giac's student_cdf accepts only INTEGER df, and Welch's df is fractional in
    // the general case — so the old bare `catch { normalCdf }` fired on nearly
    // every call and reported a z-test p-value under a "Welch's t-test" heading.
    // It inverted verdicts.
    it('reports the t p-value, and the verdict that follows from it', async () => {
      const r = await hypothesisTestingHandler({
        test: 'two_sample_t',
        data: { sample1: [20, 22, 19, 23], sample2: [24, 25, 21, 26] },
      });
      expect(r.isError).toBe(false);
      const text = allText(r);
      expect(text).toMatch(/Welch df = 5\.84/);
      // t at df 5.838 gives 0.0794. The normal approximation gave 0.0339, which
      // crosses α = 0.05 and flipped the conclusion.
      const p = Number(/p-value = ([\d.eE+-]+)/.exec(text)?.[1]);
      expect(p).toBeCloseTo(0.0794, 3);
      expect(text).toContain('Fail to reject H₀');
    });

    it('a fractional-df p-value is not the normal-approximation value', async () => {
      const r = await hypothesisTestingHandler({
        test: 'two_sample_t',
        data: {
          sample1: [12.1, 11.4, 13.2, 12.8, 11.9],
          sample2: [14.2, 15.1, 13.9, 16.0, 14.8],
        },
      });
      const p = Number(/p-value = ([\d.eE+-]+)/.exec(allText(r))?.[1]);
      expect(p).toBeCloseTo(9.109e-4, 6);
      expect(p).not.toBeCloseTo(2.459e-7, 9);
    });

    it.each([
      ['less', 0.039702],
      ['greater', 0.960298],
    ])('mirrors a negative t for the one-sided %s alternative', async (alternative, expected) => {
      // The Beta form gives the cdf of |t|, so a negative t must be mirrored.
      // Two-sided cannot see this — 2*min(cdf, 1-cdf) is symmetric — so without a
      // one-sided case the mirror is untested, and dropping it reports the
      // complement: 0.9603 where the truth is 0.0397, flipping the verdict.
      const r = await hypothesisTestingHandler({
        test: 'two_sample_t',
        data: { sample1: [20, 22, 19, 23], sample2: [24, 25, 21, 26] },
        alternative,
      });
      expect(r.isError).toBe(false);
      const p = Number(/p-value = ([\d.eE+-]+)/.exec(allText(r))?.[1]);
      expect(p).toBeCloseTo(expected, 4);
    });

    it('still matches student_cdf exactly when df is an integer', async () => {
      const r = await hypothesisTestingHandler({
        test: 'one_sample_t',
        data: { sample1: [1, 2, 3, 4, 5], mu0: 1 },
      });
      const p = Number(/p-value = ([\d.eE+-]+)/.exec(allText(r))?.[1]);
      expect(p).toBeCloseTo(0.047421, 6);
    });

    it('reports a failure rather than substituting a distribution when the CAS is down', async () => {
      vi.spyOn(giacEngine, 'evaluate').mockRejectedValue(new Error('engine unavailable'));
      const r = await hypothesisTestingHandler({
        test: 'two_sample_t',
        data: { sample1: [1, 2, 3], sample2: [4, 6, 8] },
      });
      expect(r.isError).toBe(true);
      expect(allText(r)).toMatch(/p-value could not be computed/);
      vi.restoreAllMocks();
    });
  });

  describe('a variance that underflowed is not "no variation"', () => {
    it.each([
      [
        'one_sample_t',
        { test: 'one_sample_t', data: { sample1: [0, 1e-200, 2e-200, 3e-200], mu0: 1 } },
      ],
      [
        'two_sample_t',
        {
          test: 'two_sample_t',
          data: { sample1: [0, 1e-200, 2e-200], sample2: [0, 1e-200, 3e-200] },
        },
      ],
    ])('%s says the values are too small, not that they do not vary', async (_n, args) => {
      const r = await hypothesisTestingHandler(args);
      expect(r.isError).toBe(true);
      expect(allText(r)).toMatch(/too small/);
      expect(allText(r)).not.toMatch(/no variation|neither sample varies/);
    });

    it('a genuinely constant sample still says so', async () => {
      const r = await hypothesisTestingHandler({
        test: 'one_sample_t',
        data: { sample1: [2, 2, 2], mu0: 1 },
      });
      expect(allText(r)).toMatch(/no variation/);
    });

    it('refuses a Welch df that underflowed to NaN', async () => {
      // v1 and v2 are both nonzero so v1+v2 !== 0, but their squares underflow,
      // so the Welch df is 0/0. This guard survived the previous mutation sweep.
      const r = await hypothesisTestingHandler({
        test: 'two_sample_t',
        data: { sample1: [0, 1e-100, 2e-100], sample2: [0, 1e-100, 3e-100] },
      });
      expect(r.isError).toBe(true);
    });
  });

  // The p-value fallbacks: when Giac cannot produce the CDF, the tool must
  // refuse the verdict as an error rather than printing NaN or a fabricated
  // p-value (an unavailable p-value once shipped as isError:false, which made
  // --quiet exit 0 on a computation that never happened).
  describe('engine-failure fallbacks', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('chi-square refuses the verdict when the engine rejects', async () => {
      const spy = vi.spyOn(giacEngine, 'evaluate').mockRejectedValue(new Error('engine down'));
      const result = await hypothesisTestingHandler({
        test: 'chi_square_independence',
        data: { contingency_table: [[10, 20], [30, 40]], significance: 0.05 },
      });
      expect(spy).toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(allText(result)).toContain('p-value could not be computed');
    });

    it('chi-square treats unparseable Giac output like a failure', async () => {
      const spy = vi.spyOn(giacEngine, 'evaluate').mockResolvedValue('undef');
      const result = await hypothesisTestingHandler({
        test: 'chi_square_independence',
        data: { contingency_table: [[10, 20], [30, 40]], significance: 0.05 },
      });
      expect(spy).toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(allText(result)).toContain('p-value could not be computed');
    });

    it('anova refuses the verdict when the engine fails, whatever the F', async () => {
      const spy = vi.spyOn(giacEngine, 'evaluate').mockRejectedValue(new Error('engine down'));
      // Finite F = 63 (MS_between = 63, MS_within = 1). The old heuristic
      // answered p = 0 — certainty — for any F above 10 without consulting
      // the CAS; it was removed upstream, so every F now reports the refusal.
      const result = await hypothesisTestingHandler({
        test: 'one_way_anova',
        data: { groups: [[1, 2, 3], [4, 5, 6], [10, 11, 12]], significance: 0.05 },
      });
      expect(spy).toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(allText(result)).toContain('p-value could not be computed');
      expect(allText(result)).not.toContain('Reject H₀');
    });
  });
});

