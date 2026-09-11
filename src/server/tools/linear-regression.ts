import { giacEngine } from '../giac/index.js';
import { giacNumber } from './output-cleanup.js';
import { formatRawResponse, formatRawError, formatErrorResponse } from './response-formatter.js';

function mean(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function rSquared(y: number[], yHat: number[]): number {
  const yMean = mean(y);
  const sst = y.reduce((a, yi) => a + (yi - yMean) ** 2, 0);
  const sse = y.reduce((a, yi, i) => a + (yi - yHat[i]) ** 2, 0);
  return sst === 0 ? 1 : 1 - sse / sst;
}

async function polynomialFit(
  x: number[],
  y: number[],
  degree: number
): Promise<{ coeffs: number[]; yHat: number[] }> {
  const Arows = x.map((xi) => Array.from({ length: degree + 1 }, (_, j) => xi ** j));
  const Aentries = Arows.map((row) => `[${row.join(',')}]`).join(',');
  const Astr = `[${Aentries}]`;
  const bentries = y.map((yi) => `[${yi}]`).join(',');
  const bstr = `[${bentries}]`;

  // `evalf`, and a strict per-component parse. Bare `lsq` returns EXACT
  // RATIONALS — `[[1/2],[9/14]]` — and parseFloat read those as [1, 9], so
  // linear_regression(x=[1,2,4], y=[1,2,3]) reported "ŷ = 9.00000x + 1.00000"
  // against a true fit of 0.6429x + 0.5, with R² = -762.
  const raw = await giacEngine.evaluate(`evalf(lsq(${Astr},${bstr}))`);

  const stripped = raw.replace(/^\[\[?/, '').replace(/\]?\]$/, '');
  const parsed = stripped.split(/\],?\[?/).map((part) => giacNumber(part));
  if (parsed.some((v) => v === null || !Number.isFinite(v))) {
    throw new Error(`lsq did not return numeric coefficients: got "${raw.trim().slice(0, 200)}"`);
  }
  const coeffs = parsed as number[];

  const yHat = x.map((xi) => coeffs.reduce((s, c, j) => s + c * xi ** j, 0));
  return { coeffs, yHat };
}

function formatTerm(c: number, i: number, variable: string, isFirst: boolean): string {
  let sign: string;
  if (isFirst) sign = c < 0 ? '-' : '';
  else sign = c >= 0 ? ' + ' : ' - ';
  const absC = Math.abs(c);
  const coefStr = absC === 1 && i > 0 ? '' : absC.toPrecision(6);
  let varStr: string;
  if (i === 0) varStr = '';
  else if (i === 1) varStr = variable;
  else varStr = `${variable}^${i}`;
  return `${sign}${coefStr}${varStr}`;
}

function formatPolynomial(coeffs: number[], variable = 'x'): string {
  const terms: string[] = [];
  for (let i = coeffs.length - 1; i >= 0; i--) {
    const c = coeffs[i];
    if (Math.abs(c) < 1e-12) continue;
    terms.push(formatTerm(c, i, variable, terms.length === 0));
  }
  return terms.join('') || '0';
}

function formatModelOutput(
  modelName: string,
  n: number,
  equation: string,
  coefficients: string[],
  r2: number,
  mse?: number
): string[] {
  const lines: string[] = [
    `Model: ${modelName}`,
    `n = ${n} data points`,
    ``,
    `Equation: ŷ = ${equation}`,
    ``,
    `Coefficients:`,
    ...coefficients,
    ``,
    `Goodness of fit:`,
    `  R² = ${r2.toFixed(6)} (${(r2 * 100).toFixed(2)}% variance explained)`,
  ];
  if (mse !== undefined) {
    lines.push(`  MSE = ${mse.toFixed(6)}`, `  RMSE = ${Math.sqrt(mse).toFixed(6)}`);
  }
  return lines;
}

/** A fit above this is not a useful answer and risks trapping the WASM engine. */
const MAX_FIT_DEGREE = 10;

function validateRegressionArgs(
  x: number[],
  y: number[],
  model: string,
  degree: number
): string | null {
  // Shape first, then values, then the parameter. Checking `degree` before the
  // lengths matched reported "degree must be ... below the number of points (3)"
  // for `x=[1,2,3], y=[1,2]`, naming the wrong field and citing x's length while
  // the actual defect was that y was shorter.
  if (!Array.isArray(x) || !Array.isArray(y) || x.length < 2 || y.length < 2) {
    return 'linear_regression requires x and y arrays with at least 2 points each';
  }
  if (x.length !== y.length) {
    return `x and y must have the same length (got ${x.length} and ${y.length})`;
  }
  if (!x.every(Number.isFinite) || !y.every(Number.isFinite)) {
    return 'x and y must contain only finite numbers';
  }
  // Only the polynomial branch reads `degree`, so a caller pairing an explicit
  // degree with `model: 'exponential'` was rejected on a parameter the fit
  // ignores. A degree at or above the point count is not identifiable, and an
  // unbounded one builds a Vandermonde matrix large enough to trap the WASM
  // engine — `degree=3000` used to take the CAS down for the process lifetime.
  if (
    model === 'polynomial' &&
    (!Number.isInteger(degree) || degree < 1 || degree > MAX_FIT_DEGREE || degree >= x.length)
  ) {
    return `degree must be an integer between 1 and ${MAX_FIT_DEGREE}, and below the number of points (${x.length})`;
  }
  return null;
}

// Model refusals are thrown, not returned: the handler's catch runs them
// through formatRawError, whose envelope is byte-identical to
// formatErrorResponse's for the same message.
async function fitLinearOrPolynomial(
  x: number[],
  y: number[],
  model: string,
  degree: number
): Promise<string[]> {
  const n = x.length;
  const d = model === 'polynomial' ? degree : 1;
  const { coeffs, yHat } = await polynomialFit(x, y, d);
  const r2 = rSquared(y, yHat);
  const eq = formatPolynomial(coeffs);
  const residuals = y.map((yi, i) => yi - yHat[i]);
  const mse = residuals.reduce((a, r) => a + r * r, 0) / n;

  return formatModelOutput(
    model === 'polynomial' ? `Polynomial (degree ${d})` : 'Linear',
    n,
    eq,
    coeffs.map((c, i) => `  a${i} = ${c} (coefficient of x^${i})`),
    r2,
    mse
  );
}

async function fitExponential(x: number[], y: number[]): Promise<string[]> {
  const n = x.length;
  if (y.some((yi) => yi <= 0)) {
    throw new Error('exponential model requires all y > 0');
  }
  const logY = y.map(Math.log);
  const { coeffs } = await polynomialFit(x, logY, 1);
  const lnA = coeffs[0],
    b = coeffs[1];
  const a = Math.exp(lnA);
  const yHat = x.map((xi) => a * Math.exp(b * xi));
  const r2 = rSquared(y, yHat);

  return formatModelOutput(
    'Exponential  y = a·e^(bx)',
    n,
    `${a.toPrecision(6)} · e^(${b.toPrecision(6)}·x)`,
    [`  a = ${a.toPrecision(6)}`, `  b = ${b.toPrecision(6)}`],
    r2
  );
}

async function fitLogarithmic(x: number[], y: number[]): Promise<string[]> {
  const n = x.length;
  if (x.some((xi) => xi <= 0)) {
    throw new Error('logarithmic model requires all x > 0');
  }
  const logX = x.map(Math.log);
  const { coeffs } = await polynomialFit(logX, y, 1);
  const a = coeffs[0],
    b = coeffs[1];
  const yHat = x.map((xi) => a + b * Math.log(xi));
  const r2 = rSquared(y, yHat);

  return formatModelOutput(
    'Logarithmic  y = a + b·ln(x)',
    n,
    `${a.toPrecision(6)} + ${b.toPrecision(6)}·ln(x)`,
    [`  a = ${a.toPrecision(6)}`, `  b = ${b.toPrecision(6)}`],
    r2
  );
}

async function fitPower(x: number[], y: number[]): Promise<string[]> {
  const n = x.length;
  if (x.some((xi) => xi <= 0) || y.some((yi) => yi <= 0)) {
    throw new Error('power model requires all x > 0 and y > 0');
  }
  const logX = x.map(Math.log);
  const logY = y.map(Math.log);
  const { coeffs } = await polynomialFit(logX, logY, 1);
  const lnA = coeffs[0],
    b = coeffs[1];
  const a = Math.exp(lnA);
  const yHat = x.map((xi) => a * xi ** b);
  const r2 = rSquared(y, yHat);

  return formatModelOutput(
    'Power  y = a·x^b',
    n,
    `${a.toPrecision(6)} · x^${b.toPrecision(6)}`,
    [`  a = ${a.toPrecision(6)}`, `  b = ${b.toPrecision(6)}`],
    r2
  );
}

export async function linearRegressionHandler(args: Record<string, unknown>) {
  const x = args.x as number[];
  const y = args.y as number[];
  const model = (args.model as string) || 'linear';
  // `|| 1` treats an explicit degree of 0 as absent, so the validation below
  // never saw it and a degree-0 request silently became a linear fit.
  const degree = args.degree === undefined ? 1 : (args.degree as number);

  const paramError = validateRegressionArgs(x, y, model, degree);
  if (paramError) return formatErrorResponse(paramError);

  try {
    if (model === 'linear' || model === 'polynomial') {
      return formatRawResponse(await fitLinearOrPolynomial(x, y, model, degree));
    }
    if (model === 'exponential') return formatRawResponse(await fitExponential(x, y));
    if (model === 'logarithmic') return formatRawResponse(await fitLogarithmic(x, y));
    if (model === 'power') return formatRawResponse(await fitPower(x, y));
    return formatErrorResponse(`Unknown model: ${model}`);
  } catch (error) {
    return formatRawError(error);
  }
}
