import { giacEngine } from '../giac/index.js';
import { isNumberList, isNumberMatrix } from './value-guards.js';
import { formatToolResponse, formatErrorResponse } from './response-formatter.js';
import { normalCdf } from './stats-utils.js';

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

async function tPValue(t: number, df: number, alternative: string): Promise<number> {
  try {
    const rawCdf = await giacEngine.evaluate(`student_cdf(${df},${t})`);
    const cdf = parseFloat(rawCdf.trim());
    if (isNaN(cdf)) throw new Error('Giac returned NaN');
    if (alternative === 'less') return cdf;
    if (alternative === 'greater') return 1 - cdf;
    return 2 * Math.min(cdf, 1 - cdf);
  } catch {
    const cdf = normalCdf(t);
    if (alternative === 'less') return cdf;
    if (alternative === 'greater') return 1 - cdf;
    return 2 * Math.min(cdf, 1 - cdf);
  }
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
  const pValue = await tPValue(t, df, alternative);
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
  const pValue = await tPValue(t, df, alternative);

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

  let chi2 = 0;
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const expected = (rowSums[i] * colSums[j]) / N;
      chi2 += (contingency_table[i][j] - expected) ** 2 / expected;
    }
  }
  const df = (rows - 1) * (cols - 1);

  let pValue: number;
  try {
    const rawCdf = await giacEngine.evaluate(`chisquare_cdf(${df},${chi2})`);
    pValue = 1 - parseFloat(rawCdf.trim());
    if (isNaN(pValue)) throw new Error('NaN');
  } catch {
    pValue = NaN;
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

  let pValue: number;
  try {
    // `evalf` and an explicit `1 -` inside Giac, both deliberate. Given an
    // INTEGER F, `fisher_cdf(2,6,27)` returns the unevaluated symbolic
    // `Beta(1,3,9/10,1)`, whose parseFloat is NaN; evalf forces a number.
    // Giac caps the result at three significant digits, so the subtraction is
    // done there rather than on an already-rounded cdf.
    const raw = await giacEngine.evaluate(`evalf(1-fisher_cdf(${dfBetween},${dfWithin},${F}),12)`);
    const parsed = parseFloat(raw.trim());
    if (!Number.isFinite(parsed)) throw new Error(`unparseable F cdf: ${raw}`);
    pValue = parsed;
  } catch {
    // Report the failure. The previous fallback was `F > 10 ? 0 : NaN`, which
    // asserted p = 0 — certainty — for any F above a hardcoded threshold, and
    // that is exactly the branch an integer F reached.
    pValue = NaN;
  }

  return [
    `Test: One-way ANOVA`,
    `H₀: all group means equal  |  H₁: at least one mean differs`,
    `Groups: k = ${k}, N = ${N}`,
    ``,
    ...groups.map(
      (g, i) =>
        `  Group ${i + 1}: n=${ns[i]}, mean=${means[i].toFixed(4)}, std=${std(g).toFixed(4)}`
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
  // isNaN guard was bypassed (tPValue's normalCdf fallback returns 0, not NaN),
  // so `t_test(sample1=[1,2,"x"], mu0=2)` answered "✗ Reject H₀ (p = 0.0000)".
  const shapeError = checkDataShape(rawData);
  if (shapeError) return formatErrorResponse(shapeError);

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
    if (lines.length === 1 && lines[0].startsWith('Error: ')) {
      return formatErrorResponse(lines[0].slice('Error: '.length));
    }

    const mainResult = lines[lines.length - 1];
    return formatToolResponse({
      result: mainResult,
      notes: lines,
    });
  } catch (error) {
    return formatErrorResponse(error instanceof Error ? error.message : String(error));
  }
}
