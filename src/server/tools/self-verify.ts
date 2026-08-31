import { giacEngine } from '../giac/index.js';

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
    const n = Number.parseFloat(r);
    if (!Number.isNaN(n)) return Math.abs(n) < 1e-8;
    // Non-numeric result (e.g. a complex residual like "0.+0.*i"): fall back to
    // a symbolic zero check on the un-evalf'd substitution.
    return await simplifiesToZero(`subst(${zeroForm},${substs})`);
  } catch {
    return false;
  }
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
