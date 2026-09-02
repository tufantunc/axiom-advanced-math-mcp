import { giacEngine } from '../giac/index.js';
import { MAX_ENGINE_DEPTH } from './giac-eval.js';
import { nestingDepth } from './output-cleanup.js';
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
 * Whether a join begins at `i`, with the boundary rule each FORM needs.
 *
 * The word form needs a boundary before it, or `and` matches inside `command`. An
 * operator does not, and requiring one is what made this miss the spelling `&&`
 * and `∧` are normally written in: `y'=y&&y(x)=5` was never cut, the conjunction
 * stayed in the equation, and 26 of 26 measured results shipped a non-solution at
 * isError:false. One space was the whole difference, and every `&&` test row had
 * one.
 *
 * Shared by the cut and the backstop so they cannot disagree about what a join
 * LOOKS like. They still disagree about what to DO with one, which is the point.
 *
 * The history is worth keeping because each version was a spelling prediction and
 * each was wrong: splitTopLevel takes a single CHARACTER and silently split on
 * nothing when handed 'and', leaving the condition in the equation and accusing
 * `y'=y and y(0)=1` of not satisfying itself; then a space was demanded before the
 * token, so `y'=y and(y(0)=1)` was accused the same way; then the boundary was
 * demanded of the operators too. What ended it is not this function — it is
 * isOneBareEquation, which asks nothing about spelling.
 */
function startsAt(text: string, i: number, operators: RegExp, word: RegExp): boolean {
  if (operators.test(text.slice(i))) return true;
  if (/[A-Za-z0-9_]/.test(text[i - 1] ?? ' ')) return false;
  return word.test(text.slice(i));
}

/**
 * A conjunction, which is Giac's IVP spelling: the first term is the equation.
 *
 * So are `&&` and `∧` (U+2227), and case does not matter for the word form —
 * probed against the engine rather than assumed: `and`, `AND`, `&&`, `&&&` and `∧`
 * all answer exp(x), while `And`, `et`, `xor`, `∩`, `⋀` and `&` do not. Knowing
 * only `and` was the second version of this bug: the join stayed in the equation,
 * so a correct answer was refused AND a non-solution was certified, depending on
 * whether the leftover boolean survived normalisation or collapsed to a truth
 * value. `∧` was the third, and it slipped past a round that had just widened this
 * to `&&`.
 *
 * `or` is deliberately NOT here. It is a disjunction, so the first term is not
 * "the equation" — refuting an answer to the second branch would be wrong — and
 * Giac refuses `or` inside desolve anyway. It is declined below instead of cut.
 */
const CONJUNCTION_OPERATOR = /^(?:&&|\u2227)/;
const CONJUNCTION_WORD = /^and(?![A-Za-z0-9_])/i;
const JOIN_OPERATOR = /^(?:&&|\|\||\u2227|\u2228)/;
const JOIN_WORD = /^(?:and|or)(?![A-Za-z0-9_])/i;

const startsConjunction = (text: string, i: number): boolean =>
  startsAt(text, i, CONJUNCTION_OPERATOR, CONJUNCTION_WORD);
const startsJoin = (text: string, i: number): boolean =>
  startsAt(text, i, JOIN_OPERATOR, JOIN_WORD);

function beforeTopLevelConjunction(text: string): string {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (depth === 0 && startsConjunction(text, i)) {
      return text.slice(0, i);
    }
  }
  return text;
}

/**
 * Whether the text is one bare equation, and therefore safe to substitute into.
 *
 * INDEPENDENT of the cut above, deliberately. The previous version of this check
 * was `beforeTopLevelJoin(text) !== text` — the cut's own predicate with a `!==`
 * — so it recognised exactly the spellings the cut already recognised and was
 * inert against the failure its comment claimed to cover. `&&` and `AND` walked
 * straight through both.
 *
 * Exactly one top-level `=` is the invariant that does not depend on knowing any
 * join spelling: toZeroForm splits at the first `=`, so a second one means the
 * rest is not part of the equation and whatever is left of it lands in the
 * right-hand side. That alone refuses `y'=y && y(0)=1` without knowing what `&&`
 * is. The keyword scan is kept as well, for a join that carries no second `=`.
 *
 * The `=` count has now earned itself. It looked redundant — remove it and no test
 * failed, because the later guards declined those inputs anyway — and it was kept
 * on the argument that a NEW join spelling could not walk past it. `∧` then turned
 * up as exactly that spelling: the cut did not know it, and this count is what made
 * the verifier decline instead of reaching a verdict on a boolean. It cost a
 * shipped non-solution, because declining is not refusing, but not a wrong verdict.
 */
function isOneBareEquation(text: string): boolean {
  if (splitTopLevel(text, '=').length !== 2) return false;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (depth === 0 && startsJoin(text, i)) return false;
  }
  return true;
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
 *   - ✓ only where the residual is exactly zero. `normal` is not a zero test, so
 *     a nonzero print is not yet evidence.
 *   - ✗ only where a nonzero residual survives numeric evaluation AND carries no
 *     branch marker. The numeric stage separates a dropped term (O(1)) from the
 *     `exp(ln(2)/3)-2^(1/3)` spelling artifact (~1e-15); it does NOT separate a
 *     wrong answer from a correct one probed outside its domain, which is what
 *     `abs(`/`sign(` marks and why that is declined before the probe runs.
 *   - no verdict otherwise, including when the answer is too large to hand back
 *     to the engine. "I did not check" is not evidence against an answer.
 */
export async function verifyOdeSolution(
  equation: string,
  functionName: string,
  variable: string,
  result: string,
  evaluate: (expr: string) => Promise<string>
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

  // The DIFFERENTIAL EQUATION only. The text handed in is the caller's whole
  // equation argument, which may already carry conditions — they write
  // `y'=y and y(0)=1` themselves, and the bracketed `[y'=y, y(0)=1]` too.
  // Substituting into those produced `(exp(x))(0)=1`, a residual of nonsense, and
  // a confident accusation against a correct answer: `desolve(y'=y and y(0)=1, x,
  // y)` went from exp(x) to a hard error the first time this check ran. A
  // verifier that can invent a disproof is worse than no verifier.
  //
  // The first top-level member is the equation; conditions follow it in both
  // spellings. Conditions are not checked here, which is a real gap — an answer
  // can satisfy the ODE and miss the condition — and it is the system path's
  // verifyOdeSystem that covers that for its own shape.
  const firstMember = splitTopLevel(stripEnclosingBrackets(equation.trim()), ',')[0] ?? '';
  const equationOnly = stripEnclosingBrackets(beforeTopLevelConjunction(firstMember).trim()).trim();
  // The cut is a spelling prediction and has now been wrong twice, so what follows
  // it does not ask whether the cut worked — it asks whether the result is one bare
  // equation, which is checkable without knowing any join spelling. Anything else
  // is declined rather than risked: substituting into a leftover boolean refused
  // correct answers AND certified a non-solution, depending on whether the boolean
  // survived normalisation or collapsed to a truth value.
  if (equationOnly.length === 0) return undefined;
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
    return {
      verified: false,
      method,
      detail:
        `the equation as written carries more than one equation or condition ` +
        `(${equationOnly}), so the answer could not be checked against it`,
    };
  }

  const fn = functionName.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  const v = variable.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
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
  const substituted = equationOnly
    .replaceAll(
      new RegExp(
        `\\b(?:diff|derive|deriver)\\s*\\(\\s*${fn}\\s*\\(\\s*${v}\\s*\\)\\s*,\\s*${v}\\s*,\\s*(\\d+)\\s*\\)`,
        'g'
      ),
      `diff(${sub},${variable},$1)`
    )
    .replaceAll(
      new RegExp(
        `\\b(?:diff|derive|deriver)\\s*\\(\\s*${fn}\\s*\\(\\s*${v}\\s*\\)\\s*,\\s*${v}\\s*\\)`,
        'g'
      ),
      `diff(${sub},${variable})`
    )
    .replaceAll(new RegExp(`\\bd${fn}\\s*/\\s*d${v}\\b`, 'g'), `diff(${sub},${variable})`)
    .replaceAll(
      new RegExp(`\\b${fn}('+)(?!['\\s]*\\()`, 'g'),
      (_m, primes: string) => `diff(${sub},${variable},${primes.length})`
    )
    .replaceAll(new RegExp(`\\b${fn}\\s*\\(\\s*${v}\\s*\\)`, 'g'), sub)
    .replaceAll(new RegExp(`\\b${fn}\\b(?!\\s*\\()(?!')`, 'g'), sub);
  // Nothing was substituted, so there is nothing to check — an equation this does
  // not understand must not become an accusation.
  if (substituted === equationOnly) return undefined;
  // ALL of it, or none. A surviving mention of the function means a spelling was
  // not substituted, and what Giac then does with it is not predictable: it drops
  // `y''(x)` silently, so the residual for `y''(x)=-y(x)` came back as the whole
  // answer and a correct `cos(x)` was refuted. Checking the substituted TEXT rather
  // than the residual is what makes this independent of the engine — a leftover the
  // engine erases cannot be seen downstream, only here.
  if (new RegExp(`\\b${fn}\\b`).test(substituted)) return undefined;

  try {
    const residual = (await evaluate(`normal(${toZeroForm(substituted)})`)).trim();
    if (isPrintedZero(residual) || allZero(residual)) {
      return { verified: true, method, detail: `substitutes back into ${equationOnly} exactly` };
    }
    // Kept as a second net: the engine can introduce the name itself, e.g. as
    // `(function_diff(y))(x)`, where nothing was left unsubstituted going in.
    if (new RegExp(`\\b${fn}\\b`).test(residual)) return undefined;
    // The free constants have to go too, or nothing with a `c_0` in it can ever be
    // disproved. `desolve(y''=-y, y'(x)=0)` answers a disguised `c_1/sin(x)`,
    // which is not a solution; its residual is plainly nonzero but still mentions
    // c_1, so evaluating at a point alone gave NaN and the check declined. A
    // solution FAMILY has to satisfy the equation for every constant, so any
    // assignment that leaves a residual is a disproof — two are used only because
    // one unlucky assignment could cancel a term that does not cancel in general.
    const assignments = [(k: number) => 2 + k, (k: number) => 1 - 2 * k];
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
    // `abs(` / `sign(` is the signature: all six false refusals carry one and none
    // of the disproofs this suite pins does. This is a could-not-check, not a
    // disproof — the distinction this file already draws everywhere else.
    if (/\b(?:abs|sign)\s*\(/.test(residual)) return undefined;
    let magnitude = 0;
    for (const value of assignments) {
      const constants = [...new Set(residual.match(/\bc_\d+\b/g) ?? [])]
        .map((name, k) => `${name}=${value(k)}`)
        .join(',');
      const substs = [`${variable}=13/10`, ...(constants ? [constants] : [])].join(',');
      const settled = await evaluate(`evalf(subst(${residual},${substs}))`);
      const at = Math.abs(Number(settled.trim()));
      if (Number.isFinite(at)) magnitude = Math.max(magnitude, at);
    }
    if (magnitude < 1e-6) return undefined;
    return {
      verified: false,
      method,
      detail: `the CAS returned an answer that does not satisfy ${equationOnly}; residual ${residual}`,
    };
  } catch {
    return undefined;
  }
}
