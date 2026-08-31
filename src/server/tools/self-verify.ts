import { giacEngine } from '../giac/index.js';
import { MAX_ENGINE_DEPTH, nestingDepth } from './giac-eval.js';
import { isPrintedZero, splitTopLevel } from './output-cleanup.js';
import { stripEnclosingBrackets } from './compute/arg-parsing.js';

/** Largest answer this will substitute back; a huge one is its own hazard. */
const MAX_VERIFIABLE_RESULT = 4_000;

export interface VerificationResult {
  verified: boolean;
  method: 'substitution' | 'expand' | 'differentiation';
  detail: string;
}

/**
 * Normalize "lhs=rhs" to "(lhs)-(rhs)"; wrap in parens if no '='.
 * Assumes a single '=' (a well-formed equation); only the first '=' is used.
 */
function toZeroForm(equation: string): string {
  const idx = equation.indexOf('=');
  if (idx !== -1) {
    const lhs = equation.slice(0, idx).trim();
    const rhs = equation.slice(idx + 1).trim();
    return `(${lhs})-(${rhs})`;
  }
  return `(${equation})`;
}

/** True iff evalf(subst(zeroForm, substs)) is ~0, with a symbolic fallback. Never throws. */
async function isZeroAfterSubst(zeroForm: string, substs: string): Promise<boolean> {
  try {
    const r = await giacEngine.evaluate(`evalf(subst(${zeroForm},${substs}))`);
    const n = parseFloat(r);
    if (!isNaN(n)) return Math.abs(n) < 1e-8;
    // Non-numeric result (e.g. a complex residual like "0.+0.*i"): fall back to
    // a symbolic zero check on the un-evalf'd substitution.
    return await simplifiesToZero(`subst(${zeroForm},${substs})`);
  } catch {
    return false;
  }
}

/**
 * Every component of a printed vector is zero, however the engine spelt it.
 *
 * `0.0` is a zero. Comparing the components to the string '0' is the same trap
 * this project already fixed once in the linearity check, and it reappeared here:
 * a float initial condition makes the check subtract floats, so `y(0)=1.5` — whose
 * answer `[[1.5*cos(x),-1.5*sin(x)]]` is trivially exact — left `[0.0,0.0]` and
 * silently lost its check mark, on precisely the inputs the condition check had
 * just been added for.
 */
function allZero(vector: string): boolean {
  return splitTopLevel(stripEnclosingBrackets(vector), ',').every(isPrintedZero);
}

/** True iff simplify(expr) is exactly 0. Never throws. */
async function simplifiesToZero(expr: string): Promise<boolean> {
  try {
    const r = await giacEngine.evaluate(`simplify(${expr})`);
    const t = (r ?? '').trim();
    return t === '0' || t === '0.0';
  } catch {
    return false;
  }
}

export async function verifySolveSet(
  equation: string,
  variable: string,
  solutions: string[]
): Promise<VerificationResult> {
  const method = 'substitution';
  if (solutions.length === 0) {
    return { verified: false, method, detail: 'no solutions to verify' };
  }
  const zero = toZeroForm(equation);
  let ok = 0;
  for (const sol of solutions) {
    if (await isZeroAfterSubst(zero, `${variable}=${sol}`)) ok++;
  }
  return {
    verified: ok === solutions.length,
    method,
    detail: `${ok}/${solutions.length} roots satisfy the equation`,
  };
}

export async function verifySystem(
  equations: string[],
  variables: string[],
  tuple: string[]
): Promise<VerificationResult> {
  const method = 'substitution';
  if (tuple.length === 0 || tuple.length !== variables.length) {
    return { verified: false, method, detail: 'solution tuple does not match variables' };
  }
  const substs = variables.map((v, i) => `${v}=${tuple[i]}`).join(',');
  let ok = 0;
  for (const eq of equations) {
    if (await isZeroAfterSubst(toZeroForm(eq), substs)) ok++;
  }
  return {
    verified: ok === equations.length,
    method,
    detail: `${ok}/${equations.length} equations satisfied`,
  };
}

export async function verifyFactor(
  original: string,
  factored: string
): Promise<VerificationResult> {
  const ok = await simplifiesToZero(`expand(${factored})-(${original})`);
  return {
    verified: ok,
    method: 'expand',
    detail: ok
      ? 'expand(factored) equals the original'
      : 'expand(factored) does not equal original',
  };
}

export async function verifyIntegrate(
  integrand: string,
  variable: string,
  result: string
): Promise<VerificationResult> {
  const ok = await simplifiesToZero(`diff(${result},${variable})-(${integrand})`);
  return {
    verified: ok,
    method: 'differentiation',
    detail: ok
      ? 'derivative of the result equals the integrand'
      : 'derivative does not equal the integrand',
  };
}

/**
 * Whether a matrix-form ODE system's answer actually solves the system.
 *
 * The rewrite has several places where a well-formed but wrong answer can come
 * back, and none of the shape guards see them: a coefficient matrix mixing a
 * float with an exact transcendental (`[[0,1],[-1.5,ln(2)]]`) returns an
 * ordinary-looking vector of functions whose residual is 2.1, not 0. Rather
 * than enumerate those cases, this checks the property being claimed —
 * `Y' = A*Y + b` — which is also what catches the next one.
 *
 * Numeric, at one point, with a relative tolerance: an exact symbolic check is
 * not available for a float matrix, whose true residual is ~1e-12 rather than
 * 0. Measured separation is twelve orders of magnitude — correct answers score
 * below 1e-12 relative, wrong ones above 1 — so the threshold is not delicate.
 * A single point can in principle miss a residual that vanishes there; it is a
 * check against gross wrongness, not a proof.
 */
export async function verifyOdeSystem(
  matrix: string,
  constants: string,
  variable: string,
  result: string,
  evaluate: (expr: string) => Promise<string>,
  condition?: string,
  exact = false
): Promise<VerificationResult | undefined> {
  const method = 'substitution';
  const raw = result.trim();
  // Anything but a solution vector is another guard's business — an unfinished
  // `poly1[...]` or `[]` is refused downstream, and reporting it here as
  // "unverified" would say the wrong thing about it.
  if (!raw.startsWith('[[') || !raw.endsWith(']]')) return undefined;
  // Undecided, not wrong. The check embeds the answer three times, so a large
  // one is its own hazard to send back to the engine — but "I did not check" is
  // not evidence against the answer, and returning a failure here refused a
  // correct degree-60 forcing term whose exact residual is [0,0].
  // Length AND depth, the same pair `toLatex` bounds and for the same reason:
  // this hands engine output straight back to the engine, embedding the solution
  // twice. Length alone was not enough — a depth-140 answer is 1,127 characters,
  // well inside the 4,000, and killed the worker outright. The bound is imported
  // rather than restated; the last predicate this file wrote out a second time
  // silently cost a correct answer its verification mark.
  if (raw.length > MAX_VERIFIABLE_RESULT || nestingDepth(raw) > MAX_ENGINE_DEPTH) {
    return undefined;
  }
  const solution = raw.slice(1, -1);
  const rhs = `(${matrix})*(${solution})${constants ? `+(${constants})` : ''}`;
  try {
    // Exact, or no verdict. There is no sound numeric version of this check.
    //
    // A float matrix's residual is never exactly zero, so an earlier version
    // sampled points and scored the residual against the size of the answer.
    // That cannot separate the two things it has to: a CORRECT answer whose
    // 12-digit float coefficients are amplified by ~1e16 binomial terms scores
    // the same as one that does not solve the system at all — measured, a
    // correct degree-30 forcing term scored 0.89 where a genuinely wrong answer
    // scored 1.2. Scoring the best of several points to get around that then
    // certified an answer wrong by 60x at its own initial condition, because one
    // forgiving point decided for all of them.
    //
    // So this reports ✓ only where it is proven, and no verdict otherwise —
    // never a failure it cannot stand behind. The mixed-domain answer that
    // motivated the check is now prevented at the source instead, by giving the
    // matrix a single numeric domain before it is solved.
    const residual = (await evaluate(`normal(diff(${solution},${variable})-(${rhs}))`)).trim();
    if (!allZero(residual)) {
      // "No sound numeric version" is true only where a FLOAT is involved. With
      // an exact system there is no rounding to hide behind: `normal` returning
      // anything but zero is proof the answer does not solve the system, and
      // discarding that as "undecided" shipped `[y'=z, z'=-y+sqrt(x)]` as the
      // HOMOGENEOUS solution — the forcing term simply gone, residual `[0,-√x]`,
      // success:true and no warning. main answered it wrongly too but said so.
      return exact
        ? { verified: false, method, detail: `does not satisfy Y’ = A·Y + b; residual ${residual}` }
        : undefined;
    }
    // An IVP asks a strictly stronger question, and the mark has to mean the
    // whole of it. Satisfying `Y' = A*Y + b` while missing the conditions is a
    // genuine solution of a DIFFERENT initial-value problem — one such answer
    // returned y(0) = 1984 where the caller asked for 1.5, and earned an honest ✓
    // for the half that was checked.
    if (condition !== undefined) {
      const parsed = /^[A-Za-z_]\w*\((.*)\)=(\[.*\])$/.exec(condition.trim());
      if (!parsed) return undefined;
      const [, point, values] = parsed;
      const held = (
        await evaluate(`normal(subst(${solution},${variable}=${point})-${values})`)
      ).trim();
      if (!allZero(held)) {
        return undefined;
      }
      return {
        verified: true,
        method,
        detail: 'substitutes back into Y’ = A·Y + b and meets the initial conditions',
      };
    }
    return { verified: true, method, detail: 'substitutes back into Y’ = A·Y + b exactly' };
  } catch {
    return undefined;
  }
}
