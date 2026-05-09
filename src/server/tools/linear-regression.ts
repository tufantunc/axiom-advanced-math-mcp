import { giacEngine } from '../giac/index.js';
import { formatRawResponse, formatRawError } from './response-formatter.js';

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

export async function linearRegressionHandler(args: Record<string, unknown>) {
  const x = args.x as number[];
  const y = args.y as number[];
  const model = (args.model as string) || 'linear';
  const degree = (args.degree as number) || 1;

  if (x.length !== y.length) {
    return {
      content: [{ type: 'text' as const, text: 'Error: x and y must have the same length' }],
      isError: true,
    };
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
        return {
          content: [{ type: 'text' as const, text: 'Error: exponential model requires all y > 0' }],
          isError: true,
        };
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
        return {
          content: [{ type: 'text' as const, text: 'Error: logarithmic model requires all x > 0' }],
          isError: true,
        };
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
        return {
          content: [
            { type: 'text' as const, text: 'Error: power model requires all x > 0 and y > 0' },
          ],
          isError: true,
        };
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
