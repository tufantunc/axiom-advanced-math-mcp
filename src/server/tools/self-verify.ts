import { giacEngine } from '../giac/index.js';
import { MAX_ENGINE_DEPTH } from './giac-eval.js';
import { escapeForRegExp, nestingDepth, isPrintedZero, splitTopLevel } from './output-cleanup.js';
import { stripEnclosingBrackets } from './compute/arg-parsing.js';
import { unicodeToAscii } from './unicode-normalize.js';
import { beforeTopLevelConjunction, isOneBareEquation, odeClauses } from './ode-clauses.js';

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
    const n = Number.parseFloat(r);
    if (!Number.isNaN(n)) return Math.abs(n) < 1e-8;
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

/*
 * Every verifier below that takes the CALLER's text normalises it first, as
 * the answer it checks was normalised on its way to the engine (evalWithLatex
 * runs unicodeToAscii). Unnormalised, the check and the answer read different
 * expressions: `integrate(x², x)` answered `x^3/3` and verified ✗ against an
 * integrand `x²` that Giac reads as one identifier, as did `integrate(x⁻¹, x)`
 * and `factor(x²-4)` — a correct answer reported as disproved.
 * verifyOdeSolution is normalised by its caller, which needs the ASCII form
 * for its cache key too.
 */

export async function verifySolveSet(
  equation: string,
  variable: string,
  solutions: string[]
): Promise<VerificationResult> {
  const method = 'substitution';
  if (solutions.length === 0) {
    return { verified: false, method, detail: 'no solutions to verify' };
  }
  const zero = toZeroForm(unicodeToAscii(equation));
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
    if (await isZeroAfterSubst(toZeroForm(unicodeToAscii(eq)), substs)) ok++;
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
  const ok = await simplifiesToZero(`expand(${factored})-(${unicodeToAscii(original)})`);
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
  const ok = await simplifiesToZero(`diff(${result},${variable})-(${unicodeToAscii(integrand)})`);
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
  condition?: string
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
  const constantTerm = constants ? `+(${constants})` : '';
  const rhs = `(${matrix})*(${solution})${constantTerm}`;
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
      // `normal` is not a zero test. Giac answers a `b^k` coefficient in the
      // `exp(k*ln(b))` spelling and does not cancel the difference, so an exact,
      // CORRECT answer leaves a residual like `exp(ln(2)/3)-2^(1/3)` that
      // normalises to itself and evaluates to -7.1e-15. Accusing the CAS on that
      // basis turned `sqrt(2)`, `2^(1/3)`, `2^x` and a `sqrt(2)` matrix
      // coefficient into hard errors. So the disproof is settled numerically
      // before it is made: only a residual that stays large under evaluation is
      // evidence of anything.
      const settled = await evaluate(`evalf(subst(${residual},${variable}=13/10))`);
      const magnitude = Math.max(
        ...splitTopLevel(stripEnclosingBrackets(settled.trim()), ',').map((c) =>
          Math.abs(Number(c.trim()))
        )
      );
      if (!Number.isFinite(magnitude) || magnitude < 1e-6) return undefined;
      // Numeric magnitude decides it, not whether the system was exact. Gating
      // the disproof on exactness let one decimal switch it off: `0.5*sqrt(x)` is
      // a float coefficient on an exactly-representable term, and its residual
      // `-0.5*sqrt(x)` is a DROPPED TERM, not rounding. The two are orders apart
      // — a rounding artifact measures ~1e-15 here and a dropped term O(1) — so
      // the threshold separates them without needing to know which kind of
      // system it is.
      // "No sound numeric version" is true only where a FLOAT is involved. With
      // an exact system there is no rounding to hide behind: `normal` returning
      // anything but zero is proof the answer does not solve the system, and
      // discarding that as "undecided" shipped `[y'=z, z'=-y+sqrt(x)]` as the
      // HOMOGENEOUS solution — the forcing term simply gone, residual `[0,-√x]`,
      // success:true and no warning. main answered it wrongly too but said so.
      return {
        verified: false,
        method,
        detail: `does not satisfy Y’ = A·Y + b; residual ${residual}`,
      };
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

/**
 * A comparison or a boolean, in either spelling the engine accepts.
 *
 * No `!` of any kind, and the fix was the DELETION rather than a replacement. A
 * bare `!` is FACTORIAL and a perfectly ordinary value — `desolve(y'=y, y(0)=5!,
 * x, y)` is answered `120*exp(x)`, and having `!` in this class cost that its
 * mark. The obvious repair was to narrow it to `!=`, and that alternative was
 * DEAD: every string containing `!=` contains `=`, which `[=<>&|]` already
 * matches, so it changed nothing and only made this docblock argue for a
 * character that did no work. It went the way `<=`, `>=` and `==` did, for the
 * identical reason — the bare `<`, `>` and `=` already match them.
 *
 * Word-bounded for `and`/`or` so an identifier whose NAME contains one — `or_1`,
 * `random_or_not` — is still a value; `_` is a word character, so those do not
 * match. Case-insensitive because the engine's own word form is.
 */
const NOT_A_VALUE = /[=<>&|]|\u2227|\u2228|\b(?:and|or)\b/i;

/** A condition split into its derivative order, its point and its value. */
interface OdeCondition {
  order: number;
  point: string;
  value: string;
}

/**
 * One initial or boundary condition, read as an order, a point and a value.
 *
 * Deliberately narrower than the extractor's SINGLE_ODE_CONDITION, which decides
 * what to FOLD. Being narrower here can only cost a verification mark, while being
 * wider would mean substituting into something whose meaning was guessed — and a
 * guessed substitution is how this file's earlier rounds manufactured residuals.
 *
 * So the point is a single bracket-free argument, and NEITHER part may carry a
 * boolean or a comparison. Both halves of that earned themselves. The point's
 * character class excluded only `(`, `)` and `,` at first, which let `y([0])=1`
 * through and certified an answer against the point `[0]`; the class now excludes
 * every bracket, as this sentence always claimed it did. And the value rule was a
 * bare `/[=<>!]/`, which declined `y(0)=1 or y(0)=2` only because the second
 * disjunct happens to carry an `=`: `y(0)=(1 or 2)` walked past it, Giac evaluated
 * `1 or 2` to 1, and the mark came back saying the conditions were met — about a
 * clause whose value is a disjunction. A boolean is not a value, so both spellings
 * of one are refused rather than handed to the engine to interpret.
 *
 * A point or value that mentions the independent variable is refused too. Giac
 * reads such an argument as a second EQUATION rather than a condition — `y(x)=5`,
 * `y(0)=x^2` — and the residual check above is what settles those; evaluating
 * `subst(answer, x=x)` here would be a substitution that means nothing.
 *
 * Derivative conditions are read, not dropped: `y'(0)=0` is order 1 and `y''(0)=6`
 * is order 2. A spelling outside this shape — `diff(y(x),x)(0)=0`, which Giac
 * itself drops — returns undefined and costs the mark, which is the intended
 * outcome for a condition nobody can confirm was applied.
 */
function readCondition(
  clause: string,
  functionName: string,
  variable: string
): OdeCondition | undefined {
  const shape = new RegExp(
    String.raw`^${escapeForRegExp(functionName)}('*)\s*\(\s*([^(){}\[\],]*?)\s*\)\s*=\s*(.+)$`
  );
  const parsed = shape.exec(clause.trim());
  if (!parsed) return undefined;
  const [, primes, point, value] = parsed;
  if (point.length === 0) return undefined;
  if (NOT_A_VALUE.test(point) || NOT_A_VALUE.test(value)) return undefined;
  const mentionsVariable = new RegExp(String.raw`\b${escapeForRegExp(variable)}\b`);
  if (mentionsVariable.test(point) || mentionsVariable.test(value)) return undefined;
  return { order: primes.length, point, value };
}

/**
 * Bound on the engine work this check adds: one round-trip per condition, or two
 * where `normal` leaves a residual standing, each embedding the answer once more.
 * Eight is an eighth-order IVP, past anything desolve answers here, and above it
 * the whole check declines rather than certifying a prefix — checking some of the
 * conditions and marking the answer ✓ is the exact failure this check exists to
 * remove.
 */
const MAX_VERIFIABLE_CONDITIONS = 8;

/**
 * How an IVP's conditions hold: `exact`, `rounded` (to the rounding of the
 * decimals the answer is printed in), or not shown to hold at all.
 */
type ConditionsHold = 'exact' | 'rounded' | false;

/**
 * Relative slack for a condition the answer can only meet to its rounding.
 * Giac prints a float to 12 significant digits, so a rounded coefficient is off
 * by at most 5e-12 relative; 1e-9 leaves three orders for cancellation, and a
 * wrong coefficient is off by O(1).
 */
const ROUNDING_SLACK = 1e-9;

/** A decimal in printed engine output: `0.551819161757`, `3.0`, `1.4e-13`. */
const PRINTED_DECIMAL = /\d\.|\.\d/;

/**
 * Whether EVERY clause is a condition that holds — exactly, or to the rounding
 * of a decimal answer — or false.
 *
 * False means "not proven", never "disproved", and the caller must not turn it
 * into a failure. There is no sound disproof available here. A correct answer to
 * `desolve(y'=y, y(0.1)=1e10, x, y)` is `9048374180.36*exp(x)`, whose condition
 * residual is 3.7e-4 — four orders ABOVE the 1e-6 the equation's disproof uses —
 * so no threshold could refuse on a residual. A residual is also no evidence when
 * it still carries a `c_1`: an under-determined answer is legitimate — `desolve(y''=-y,
 * y(0)=1, x, y)` correctly answers `cos(x)+c_1*sin(x)` — and the family may contain
 * a member that satisfies the condition even where the arbitrary one does not.
 *
 * So this only ever withholds the mark, which is verifyOdeSystem's rule for the
 * same question and the reason it cannot cost a correct answer anything but a ✓.
 *
 * `rounded` is the one numeric verdict, and it is narrow on purpose. What cost
 * the mark was a rounded float COEFFICIENT in the answer, not a float in the
 * condition: `desolve(y'=y, y(1)=1.5, x, y)` answers `0.551819161757*exp(x)`,
 * which leaves ~1e-13 at x=1 and can never be exactly 3/2, while `y(0)=1.5`
 * answers `1.5*exp(x)` and is exact. Without it, a rewritten single ODE — which
 * ships only with a ✓ — refused every such answer. So a condition the exact tests
 * leave standing holds `rounded` only where the ANSWER prints a decimal (an exact
 * answer has no rounding to excuse), the residual and the value evaluate to
 * finite real numbers (a surviving `c_1`, an `i` or an `erf` leaves none), and
 * the residual is within ROUNDING_SLACK of the value — relative, so a zero
 * value leaves no slack at all. The equation itself is still held to an
 * exact zero by the caller; only the conditions get the slack, and the mark says
 * so. That is also the 1e10 case above: 3.7e-14 relative.
 *
 * Over 513 requests through computeHandler, 77 answers lost the mark to this
 * check before `rounded` existed: one the 1e10 case, 58 float-rounding residuals
 * below 1e-6, and 18 residuals that are not numeric at all (an `erf`, an `i`, a
 * surviving `c_1`), which stay unmarked.
 */
async function everyConditionHolds(
  clauses: string[],
  functionName: string,
  variable: string,
  answer: string,
  evaluate: (expr: string) => Promise<string>
): Promise<ConditionsHold> {
  if (clauses.length > MAX_VERIFIABLE_CONDITIONS) return false;
  let hold: ConditionsHold = 'exact';
  for (const clause of clauses) {
    const condition = readCondition(clause, functionName, variable);
    if (condition === undefined) return false;
    const { order, point, value } = condition;
    // Differentiated first, then evaluated at the point — `y'(0)=0` is a claim
    // about the derivative AT 0, not about the derivative of a constant.
    const at = order === 0 ? `(${answer})` : `diff(${answer},${variable},${order})`;
    const zeroForm = `subst(${at},${variable}=(${point}))-(${value})`;
    const residual = await evaluate(`normal(${zeroForm})`);
    if (allZero(residual.trim())) continue;
    // `normal` is not a zero test, and here that is the difference between a mark
    // and no mark rather than between an accusation and none. It leaves
    // `exp(ln(2)/3)-2^(1/3)` standing — the artifact this file already records for
    // the equation's residual — so a correct `exp(ln(2)/3)*exp(x)` lost its mark
    // for `y(0)=2^(1/3)`. `simplify` reduces that to 0, and it recovers 16 of the
    // 93 answers that lost their mark without it. Still EXACT: the fallback asks
    // for a stronger simplification, not for a smaller number, so nothing is
    // certified on numeric evidence. Second call only where the first failed, so
    // the common case still costs one round-trip per condition.
    //
    // `allZero` again rather than a second zero test, so the two stages cannot
    // disagree about what a printed zero is. Its float arm is unreachable HERE and
    // that is measured, not assumed: a float anywhere in the answer, the point or
    // the value collapses the whole residual to a numeric print that `normal`
    // already reduces, so nothing gets this far printing `0.0`. It is shared for
    // the sake of one predicate, not because this call needs the float case.
    if (allZero((await evaluate(`simplify(${zeroForm})`)).trim())) continue;
    if (!(await holdsToRounding(zeroForm, value, answer, evaluate))) return false;
    hold = 'rounded';
  }
  return hold;
}

/**
 * Whether a condition's residual is within ROUNDING_SLACK of its value, for an
 * answer printed in decimals — the `rounded` verdict everyConditionHolds
 * documents. One round-trip, and only for a condition both exact tests left.
 */
async function holdsToRounding(
  zeroForm: string,
  value: string,
  answer: string,
  evaluate: (expr: string) => Promise<string>
): Promise<boolean> {
  if (!PRINTED_DECIMAL.test(answer)) return false;
  const printed = await evaluate(`evalf([${zeroForm},${value}])`);
  const [residual, scale] = splitTopLevel(stripEnclosingBrackets(printed.trim()), ',').map((n) =>
    Number(n.trim())
  );
  if (!Number.isFinite(residual) || !Number.isFinite(scale)) return false;
  return Math.abs(residual) <= ROUNDING_SLACK * Math.abs(scale);
}

type BareEquation =
  | { status: 'decline' }
  | { status: 'refuse'; equationOnly: string }
  | { status: 'ok'; equationOnly: string };

/**
 * The caller's equation argument, cut down to the differential equation alone.
 *
 * Declines (no verdict) when nothing is left after the cut; refuses (a
 * disproof-shaped verdict, built by the caller) when what is left is not one
 * bare equation.
 */
function extractBareEquation(equation: string): BareEquation {
  // The DIFFERENTIAL EQUATION only. The text handed in is the caller's whole
  // equation argument, which may already carry conditions — they write
  // `y'=y and y(0)=1` themselves, and the bracketed `[y'=y, y(0)=1]` too.
  // Substituting into those produced `(exp(x))(0)=1`, a residual of nonsense, and
  // a confident accusation against a correct answer: `desolve(y'=y and y(0)=1, x,
  // y)` went from exp(x) to a hard error the first time this check ran. A
  // verifier that can invent a disproof is worse than no verifier.
  //
  // The first top-level member is the equation; conditions follow it in both
  // spellings. They are cut off HERE and checked separately at the end, against
  // odeClauses of the built command — substituting an answer into a condition and
  // into an equation are different operations, and the round that conflated them
  // produced `(exp(x))(0)=1`.
  const firstMember = splitTopLevel(stripEnclosingBrackets(equation.trim()), ',')[0] ?? '';
  const equationOnly = stripEnclosingBrackets(beforeTopLevelConjunction(firstMember).trim()).trim();
  // The cut is a spelling prediction and has now been wrong twice, so what follows
  // it does not ask whether the cut worked — it asks whether the result is one bare
  // equation, which is checkable without knowing any join spelling. Anything else
  // is declined rather than risked: substituting into a leftover boolean refused
  // correct answers AND certified a non-solution, depending on whether the boolean
  // survived normalisation or collapsed to a truth value.
  if (equationOnly.length === 0) return { status: 'decline' };
  // Two different declines, and conflating them is what let this family ship.
  //
  // "I could not check" — an unknown derivative spelling, an answer too large,
  // an answer that mentions the function — is a no-verdict, and a no-verdict
  // ships. That is right: the answer is probably fine and nothing here knows
  // otherwise.
  //
  // "This text carries something that is not the equation" is a different
  // statement. A join the cut did not recognise leaves the caller's condition
  // sitting in the equation, and every measured instance of that shipped a
  // non-solution — 26 of 26 for the unspaced operators alone. So it refuses.
  //
  // This is the part no join spelling can walk past: it does not ask what the
  // join was, only whether what is left is one equation. `et`, `⋀`, or whatever
  // the next round would have found lands here rather than in a shipped answer.
  if (!isOneBareEquation(equationOnly)) {
    return { status: 'refuse', equationOnly };
  }
  return { status: 'ok', equationOnly };
}

function substituteAnswer(
  equationOnly: string,
  answer: string,
  functionName: string,
  variable: string
): string {
  const fn = escapeForRegExp(functionName);
  const v = escapeForRegExp(variable);
  const sub = `(${answer})`;
  // Longest spelling first, so `diff(y(x),x,2)` is not eaten by the `y(x)` rule.
  // The same three spellings derivativeTarget reads, and the prime rule is anchored
  // the way derivativeTarget anchors it: `y'` is a derivative, `y'(x)` is not one of
  // the three. Unanchored it ate the prime and left `(x)` applied to the substituted
  // expression, which Giac reads as multiplication — a residual mentioning no `y`, so
  // the guard below could not catch it, and a correct `c_0*exp(x)` was refuted for
  // `y'(x)=y(x)`.
  //
  // Two lookaheads, because one was not enough: `('+)` backtracks, so a single
  // `(?!\s*\()` let `y''(x)` give up a prime and match anyway, and the bare-`y`
  // fallback then substituted the `y` of `y'(x)` because `'` is not `(`. With both,
  // anything outside the three spellings is left intact and the residual still names
  // the function, which is what makes the decline below sound rather than lucky —
  // before this it was the numeric stage returning NaN that happened to save it.
  return equationOnly
    .replaceAll(
      new RegExp(
        String.raw`\b(?:diff|derive|deriver)\s*\(\s*${fn}\s*\(\s*${v}\s*\)\s*,\s*${v}\s*,\s*(\d+)\s*\)`,
        'g'
      ),
      `diff(${sub},${variable},$1)`
    )
    .replaceAll(
      new RegExp(
        String.raw`\b(?:diff|derive|deriver)\s*\(\s*${fn}\s*\(\s*${v}\s*\)\s*,\s*${v}\s*\)`,
        'g'
      ),
      `diff(${sub},${variable})`
    )
    .replaceAll(new RegExp(String.raw`\bd${fn}\s*/\s*d${v}\b`, 'g'), `diff(${sub},${variable})`)
    .replaceAll(
      new RegExp(String.raw`\b${fn}('+)(?!['\s]*\()`, 'g'),
      (_m, primes: string) => `diff(${sub},${variable},${primes.length})`
    )
    .replaceAll(new RegExp(String.raw`\b${fn}\s*\(\s*${v}\s*\)`, 'g'), sub)
    .replaceAll(new RegExp(String.raw`\b${fn}\b(?!\s*\()(?!')`, 'g'), sub);
}

async function checkConditions(
  clauseSource: string,
  equationOnly: string,
  functionName: string,
  variable: string,
  answer: string,
  evaluate: (expr: string) => Promise<string>
): Promise<VerificationResult | undefined> {
  const method = 'substitution';
  // The equation is only half of an IVP. Everything above proves the answer
  // solves `equationOnly`; these are the caller's conditions, and without them
  // `2*exp(x)` was marked ✓ for `desolve(y'=y, y(0)=1, x, y)` — a genuine
  // solution of a DIFFERENT initial-value problem, exactly the failure
  // verifyOdeSystem's condition block was added to stop on the system path.
  const clauses = odeClauses(clauseSource);
  // The cross-check, not an assumption. `conditionSource` is a second text
  // and this is the one thing that has to be true of it: its first clause is
  // the caller's equation, because the fold embeds that verbatim and only
  // appends. Where the two disagree, the clauses after the first are not
  // known to be this equation's conditions, so nothing is claimed about them.
  if (clauses[0] !== equationOnly) return undefined;
  const conditions = clauses.slice(1);
  const hold = await everyConditionHolds(conditions, functionName, variable, answer, evaluate);
  if (hold === false) return undefined;
  let detail = `substitutes back into ${equationOnly} exactly`;
  if (conditions.length > 0) detail += ' and meets the conditions';
  if (hold === 'rounded') detail += ' to the rounding of its decimals';
  return { verified: true, method, detail };
}

async function disproveResidual(
  residual: string,
  equationOnly: string,
  variable: string,
  evaluate: (expr: string) => Promise<string>
): Promise<VerificationResult | undefined> {
  const method = 'substitution';
  // A residual that carries a branch marker is not evidence. For a separable ODE
  // integrated through a square root the CONSTANT is the domain boundary — the
  // solution family of `y'=sqrt(y)` is [((x-c_0)/2)^2], valid for x >= c_0 — so
  // probing at x=13/10 with c_0=2 asks whether a correct answer holds at a point
  // it never claimed. It does not, and the answer was refused: six correct
  // answers, all of which main returned, turned into hard errors blaming the CAS.
  //
  // Whether it fired was luck. The same equation with y(0)=1 gives [(1+x/2)^2],
  // where 13/10 happens to land inside the branch, and shipped.
  //
  // `abs(` / `sign(` is the signature for those six: all carry one and none of
  // the disproofs this suite pins does. This is a could-not-check, not a
  // disproof — the distinction this file already draws everywhere else.
  if (/\b(?:abs|sign)\s*\(/.test(residual)) return undefined;
  // A marker list is not enough, because the same domain problem arrives without
  // one. `desolve(y'=sqrt(1-y^2), y(0)=1/2, x, y)` answers [sin(x+pi/6)], which is
  // CORRECT, and its residual is cos(θ)-√(1-sin²θ) — that is cos(θ)-|cos(θ)|
  // wearing a square root, so it is zero while cos θ >= 0 and nonzero after. A
  // single probe at x=13/10 sits past that boundary, so a correct answer was
  // refuted, and adding `sqrt` to the marker list would have gutted the disproof
  // for every equation with a radical in it.
  //
  // So the domain is SAMPLED rather than assumed: a disproof requires the residual
  // to be nonzero at every point, and a residual that vanishes anywhere on the
  // sample is a domain artifact rather than evidence. Measured, the five disproofs
  // this suite pins are nonzero at all three points (-5, 2*x*exp(x), 2*x,
  // 4*x*cos(x)+2*sin(x), 2*x*exp(x^2/2)) while the residual above is 3.6e-15 at
  // x=1/10 and 0.5 at x=13/10, so it declines.
  //
  // The small point earns its place: with only points past pi/3 every sample is
  // outside the branch and the false refusal survives. Zero is deliberately NOT a
  // point — `2*x` and `2*x*exp(x)` vanish there, and a genuine disproof must not
  // be discarded for having a root at the origin.
  const probePoints = ['1/10', '13/10', '23/10'];
  let magnitude = Number.POSITIVE_INFINITY;
  for (const point of probePoints) {
    magnitude = Math.min(magnitude, await residualMagnitudeAt(point));
    if (magnitude < 1e-6) break;
  }
  async function residualMagnitudeAt(point: string): Promise<number> {
    let at = 0;
    // The free constants have to go too, or nothing with a `c_0` in it can ever be
    // disproved. `desolve(y''=-y, y'(x)=0)` answers a disguised `c_1/sin(x)`,
    // which is not a solution; its residual is plainly nonzero but still mentions
    // c_1, so evaluating at a point alone gave NaN and the check declined. A
    // solution FAMILY has to satisfy the equation for every constant, so any
    // assignment that leaves a residual is a disproof — two are used only because
    // one unlucky assignment could cancel a term that does not cancel in general.
    const assignments = [(k: number) => 2 + k, (k: number) => 1 - 2 * k];
    for (const value of assignments) {
      const constants = [...new Set(residual.match(/\bc_\d+\b/g) ?? [])]
        .map((name, k) => `${name}=${value(k)}`)
        .join(',');
      const substs = [`${variable}=${point}`, ...(constants ? [constants] : [])].join(',');
      const settled = await evaluate(`evalf(subst(${residual},${substs}))`);
      const here = Math.abs(Number(settled.trim()));
      // Max over the constant assignments, as before: a solution FAMILY has to
      // satisfy the equation for every constant, so one assignment leaving a
      // residual is enough at this point.
      if (Number.isFinite(here)) at = Math.max(at, here);
    }
    return at;
  }
  if (magnitude < 1e-6) return undefined;
  return {
    verified: false,
    method,
    detail: `the CAS returned an answer that does not satisfy ${equationOnly}; residual ${residual}`,
  };
}

/**
 * Substitutes a candidate solution into a SINGLE ODE and reports whether it
 * satisfies it.
 *
 * This is the check the single-equation path never had. verifyOdeSystem has done
 * this for rewritten systems all along, and every silent wrong answer the
 * separate-argument condition work produced landed on the path without one: an
 * argument Giac reads as a second equation rather than a condition —
 * `y(x)=5`, `y(x+0)=5`, `y(0)=x^2` — folds in and the answer solves a problem the
 * caller did not pose. Three rounds of syntactic guards each closed the reported
 * spelling and left the field next door, because a syntactic guard has to predict
 * what Giac will read. This does not predict anything: it asks whether the thing
 * about to be shipped solves the equation that was actually written.
 *
 * Verdicts follow verifyOdeSystem's rules exactly, and for its reasons:
 *
 *   - ✓ only where the residual is exactly zero AND every condition the caller
 *     wrote provably holds. An IVP asks a strictly stronger question than its
 *     equation does, and the mark has to mean the whole of it — verifyOdeSystem
 *     records an answer that returned y(0) = 1984 where the caller asked for 1.5
 *     and earned an honest ✓ for the half that was checked. `normal` is not a zero
 *     test, so a nonzero print is not yet evidence.
 *   - ✗ only where a nonzero residual OF THE EQUATION survives numeric evaluation
 *     AND carries no branch marker. The numeric stage separates a dropped term
 *     (O(1)) from the `exp(ln(2)/3)-2^(1/3)` spelling artifact (~1e-15); it does
 *     NOT separate a wrong answer from a correct one probed outside its domain,
 *     which is what `abs(`/`sign(` marks and why that is declined before the probe
 *     runs. A condition NEVER produces a ✗ — see everyConditionHolds for why no
 *     sound disproof is available there. So an answer that misses a condition
 *     ships, unmarked; it is the certificate that is withdrawn, not the answer.
 *   - no verdict otherwise, including when the answer is too large to hand back
 *     to the engine. "I did not check" is not evidence against an answer.
 *
 * `conditionSource` is the command the extractor BUILT — `args.equation`, which is
 * `(y'=y) and (y(0)=1)` where the caller wrote `desolve(y'=y, y(0)=1, x, y)` —
 * while `equation` stays the caller's own text, `args.original_equation`. Two
 * arguments rather than one because they answer different questions and only one
 * of them may be trusted for each: the residual must be checked against what the
 * caller WROTE, so that a fold which mangled the equation could not be verified
 * against its own mangling, whereas the conditions exist only in the built
 * command. Conditions written into the equation are in both, and taking them from
 * the built command picks up those as well, since the fold embeds the caller's
 * equation verbatim. The two are cross-checked below rather than assumed to agree.
 */ export async function verifyOdeSolution(
  equation: string,
  functionName: string,
  variable: string,
  result: string,
  evaluate: (expr: string) => Promise<string>,
  conditionSource?: string
): Promise<VerificationResult | undefined> {
  const method = 'substitution';
  const raw = result.trim();
  if (raw.length === 0 || raw.length > MAX_VERIFIABLE_RESULT) return undefined;
  if (nestingDepth(raw) > MAX_ENGINE_DEPTH || nestingDepth(equation) > MAX_ENGINE_DEPTH) {
    return undefined;
  }
  // A one-element list is Giac's spelling for a single implicit solution
  // (`y'=y^2` answers `[1/(1/5-x)]`); more than one is a branch set, and which
  // branch the caller meant is not this function's question.
  const inner = /^\[(.*)\]$/.exec(raw)?.[1];
  const answer = inner !== undefined && splitTopLevel(inner, ',').length === 1 ? inner : raw;
  if (answer.startsWith('[')) return undefined;

  const cut = extractBareEquation(equation);
  if (cut.status === 'refuse') {
    return {
      verified: false,
      method,
      detail:
        `the equation as written carries more than one equation or condition ` +
        `(${cut.equationOnly}), so the answer could not be checked against it`,
    };
  }
  if (cut.status === 'decline') return undefined;
  const equationOnly = cut.equationOnly;

  const substituted = substituteAnswer(equationOnly, answer, functionName, variable);
  // Nothing was substituted, so there is nothing to check — an equation this does
  // not understand must not become an accusation.
  if (substituted === equationOnly) return undefined;
  // ALL of it, or none. A surviving mention of the function means a spelling was
  // not substituted, and what Giac then does with it is not predictable: it drops
  // `y''(x)` silently, so the residual for `y''(x)=-y(x)` came back as the whole
  // answer and a correct `cos(x)` was refuted. Checking the substituted TEXT rather
  // than the residual is what makes this independent of the engine — a leftover the
  // engine erases cannot be seen downstream, only here.
  const fn = escapeForRegExp(functionName);
  if (new RegExp(String.raw`\b${fn}\b`).test(substituted)) return undefined;

  try {
    const residual = (await evaluate(`normal(${toZeroForm(substituted)})`)).trim();
    if (isPrintedZero(residual) || allZero(residual)) {
      return checkConditions(
        conditionSource ?? equation,
        equationOnly,
        functionName,
        variable,
        answer,
        evaluate
      );
    }
    // Kept as a second net: the engine can introduce the name itself, e.g. as
    // `(function_diff(y))(x)`, where nothing was left unsubstituted going in.
    if (new RegExp(String.raw`\b${fn}\b`).test(residual)) return undefined;
    return disproveResidual(residual, equationOnly, variable, evaluate);
  } catch {
    return undefined;
  }
}
