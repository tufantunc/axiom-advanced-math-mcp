import { giacEngine } from '../giac/index.js';
import { formatToolResponse, formatErrorResponse } from './response-formatter.js';

/** Evaluate f(x) at a point using Giac */
async function evalAt(expr: string, variable: string, x: number): Promise<number> {
  const raw = await giacEngine.evaluate(`evalf(subst(${expr},${variable}=${x}))`);
  const val = parseFloat(raw.trim());
  if (isNaN(val)) throw new Error(`Cannot evaluate ${expr} at ${variable}=${x}: got "${raw}"`);
  return val;
}

/** Evaluate f'(x) at a point using Giac symbolic differentiation */
async function evalDerivAt(expr: string, variable: string, x: number): Promise<number> {
  const raw = await giacEngine.evaluate(`evalf(subst(diff(${expr},${variable}),${variable}=${x}))`);
  const val = parseFloat(raw.trim());
  if (isNaN(val)) throw new Error(`Cannot evaluate derivative of ${expr} at ${variable}=${x}`);
  return val;
}

async function newtonRaphson(
  expr: string,
  variable: string,
  x0: number,
  tol: number,
  maxIter: number
): Promise<string[]> {
  const lines = [
    `Method: Newton-Raphson`,
    `f(${variable}) = ${expr}`,
    `Starting point: ${x0}`,
    `Tolerance: ${tol}`,
    ``,
    'Iteration table:',
    `${'Iter'.padEnd(6)} ${'x'.padEnd(20)} ${'f(x)'.padEnd(20)} ${'|f(x)|'}`,
  ];

  let x = x0;
  for (let i = 0; i < maxIter; i++) {
    const fx = await evalAt(expr, variable, x);
    const fpx = await evalDerivAt(expr, variable, x);
    lines.push(
      `${String(i).padEnd(6)} ${x.toPrecision(14).padEnd(20)} ${fx.toPrecision(6).padEnd(20)} ${Math.abs(fx).toExponential(3)}`
    );

    if (Math.abs(fx) < tol) {
      lines.push(``, `✓ Converged in ${i + 1} iterations.`);
      lines.push(`Root: ${variable} = ${x}`);
      lines.push(`f(root) = ${fx.toExponential(6)}`);
      return lines;
    }
    if (Math.abs(fpx) < 1e-15) {
      lines.push(``, `✗ Failed: derivative too small at x = ${x} (flat region).`);
      return lines;
    }
    x = x - fx / fpx;
  }
  lines.push(``, `✗ Did not converge within ${maxIter} iterations.`);
  lines.push(`Last x = ${x}`);
  return lines;
}

/**
 * Simpson's rule costs one Giac call per subinterval. 200 points keeps a
 * well-behaved integrand near the cost of a single evaluation; the wall-clock
 * budget below is what actually bounds a hostile integrand, since the caller
 * chooses how expensive each of those calls is.
 */
const MAX_SIMPSON_POINTS = 200;
const DEFAULT_SIMPSON_POINTS = 200;
/**
 * Read per call rather than at module load so a test can shrink it: the real
 * budget takes ~11s to trip, which is too slow to assert in the unit suite.
 * Mirrors AXIOM_EVAL_TIMEOUT_MS, the per-call bound this one sits above.
 */
const integrationBudgetMs = (): number => Number(process.env.AXIOM_INTEGRATION_BUDGET_MS ?? 10_000);

async function bisection(
  expr: string,
  variable: string,
  a: number,
  b: number,
  tol: number,
  maxIter: number
): Promise<string[]> {
  const fa = await evalAt(expr, variable, a);
  const fb = await evalAt(expr, variable, b);

  if (fa * fb >= 0) {
    return [
      `Method: Bisection`,
      `✗ Error: f(${a}) = ${fa.toFixed(6)} and f(${b}) = ${fb.toFixed(6)} have the same sign.`,
      `Bisection requires a sign change in [x0, x1] — f must have a root in this interval.`,
    ];
  }

  const lines = [
    `Method: Bisection`,
    `f(${variable}) = ${expr}`,
    `Bracket: [${a}, ${b}]`,
    `f(${a}) = ${fa.toExponential(4)}, f(${b}) = ${fb.toExponential(4)}`,
    `Tolerance: ${tol}`,
    ``,
    'Iteration table:',
    `${'Iter'.padEnd(6)} ${'a'.padEnd(20)} ${'b'.padEnd(20)} ${'midpoint'.padEnd(22)} f(mid)`,
  ];

  let lo = a,
    hi = b;
  for (let i = 0; i < maxIter; i++) {
    const mid = (lo + hi) / 2;
    const fmid = await evalAt(expr, variable, mid);
    const flo = await evalAt(expr, variable, lo);
    lines.push(
      `${String(i).padEnd(6)} ${lo.toPrecision(10).padEnd(20)} ${hi.toPrecision(10).padEnd(20)} ${mid.toPrecision(12).padEnd(22)} ${fmid.toExponential(4)}`
    );

    if (Math.abs(fmid) < tol || (hi - lo) / 2 < tol) {
      lines.push(``, `✓ Converged in ${i + 1} iterations.`);
      lines.push(`Root: ${variable} = ${mid}`);
      lines.push(`f(root) = ${fmid.toExponential(6)}`);
      return lines;
    }
    if (flo * fmid < 0) hi = mid;
    else lo = mid;
  }
  lines.push(``, `✗ Did not converge within ${maxIter} iterations.`);
  return lines;
}

async function secant(
  expr: string,
  variable: string,
  x0: number,
  x1: number,
  tol: number,
  maxIter: number
): Promise<string[]> {
  const lines = [
    `Method: Secant`,
    `f(${variable}) = ${expr}`,
    `Starting points: x0=${x0}, x1=${x1}`,
    `Tolerance: ${tol}`,
    ``,
    'Iteration table:',
    `${'Iter'.padEnd(6)} ${'x'.padEnd(22)} ${'f(x)'.padEnd(20)} ${'|f(x)|'}`,
  ];

  let prev = x0,
    curr = x1;
  for (let i = 0; i < maxIter; i++) {
    const fprev = await evalAt(expr, variable, prev);
    const fcurr = await evalAt(expr, variable, curr);
    lines.push(
      `${String(i).padEnd(6)} ${curr.toPrecision(14).padEnd(22)} ${fcurr.toPrecision(6).padEnd(20)} ${Math.abs(fcurr).toExponential(3)}`
    );

    if (Math.abs(fcurr) < tol) {
      lines.push(``, `✓ Converged in ${i + 1} iterations.`);
      lines.push(`Root: ${variable} = ${curr}`);
      lines.push(`f(root) = ${fcurr.toExponential(6)}`);
      return lines;
    }
    const denom = fcurr - fprev;
    if (Math.abs(denom) < 1e-15) {
      lines.push(``, `✗ Failed: division by zero (f(x1) ≈ f(x0)).`);
      return lines;
    }
    const next = curr - (fcurr * (curr - prev)) / denom;
    prev = curr;
    curr = next;
  }
  lines.push(``, `✗ Did not converge within ${maxIter} iterations.`);
  return lines;
}

async function rombergIntegration(
  expr: string,
  variable: string,
  a: number,
  b: number
): Promise<string[]> {
  const raw = await giacEngine.evaluate(`romberg(${expr},${variable},${a},${b})`);
  const val = parseFloat(raw.trim());
  const lines = [
    `Method: Romberg Integration (adaptive)`,
    `∫ ${expr} d${variable} from ${a} to ${b}`,
    ``,
    `Result = ${isNaN(val) ? raw.trim() : val}`,
  ];
  return lines;
}

async function simpsonIntegration(
  expr: string,
  variable: string,
  a: number,
  b: number,
  n: number
): Promise<string[]> {
  // n must be even
  if (n % 2 !== 0) n += 1;
  const h = (b - a) / n;
  const lines = [
    `Method: Simpson's Rule (n = ${n} subintervals)`,
    `∫ ${expr} d${variable} from ${a} to ${b}`,
  ];

  let sum = 0;
  const fa = await evalAt(expr, variable, a);
  const fb = await evalAt(expr, variable, b);
  sum = fa + fb;

  // One Giac round trip per subinterval, and the caller controls the integrand,
  // so the per-call AXIOM_EVAL_TIMEOUT_MS never fires while the total runs away:
  // a 78-character problem measured 18.4s at 1000 points and was still running
  // after 10 minutes with a heavier integrand. The whole handler holds the
  // global CAS mutex, so that stalls every other client too. Bound the sum.
  const budgetMs = integrationBudgetMs();
  const deadline = Date.now() + budgetMs;
  for (let i = 1; i < n; i++) {
    if (Date.now() > deadline) {
      throw new Error(
        `numerical_integration exceeded its ${budgetMs}ms budget after ${i} of ${n} points — ` +
          `try a simpler integrand or a smaller n_points`
      );
    }
    const xi = a + i * h;
    const fxi = await evalAt(expr, variable, xi);
    sum += (i % 2 === 0 ? 2 : 4) * fxi;
  }
  const result = (h / 3) * sum;

  lines.push(`h = (${b} - ${a}) / ${n} = ${h.toExponential(6)}`);
  lines.push(``, `Result = ${result}`);
  return lines;
}

export async function numericalMethodsHandler(args: Record<string, unknown>) {
  const method = args.method as string;
  const expr = args.expression as string;
  const variable = (args.variable as string) || 'x';
  const tol = (args.tolerance as number) ?? 1e-10;
  const maxIter = (args.max_iterations as number) ?? 100;

  try {
    let lines: string[];

    switch (method) {
      case 'newton_raphson': {
        const x0 = args.initial_guess as number;
        if (x0 === undefined) return formatErrorResponse('newton_raphson requires initial_guess');
        lines = await newtonRaphson(expr, variable, x0, tol, maxIter);
        break;
      }
      case 'bisection': {
        const a = args.x0 as number,
          b = args.x1 as number;
        if (a === undefined || b === undefined)
          return formatErrorResponse('bisection requires x0 (lower) and x1 (upper) bracket');
        lines = await bisection(expr, variable, a, b, tol, maxIter);
        break;
      }
      case 'secant': {
        const x0 = args.x0 as number,
          x1 = args.x1 as number;
        if (x0 === undefined || x1 === undefined)
          return formatErrorResponse('secant requires x0 and x1');
        lines = await secant(expr, variable, x0, x1, tol, maxIter);
        break;
      }
      case 'romberg_integration': {
        const a = args.lower_bound as number,
          b = args.upper_bound as number;
        if (a === undefined || b === undefined)
          return formatErrorResponse('romberg_integration requires lower_bound and upper_bound');
        lines = await rombergIntegration(expr, variable, a, b);
        break;
      }
      case 'numerical_integration': {
        const a = args.lower_bound as number,
          b = args.upper_bound as number;
        const requested = (args.n_points as number) || DEFAULT_SIMPSON_POINTS;
        if (!Number.isInteger(requested) || requested < 2 || requested > MAX_SIMPSON_POINTS) {
          return formatErrorResponse(
            `n_points must be an integer between 2 and ${MAX_SIMPSON_POINTS}, got ${String(requested)}`
          );
        }
        const n = requested;
        if (a === undefined || b === undefined)
          return formatErrorResponse('numerical_integration requires lower_bound and upper_bound');
        lines = await simpsonIntegration(expr, variable, a, b, n);
        break;
      }
      default:
        return formatErrorResponse(`Unknown method: ${method}`);
    }

    // A failure is signalled in-band, as a line beginning `✗ Error:`. Shipping
    // that through formatToolResponse made `bisection(x^2-2, 3, 4)` answer
    // "Bisection requires a sign change in [x0, x1]" with isError:false — a
    // failure the caller reads as the result. Reachable only since the extractor
    // started emitting x0/x1, which is what makes these methods run at all.
    const failure = lines.find((l) => /^\s*✗?\s*Error:/.test(l));
    if (failure) {
      return formatErrorResponse(
        lines
          .slice(1)
          .join(' ')
          .replace(/^\s*✗?\s*Error:\s*/, '')
      );
    }

    // The answer to "find a root" is the root, not the residual. Scanning only
    // the last line found `f(root) = 3.154474e-11`, and the `Root|Result` regex
    // is case-sensitive so lowercase `f(root)` fell through to the raw line —
    // so `bisection(x^2-2, 1, 2)` answered 3.15e-11 for a root of 1.4142136.
    const answer =
      lines.find((l) => /^Root:/.test(l)) ??
      lines.find((l) => /^Result/.test(l)) ??
      lines[lines.length - 1];
    const mainResult = answer.replace(/^[^=:]*[=:]\s*/, '').trim();

    return formatToolResponse({
      result: mainResult,
      notes: lines,
    });
  } catch (error) {
    return formatErrorResponse(error instanceof Error ? error.message : String(error));
  }
}
