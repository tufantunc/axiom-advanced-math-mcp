import { giacEngine } from '../giac/index.js';
import { isNumberList, isNumberMatrix } from './value-guards.js';
import { giacNumber } from './output-cleanup.js';
import { formatToolResponse, formatErrorResponse, inBandFailure } from './response-formatter.js';

function mean(data: number[]): number {
  return data.reduce((a, b) => a + b, 0) / data.length;
}

function variance(data: number[], sampleVar = true): number {
  const m = mean(data);
  const sumSq = data.reduce((a, x) => a + (x - m) ** 2, 0);
  return sumSq / (sampleVar ? data.length - 1 : data.length);
}

function std(data: number[], sampleStd = true): number {
  return Math.sqrt(variance(data, sampleStd));
}

function formatTestConclusion(pValue: number, significance: number, detail = ''): string {
  if (isNaN(pValue)) return 'Could not determine significance';
  const action = pValue < significance ? '✗ Reject H₀' : '✓ Fail to reject H₀';
  const comparison =
    pValue < significance
      ? `p = ${pValue.toFixed(4)} < α = ${significance}`
      : `p = ${pValue.toFixed(4)} ≥ α = ${significance}`;
  return detail ? `${action} — ${detail} (${comparison})` : `${action} (${comparison})`;
}

/** The one wording for "the CAS did not give us a p-value", used by all five tests. */
const P_VALUE_UNAVAILABLE =
  'Error: the p-value could not be computed — the CAS did not return a numeric cdf';

/**
 * Student's t cdf, or null when the CAS could not give one.
 *
 * Giac's `student_cdf` accepts only INTEGER degrees of freedom — it answers
 * `student_cdf(4,2.5)` and returns `GIAC_ERROR: Bad Argument Value` for
 * `student_cdf(3.95,2.5)`. Welch's df is fractional in the general case (over
 * 20,000 random realistic sample pairs it was integral in 0 of them), so the
 * integer path covers almost no real two-sample call.
 *
 * The fractional case goes through the regularized incomplete beta, which Giac
 * does evaluate at real df, and which agrees with `student_cdf` to all 12
 * printed digits wherever both are defined. Beta gives the cdf of |t|, so a
 * negative t is mirrored.
 *
 * This used to fall back to `normalCdf` inside a bare catch. That reported a
 * NORMAL p-value under a heading that says "Welch's t-test", with no marker
 * anywhere — and it INVERTED verdicts: two_sample_t([20,22,19,23],[24,25,21,26])
 * shipped "✗ Reject H₀ (p = 0.0339)" where the t distribution at df = 5.84 gives
 * p = 0.0794, "✓ Fail to reject". Returning null instead lets the callers report
 * the same failure chi-square and ANOVA already report.
 */
async function tCdf(t: number, df: number): Promise<number | null> {
  if (!Number.isFinite(t) || !Number.isFinite(df) || df <= 0) return null;
  const expr = Number.isInteger(df)
    ? `student_cdf(${df},${t})`
    : `evalf(1-0.5*Beta(${df}/2,0.5,${df}/(${df}+(${Math.abs(t)})^2),1),12)`;
  try {
    const value = giacNumber(await giacEngine.evaluate(expr));
    if (value === null || !Number.isFinite(value)) return null;
    return Number.isInteger(df) || t >= 0 ? value : 1 - value;
  } catch {
    return null;
  }
}

async function tPValue(t: number, df: number, alternative: string): Promise<number | null> {
  const cdf = await tCdf(t, df);
  if (cdf === null) return null;
  if (alternative === 'less') return cdf;
  if (alternative === 'greater') return 1 - cdf;
  return 2 * Math.min(cdf, 1 - cdf);
}

async function oneSampleT(
  data: { sample1?: number[]; mu0?: number; significance: number },
  alternative: string,
  /**
   * How to name the test and its parameter in the report. `paired_t` runs a
   * one-sample test on the differences — correct arithmetic, but reporting it
   * as "One-sample t-test / H₀: μ = 0" tells a user who asked for a paired
   * test that a different test ran.
   */
  report: { name: string; parameter: string } = {
    name: 'One-sample t-test',
    parameter: 'μ',
  }
): Promise<string[]> {
  const { sample1, mu0, significance } = data;
  if (!sample1 || sample1.length < 2)
    return ['Error: one_sample_t requires sample1 with at least 2 values'];
  if (mu0 === undefined) return ['Error: one_sample_t requires mu0 (hypothesized mean)'];

  const n = sample1.length;
  const xbar = mean(sample1);
  const s = std(sample1);
  const t = (xbar - mu0) / (s / Math.sqrt(n));
  const df = n - 1;
  // Guarded here rather than on the raw sample, because this is where the
  // statistic exists. `paired_t` tests the DIFFERENCES, so a handler-level check
  // on sample1/sample2 never saw them: `paired_t([1,2,3],[1,2,3])` — two
  // identical inputs — produced t = NaN and reported "✗ Reject H₀ (p = 0.0000)",
  // the strongest possible claim of a difference.
  // Guard the INPUTS to the ratio, not only the ratio. t is a quotient, so an
  // overflowed standard deviation makes s Infinity and collapses t to a finite
  // 0, which passes a check on t alone — the same collapse oneWayAnova guards
  // against for F. Leaving it here meant one_sample_t([1e200,-1e200,3,4]) still
  // reported "✓ Fail to reject H₀" off a std of Infinity, with a 95% CI of
  // [-Infinity, Infinity]. paired_t inherits this guard and needs it — but be
  // precise about the baseline: main ANSWERED the overflow case too. What main
  // refused, through a handler-level `new Set(sample).size === 1` rule this file
  // no longer has, was a CONSTANT sample; paired_t's differences made that
  // reachable. The overflow case is refused here for the first time.
  if (!Number.isFinite(xbar) || !Number.isFinite(s)) {
    return [
      `Error: ${report.name} is undefined for this input — the values are too ` +
        `large, so the sample mean or standard deviation overflowed`,
    ];
  }
  if (s === 0 || !Number.isFinite(t)) {
    // Distinguish "constant" from "varies, but the squared deviations underflowed
    // to zero" — below ~1e-154 the latter happens while the sample plainly varies,
    // and calling that "no variation" is the same misdiagnosis the overflow split
    // was added to remove.
    const varies = new Set(sample1).size > 1;
    return [
      varies
        ? `Error: ${report.name} is undefined for this input — the values are too ` +
          `small, so the variance underflowed to zero`
        : `Error: ${report.name} is undefined for this input — the sample has no ` +
          `variation, so the t-statistic divides by a zero standard error`,
    ];
  }
  const pValue = await tPValue(t, df, alternative);
  if (pValue === null) return [P_VALUE_UNAVAILABLE];
  const ci95Half = (1.96 * s) / Math.sqrt(n);

  return [
    `Test: ${report.name}`,
    `H₀: ${report.parameter} = ${mu0}  |  H₁: ${report.parameter} ${alternative === 'two_sided' ? '≠' : alternative === 'less' ? '<' : '>'} ${mu0}`,
    ``,
    `Sample mean: ${xbar.toFixed(6)}`,
    `Sample std:  ${s.toFixed(6)}`,
    `n = ${n}, df = ${df}`,
    `t-statistic = ${t.toFixed(6)}`,
    `p-value = ${pValue.toFixed(6)}`,
    `α = ${significance}`,
    ``,
    `95% CI (approx): [${(xbar - ci95Half).toFixed(4)}, ${(xbar + ci95Half).toFixed(4)}]`,
    ``,
    formatTestConclusion(pValue, significance),
  ];
}

async function twoSampleT(
  data: { sample1?: number[]; sample2?: number[]; significance: number },
  alternative: string
): Promise<string[]> {
  const { sample1, sample2, significance } = data;
  if (!sample1 || sample1.length < 2)
    return ['Error: two_sample_t requires sample1 with at least 2 values'];
  if (!sample2 || sample2.length < 2)
    return ['Error: two_sample_t requires sample2 with at least 2 values'];

  const n1 = sample1.length,
    n2 = sample2.length;
  const m1 = mean(sample1),
    m2 = mean(sample2);
  const s1 = std(sample1),
    s2 = std(sample2);
  const v1 = s1 ** 2 / n1,
    v2 = s2 ** 2 / n2;
  const t = (m1 - m2) / Math.sqrt(v1 + v2);
  const df = (v1 + v2) ** 2 / (v1 ** 2 / (n1 - 1) + v2 ** 2 / (n2 - 1));
  // Welch's t divides by the POOLED standard error, so one constant sample is
  // fine — only both being constant makes it undefined. The handler-level check
  // this replaces rejected either sample being constant, which refused the
  // perfectly well-defined `two_sample_t([2,2,2],[5,7,9])`.
  // Same three-way split as oneSampleT. The single combined condition reported
  // "neither sample varies" for an overflow, which is false whenever one sample
  // plainly does vary — sending a caller to fix the wrong thing about their data.
  if (![m1, m2, s1, s2, v1, v2].every((v) => Number.isFinite(v))) {
    return [
      'Error: two_sample_t is undefined for this input — the values are too ' +
        'large, so the sample statistics overflowed',
    ];
  }
  if (v1 + v2 === 0) {
    const varies = new Set(sample1).size > 1 || new Set(sample2).size > 1;
    return [
      varies
        ? 'Error: two_sample_t is undefined for this input — the values are too ' +
          'small, so both variances underflowed to zero'
        : 'Error: two_sample_t is undefined for this input — neither sample varies, ' +
          'so the t-statistic divides by a zero standard error',
    ];
  }
  if (!Number.isFinite(t) || !Number.isFinite(df)) {
    return ['Error: two_sample_t is undefined for this input — the t-statistic is not finite'];
  }
  const pValue = await tPValue(t, df, alternative);
  if (pValue === null) return [P_VALUE_UNAVAILABLE];

  return [
    `Test: Two-sample Welch's t-test`,
    `H₀: μ₁ = μ₂  |  H₁: μ₁ ${alternative === 'two_sided' ? '≠' : alternative === 'less' ? '<' : '>'} μ₂`,
    ``,
    `Sample 1: mean = ${m1.toFixed(6)}, std = ${s1.toFixed(6)}, n = ${n1}`,
    `Sample 2: mean = ${m2.toFixed(6)}, std = ${s2.toFixed(6)}, n = ${n2}`,
    `Welch df = ${df.toFixed(2)}`,
    `t-statistic = ${t.toFixed(6)}`,
    `p-value = ${pValue.toFixed(6)}`,
    `α = ${significance}`,
    ``,
    formatTestConclusion(pValue, significance),
  ];
}

async function pairedT(
  data: { sample1?: number[]; sample2?: number[]; significance: number },
  alternative: string
): Promise<string[]> {
  const { sample1, sample2, significance } = data;
  if (!sample1 || sample1.length < 2)
    return ['Error: paired_t requires sample1 with at least 2 values'];
  if (!sample2 || sample2.length !== sample1.length)
    return ['Error: paired_t requires sample1 and sample2 of equal length'];

  const diffs = sample1.map((v, i) => v - sample2[i]);
  return oneSampleT({ sample1: diffs, mu0: 0, significance }, alternative, {
    name: 'Paired t-test',
    parameter: 'μ_d',
  });
}

async function chiSquareIndependence(data: {
  contingency_table?: number[][];
  significance: number;
}): Promise<string[]> {
  const { contingency_table, significance } = data;
  if (!contingency_table || contingency_table.length < 2)
    return ['Error: chi_square_independence requires contingency_table (2D array)'];

  const rows = contingency_table.length;
  const cols = contingency_table[0].length;
  const rowSums = contingency_table.map((row) => row.reduce((a, b) => a + b, 0));
  const colSums = Array.from({ length: cols }, (_, j) =>
    contingency_table.reduce((a, row) => a + row[j], 0)
  );
  const N = rowSums.reduce((a, b) => a + b, 0);

  // Every expected count is (rowSum x colSum) / N, so an empty table divides by
  // zero and an empty row or column makes one expected count zero. Either way χ²
  // is NaN. On main that was not caught downstream either: Giac returns the
  // symbolic `1-UTPC(1,NaN)`, whose parseFloat is 1, so p = 1 - 1 = 0 — finite,
  // so formatTestConclusion's isNaN guard never fired. giacNumber now rejects
  // that reply, so these guards are no longer the only thing standing in the
  // way; they remain because they name WHICH row or column is at fault instead
  // of reporting a bare "the p-value could not be computed". `[[0,0],[0,0]]` reported
  // "✗ Reject H₀ — evidence of dependence (p = 0.0000)" on no data at all.
  // Counts, so negatives are not data. `[[10,-2],[3,4]]` reported
  // "✗ Reject H₀ — evidence of dependence (p = 0.0000)" on an impossible table.
  for (let i = 0; i < rows; i++) {
    const j = contingency_table[i].findIndex((v) => v < 0);
    if (j >= 0) {
      return [
        `Error: row ${i + 1}, column ${j + 1} of contingency_table is ` +
          `${contingency_table[i][j]}; a contingency table holds counts, which ` +
          `cannot be negative`,
      ];
    }
  }

  // With every count non-negative, a zero total means every row is empty, so the
  // row and column checks below cover it and report which one is at fault.
  const emptyRow = rowSums.findIndex((sum) => sum <= 0);
  if (emptyRow >= 0) {
    return [
      `Error: row ${emptyRow + 1} of contingency_table has no observations — ` +
        `its expected counts are zero, so χ² is undefined`,
    ];
  }
  const emptyCol = colSums.findIndex((sum) => sum <= 0);
  if (emptyCol >= 0) {
    return [
      `Error: column ${emptyCol + 1} of contingency_table has no observations — ` +
        `its expected counts are zero, so χ² is undefined`,
    ];
  }

  let chi2 = 0;
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const expected = (rowSums[i] * colSums[j]) / N;
      chi2 += (contingency_table[i][j] - expected) ** 2 / expected;
    }
  }
  const df = (rows - 1) * (cols - 1);

  // Not a backstop: this is the working guard for counts large enough that the
  // sum overflows to Infinity, which the checks above do not touch.
  if (!Number.isFinite(chi2)) {
    return ['Error: the counts are too large — the χ² statistic overflowed'];
  }
  if (df < 1) {
    return [`Error: df = ${df}; a ${rows}x${cols} table has no degrees of freedom to test`];
  }

  let pValue: number;
  try {
    const rawCdf = await giacEngine.evaluate(`chisquare_cdf(${df},${chi2})`);
    const cdf = giacNumber(rawCdf);
    if (cdf === null || !Number.isFinite(cdf)) throw new Error(`unparseable χ² cdf: ${rawCdf}`);
    pValue = 1 - cdf;
  } catch {
    pValue = NaN;
  }

  // A p-value that could not be computed is a failure, not a result. Reporting
  // it as "Could not determine significance" shipped with isError:false, because
  // inBandFailure only recognises the Error:/Failed:/Did not converge markers —
  // so --json said {"success": true} and --quiet exited 0 on a computation that
  // did not happen.
  if (Number.isNaN(pValue)) {
    return [P_VALUE_UNAVAILABLE];
  }

  return [
    `Test: Chi-square test of independence`,
    `H₀: Variables are independent  |  H₁: Variables are NOT independent`,
    `Table: ${rows}×${cols}, N = ${N}`,
    `df = (${rows}-1)×(${cols}-1) = ${df}`,
    `χ² = ${chi2.toFixed(6)}`,
    `p-value = ${isNaN(pValue) ? 'computation error' : pValue.toFixed(6)}`,
    `α = ${significance}`,
    ``,
    formatTestConclusion(
      pValue,
      significance,
      pValue < significance ? 'evidence of dependence' : 'no evidence of dependence'
    ),
  ];
}

async function oneWayAnova(data: { groups?: number[][]; significance: number }): Promise<string[]> {
  const { groups, significance } = data;
  if (!groups || groups.length < 3) return ['Error: one_way_anova requires at least 3 groups'];

  const k = groups.length;
  const ns = groups.map((g) => g.length);
  const N = ns.reduce((a, b) => a + b, 0);
  const means = groups.map(mean);
  const grandMean = groups.flat().reduce((a, b) => a + b, 0) / N;

  const ssBetween = ns.reduce((a, ni, i) => a + ni * (means[i] - grandMean) ** 2, 0);
  const ssWithin = groups.reduce((a, g) => {
    const m = mean(g);
    return a + g.reduce((s, x) => s + (x - m) ** 2, 0);
  }, 0);
  const dfBetween = k - 1;
  const dfWithin = N - k;
  const msBetween = ssBetween / dfBetween;
  const msWithin = ssWithin / dfWithin;
  const F = msBetween / msWithin;

  // Same laundering as chi-square. With no within-group variation MS_within is
  // 0, so F is 0/0 = NaN. Bare `fisher_cdf(2,6,NaN)` returns the symbolic
  // `Beta(1,3,2*NaN/(2*NaN+6),1)`, but the expression this code actually sends
  // is `evalf(1-fisher_cdf(...),12)`, which returns `1.0-Beta(1.0,3.0,...)/...`
  // — and parseFloat of that is 1. So `[[5,5,5],[5,5,5],[5,5,5]]` reported
  // "✓ Fail to reject H₀ (p = 1.0000)" from a NaN F.
  if (dfWithin < 1) {
    return [
      `Error: N = ${N} across k = ${k} groups leaves ${dfWithin} within-group ` +
        `degrees of freedom; each group needs more than one observation between them`,
    ];
  }
  if (msWithin <= 0) {
    return [
      'Error: every group has zero variance — F is undefined when there is no ' +
        'within-group variation to compare against',
    ];
  }
  // Guarded on the INPUTS to the ratio, not only on the ratio: F is a quotient,
  // so an infinite denominator collapses to a finite 0 rather than to NaN.
  // `[[1e200,-1e200],[1,2],[3,4]]` gave MS_within = Infinity, F = 0, and a
  // confident "✓ Fail to reject H₀" — clearing an `F`-only check.
  if (!Number.isFinite(ssBetween) || !Number.isFinite(ssWithin) || !Number.isFinite(F)) {
    return ['Error: the values are too large — the F statistic overflowed'];
  }

  let pValue: number;
  try {
    // `evalf` and an explicit `1 -` inside Giac, both deliberate. Given an
    // INTEGER F, `fisher_cdf(2,6,27)` returns the unevaluated symbolic
    // `Beta(1,3,9/10,1)`, whose parseFloat is NaN; evalf forces a number.
    // Giac caps the result at three significant digits, so the subtraction is
    // done there rather than on an already-rounded cdf.
    const raw = await giacEngine.evaluate(`evalf(1-fisher_cdf(${dfBetween},${dfWithin},${F}),12)`);
    const parsed = giacNumber(raw);
    if (parsed === null || !Number.isFinite(parsed)) throw new Error(`unparseable F cdf: ${raw}`);
    pValue = parsed;
  } catch {
    // Report the failure. The previous fallback was `F > 10 ? 0 : NaN`, which
    // asserted p = 0 — certainty — for any F above a hardcoded threshold, and
    // that is exactly the branch an integer F reached.
    pValue = NaN;
  }

  if (Number.isNaN(pValue)) {
    return [P_VALUE_UNAVAILABLE];
  }

  return [
    `Test: One-way ANOVA`,
    `H₀: all group means equal  |  H₁: at least one mean differs`,
    `Groups: k = ${k}, N = ${N}`,
    ``,
    ...groups.map(
      (g, i) =>
        // `std` of a single observation divides by n-1 = 0. The test itself can
        // still be valid (dfWithin counts across groups), so the group line
        // reports n/a rather than rendering NaN beside a real verdict.
        `  Group ${i + 1}: n=${ns[i]}, mean=${means[i].toFixed(4)}, std=${
          ns[i] > 1 ? std(g).toFixed(4) : 'n/a'
        }`
    ),
    ``,
    `SS_between = ${ssBetween.toFixed(4)}, df = ${dfBetween}, MS = ${msBetween.toFixed(4)}`,
    `SS_within  = ${ssWithin.toFixed(4)}, df = ${dfWithin}, MS = ${msWithin.toFixed(4)}`,
    `F = ${F.toFixed(6)}`,
    `p-value = ${isNaN(pValue) ? 'computation error' : pValue.toFixed(6)}`,
    `α = ${significance}`,
    ``,
    formatTestConclusion(
      pValue,
      significance,
      pValue < significance ? 'significant difference between groups' : 'no significant difference'
    ),
  ];
}

/** Conventional α when the caller does not name one. */
const DEFAULT_SIGNIFICANCE = 0.05;

/**
 * Turns a parsed argument list into this module's data shape.
 *
 * The field names — sample1, sample2, mu0, groups, significance — are owned
 * here, so the mapping lives here too rather than in the routing layer. Accepts
 * `data`/`sample` for sample1 and `alpha` for significance.
 *
 * Positional: every numeric list is a sample, so three or more become `groups`
 * rather than being silently truncated to the first two; a list of lists is
 * `groups` directly; a bare number is mu0.
 */
export function coerceTestData(
  named: Record<string, unknown>,
  positional: unknown[],
  // Required: the single caller always knows the test, and when this was
  // optional an absent value silently landed a contingency table under
  // `groups` and a positional alpha under `mu0`.
  test: string
): Record<string, unknown> {
  const aliases: Record<string, string> = {
    data: 'sample1',
    sample: 'sample1',
    alpha: 'significance',
  };
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(named)) out[aliases[key] ?? key] = value;

  const matrix = positional.find(isNumberMatrix);
  const lists = positional.filter(isNumberList);
  // chi-square reads a contingency_table; the other tests read groups. Same
  // shape, different field, so the test decides which name it lands under.
  const matrixField = test === 'chi_square_independence' ? 'contingency_table' : 'groups';
  if (matrix) out[matrixField] ??= matrix;
  else if (lists.length >= 3) out['groups'] ??= lists;
  else {
    if (lists[0]) out['sample1'] ??= lists[0];
    if (lists[1]) out['sample2'] ??= lists[1];
  }

  // Only these two read mu0. For the others a bare number was absorbed into an
  // unread field and the caller's α was replaced by the default, so
  // `two_sample_t([1,2,3],[4,5,6], 0.01)` reported "✗ Reject H₀ (p = 0.0213 <
  // α = 0.05)" — the opposite verdict at the α that was actually supplied.
  const scalar = positional.find((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (scalar !== undefined) {
    const readsMu0 = test === 'one_sample_t' || test === 'paired_t';
    if (readsMu0) out['mu0'] ??= scalar;
    else if (scalar > 0 && scalar < 1) out['significance'] ??= scalar;
  }
  return out;
}

/**
 * Rejects data that is not the numeric shape the tests below index into.
 *
 * Every field here is read as `number[]`, `number[][]` or `number` with no
 * runtime check, and the values arrive from `coerceValue`, which returns
 * `unknown`. The predicates are the same ones the extractor uses on the
 * positional half of the same input.
 */
function checkDataShape(data: Record<string, unknown> | undefined): string | null {
  if (!data) return null;
  for (const field of ['sample1', 'sample2'] as const) {
    const value = data[field];
    if (value !== undefined && !isNumberList(value)) {
      return `${field} must be a list of finite numbers`;
    }
  }
  for (const field of ['groups', 'contingency_table'] as const) {
    const value = data[field];
    if (value !== undefined && !isNumberMatrix(value)) {
      return `${field} must be a list of lists of finite numbers`;
    }
  }

  // Only the contingency table. `groups` is a list of samples, and unequal group
  // sizes are an ordinary unbalanced ANOVA design, not an error.
  //
  // `isNumberMatrix` deliberately says nothing about row lengths, and a ragged
  // table is not caught downstream: chiSquareIndependence takes its column count
  // from row 0, so cells past that width are counted in the row sums and in N but
  // never enter the χ² sum. `[[1,2],[3,4,5]]` reported "Table: 2×2, N = 15" and a
  // confident verdict computed against marginals that summed to 10.
  const table = data['contingency_table'];
  if (isNumberMatrix(table)) {
    const width = table[0].length;
    const ragged = table.findIndex((row) => row.length !== width);
    if (ragged >= 0) {
      return (
        `contingency_table row ${ragged + 1} has ${table[ragged].length} ` +
        `entries but row 1 has ${width}; every row must be the same length`
      );
    }
  }

  const mu0 = data['mu0'];
  if (mu0 !== undefined && !(typeof mu0 === 'number' && Number.isFinite(mu0))) {
    return `mu0 must be a finite number, got ${String(mu0)}`;
  }
  return null;
}

export async function hypothesisTestingHandler(args: Record<string, unknown>) {
  const test = args.test as string;
  const rawData = args.data as {
    sample1?: number[];
    sample2?: number[];
    mu0?: number;
    significance?: number;
    contingency_table?: number[][];
    groups?: number[][];
  };
  // The type used to declare `significance: number` as required while nothing
  // supplied it, so every comparison was `p < undefined` — false — and every
  // test reported "Fail to reject H₀" whatever the p-value was.
  // A significance level outside (0,1) inverts the conclusion: α = 1.5 makes
  // every test reject, α ≤ 0 makes none reject, and both used to be reported as
  // confident successes. An ABSENT α gets the convention; a malformed one is an
  // error, because those are different inputs.
  const alpha = rawData?.significance;
  if (alpha !== undefined && !(typeof alpha === 'number' && alpha > 0 && alpha < 1)) {
    return formatErrorResponse(
      `significance must be a number strictly between 0 and 1, got ${String(alpha)}`
    );
  }

  // The cast above is the only thing standing between an argument and the
  // arithmetic, and `coerceValue` hands through whatever the caller typed. A
  // non-numeric element made every statistic NaN while `formatTestConclusion`'s
  // isNaN guard was bypassed (on main, tPValue's normalCdf fallback returned 0),
  // so `t_test(sample1=[1,2,"x"], mu0=2)` answered "✗ Reject H₀ (p = 0.0000)".
  const shapeError = checkDataShape(rawData);
  if (shapeError) return formatErrorResponse(shapeError);

  // The zero-variance rule used to live here, on the raw samples. It now lives
  // in each test beside the statistic it protects, because which sample must
  // vary depends on the test: paired_t tests the differences (so a check here
  // missed it entirely) and Welch's t only needs ONE sample to vary (so a check
  // here refused valid input). See oneSampleT and twoSampleT.

  const data = { ...rawData, significance: alpha ?? DEFAULT_SIGNIFICANCE };
  const alternative = (args.alternative as string) ?? 'two_sided';

  try {
    let lines: string[];

    switch (test) {
      case 'one_sample_t':
        lines = await oneSampleT(data, alternative);
        break;
      case 'two_sample_t':
        lines = await twoSampleT(data, alternative);
        break;
      case 'paired_t':
        lines = await pairedT(data, alternative);
        break;
      case 'chi_square_independence':
        lines = await chiSquareIndependence(data);
        break;
      case 'one_way_anova':
        lines = await oneWayAnova(data);
        break;
      default:
        return formatErrorResponse(`Unknown test: ${test}`);
    }

    // The per-test functions signal a validation failure by returning a single
    // `Error: ...` line, which formatToolResponse would ship with
    // isError: false — so `t_test(data=[1])` answered "The answer is Error:
    // one_sample_t requires sample1 with at least 2 values" as a SUCCESS. An
    // LLM caller reads that as a result.
    //
    const failure = inBandFailure(lines);
    if (failure) return formatErrorResponse(failure);

    const mainResult = lines[lines.length - 1];
    return formatToolResponse({
      result: mainResult,
      notes: lines,
    });
  } catch (error) {
    return formatErrorResponse(error instanceof Error ? error.message : String(error));
  }
}
