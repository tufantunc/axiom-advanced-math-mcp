import { giacEngine } from '../giac/index.js';
import { formatToolResponse, formatErrorResponse, inBandFailure } from './response-formatter.js';
import { giacNumber } from './output-cleanup.js';

/** Evaluate f(x) at a point using Giac */
async function evalAt(expr: string, variable: string, x: number): Promise<number> {
  const raw = await giacEngine.evaluate(`evalf(subst(${expr},${variable}=${x}))`);
  // Strict: a symbolic reply is not a value. `evalf(subst(1-cos(y),x=2))` comes
  // back as "1.0-cos(y)", whose parseFloat is 1 — so numerical_integration of an
  // expression in the wrong variable answered "Result = 1".
  const val = giacNumber(raw);
  if (val === null) throw new Error(`Cannot evaluate ${expr} at ${variable}=${x}: got "${raw}"`);
  return val;
}

/** Evaluate f'(x) at a point using Giac symbolic differentiation */
async function evalDerivAt(expr: string, variable: string, x: number): Promise<number> {
  const raw = await giacEngine.evaluate(`evalf(subst(diff(${expr},${variable}),${variable}=${x}))`);
  // Backstop, and labelled as one deliberately: this is called only from
  // newtonRaphson, immediately after evalAt on the same expression and point.
  // A free symbol makes the VALUE symbolic too, so evalAt refuses first — I
  // could not construct an expression numeric at x whose derivative is not.
  // Kept because it costs nothing and the next caller may not have that order.
  const val = giacNumber(raw);
  if (val === null) throw new Error(`Cannot evaluate derivative of ${expr} at ${variable}=${x}`);
  return val;
}

async function newtonRaphson(
  expr: string,
  variable: string,
  x0: number,
  tol: number,
  maxIter: number
): Promise<string[]> {
  const checkIterationBudget = startBudget('root finding');
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
    checkIterationBudget(i, maxIter);
    const fx = await evalAt(expr, variable, x);
    const fpx = await evalDerivAt(expr, variable, x);
    lines.push(
      `${String(i).padEnd(6)} ${x.toPrecision(14).padEnd(20)} ${fx.toPrecision(6).padEnd(20)} ${Math.abs(fx).toExponential(3)}`
    );

    if (Math.abs(fx) < tol) {
      lines.push(
        ``,
        `✓ Converged in ${i + 1} iterations.`,
        `Root: ${variable} = ${x}`,
        `f(root) = ${fx.toExponential(6)}`
      );
      return lines;
    }
    if (Math.abs(fpx) < 1e-15) {
      lines.push(``, `✗ Failed: derivative too small at x = ${x} (flat region).`);
      return lines;
    }
    x = x - fx / fpx;
  }
  lines.push(``, `✗ Did not converge within ${maxIter} iterations.`, `Last x = ${x}`);
  return lines;
}

/**
 * Simpson's rule costs one Giac call per subinterval, so 200 points is ~200
 * round trips — measured at ~18ms each on a moderate integrand, ~3.7s total.
 * The caller chooses how expensive each call is, so the wall-clock budget below
 * is the real bound; this constant only bounds the call COUNT.
 *
 * One value, not a range: the default is the maximum.
 */
const SIMPSON_POINTS = 200;

/**
 * Iterations a root-finder may take. Each costs one or two Giac calls the
 * caller prices via the expression, so an unbounded count is an unbounded hold
 * on the single CAS worker: a 41-character `secant(...)` measured 69.8s.
 */
const MAX_ROOT_ITERATIONS = 100;

const DEFAULT_CALL_TIMEOUT_MS = Number(process.env.AXIOM_EVAL_TIMEOUT_MS ?? 10_000);

/**
 * Wall-clock budget for one multi-call numerical routine.
 *
 * Read per call rather than at module load so a test can shrink it. Validated
 * rather than coerced: `Number('10s')` is NaN and `Date.now() > NaN` is always
 * false, so an unvalidated typo removed the guard silently, while `Number('')`
 * is 0, which failed every integration on its first subinterval.
 *
 * This bounds a SUM of CAS calls, so it sits ABOVE the per-call bound rather
 * than equal to it — at 1x, one slow evaluation consumes the whole budget.
 */
/**
 * A wall-clock checker for a loop that calls the CAS repeatedly.
 *
 * The budget went to Simpson only, leaving the three root-finders — the same
 * shape, in the same file — unbounded: a 55-byte `bisection(...)` with a wide
 * bracket runs all 100 iterations and measured 455.8s, holding the single CAS
 * worker and therefore every other client for that whole window.
 */
function startBudget(label: string): (done: number, total: number) => void {
  const budgetMs = integrationBudgetMs();
  const deadline = Date.now() + budgetMs;
  return (done, total) => {
    if (Date.now() > deadline) {
      throw new Error(
        `${label} exceeded its ${budgetMs}ms budget after ${done} of ${total} steps — ` +
          `try a simpler expression`
      );
    }
  };
}

const integrationBudgetMs = (): number => {
  const configured = Number(process.env.AXIOM_INTEGRATION_BUDGET_MS);
  if (Number.isFinite(configured) && configured > 0) return configured;
  return Math.max(DEFAULT_CALL_TIMEOUT_MS * 3, 30_000);
};

async function bisection(
  expr: string,
  variable: string,
  a: number,
  b: number,
  tol: number,
  maxIter: number
): Promise<string[]> {
  const checkIterationBudget = startBudget('root finding');
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
    checkIterationBudget(i, maxIter);
    const mid = (lo + hi) / 2;
    const fmid = await evalAt(expr, variable, mid);
    const flo = await evalAt(expr, variable, lo);
    lines.push(
      `${String(i).padEnd(6)} ${lo.toPrecision(10).padEnd(20)} ${hi.toPrecision(10).padEnd(20)} ${mid.toPrecision(12).padEnd(22)} ${fmid.toExponential(4)}`
    );

    if (Math.abs(fmid) < tol || (hi - lo) / 2 < tol) {
      lines.push(
        ``,
        `✓ Converged in ${i + 1} iterations.`,
        `Root: ${variable} = ${mid}`,
        `f(root) = ${fmid.toExponential(6)}`
      );
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
  const checkIterationBudget = startBudget('root finding');
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
    checkIterationBudget(i, maxIter);
    const fprev = await evalAt(expr, variable, prev);
    const fcurr = await evalAt(expr, variable, curr);
    lines.push(
      `${String(i).padEnd(6)} ${curr.toPrecision(14).padEnd(22)} ${fcurr.toPrecision(6).padEnd(20)} ${Math.abs(fcurr).toExponential(3)}`
    );

    if (Math.abs(fcurr) < tol) {
      lines.push(
        ``,
        `✓ Converged in ${i + 1} iterations.`,
        `Root: ${variable} = ${curr}`,
        `f(root) = ${fcurr.toExponential(6)}`
      );
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
  // A non-numeric reply is a failure, not a result. Leaving it on the success
  // path put 132KB of unevaluated Giac into `final_result` on exit 0, while the
  // sibling numerical_integration path twelve lines up correctly errored on the
  // same input class.
  const val = giacNumber(raw);
  if (val === null) {
    return [
      `Error: romberg could not evaluate ${expr} over [${a}, ${b}] — the CAS ` +
        `returned "${raw.trim().slice(0, 160)}" rather than a number`,
    ];
  }
  const lines = [
    `Method: Romberg Integration (adaptive)`,
    `∫ ${expr} d${variable} from ${a} to ${b}`,
    ``,
    `Result = ${val}`,
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

  // The deadline has to exist before the first CAS call. Setting it after the
  // two endpoint evaluations left them entirely unbudgeted, so a 10s budget
  // measured 29.3s end to end on a caller-priced integrand.
  const checkBudget = startBudget('numerical_integration');

  let sum = 0;
  checkBudget(0, n);
  const fa = await evalAt(expr, variable, a);
  checkBudget(0, n);
  const fb = await evalAt(expr, variable, b);
  sum = fa + fb;

  for (let i = 1; i < n; i++) {
    checkBudget(i, n);
    const xi = a + i * h;
    const fxi = await evalAt(expr, variable, xi);
    sum += (i % 2 === 0 ? 2 : 4) * fxi;
  }
  const result = (h / 3) * sum;

  lines.push(`h = (${b} - ${a}) / ${n} = ${h.toExponential(6)}`, ``, `Result = ${result}`);
  return lines;
}

/** What one method produced: its output lines, or a refusal to show instead. */
type MethodOutcome = string[] | { error: string };

/** The shared arguments the handler parsed and validated, handed to every runner. */
interface MethodContext {
  expr: string;
  variable: string;
  tol: number;
  maxIter: number;
}

async function runNewtonRaphson(
  args: Record<string, unknown>,
  ctx: MethodContext
): Promise<MethodOutcome> {
  const x0 = args.initial_guess as number;
  if (x0 === undefined) return { error: 'newton_raphson requires initial_guess' };
  return newtonRaphson(ctx.expr, ctx.variable, x0, ctx.tol, ctx.maxIter);
}

async function runBisection(
  args: Record<string, unknown>,
  ctx: MethodContext
): Promise<MethodOutcome> {
  const a = args.x0 as number,
    b = args.x1 as number;
  if (a === undefined || b === undefined)
    return { error: 'bisection requires x0 (lower) and x1 (upper) bracket' };
  return bisection(ctx.expr, ctx.variable, a, b, ctx.tol, ctx.maxIter);
}

async function runSecant(
  args: Record<string, unknown>,
  ctx: MethodContext
): Promise<MethodOutcome> {
  const x0 = args.x0 as number,
    x1 = args.x1 as number;
  if (x0 === undefined || x1 === undefined) return { error: 'secant requires x0 and x1' };
  return secant(ctx.expr, ctx.variable, x0, x1, ctx.tol, ctx.maxIter);
}

async function runRomberg(
  args: Record<string, unknown>,
  ctx: MethodContext
): Promise<MethodOutcome> {
  const a = args.lower_bound as number,
    b = args.upper_bound as number;
  if (a === undefined || b === undefined)
    return { error: 'romberg_integration requires lower_bound and upper_bound' };
  return rombergIntegration(ctx.expr, ctx.variable, a, b);
}

async function runSimpson(
  args: Record<string, unknown>,
  ctx: MethodContext
): Promise<MethodOutcome> {
  const a = args.lower_bound as number,
    b = args.upper_bound as number;
  const requested = args.n_points === undefined ? SIMPSON_POINTS : (args.n_points as number);
  // n_points first, as before: a call with both malformed keeps the message
  // about the count, which a direct caller can act on; the extractor that
  // feeds this handler cannot even emit n_points, so this order is for
  // exactly those callers.
  if (!Number.isInteger(requested) || requested < 2 || requested > SIMPSON_POINTS) {
    return {
      error: `n_points must be an integer between 2 and ${SIMPSON_POINTS}, got ${String(requested)}`,
    };
  }
  if (a === undefined || b === undefined)
    return { error: 'numerical_integration requires lower_bound and upper_bound' };
  return simpsonIntegration(ctx.expr, ctx.variable, a, b, requested);
}

/**
 * Dispatch by method name. A switch kept every guard at switch-depth, which is
 * what carried this handler past Sonar's cognitive-complexity threshold; one
 * runner per method leaves every guard top-level (runSimpson, the busiest,
 * carries two guards and a ternary). Romberg and Simpson ignore tol/maxIter.
 */
type MethodRunner = (args: Record<string, unknown>, ctx: MethodContext) => Promise<MethodOutcome>;

const METHOD_RUNNERS: Record<string, MethodRunner> = {
  newton_raphson: runNewtonRaphson,
  bisection: runBisection,
  secant: runSecant,
  romberg_integration: runRomberg,
  numerical_integration: runSimpson,
};

export async function numericalMethodsHandler(args: Record<string, unknown>) {
  const method = args.method as string;
  const expr = args.expression as string;
  const variable = (args.variable as string) || 'x';
  const tol = (args.tolerance as number) ?? 1e-10;
  const requestedIter = (args.max_iterations as number) ?? MAX_ROOT_ITERATIONS;
  if (
    !Number.isInteger(requestedIter) ||
    requestedIter < 1 ||
    requestedIter > MAX_ROOT_ITERATIONS
  ) {
    return formatErrorResponse(
      `max_iterations must be an integer between 1 and ${MAX_ROOT_ITERATIONS}, got ${String(requestedIter)}`
    );
  }

  try {
    // hasOwn, not a bare lookup: a Record inherits Object.prototype, so
    // METHOD_RUNNERS['constructor'] would resolve to a truthy inherited value
    // and run it, where the switch this replaced answered "Unknown method".
    // Reached only by direct callers today, but the handler is exported for
    // exactly those.
    const runner = Object.hasOwn(METHOD_RUNNERS, method) ? METHOD_RUNNERS[method] : undefined;
    if (!runner) return formatErrorResponse(`Unknown method: ${method}`);
    const outcome = await runner(args, { expr, variable, tol, maxIter: requestedIter });
    if ('error' in outcome) return formatErrorResponse(outcome.error);
    return formatMethodResult(outcome);
  } catch (error) {
    return formatErrorResponse(error instanceof Error ? error.message : String(error));
  }
}

/**
 * The method's lines become either a refusal (an in-band failure marker) or
 * the response whose result is the labelled answer line.
 */
function formatMethodResult(
  lines: string[]
): ReturnType<typeof formatToolResponse> | ReturnType<typeof formatErrorResponse> {
  // Matching only `✗ Error:` caught bisection's sign-change return and none of
  // the five siblings in this file — `✗ Failed: ...` and `✗ Did not converge
  // within N iterations.` fell through to the headline scan below, where the
  // label strip turned them into answers: `newton(x^3-2*x+2, x, 0)` reported
  // "0" for a point where f = 2, and `secant(x^2-2, 1, 1)` reported "division
  // by zero (f(x1) ≈ f(x0))".
  const failure = inBandFailure(lines);
  if (failure) return formatErrorResponse(failure);

  // The answer to "find a root" is the root, not the residual. Scanning only
  // the last line found `f(root) = 3.154474e-11`, and the `Root|Result` regex
  // is case-sensitive so lowercase `f(root)` fell through to the raw line —
  // so `bisection(x^2-2, 1, 2)` answered 3.15e-11 for a root of 1.4142136.
  const labelled =
    lines.find((l) => l.startsWith('Root:')) ?? lines.find((l) => l.startsWith('Result'));
  // Strip the label only from a line that has one. Applying the strip to the
  // raw last line is what turned `Last x = 0` into a bare `0`.
  const mainResult = labelled ? labelled.replace(/^[^=:]*[=:]\s*/, '').trim() : lines.at(-1);
  if (mainResult === undefined) return formatErrorResponse('the method produced no output');

  return formatToolResponse({
    result: mainResult,
    notes: lines,
  });
}
