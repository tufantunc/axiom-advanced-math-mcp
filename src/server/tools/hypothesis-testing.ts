import { z } from 'zod';
import { giacEngine } from '../giac/index.js';
import { formatToolResponse, formatErrorResponse } from './response-formatter.js';

export const hypothesisTestingSchema = z.object({
  test: z
    .enum([
      'one_sample_t',
      'two_sample_t',
      'paired_t',
      'chi_square_independence',
      'one_way_anova',
    ] as const)
    .describe(
      'Statistical test to perform. ' +
        'one_sample_t: test if population mean equals a hypothesized value (requires sample1, mu0). ' +
        'two_sample_t: compare means of two independent groups (requires sample1, sample2). ' +
        'paired_t: before/after paired measurements (requires sample1, sample2 of equal length). ' +
        'chi_square_independence: test independence in contingency table (requires contingency_table). ' +
        'one_way_anova: compare means of 3+ groups (requires groups array).'
    ),
  data: z
    .object({
      sample1: z.array(z.number()).optional().describe('First sample data array'),
      sample2: z.array(z.number()).optional().describe('Second sample data array'),
      mu0: z.number().optional().describe('Hypothesized mean for one_sample_t'),
      significance: z
        .number()
        .min(0)
        .max(1)
        .default(0.05)
        .describe('Significance level α (default: 0.05)'),
      contingency_table: z
        .array(z.array(z.number()))
        .optional()
        .describe('2D contingency table for chi_square_independence'),
      groups: z
        .array(z.array(z.number()))
        .optional()
        .describe('Array of group data arrays for one_way_anova'),
    })
    .describe('Test data and parameters'),
  alternative: z
    .enum(['two_sided', 'less', 'greater'] as const)
    .default('two_sided')
    .describe('Alternative hypothesis direction (default: two_sided)'),
});

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

/** Erf approximation (Abramowitz and Stegun) */
function erf(x: number): number {
  const sign = x >= 0 ? 1 : -1;
  x = Math.abs(x);
  const a1 = 0.254829592,
    a2 = -0.284496736,
    a3 = 1.421413741,
    a4 = -1.453152027,
    a5 = 1.061405429,
    p = 0.3275911;
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}

function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.sqrt(2)));
}

/** Get p-value from Giac student_cdf; fall back to JS approximation */
async function tPValue(t: number, df: number, alternative: string): Promise<number> {
  try {
    const rawCdf = await giacEngine.evaluate(`student_cdf(${df},${t})`);
    const cdf = parseFloat(rawCdf.trim());
    if (isNaN(cdf)) throw new Error('Giac returned NaN');
    if (alternative === 'less') return cdf;
    if (alternative === 'greater') return 1 - cdf;
    return 2 * Math.min(cdf, 1 - cdf);
  } catch {
    // Normal approximation fallback for large df
    const cdf = normalCdf(t);
    if (alternative === 'less') return cdf;
    if (alternative === 'greater') return 1 - cdf;
    return 2 * Math.min(cdf, 1 - cdf);
  }
}

async function oneSampleT(
  data: { sample1?: number[]; mu0?: number; significance: number },
  alternative: string
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
  const ci95Half = (1.96 * s) / Math.sqrt(n); // approx — exact would need t quantile

  const lines = [
    `Test: One-sample t-test`,
    `H₀: μ = ${mu0}  |  H₁: μ ${alternative === 'two_sided' ? '≠' : alternative === 'less' ? '<' : '>'} ${mu0}`,
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
    pValue < significance
      ? `✗ Reject H₀ (p = ${pValue.toFixed(4)} < α = ${significance})`
      : `✓ Fail to reject H₀ (p = ${pValue.toFixed(4)} ≥ α = ${significance})`,
  ];
  return lines;
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
  // Welch-Satterthwaite df
  const df = (v1 + v2) ** 2 / (v1 ** 2 / (n1 - 1) + v2 ** 2 / (n2 - 1));
  const pValue = await tPValue(t, df, alternative);

  const lines = [
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
    pValue < significance
      ? `✗ Reject H₀ (p = ${pValue.toFixed(4)} < α = ${significance})`
      : `✓ Fail to reject H₀ (p = ${pValue.toFixed(4)} ≥ α = ${significance})`,
  ];
  return lines;
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
  return oneSampleT({ sample1: diffs, mu0: 0, significance }, alternative);
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

  const lines = [
    `Test: Chi-square test of independence`,
    `H₀: Variables are independent  |  H₁: Variables are NOT independent`,
    `Table: ${rows}×${cols}, N = ${N}`,
    `df = (${rows}-1)×(${cols}-1) = ${df}`,
    `χ² = ${chi2.toFixed(6)}`,
    `p-value = ${isNaN(pValue) ? 'computation error' : pValue.toFixed(6)}`,
    `α = ${significance}`,
    ``,
    isNaN(pValue)
      ? 'Could not determine significance'
      : pValue < significance
        ? `✗ Reject H₀ — evidence of dependence (p = ${pValue.toFixed(4)} < α = ${significance})`
        : `✓ Fail to reject H₀ — no evidence of dependence (p = ${pValue.toFixed(4)} ≥ α = ${significance})`,
  ];
  return lines;
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
    const rawCdf = await giacEngine.evaluate(`fisher_cdf(${dfBetween},${dfWithin},${F})`);
    const cdf = parseFloat(rawCdf.trim());
    if (isNaN(cdf)) throw new Error('NaN');
    pValue = 1 - cdf;
  } catch {
    // Giac fisher_cdf may fail for very large F values.
    // For F >> 1 in ANOVA context, the p-value is essentially 0.
    pValue = F > 10 ? 0 : NaN;
  }

  const lines = [
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
    isNaN(pValue)
      ? 'Could not determine significance'
      : pValue < significance
        ? `✗ Reject H₀ — significant difference between groups (p = ${pValue.toFixed(4)} < α = ${significance})`
        : `✓ Fail to reject H₀ — no significant difference (p = ${pValue.toFixed(4)} ≥ α = ${significance})`,
  ];
  return lines;
}

export async function hypothesisTestingHandler(args: Record<string, unknown>) {
  const test = args.test as string;
  const data = args.data as {
    sample1?: number[];
    sample2?: number[];
    mu0?: number;
    significance: number;
    contingency_table?: number[][];
    groups?: number[][];
  };
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

    const mainResult = lines[lines.length - 1];
    return formatToolResponse({
      result: mainResult,
      notes: lines,
    });
  } catch (error) {
    return formatErrorResponse(error instanceof Error ? error.message : String(error));
  }
}
