import { giacEngine } from '../giac/index.js';
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
  if (Number.isNaN(pValue)) return 'Could not determine significance';
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
    const cdf = Number.parseFloat(rawCdf.trim());
    if (Number.isNaN(cdf)) throw new Error('Giac returned NaN');
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
  const ci95Half = (1.96 * s) / Math.sqrt(n);

  return [
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
  if (sample2?.length !== sample1.length)
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
    pValue = 1 - Number.parseFloat(rawCdf.trim());
    if (Number.isNaN(pValue)) throw new Error('NaN');
  } catch {
    pValue = Number.NaN;
  }

  return [
    `Test: Chi-square test of independence`,
    `H₀: Variables are independent  |  H₁: Variables are NOT independent`,
    `Table: ${rows}×${cols}, N = ${N}`,
    `df = (${rows}-1)×(${cols}-1) = ${df}`,
    `χ² = ${chi2.toFixed(6)}`,
    `p-value = ${Number.isNaN(pValue) ? 'computation error' : pValue.toFixed(6)}`,
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
    const rawCdf = await giacEngine.evaluate(`fisher_cdf(${dfBetween},${dfWithin},${F})`);
    const cdf = Number.parseFloat(rawCdf.trim());
    if (Number.isNaN(cdf)) throw new Error('NaN');
    pValue = 1 - cdf;
  } catch {
    pValue = F > 10 ? 0 : Number.NaN;
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
    `p-value = ${Number.isNaN(pValue) ? 'computation error' : pValue.toFixed(6)}`,
    `α = ${significance}`,
    ``,
    formatTestConclusion(
      pValue,
      significance,
      pValue < significance ? 'significant difference between groups' : 'no significant difference'
    ),
  ];
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
