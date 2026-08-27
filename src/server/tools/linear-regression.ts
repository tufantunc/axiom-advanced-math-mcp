import { giacEngine } from '../giac/index.js';
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
  const Astr = `[${Arows.map((row) => `[${row.join(',')}]`).join(',')}]`;
  const bstr = `[${y.map((yi) => `[${yi}]`).join(',')}]`;

  const raw = await giacEngine.evaluate(`lsq(${Astr},${bstr})`);

  const stripped = raw.replace(/^\[\[?/, '').replace(/\]?\]$/, '');
  const coeffs = stripped
    .split(/\],?\[?/)
    .map((s) => parseFloat(s.trim()))
    .filter((v) => !isNaN(v));

  const yHat = x.map((xi) => coeffs.reduce((s, c, j) => s + c * xi ** j, 0));
  return { coeffs, yHat };
}

function formatPolynomial(coeffs: number[], variable = 'x'): string {
  const terms: string[] = [];
  for (let i = coeffs.length - 1; i >= 0; i--) {
    const c = coeffs[i];
    if (Math.abs(c) < 1e-12) continue;
    const sign = terms.length > 0 ? (c >= 0 ? ' + ' : ' - ') : c < 0 ? '-' : '';
    const absC = Math.abs(c);
    const coefStr = absC === 1 && i > 0 ? '' : absC.toPrecision(6);
    const varStr = i === 0 ? '' : i === 1 ? variable : `${variable}^${i}`;
    terms.push(`${sign}${coefStr}${varStr}`);
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
    lines.push(`  MSE = ${mse.toFixed(6)}`);
    lines.push(`  RMSE = ${Math.sqrt(mse).toFixed(6)}`);
  }
  return lines;
}

/** A fit above this is not a useful answer and risks trapping the WASM engine. */
const MAX_FIT_DEGREE = 10;

export async function linearRegressionHandler(args: Record<string, unknown>) {
  const x = args.x as number[];
  const y = args.y as number[];
  const model = (args.model as string) || 'linear';
  // `|| 1` treats an explicit degree of 0 as absent, so the validation below
  // never saw it and a degree-0 request silently became a linear fit.
  const degree = args.degree === undefined ? 1 : (args.degree as number);

  // Shape first, then values, then the parameter. Checking `degree` before the
  // lengths matched reported "degree must be ... below the number of points (3)"
  // for `x=[1,2,3], y=[1,2]`, naming the wrong field and citing x's length while
  // the actual defect was that y was shorter.
  if (!Array.isArray(x) || !Array.isArray(y) || x.length < 2 || y.length < 2) {
    return formatErrorResponse(
      'linear_regression requires x and y arrays with at least 2 points each'
    );
  }
  if (x.length !== y.length) {
    return formatErrorResponse(
      `x and y must have the same length (got ${x.length} and ${y.length})`
    );
  }
  if (!x.every(Number.isFinite) || !y.every(Number.isFinite)) {
    return formatErrorResponse('x and y must contain only finite numbers');
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
    return formatErrorResponse(
      `degree must be an integer between 1 and ${MAX_FIT_DEGREE}, and below the number of points (${x.length})`
    );
  }

  try {
    const n = x.length;
    let lines: string[];

    if (model === 'linear' || model === 'polynomial') {
      const d = model === 'polynomial' ? degree : 1;
      const { coeffs, yHat } = await polynomialFit(x, y, d);
      const r2 = rSquared(y, yHat);
      const eq = formatPolynomial(coeffs);
      const residuals = y.map((yi, i) => yi - yHat[i]);
      const mse = residuals.reduce((a, r) => a + r * r, 0) / n;

      lines = formatModelOutput(
        model === 'polynomial' ? `Polynomial (degree ${d})` : 'Linear',
        n,
        eq,
        coeffs.map((c, i) => `  a${i} = ${c} (coefficient of x^${i})`),
        r2,
        mse
      );
    } else if (model === 'exponential') {
      if (y.some((yi) => yi <= 0)) {
        return formatErrorResponse('exponential model requires all y > 0');
      }
      const logY = y.map(Math.log);
      const { coeffs } = await polynomialFit(x, logY, 1);
      const lnA = coeffs[0],
        b = coeffs[1];
      const a = Math.exp(lnA);
      const yHat = x.map((xi) => a * Math.exp(b * xi));
      const r2 = rSquared(y, yHat);

      lines = formatModelOutput(
        'Exponential  y = a·e^(bx)',
        n,
        `${a.toPrecision(6)} · e^(${b.toPrecision(6)}·x)`,
        [`  a = ${a.toPrecision(6)}`, `  b = ${b.toPrecision(6)}`],
        r2
      );
    } else if (model === 'logarithmic') {
      if (x.some((xi) => xi <= 0)) {
        return formatErrorResponse('logarithmic model requires all x > 0');
      }
      const logX = x.map(Math.log);
      const { coeffs } = await polynomialFit(logX, y, 1);
      const a = coeffs[0],
        b = coeffs[1];
      const yHat = x.map((xi) => a + b * Math.log(xi));
      const r2 = rSquared(y, yHat);

      lines = formatModelOutput(
        'Logarithmic  y = a + b·ln(x)',
        n,
        `${a.toPrecision(6)} + ${b.toPrecision(6)}·ln(x)`,
        [`  a = ${a.toPrecision(6)}`, `  b = ${b.toPrecision(6)}`],
        r2
      );
    } else if (model === 'power') {
      if (x.some((xi) => xi <= 0) || y.some((yi) => yi <= 0)) {
        return formatErrorResponse('power model requires all x > 0 and y > 0');
      }
      const logX = x.map(Math.log);
      const logY = y.map(Math.log);
      const { coeffs } = await polynomialFit(logX, logY, 1);
      const lnA = coeffs[0],
        b = coeffs[1];
      const a = Math.exp(lnA);
      const yHat = x.map((xi) => a * xi ** b);
      const r2 = rSquared(y, yHat);

      lines = formatModelOutput(
        'Power  y = a·x^b',
        n,
        `${a.toPrecision(6)} · x^${b.toPrecision(6)}`,
        [`  a = ${a.toPrecision(6)}`, `  b = ${b.toPrecision(6)}`],
        r2
      );
    } else {
      return {
        content: [{ type: 'text' as const, text: `Error: Unknown model: ${model}` }],
        isError: true,
      };
    }

    return formatRawResponse(lines);
  } catch (error) {
    return formatRawError(error);
  }
}
