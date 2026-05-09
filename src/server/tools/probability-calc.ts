import { giacEngine } from '../giac/index.js';
import { formatToolResponse, formatErrorResponse } from './response-formatter.js';
import { erf } from './stats-utils.js';

function combinations(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  if (k > n - k) k = n - k;
  let result = 1;
  for (let i = 0; i < k; i++) {
    result = (result * (n - i)) / (i + 1);
  }
  return result;
}

function factorial(n: number): number {
  let result = 1;
  for (let i = 2; i <= n; i++) result *= i;
  return result;
}

interface CalcResult {
  lines: string[];
}

async function handleGiacDistOps(
  op: string,
  params: Record<string, number>,
  giacPdf: string,
  giacCdf: string,
  giacIcdf: string,
  headerLines: string[]
): Promise<CalcResult | null> {
  const { x, p } = params;
  if (op === 'quantile') {
    if (p === undefined) return { lines: [...headerLines, 'Error: quantile requires param p'] };
    const val = await giacEngine.evaluate(giacIcdf.replace('${p}', String(p)));
    return { lines: [...headerLines, `P(X ≤ x) = ${p} → x = ${val.trim()}`] };
  }
  if (x === undefined) return { lines: [...headerLines, 'Error: pmf/cdf requires param x'] };
  if (op === 'pmf') {
    const val = await giacEngine.evaluate(giacPdf.replace('${x}', String(x)));
    return { lines: [...headerLines, `f(${x}) = ${val.trim()}`] };
  }
  if (op === 'cdf') {
    const val = await giacEngine.evaluate(giacCdf.replace('${x}', String(x)));
    return { lines: [...headerLines, `P(X ≤ ${x}) = ${val.trim()}`] };
  }
  return null;
}

function binomial(op: string, params: Record<string, number>): CalcResult {
  const { n, k, p } = params;
  const lines: string[] = [`Distribution: Binomial(n=${n}, p=${p})`];

  if (n === undefined || p === undefined) {
    return {
      lines: ['Error: Binomial requires params: n (trials), k (successes), p (probability)'],
    };
  }

  const q = 1 - p;
  const ev = n * p;
  const variance = n * p * q;

  if (op === 'expected_value') {
    lines.push(`E[X] = n×p = ${n}×${p} = ${ev}`);
    lines.push(`Var(X) = n×p×(1-p) = ${variance}`);
    lines.push(`Std(X) = ${Math.sqrt(variance)}`);
    return { lines };
  }

  if (op === 'variance') {
    lines.push(`Var(X) = n×p×(1-p) = ${n}×${p}×${q} = ${variance}`);
    lines.push(`Std(X) = ${Math.sqrt(variance)}`);
    return { lines };
  }

  if (k === undefined) {
    return { lines: ['Error: pmf/cdf requires param k (number of successes)'] };
  }

  if (op === 'pmf') {
    const prob = combinations(n, k) * Math.pow(p, k) * Math.pow(q, n - k);
    lines.push(`P(X = ${k}) = C(${n},${k}) × ${p}^${k} × ${q}^${n - k}`);
    lines.push(`P(X = ${k}) = ${prob}`);
    lines.push(`E[X] = ${ev}, Var(X) = ${variance}`);
    return { lines };
  }

  if (op === 'cdf') {
    let cumProb = 0;
    for (let i = 0; i <= k; i++) {
      cumProb += combinations(n, i) * Math.pow(p, i) * Math.pow(q, n - i);
    }
    lines.push(`P(X ≤ ${k}) = Σ P(X=i) for i=0..${k}`);
    lines.push(`P(X ≤ ${k}) = ${cumProb}`);
    lines.push(`E[X] = ${ev}, Var(X) = ${variance}`);
    return { lines };
  }

  return { lines };
}

async function normal(op: string, params: Record<string, number>): Promise<CalcResult> {
  const mu = params.mu ?? 0;
  const sigma = params.sigma ?? 1;
  const lines: string[] = [`Distribution: Normal(μ=${mu}, σ=${sigma})`];

  if (op === 'expected_value') {
    lines.push(`E[X] = μ = ${mu}`);
    lines.push(`Var(X) = σ² = ${sigma * sigma}`);
    lines.push(`Std(X) = σ = ${sigma}`);
    return { lines };
  }

  if (op === 'variance') {
    lines.push(`Var(X) = σ² = ${sigma * sigma}`);
    lines.push(`Std(X) = σ = ${sigma}`);
    return { lines };
  }

  const x = params.x;
  if (x === undefined) {
    return { lines: ['Error: pmf/cdf for normal distribution requires param x'] };
  }

  if (op === 'pmf') {
    const coeff = 1 / (sigma * Math.sqrt(2 * Math.PI));
    const exponent = -0.5 * Math.pow((x - mu) / sigma, 2);
    const pdf = coeff * Math.exp(exponent);
    lines.push(`f(${x}) = (1/(σ√(2π))) × exp(-½((x-μ)/σ)²)`);
    lines.push(`f(${x}) = ${pdf}`);
    const z = (x - mu) / sigma;
    lines.push(`z-score: ${z}`);
    return { lines };
  }

  if (op === 'cdf') {
    try {
      const result = await giacEngine.evaluate(`normald_cdf(${mu},${sigma},${x})`);
      lines.push(`P(X ≤ ${x}) = Φ((${x}-${mu})/${sigma})`);
      lines.push(`P(X ≤ ${x}) = ${result.trim()}`);
      const z = (x - mu) / sigma;
      lines.push(`z-score: ${z}`);
    } catch {
      const z = (x - mu) / sigma;
      const cdf = 0.5 * (1 + erf(z / Math.sqrt(2)));
      lines.push(`P(X ≤ ${x}) ≈ ${cdf}`);
      lines.push(`z-score: ${z}`);
    }
    return { lines };
  }

  return { lines };
}

function poisson(op: string, params: Record<string, number>): CalcResult {
  const lambda = params.lambda;
  const lines: string[] = [`Distribution: Poisson(λ=${lambda})`];

  if (lambda === undefined) {
    return { lines: ['Error: Poisson requires param lambda'] };
  }

  if (op === 'expected_value') {
    lines.push(`E[X] = λ = ${lambda}`);
    lines.push(`Var(X) = λ = ${lambda}`);
    return { lines };
  }

  if (op === 'variance') {
    lines.push(`Var(X) = λ = ${lambda}`);
    lines.push(`Std(X) = √λ = ${Math.sqrt(lambda)}`);
    return { lines };
  }

  const k = params.k;
  if (k === undefined) {
    return { lines: ['Error: pmf/cdf requires param k'] };
  }

  if (op === 'pmf') {
    const prob = (Math.exp(-lambda) * Math.pow(lambda, k)) / factorial(k);
    lines.push(`P(X = ${k}) = e^(-${lambda}) × ${lambda}^${k} / ${k}!`);
    lines.push(`P(X = ${k}) = ${prob}`);
    return { lines };
  }

  if (op === 'cdf') {
    let cumProb = 0;
    for (let i = 0; i <= k; i++) {
      cumProb += (Math.exp(-lambda) * Math.pow(lambda, i)) / factorial(i);
    }
    lines.push(`P(X ≤ ${k}) = ${cumProb}`);
    return { lines };
  }

  return { lines };
}

function geometric(op: string, params: Record<string, number>): CalcResult {
  const p = params.p;
  const lines: string[] = [`Distribution: Geometric(p=${p})`];

  if (p === undefined) {
    return { lines: ['Error: Geometric requires param p (success probability)'] };
  }

  const q = 1 - p;

  if (op === 'expected_value') {
    lines.push(`E[X] = 1/p = ${1 / p}`);
    lines.push(`Var(X) = (1-p)/p² = ${q / (p * p)}`);
    return { lines };
  }

  if (op === 'variance') {
    lines.push(`Var(X) = (1-p)/p² = ${q / (p * p)}`);
    lines.push(`Std(X) = √((1-p)/p²) = ${Math.sqrt(q / (p * p))}`);
    return { lines };
  }

  const k = params.k;
  if (k === undefined) {
    return { lines: ['Error: pmf/cdf requires param k (trial number)'] };
  }

  if (op === 'pmf') {
    const prob = Math.pow(q, k - 1) * p;
    lines.push(`P(X = ${k}) = (1-${p})^${k - 1} × ${p}`);
    lines.push(`P(X = ${k}) = ${prob}`);
    return { lines };
  }

  if (op === 'cdf') {
    const cumProb = 1 - Math.pow(q, k);
    lines.push(`P(X ≤ ${k}) = 1 - (1-${p})^${k}`);
    lines.push(`P(X ≤ ${k}) = ${cumProb}`);
    return { lines };
  }

  return { lines };
}

function hypergeometric(op: string, params: Record<string, number>): CalcResult {
  const { N, K, n, k } = params;
  const lines: string[] = [`Distribution: Hypergeometric(N=${N}, K=${K}, n=${n})`];

  if (N === undefined || K === undefined || n === undefined) {
    return {
      lines: [
        'Error: Hypergeometric requires params: N (population), K (success states), n (draws), k (observed successes)',
      ],
    };
  }

  const ev = (n * K) / N;
  const variance = (n * K * (N - K) * (N - n)) / (N * N * (N - 1));

  if (op === 'expected_value') {
    lines.push(`E[X] = nK/N = ${n}×${K}/${N} = ${ev}`);
    lines.push(`Var(X) = ${variance}`);
    return { lines };
  }

  if (op === 'variance') {
    lines.push(`Var(X) = nK(N-K)(N-n) / (N²(N-1)) = ${variance}`);
    return { lines };
  }

  if (k === undefined) {
    return { lines: ['Error: pmf/cdf requires param k'] };
  }

  if (op === 'pmf') {
    const prob = (combinations(K, k) * combinations(N - K, n - k)) / combinations(N, n);
    lines.push(`P(X = ${k}) = C(${K},${k})×C(${N - K},${n - k}) / C(${N},${n})`);
    lines.push(`P(X = ${k}) = ${prob}`);
    lines.push(`E[X] = ${ev}`);
    return { lines };
  }

  if (op === 'cdf') {
    let cumProb = 0;
    for (let i = 0; i <= k; i++) {
      cumProb += (combinations(K, i) * combinations(N - K, n - i)) / combinations(N, n);
    }
    lines.push(`P(X ≤ ${k}) = ${cumProb}`);
    lines.push(`E[X] = ${ev}`);
    return { lines };
  }

  return { lines };
}

async function chiSquare(op: string, params: Record<string, number>): Promise<CalcResult> {
  const { df } = params;
  const lines: string[] = [`Distribution: Chi-square(df=${df})`];
  if (df === undefined)
    return { lines: ['Error: chi_square requires param df (degrees of freedom)'] };

  if (op === 'expected_value') {
    lines.push(`E[X] = df = ${df}`);
    lines.push(`Var(X) = 2×df = ${2 * df}`);
    return { lines };
  }
  if (op === 'variance') {
    lines.push(`Var(X) = 2×df = ${2 * df}`);
    return { lines };
  }

  const distResult = await handleGiacDistOps(
    op,
    params,
    `chisquare(\${x},${df})`,
    `chisquare_cdf(${df},\${x})`,
    `chisquare_icdf(${df},\${p})`,
    lines
  );
  return distResult ?? { lines };
}

async function studentT(op: string, params: Record<string, number>): Promise<CalcResult> {
  const { df } = params;
  const lines: string[] = [`Distribution: Student-t(df=${df})`];
  if (df === undefined)
    return { lines: ['Error: student_t requires param df (degrees of freedom)'] };

  if (op === 'expected_value') {
    lines.push(`E[X] = 0 (df > 1)`);
    lines.push(df > 2 ? `Var(X) = df/(df-2) = ${df / (df - 2)}` : `Var(X) = undefined (df ≤ 2)`);
    return { lines };
  }
  if (op === 'variance') {
    lines.push(df > 2 ? `Var(X) = df/(df-2) = ${df / (df - 2)}` : `Var(X) = undefined (df ≤ 2)`);
    return { lines };
  }

  const distResult = await handleGiacDistOps(
    op,
    params,
    `studentd(${df},\${x})`,
    `student_cdf(${df},\${x})`,
    `student_icdf(${df},\${p})`,
    lines
  );
  return distResult ?? { lines };
}

async function fDistribution(op: string, params: Record<string, number>): Promise<CalcResult> {
  const { df1, df2 } = params;
  const lines: string[] = [`Distribution: F(df1=${df1}, df2=${df2})`];
  if (df1 === undefined || df2 === undefined)
    return { lines: ['Error: f_distribution requires params df1 and df2'] };

  if (op === 'expected_value') {
    lines.push(df2 > 2 ? `E[X] = df2/(df2-2) = ${df2 / (df2 - 2)}` : `E[X] = undefined (df2 ≤ 2)`);
    return { lines };
  }
  if (op === 'variance') {
    if (df2 <= 4) {
      lines.push('Var(X) = undefined (df2 ≤ 4)');
      return { lines };
    }
    const v = (2 * df2 * df2 * (df1 + df2 - 2)) / (df1 * (df2 - 2) ** 2 * (df2 - 4));
    lines.push(`Var(X) = ${v}`);
    return { lines };
  }

  const distResult = await handleGiacDistOps(
    op,
    params,
    `fisherd(${df1},${df2},\${x})`,
    `fisher_cdf(${df1},${df2},\${x})`,
    `fisher_icdf(${df1},${df2},\${p})`,
    lines
  );
  return distResult ?? { lines };
}

async function betaDist(op: string, params: Record<string, number>): Promise<CalcResult> {
  const alpha = params.alpha;
  const betaParam = params.beta;
  const lines: string[] = [`Distribution: Beta(α=${alpha}, β=${betaParam})`];
  if (alpha === undefined || betaParam === undefined)
    return { lines: ['Error: beta requires params alpha and beta'] };

  const ev = alpha / (alpha + betaParam);
  const variance = (alpha * betaParam) / ((alpha + betaParam) ** 2 * (alpha + betaParam + 1));

  if (op === 'expected_value') {
    lines.push(`E[X] = α/(α+β) = ${ev}`);
    lines.push(`Var(X) = αβ/((α+β)²(α+β+1)) = ${variance}`);
    return { lines };
  }
  if (op === 'variance') {
    lines.push(`Var(X) = ${variance}`);
    return { lines };
  }

  const distResult = await handleGiacDistOps(
    op,
    params,
    `betad(${alpha},${betaParam},\${x})`,
    `betad_cdf(${alpha},${betaParam},\${x})`,
    `betad_icdf(${alpha},${betaParam},\${p})`,
    lines
  );
  return distResult ?? { lines };
}

function exponentialDist(op: string, params: Record<string, number>): CalcResult {
  const { lambda, x, p } = params;
  const lines: string[] = [`Distribution: Exponential(λ=${lambda})`];
  if (lambda === undefined) return { lines: ['Error: exponential requires param lambda'] };

  if (op === 'expected_value') {
    lines.push(`E[X] = 1/λ = ${1 / lambda}`);
    lines.push(`Var(X) = 1/λ² = ${1 / (lambda * lambda)}`);
    return { lines };
  }
  if (op === 'variance') {
    lines.push(`Var(X) = 1/λ² = ${1 / (lambda * lambda)}`);
    lines.push(`Std(X) = 1/λ = ${1 / lambda}`);
    return { lines };
  }
  if (op === 'quantile') {
    if (p === undefined) return { lines: ['Error: quantile requires param p'] };
    lines.push(`P(X ≤ x) = ${p} → x = ${-Math.log(1 - p) / lambda}`);
    return { lines };
  }
  if (x === undefined) return { lines: ['Error: pmf/cdf requires param x'] };
  if (op === 'pmf') {
    const pdf = lambda * Math.exp(-lambda * x);
    lines.push(`f(${x}) = λ×e^(-λx) = ${pdf}`);
    return { lines };
  }
  if (op === 'cdf') {
    const cdf = 1 - Math.exp(-lambda * x);
    lines.push(`P(X ≤ ${x}) = 1 - e^(-λx) = ${cdf}`);
    return { lines };
  }
  return { lines };
}

export async function probabilityCalcHandler(args: Record<string, unknown>) {
  const dist = args.distribution as string;
  const op = args.operation as string;
  const params = args.params as Record<string, number>;

  try {
    let result: CalcResult;

    switch (dist) {
      case 'binomial':
        result = binomial(op, params);
        break;
      case 'normal':
        result = await normal(op, params);
        break;
      case 'poisson':
        result = poisson(op, params);
        break;
      case 'geometric':
        result = geometric(op, params);
        break;
      case 'hypergeometric':
        result = hypergeometric(op, params);
        break;
      case 'chi_square':
        result = await chiSquare(op, params);
        break;
      case 'student_t':
        result = await studentT(op, params);
        break;
      case 'f_distribution':
        result = await fDistribution(op, params);
        break;
      case 'beta':
        result = await betaDist(op, params);
        break;
      case 'exponential':
        result = exponentialDist(op, params);
        break;
      default:
        result = { lines: [`Error: Unknown distribution: ${dist}`] };
    }

    const mainResult = result.lines[result.lines.length - 1].replace(/^[^=:]*[=:]\s*/, '');
    return formatToolResponse({
      result: mainResult,
      notes: result.lines,
    });
  } catch (error) {
    return formatErrorResponse(error instanceof Error ? error.message : String(error));
  }
}
