import { giacEngine } from '../giac/index.js';
import { splitTopLevel } from './output-cleanup.js';
import { formatToolResponse, formatErrorResponse, inBandFailure } from './response-formatter.js';
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

/**
 * Bounds the discrete count parameters (n, k, N, K).
 *
 * These branches are plain-double loops on the main thread, where the Giac
 * worker timeout cannot reach them. A single scalar ceiling was the wrong shape:
 * the cdf loops call an O(k)-inner helper once per iteration, so their cost is
 * O(n·k), and at a ceiling of 100000 `binomial(n=100000, p=0.5, k=100000, cdf)`
 * measured 9.8s and `hypergeometric(N=100000, ..., cdf)` 14.2s — both blocking
 * the event loop outright, and both answering NaN because a double overflows
 * past ~170 anyway.
 *
 * So: a generous ceiling on any single count, and a much tighter one on the
 * product that actually drives the summation.
 */
const MAX_COUNT = 100_000;
const MAX_CDF_WORK = 2_000_000;

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

  // A probability is a number. Giac keeps these exact unless asked otherwise,
  // so the density of χ²(3) at 2 came back as `√2/exp(1)/(1/2*√pi*2*√2)` and
  // Student-t(5) at 2 as `2/(3/4*√pi)/√(5*pi)*125/729` — both correct, neither
  // an answer a caller can use.
  const decimal = (expr: string): string => `evalf(${expr},12)`;

  if (op === 'quantile') {
    if (p === undefined) return { lines: [...headerLines, 'Error: quantile requires param p'] };
    const val = await giacEngine.evaluate(decimal(giacIcdf.replace('${p}', String(p))));
    return { lines: [...headerLines, `P(X ≤ x) = ${p} → x = ${val.trim()}`] };
  }
  if (x === undefined) return { lines: [...headerLines, 'Error: pmf/cdf requires param x'] };
  if (op === 'pmf') {
    const val = await giacEngine.evaluate(decimal(giacPdf.replace('${x}', String(x))));
    return { lines: [...headerLines, `f(${x}) = ${val.trim()}`] };
  }
  if (op === 'cdf') {
    const val = await giacEngine.evaluate(decimal(giacCdf.replace('${x}', String(x))));
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
    lines.push(`E[X] = ${ev}`);
    lines.push(`Var(X) = ${variance}`);
    return { lines };
  }

  if (op === 'cdf') {
    let cumProb = 0;
    for (let i = 0; i <= k; i++) {
      cumProb += combinations(n, i) * Math.pow(p, i) * Math.pow(q, n - i);
    }
    lines.push(`P(X ≤ ${k}) = Σ P(X=i) for i=0..${k}`);
    lines.push(`P(X ≤ ${k}) = ${cumProb}`);
    lines.push(`E[X] = ${ev}`);
    lines.push(`Var(X) = ${variance}`);
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
    // Giac's density takes the degrees of freedom first, as the cdf and icdf
    // lines below already do. Reversed, `chi_square(df=3, x=2)` evaluated
    // `chisquare(2,3)` = 0.1116 — the density of χ²(2) at 3 — and reported it
    // as the density of χ²(3) at 2, which is 0.2076.
    `chisquare(${df},\${x})`,
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
    lines.push(`f(x) = λ×e^(-λx)`);
    lines.push(`f(${x}) = ${pdf}`);
    return { lines };
  }
  if (op === 'cdf') {
    const cdf = 1 - Math.exp(-lambda * x);
    lines.push(`P(X ≤ ${x}) = 1 - e^(-λx) = ${cdf}`);
    return { lines };
  }
  return { lines };
}

/**
 * The density/mass branch is implemented under the name `pmf`, and nothing
 * branches on `pdf` — so a query carrying `pdf`, or no operation at all, fell
 * past every branch and returned only the header line: `normal(mu=0, sigma=1,
 * x=1)` answered "Normal(μ=0, σ=1)" instead of the density at 1, isError:false.
 *
 * The extractor now emits `pmf` directly. `pdf` is kept as an alias because it
 * is the standard name for the continuous case and a caller invoking this
 * handler directly may well use it.
 */
function densityOrGiven(op: string | undefined): string {
  return op === undefined || op === 'pdf' ? 'pmf' : op;
}

/**
 * The line carrying the answer to the operation that was actually asked for.
 *
 * The headline used to be `lines[lines.length - 1]` — whatever a branch happened
 * to push last. Once the pdf->pmf alias made the density branches reachable that
 * became the trailing note rather than the value: `normal(mu=0, sigma=1, x=1)`
 * answered "1" (the z-score) for a density of 0.2419707, and
 * `binomial(n=10, p=0.5, k=3)` answered "5, Var(X) = 2.5" for a mass of
 * 0.1171875. A plausible wrong number is worse than the header-only non-answer
 * it replaced.
 *
 * Each branch pushes its formula first and its value second, so scan backwards
 * and take the last line matching the operation's own shape.
 */
const ANSWER_LINE: Record<string, RegExp> = {
  pmf: /^(f\(|P\(X = )/,
  cdf: /^P\(X \u2264 /,
  expected_value: /^E\[X\]/,
  variance: /^Var\(X\)/,
  quantile: /\u2192 x = /,
};

/**
 * The value on a `label = value` line.
 *
 * The old strip cut at the FIRST `=` or `:`, which for `P(X = 3) = 0.1171875`
 * sits inside the label — so the headline read "3) = 0.1171875". Split on
 * top-level separators only and take the last part.
 */
function valueOf(line: string): string {
  // The erf fallback (used when Giac is unavailable) writes `P(X ≤ 1) ≈ 0.84`,
  // which has no top-level `=` — so both branches fell through and the whole
  // labelled line became the answer.
  const parts = splitTopLevel(line.replace('≈', '='), '=');
  if (parts.length > 1) return parts[parts.length - 1].trim();
  return line.replace(/^[^:]*:\s*/, '').trim();
}

function answerLine(op: string, lines: string[]): string | null {
  const shape = ANSWER_LINE[op];
  if (!shape) return lines[lines.length - 1];
  for (let i = lines.length - 1; i >= 0; i--) {
    if (shape.test(lines[i])) return lines[i];
  }
  // No line of the right shape means the branch was never written — several
  // distributions implement pmf/cdf and fall through to `return { lines }` for
  // anything else. Falling back to the last line handed back the
  // `Distribution: ...` header as the answer, which is the header-as-answer bug
  // this function exists to remove.
  return null;
}

export async function probabilityCalcHandler(args: Record<string, unknown>) {
  const dist = args.distribution as string;
  const op = densityOrGiven(args.operation as string | undefined);
  const params = args.params as Record<string, number>;

  // Each distribution reads these with a default (`params.sigma ?? 1`), so a
  // value that is not a number would silently become the default rather than a
  // reported problem.
  for (const [key, value] of Object.entries(params ?? {})) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return formatErrorResponse(`${key} must be a finite number, got ${String(value)}`);
    }
    if (['n', 'k', 'N', 'K'].includes(key) && Math.abs(value) > MAX_COUNT) {
      return formatErrorResponse(`${key} is limited to ${MAX_COUNT}, got ${value}`);
    }
  }

  // Only the summing operations pay the product cost; expected_value and
  // variance are closed forms and must stay available at any n.
  if (op === 'cdf') {
    const n = Math.abs(Number(params?.n ?? params?.N ?? 0));
    const k = Math.abs(Number(params?.k ?? 0));
    if (n * k > MAX_CDF_WORK) {
      return formatErrorResponse(
        `a cdf over n=${n}, k=${k} is too large to sum on the main thread ` +
          `(n*k must be <= ${MAX_CDF_WORK})`
      );
    }
  }

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

    // These functions signal a validation failure by returning an `Error: ...`
    // line, which formatToolResponse ships with isError:false — so
    // `beta(a=2, b=3, x=0.5)` answered "The answer is beta requires params
    // alpha and beta" as a SUCCESS, which an LLM caller reads as a result.
    //
    // Test the LAST line, not a one-line array: handleGiacDistOps prepends the
    // `Distribution: ...` header to its errors, so chi_square, student_t,
    // f_distribution and beta never produced a single-line failure and kept
    // reporting `chi_square(df=3)` as "The answer is pmf/cdf requires param x".
    //
    // These functions should return a discriminated outcome rather than prose
    // plus a convention; until they do, each entry point enforces it. The same
    // convention is honoured in numerical-methods.ts.
    const failure = inBandFailure(result.lines);
    if (failure) return formatErrorResponse(failure);

    const answer = answerLine(op, result.lines);
    if (answer === null) {
      return formatErrorResponse(`${dist} does not implement ${op}`);
    }
    const mainResult = valueOf(answer);

    // A numeric branch that overflowed or divided by zero used to report its
    // NaN as the answer with isError:false — `poisson(lambda=2, k=1e9)` said
    // "The answer is NaN", and `normal(mu=0, sigma=0, x=1)` said "Infinity".
    if (/^-?(NaN|Infinity)$|^undefined\b/.test(mainResult)) {
      return formatErrorResponse(
        `${dist} ${op} is not defined for these parameters (computed ${mainResult})`
      );
    }
    return formatToolResponse({
      result: mainResult,
      notes: result.lines,
    });
  } catch (error) {
    return formatErrorResponse(error instanceof Error ? error.message : String(error));
  }
}
