import { isPrintedZero, splitTopLevel } from './output-cleanup.js';
import { stripEnclosingBrackets } from './compute/arg-parsing.js';
import type { GiacEngineLike } from './compute/hygiene.js';
import { validateSystemShape, type OdeSystem } from './ode-system-shape.js';

/**
 * Translating a list-form ODE system into the form this CAS actually solves.
 *
 * `desolve([y'=z, z'=-y], x, y)` answers `[]` — an empty result presented as a
 * solution. The capability is NOT missing, which an earlier attempt at this
 * concluded and asserted in a user-facing message: the same system solves in one
 * call written as a matrix product.
 *
 *   desolve(Y'=[[0,1],[-1,0]]*Y, x, Y)
 *     -> [[c_0*cos(x)+c_1*sin(x), -c_0*sin(x)+c_1*cos(x)]]
 *
 * That is mechanical for a linear system with constant coefficients, so the list
 * form is rewritten into it rather than refused. Giac's own limits set the
 * boundary: it rejects a non-constant coefficient matrix with "Non constant
 * linear differential system", and a nonlinear system has no matrix at all —
 * both are reported as themselves instead of as an empty answer.
 */

/**
 * Ceiling on the generated probe, in characters. The equation cap alone does not
 * bound this: two equations with very long right-hand sides reach the same engine
 * limits many short ones do.
 *
 * Measured — and then re-measured, because the first measurement was
 * shape-specific. A flat sum traps between 6,060 and 8,060 characters, but a
 * DEEP PRODUCT (`z+x*x*...*1`) traps from ~3,660, and at that size the worker
 * died and took a concurrent caller's unrelated call with it. 2,000 sits below
 * the smallest trap observed for either shape. The try/catch around the probe
 * stays as the backstop, but it does not save the worker — only refusing does.
 */
const MAX_PROBE_CHARS = 2_000;

/**
 * Ceiling on what the probe SENDS BACK, which is a different quantity from what
 * it sends.
 *
 * `normal` expands, so a short right-hand side can produce an enormous
 * coefficient matrix, and that matrix is then re-sent to the engine three more
 * times (the `exact` classifier, the degree probe, and the solve itself). 4,000
 * is an order of magnitude above the largest legitimate reply measured — 329
 * characters, for a forcing term of 25 exponential terms — and two orders below
 * the 677,259 that killed the worker.
 */
const MAX_PROBE_REPLY_CHARS = 4_000;

/**
 * Ceiling on the command actually sent, which is a different measurement from
 * MAX_PROBE_CHARS and cannot reuse its number.
 *
 * The probe wraps every right-hand side in `grad`/`subst`, and a deep product
 * survives to ~3,660 characters in that form. The same product sitting bare in
 * an initial condition traps the engine much earlier: measured, `Y(0)=[x*x*
 * ...*1,0]` answers at 520 factors (1,085 characters) and traps fatally at 540
 * (1,125) with "RuntimeError: memory access out of bounds", which recycles the
 * worker and rejects whatever else was pending on it.
 *
 * 800 sits below that and well above real work: the largest command any input
 * that passes MAX_PROBE_CHARS can produce is 339 characters (a forcing term of
 * 25 exponential terms), and a nine-equation system with initial conditions is
 * 226.
 */
const MAX_COMMAND_CHARS = 800;

/**
 * Ceiling on the degree of the forcing term in the independent variable.
 *
 * The third axis, and the one no character count reaches: see the measurement
 * at the check itself. Text length bounds width, the equation cap bounds count,
 * and this bounds the degree that makes a four-character `^300` cost more than
 * the whole per-call budget.
 */
const MAX_FORCING_DEGREE = 60;

/**
 * Ceiling on a forcing term's degree when the matrix holds a float.
 *
 * The only bound here that is about accuracy rather than survival. See the check
 * itself for the measurements; 8 is the last degree whose worst relative error
 * over three sample points stays below 1e-9.
 */
const MAX_FLOAT_FORCING_DEGREE = 8;

/**
 * The same ceiling for a decimal that appears only in an initial condition.
 *
 * A separate number because this channel genuinely does behave differently — the
 * claim the other two make about each other is false, but this one is measured:
 * the ODE residual stays exactly zero, and it is the CONDITION that stops being
 * met, abruptly. See the check itself for the numbers.
 */
const MAX_CONDITION_FLOAT_DEGREE = 14;

/**
 * A symbol that appears nowhere in the problem.
 *
 * Checking only the differentiated names was not enough: a `Y` on a RIGHT-hand
 * side is invisible to that check and gets captured by the vector. `[y'=Y*z,
 * z'=-y]` emitted `desolve(Y'=[[0,Y],[-1,0]]*Y,x,Y)` and answered `[]` — the very
 * defect this module exists to remove — and `[y'=z+Y, z'=-y]` answered wrongly.
 */
function vectorSymbol(taken: string[]): string {
  const used = new Set(taken.flatMap((t) => t.match(/[A-Za-z_]\w*/g) ?? []));
  let name = 'Y';
  while (used.has(name)) name += '_';
  return name;
}

/**
 * A union, not all-optional fields: `{}` and `{command, error}` were type-legal
 * states the producer never emits, so the consumer had to defend against an
 * impossible case with a fallback message nothing could ever prove right.
 */
export type SystemTranslation =
  | {
      command: string;
      functions: string[];
      /** The pieces the answer is checked against; see verifyOdeSystem. */
      matrix: string;
      constants: string;
      /** `Y(0)=[1,0]` when the caller gave conditions, absent otherwise. */
      condition?: string;
    }
  | { error: string };

/**
 * How an engine rejection should be described to the caller, if at all.
 *
 * Three classes, because they are three different facts and only one is about
 * the caller's mathematics. Dropping the error entirely told someone their
 * system "could not be analysed" when the truth was that the engine never
 * started; matching availability too broadly then told someone their input was
 * an outage and invited them to retry it.
 *
 * A TIMEOUT is the caller's cost, not an outage: `Giac evaluation timed out`
 * means this input wedged the shared worker for the whole per-call budget, and
 * "retry" is advice that repeats the wedge and the recycle it causes.
 *
 * The engine's own wording is never returned — it named this service's worker
 * recycling and probe expressions the caller never wrote.
 */
function engineFailureSuffix(failure: unknown): string {
  const message = failure instanceof Error ? failure.message : String(failure);
  if (
    /worker (unavailable|exited|init (timed out|failed))|recycled repeatedly|host disposed/i.test(
      message
    )
  ) {
    return ': the CAS was unavailable — retry';
  }
  if (/timed out/i.test(message)) {
    return ' in the time the CAS allows — simplify the system';
  }
  return '';
}

/**
 * What the rewritten system holds numerically, as answered by readNumericDomain.
 *
 * Named because two functions take these facts and a third derives from them; as
 * an anonymous shape it was written out twice and a fifth channel would have had
 * to be added in three places.
 */
type NumericDomain = {
  holdsExact: boolean;
  floatInMatrix: boolean;
  floatInForcing: boolean;
  floatInConditions: boolean;
};

/**
 * The caps that only a forcing term can trip: polynomial degree, a pole in the
 * solve variable, and the tighter degree allowed once a decimal is in play.
 *
 * Extracted for the same reason as readNumericDomain: a self-contained phase
 * whose only output is a refusal. Taking the decimal flags as a parameter is the
 * point — inlined, these caps read them out of the enclosing scope, so every flag
 * translateOdeSystem happened to hold was in scope here whether or not this phase
 * was meant to see it. Now the phase can only consult what it was handed.
 */
async function checkForcingTerm(
  constantEntries: string[],
  variable: string,
  domain: NumericDomain,
  evaluate: (command: string) => Promise<string>
): Promise<{ error: string } | undefined> {
  const { floatInMatrix, floatInForcing, floatInConditions } = domain;
  // Wherever the decimal lives, the accuracy cost is the same. Measured worst
  // relative residual over three points, matrix-float against forcing-float:
  // degree 8 is 6.9e-12 / 4.4e-11, degree 10 is 1.2e-9 / 1.5e-9, degree 14 is
  // 2.6e-5 / 5.3e-5 — within a factor of three at every degree, with no plateau
  // and no cliff. A separate, looser threshold for the forcing term rested on a
  // measurement that does not reproduce, and it shipped 5.3e-5 with a check mark
  // while the other channel refused 2.5e-10 as unusable.
  //
  // Derived here rather than handed in, so it cannot disagree with the cap below
  // that is its only reader.
  const holdsFloat = floatInMatrix || floatInForcing;
  // A forcing term's cost to the matrix `desolve` is driven by its DEGREE, and
  // none of the three text bounds can see that: `[y'=z+(x+1)^300, z'=-y]` is 35
  // characters, builds a 229-character probe and a 46-character command — inside
  // every cap — and then trapped the engine fatally, after which the NEXT
  // unrelated caller got "Giac worker exited (code 1)". `grad` and `subst`
  // differentiate the term away rather than expanding it, so the probe never
  // grows, and `^300` is four characters in the command.
  //
  // Measured on `desolve(Y'=[[0,1],[-1,0]]*Y+[(x+1)^n,0],x,Y)`: n=60 answers in
  // 800ms, n=80 takes 4.1s of a 10s budget, and n=100 traps and kills the
  // worker. 60 is the last comfortable one. Only asked when there is a forcing
  // term to ask about, so the homogeneous systems that are the common case pay
  // nothing.
  // numerator AND denominator. `degree` is the SIGNED polynomial degree, so it
  // reports 0 for `(x+1)^60/(x-1)^60` and -400 for `1/(x-1)^400` — both sail
  // past a `> MAX` test, and both are what the cap exists to stop: the first
  // killed the worker outright, the second burnt the full 10s budget, where
  // main answered each with a harmless `[]` in about 100ms. Summing the two
  // degrees measures the work the rational form actually implies; a
  // transcendental term is 0 on both, so `exp(x)` and `sin(2*x)` stay free.
  // Two numbers, because two different shapes are expensive. The SUM bounds
  // sheer size — `(x+1)^300`, and `1/(x-1)^400`, which the signed degree
  // reports as -400. The MINIMUM bounds a genuine rational, which is far
  // costlier per degree than either half alone: measured, numerator 40 over
  // denominator 2 and numerator 2 over denominator 40 both answer in under
  // 200ms, and so does 13 over 13, but 15 over 15 traps the engine fatally.
  const numerator = (c: string) => `degree(numer(${c}),${variable})`;
  const denominator = (c: string) => `degree(denom(${c}),${variable})`;
  // Written out rather than assembled by patching a comma into a shared
  // template: `.replace(',', '+')` on `degree(numer(c),x),degree(denom(c),x)`
  // replaces the FIRST comma, which is the argument separator inside the first
  // `degree` call, giving `degree(numer(c)+x)` and a MAX where the sum was
  // meant. The sum guard was therefore never computed, and
  // `(x+1)^50/(x-1)^12` — total 62, minimum 12, outside neither cap as
  // measured — trapped the engine fatally and killed the worker.
  const degrees =
    `[max(${constantEntries.map((c) => `${numerator(c)}+${denominator(c)}`).join(',')}),` +
    `max(${constantEntries.map((c) => `has(denom(${c}),${variable})`).join(',')})]`;
  let reply: string;
  try {
    reply = (await evaluate(degrees)).trim();
  } catch {
    return { error: `has a forcing term whose degree in ${variable} could not be read` };
  }
  const [total, denominatorSymbols] = splitTopLevel(stripEnclosingBrackets(reply), ',').map((n) =>
    Number(n.trim())
  );
  if (!Number.isFinite(total) || !Number.isFinite(denominatorSymbols)) {
    return { error: `has a forcing term whose degree in ${variable} could not be read` };
  }
  if (total > MAX_FORCING_DEGREE) {
    return {
      error:
        `has a forcing term of degree ${total} in ${variable}, above the ` +
        `${MAX_FORCING_DEGREE} the matrix form can be solved at`,
    };
  }
  // A float coefficient and a high-degree forcing term cannot be solved to
  // usable precision, whatever the engine survives. Every other bound here is
  // about the WORKER staying alive; this one is about the ANSWER being worth
  // having, and the two are far apart: degree 60 is comfortable for the engine
  // while `[y'=z, z'=-1.5*y+z+(x+1)^20]` — thirty ordinary characters, inside
  // every other cap — came back failing its own first equation `y'=z`, which
  // has no coefficient at all, by a factor of 13. Measured worst relative error
  // over three points: degree 8 is 4.6e-10, 10 is 8.7e-8, 12 is 2.0e-5, 15 is
  // 2.9e-2. Refusing is right where verifying is not: the answer is
  // unverifiable by construction, since an exact residual does not exist for a
  // float matrix.
  // A float anywhere beside a forcing term with a DENOMINATOR traps the engine
  // fatally, and no degree cap can see it because the hazard is not size:
  // `[y'=z, z'=-0.5*y+1/(x+1)]` is 26 characters, its numerator degree is 0 and
  // its denominator degree 1, and it killed the worker — where `main` returned
  // garbage without trapping, so this is a regression the caps did not cover.
  // The exact spelling solves the same system in 0ms, which is what the message
  // asks for.
  // A forcing term with a POLE, which the matrix `desolve` cannot integrate and
  // which kills the worker trying. Two tests, because one does not see both
  // shapes. A denominator carrying the variable covers `1/(x+1)`, `1/cos(x)`
  // and `1/(exp(x)+1)` — `size(lvar(denom(c)))` rather than its degree, since
  // `degree(denom(1/cos(x)),x)` is 0. It does NOT cover `tan`, which Giac keeps
  // atomic: `denom(tan(x))` is 1 and `texpand` does not open it either. So the
  // pole-bearing elementary functions are named. That is a shape list and will
  // not generalise, which is the honest description of it; the measurement is
  // that `[y'=z, z'=-y+tan(x)]` — 21 characters, exact — traps the engine and
  // takes a concurrent caller's unrelated call with it, where main answers.
  // Three names, not nine. Giac gives `cot`, `sec`, `csc`, `coth`, `sech` and
  // `csch` a denominator that mentions the variable, so the has(denom(c),x) test
  // already refuses them and those six were unreachable — measured with
  // `has(denom(f(x)),x)`, which is 1 for each of them and 0 for these three.
  // A shape list should hold only the shapes nothing else catches.
  //
  // The variable has to be IN it. Matching the function name alone refused
  // `tan(1)*x`, whose `tan(1)` is a constant, and asking `size(lvar(denom(c)))`
  // rather than whether the denominator involves the variable refused
  // `1/(a+1)` and `x/(a+b)` — all three solve, and the message told the caller
  // they had a pole in x that is not there.
  const poleFunction = new RegExp(String.raw`\b(tan|cotan|tanh)\s*\([^)]*\b${variable}\b`);
  if (denominatorSymbols > 0 || constantEntries.some((c) => poleFunction.test(c))) {
    return {
      error:
        `has a forcing term with a pole in ${variable}; the matrix form cannot ` +
        'solve one, and the attempt fatally traps the engine',
    };
  }
  if (floatInConditions && total > MAX_CONDITION_FLOAT_DEGREE) {
    return {
      error:
        `has a float initial condition and a forcing term of degree ${total} in ` +
        `${variable}; above degree ${MAX_CONDITION_FLOAT_DEGREE} the condition is ` +
        'no longer met — write the decimals exactly (3/2 rather than 1.5) or ' +
        'lower the degree',
    };
  }
  if (holdsFloat && total > MAX_FLOAT_FORCING_DEGREE) {
    return {
      error:
        `has a float and a forcing term of degree ${total} in ${variable}; above ` +
        `degree ${MAX_FLOAT_FORCING_DEGREE} that combination cannot be solved to ` +
        'usable precision — write the decimals exactly (1/2 rather than 0.5, ' +
        'wherever they appear, including the initial conditions) or lower the degree',
    };
  }
  return undefined;
}
/**
 * Whitespace-free copy, for comparing two of the engine's own prints of the same
 * expression — `exact()` reformats spacing without changing the value, so a raw
 * string compare reports a difference that is not one.
 *
 * One copy, and it sits with readNumericDomain because that is its only caller.
 * It was defined twice inside translateOdeSystem, in two adjacent try blocks
 * feeding the same comparison, so normalising a different whitespace class in one
 * would have moved the matrix verdict while leaving the conditions verdict on the
 * old rule.
 */
const flat = (text: string) => text.trim().replaceAll(/\s+/g, '');

/**
 * What the rewritten system holds NUMERICALLY: an exact symbolic constant, and a
 * float in any of the three places one can hide.
 *
 * Extracted because translateOdeSystem held every phase of the translation in one
 * body. These four facts are one question asked in three places, so they come back
 * as one record with a declared type, rather than four `let`s the rest of the
 * function could read — or reassign — at any point after them. The `let`s survive
 * inside here, where the try/catch that sets them is the next statement.
 */
async function readNumericDomain(
  matrix: string,
  constants: string,
  conditions: string[],
  evaluate: (command: string) => Promise<string>
): Promise<NumericDomain | { error: string }> {
  // Ask the ENGINE what the matrix holds, rather than reading how it printed it.
  //
  // This was a pair of character tests, and each one was a guess about Giac's
  // printer that turned out to be wrong. "Exact constant = contains a letter"
  // missed U+221A, the glyph Giac prints radicals with, so a float beside `√2`
  // was never normalised and `[y'=z, z'=-1.5*y+sqrt(3)*z]` returned a
  // complex-valued answer. Fixing that half moved the bug across the `&&`:
  // "float = contains a decimal point" missed `-3e+15`, and the same wrong
  // answer came back. `lvar` reports the non-numeric atoms and `DOM_FLOAT` the
  // float entries, both from the engine's own type tags — which also gets `E`
  // (a free identifier, not Euler's number) and `1.5*i` right, where the
  // character tests did not.

  // Two questions, both asked of the ENGINE rather than of how it printed: does
  // this hold an exact symbolic constant, and does it hold a float.
  //
  // `exact()` rewrites every float as a rational and leaves everything else
  // alone, so comparing its result with what came in answers the second question
  // — and it looks INSIDE an expression, which a type tag does not. Tagging was
  // the first attempt and `type(0.5*(x+1)^15)` is DOM_SYMBOLIC, not DOM_FLOAT, so
  // a float anywhere but at the top level was invisible. The comparison is
  // string-wise, which is only sound because both sides are the engine's own
  // print of the same expression: `matrix` and `constants` are probe output, and
  // `exact` reprints through the same writer.
  //
  // The forcing vector is asked about separately, not folded in with the matrix.
  // It was not asked about at all, and a float living only there skipped the
  // accuracy cap: `[y'=z, z'=-y+0.5*(x+1)^15]` shipped an answer whose relative
  // residual against its own system is 0.33. The two also degrade at very
  // different rates, so they cannot share a threshold.
  let holdsExact = false;
  let floatInMatrix = false;
  let floatInForcing = false;
  let floatInConditions = false;
  try {
    const [atoms, exactMatrix, exactForcing] = await Promise.all([
      evaluate(`size(lvar(${matrix}))`),
      evaluate(`exact(${matrix})`),
      evaluate(`exact(${constants})`),
    ]);
    holdsExact = Number(atoms.trim()) > 0;
    floatInMatrix = flat(exactMatrix) !== flat(matrix);
    floatInForcing = flat(exactForcing) !== flat(constants);
  } catch {
    // A refusal, not a shrug. These flags gate the accuracy caps and the
    // normalisation; clearing them lets the request continue with both guards
    // silently off, and the measured consequence is an answer this module has
    // already established is wrong — `[y'=z, z'=-1.5*y+z+(x+1)^20]` fails its own
    // first equation by a factor of 13. "What happened before any of this
    // existed" was also not true: before this module the input never took this
    // path. Not knowing whether the answer is safe to produce is not the same as
    // knowing that it is.
    return {
      error:
        'could not be examined for decimal coefficients, so the accuracy bounds ' +
        'that depend on that could not be applied',
    };
  }
  // Asked separately, and only after validateSystemShape has bounded them. Folded into the
  // same `Promise.all`, a failure on this one — the only member built from caller
  // text — silently cleared the matrix and forcing flags too, reopening the
  // unscanned-float hole and skipping the normalisation that prevents the
  // mixed-domain wrong answer.
  if (conditions.length > 0) {
    try {
      // Two calls, one copy of the text each. Asking both questions in one
      // command doubled the caller's own text: the input cap is 8,192 characters
      // and a long flat expression traps around 10,000, so a 7,528-character
      // request — comfortably inside the cap — became a ~15,000-character command
      // and killed the shared worker, where main answers it in 21ms.
      //
      // This RAISES the threshold; it does not remove it. The engine also traps on
      // parse DEPTH, which no character count expresses: a condition nested 600
      // deep is 2,415 characters and kills the worker in one copy. That is bounded
      // in validateSystemShape, before either of these calls — saying otherwise
      // here is what would stop the next reader from noticing.
      const written = `[${conditions.join(',')}]`;
      const [asExact, asWritten] = await Promise.all([
        evaluate(`exact(${written})`),
        evaluate(written),
      ]);
      floatInConditions = flat(asExact) !== flat(asWritten);
    } catch (error) {
      // Same classification as the probe's. An outage that lands here is not the
      // caller's conditions being at fault, and a recycle caused by somebody
      // else's request read as a verdict on theirs.
      return {
        error:
          'has initial conditions that could not be examined for decimals, so the ' +
          `accuracy bound that depends on that could not be applied${engineFailureSuffix(error)}`,
      };
    }
  }
  return { holdsExact, floatInMatrix, floatInForcing, floatInConditions };
}

/**
 * Rewrites a linear constant-coefficient system as a matrix product.
 *
 * Asks Giac for the coefficient matrix, the inhomogeneous term and the residual
 * in ONE call: the residual is what the right-hand side still contains after the
 * linear part is subtracted, so a nonzero residual means the system is not
 * linear in the unknown functions and there is no matrix to build.
 */
export async function translateOdeSystem(
  system: OdeSystem,
  variable: string,
  engine: GiacEngineLike
): Promise<SystemTranslation> {
  const evaluate = (expr: string): Promise<string> => engine.evaluate(expr);
  const shape = validateSystemShape(system, variable);
  if ('error' in shape) return shape;
  const { functions, rhss, conditions } = shape;

  // `grad` gives the whole row at once, and its entries answer BOTH questions a
  // hand-built residual used to: an entry naming an unknown function means the
  // system is not linear in them, and an entry naming the independent variable
  // means the coefficients are not constant. A forcing term in the independent
  // variable is fine and stays out of the matrix, which is why `exp(x)` in
  // `y'=z+exp(x)` is still accepted.
  // Three members: the gradient rows, the constant vector, and the residual.
  //
  // The gradient alone is not a test for linearity. It asks whether the gradient
  // still depends on an unknown, which is a different question: Giac
  // differentiates floor/ceil/round/sign to the constant 0 and frac to 1, so
  // `[y'=floor(z), z'=-y]` passed that scan and was answered — and `grad(frac(z))`
  // is [0,1], indistinguishable from `z` itself. The residual asks directly what
  // is left of the right-hand side once the linear part and the constant are
  // removed. It must be identically zero.
  //
  // Two members are wrapped in `normal`, not `simplify`. simplify's cost is
  // exponential in composition depth and no character bound can express that:
  // `[y'=sin(sin(sin(sin(sin(z))))), z'=-y]` is 50 characters and builds a
  // 292-character probe — 6.8x inside the cap — yet burnt the whole 10s per-call
  // budget in the shared worker, a denial of service against every concurrent
  // caller. `normal` decides the same question, cancels the float terms simplify
  // leaves (`z+0.5-z-0.5`), and costs 197ms at depth 80 where the character cap
  // is already binding. What it gives up is a coefficient that is constant only
  // under a trig identity, which it reports as non-constant.
  const vec = `[${functions.join(',')}]`;
  const zeroAll = `[${functions.map((f) => `${f}=0`).join(',')}]`;
  const probe =
    `[[${rhss.map((r) => `normal(grad(${r},${vec}))`).join(',')}],` +
    `subst([${rhss.join(',')}],${zeroAll}),` +
    `[${rhss.map((r) => `normal(${r}-(grad(${r},${vec})*${vec})-subst(${r},${zeroAll}))`).join(',')}]]`;
  // The equation cap bounds the count; this bounds the SIZE, which is what the
  // engine actually chokes on — the probe grows as (equations x right-hand-side
  // length), so a few very long equations reach the same place many short ones
  // do. Measured: an 8KB request could build a 58MB probe and take the parent
  // process from 92MB to 613MB RSS before the worker was even sent the message.
  if (probe.length > MAX_PROBE_CHARS) {
    return {
      error:
        `expands to ${probe.length} characters of coefficient extraction, above the ` +
        `${MAX_PROBE_CHARS}-character limit — use shorter right-hand sides`,
    };
  }

  let raw: string;
  try {
    raw = (await evaluate(probe)).trim();
    // The REPLY, not just the request. MAX_PROBE_CHARS bounds what is sent;
    // `normal` expands what comes back, and nothing bounded that — so a
    // 28-character system, `[y'=y*z*(x+1)^1000, z'=-y]`, returned a
    // 677,259-character matrix that survived the probe and then killed the
    // worker when it was re-sent to the `exact` classifier. main burns its
    // timeout on the same input and the worker LIVES, so an unbounded reply was
    // strictly worse than doing nothing. Legitimate replies are tiny: 28
    // characters for `[y'=z, z'=-y]`, 223 for a nine-equation ring, 329 for a
    // 25-term forcing sum.
    if (raw.length > MAX_PROBE_REPLY_CHARS) {
      return {
        error:
          `expands to ${raw.length} characters of coefficients, above the ` +
          `${MAX_PROBE_REPLY_CHARS}-character limit — the coefficients grow far ` +
          'faster than the input that produced them',
      };
    }
  } catch (error) {
    // A trap or timeout in the probe is this operation's failure, not a raw
    // engine string for the caller to decipher.
    return { error: `could not be analysed${engineFailureSuffix(error)}` };
  }
  if (raw.includes('GIAC_ERROR')) {
    return {
      error:
        `has coefficients that could not be read for ${functions.join(', ')} — one of ` +
        'those names may be reserved by the CAS; rename it',
    };
  }

  const parts = splitTopLevel(stripEnclosingBrackets(raw), ',');
  if (parts.length !== 3) {
    return { error: 'has coefficients that could not be read' };
  }
  let [matrix, constants] = parts.map((p) => p.trim());
  const residual = parts[2].trim();
  // Numeric, not textual. Giac prints a FLOAT zero as `0.0` (and `-0.0`) whenever
  // a float survives into the right-hand side, so comparing to the string '0'
  // refused every system with a decimal coefficient — `[y'=0.5*z, z'=-1.5*y]`,
  // a damped oscillator, an SIR model — and told the caller its linear system
  // was not linear. Exact rationals (`z/2`) print as `0` and so were unaffected,
  // which is why this survived a suite full of them.
  // A residual entry that is a bare NUMBER is not evidence of nonlinearity. A
  // nonlinear term always survives as something symbolic — `y*z`, `floor(z)` —
  // because the linear part and the constant are what were subtracted off. A
  // lone tiny number is a cancellation artifact: Giac promotes a literal with
  // 15+ decimal places to extended precision and then does not cancel it, so
  // `[y'=z, z'=-y+0.000000000000001]` left `0.100000000000000e-14` and was
  // refused as "not linear", while the same value written `1e-15` cancelled and
  // solved. Bounded rather than ignored, so a large leftover constant — which
  // would mean the matrix/constant split itself disagreed — still refuses.
  const negligible = (entry: string): boolean => {
    // The empty check is load-bearing, as it is in isPrintedZero: `Number('')` is 0, so
    // without it a malformed reply with a missing entry reads as a negligible
    // residue and the system is accepted instead of refused.
    const text = entry.trim();
    if (text.length === 0) return false;
    const value = Number(text);
    return Number.isFinite(value) && Math.abs(value) < 1e-9;
  };
  const leftover = (text: string): boolean =>
    splitTopLevel(stripEnclosingBrackets(text), ',').some(
      (r) => !isPrintedZero(r) && !negligible(r)
    );
  let notAffine = leftover(residual);
  if (notAffine) {
    // One round trip, and only when the text alone says nonlinear. A float in
    // the right-hand side makes `subst` numericalise the constant, so an exact
    // one comes back as a float in the subtrahend and as itself in the minuend:
    // `[y'=z, z'=-1.5*y+pi]` left `pi-3.14159265359`, which `normal` cannot
    // cancel and which stays SYMBOLIC — so the bare-number rule above could not
    // see it, and a linear system was refused as not linear. Asking the engine
    // for a number settles it: the artifact is 2.1e-13, while `y*z`, `floor(z)`
    // and `z^2` stay symbolic and are still refused.
    try {
      // No GIAC_ERROR check: this runs only when the verdict is ALREADY "not
      // affine", and an error reply reads as a nonzero entry, so it re-reaches
      // the same conclusion. A check here would be a branch nothing can tell
      // apart from its absence.
      notAffine = leftover(await evaluate(`evalf(${residual})`));
    } catch {
      // Keep the textual verdict.
    }
  }
  if (notAffine) {
    return {
      error:
        'is not linear in the unknown functions — what remains after removing the ' +
        'linear part is not zero, so it has no coefficient matrix',
    };
  }

  // One scan over the matrix decides both boundaries, and can name what it found.
  // Constancy is Giac's own limit too — it answers "Non constant linear
  // differential system" — checked here so it arrives as an error rather than as
  // a Result line with isError:false.
  const entries = splitTopLevel(stripEnclosingBrackets(matrix), ',').flatMap((row) =>
    splitTopLevel(stripEnclosingBrackets(row), ',')
  );
  const mentions = (entry: string, symbol: string): boolean =>
    new RegExp(`(^|[^A-Za-z_0-9])${symbol}([^A-Za-z_0-9]|$)`).test(entry);

  const nonlinear = functions.find((f) => entries.some((e) => mentions(e, f)));
  if (nonlinear !== undefined) {
    return {
      error:
        `is not linear in the unknown functions — a coefficient still depends on ` +
        `${nonlinear}, so the system has no constant coefficient matrix`,
    };
  }
  if (entries.some((e) => mentions(e, variable))) {
    return {
      error:
        `has a coefficient that still mentions ${variable} after normalising, so ` +
        'it could not be confirmed constant; only constant-coefficient systems ' +
        'can be rewritten as a matrix. A coefficient that is constant only under ' +
        'an identity (sin(x)^2+cos(x)^2) has to be reduced by hand',
    };
  }

  // `variable` belongs in this list as much as the functions do. Without it,
  // solving in a variable named Y collided with the vector: the emitted
  // `desolve(Y'=[[0,1],[-1,0]]*Y,Y,Y)` came back isError:false with an answer
  // whose residual is [0,-1] — it satisfies z'=-y-1, not the system asked for.
  // The IVP form hid it completely, since the initial conditions still held.
  const vector = vectorSymbol([variable, ...functions, matrix, constants, ...system.conditions]);
  const domain = await readNumericDomain(matrix, constants, system.conditions, evaluate);
  if ('error' in domain) return domain;
  // Only the two the normalisation below reads; the decimal caps take `domain`
  // whole and unpack it themselves.
  const { holdsExact, floatInMatrix } = domain;

  // Giac mishandles a matrix mixing a float with an exact irrational:
  // `[[0,1],[-1.5,ln(2)]]` came back as an ordinary-looking vector whose
  // residual is 2.1, not 0, and evaluating that matrix to floats makes it
  // 7.6e-12. It needs BOTH: normalising whenever a float appeared reached
  // systems with nothing to normalise and made them worse, since a 12-digit
  // float matrix splits a repeated root, and an all-rational matrix with a
  // decimal only in its forcing term failed outright where `1/2` for `0.5`
  // solved it.

  if (holdsExact && floatInMatrix) {
    try {
      const asFloat = await evaluate(`evalf(${matrix})`);
      if (!asFloat.includes('GIAC_ERROR')) matrix = asFloat.trim().replaceAll(/\s+/g, '');
    } catch {
      // Keep the exact spelling; the answer is then checked as before.
    }
  }

  const constantEntries = splitTopLevel(stripEnclosingBrackets(constants), ',');
  const homogeneous = constantEntries.every(isPrintedZero);
  if (!homogeneous) {
    const refusal = await checkForcingTerm(constantEntries, variable, domain, evaluate);
    if (refusal) return refusal;
  }
  // Cosmetic, and only for the Command line the caller sees: Giac answers
  // `A*Y+[0,0]` identically to `A*Y`. Kept so a homogeneous system does not
  // display a zero vector it never had; pinned by a test on the emitted command.
  const rhs = homogeneous ? `${matrix}*${vector}` : `${matrix}*${vector}+${constants}`;
  const body = `${vector}'=${rhs}`;

  // Conditions have to become one vector condition: Giac takes `Y(0)=[1,0]`, not
  // the per-function `y(0)=1, z(0)=0` the caller wrote. The fact that decides
  // this is the one carrying the values, so it cannot disagree with what it
  // guards.
  const vectorCondition =
    conditions && buildVectorCondition(vector, conditions.point, conditions.values);
  return withinLimit({
    command: vectorCondition
      ? `desolve([${body},${vectorCondition}],${variable},${vector})`
      : `desolve(${body},${variable},${vector})`,
    functions,
    matrix,
    constants: homogeneous ? '' : constants,
    ...(vectorCondition ? { condition: vectorCondition } : {}),
  });
}

/**
 * The same size bound the probe gets, applied to the command actually sent.
 *
 * The probe cap does not cover this. Two kinds of text reach the command without
 * ever entering the probe: an initial condition's POINT and VALUE, which are not
 * right-hand sides so no gradient is taken of them, and the engine's OWN output —
 * the coefficient matrix and forcing vector, which can be far longer than the
 * input that produced them (`10^900` is six characters and comes back as 901
 * digits). A 1,000-deep product as a condition value passed every
 * guard in this module and trapped the WASM engine fatally
 * ("RuntimeError: null function or function signature mismatch"), which forces
 * the worker to be recycled and rejects whatever else was pending on it, and
 * returned that raw engine string to the caller.
 *
 * Bounding the whole command rather than each value keeps one number in charge
 * of one question: how much text this module is willing to hand the engine.
 */
function withinLimit(
  translation: Extract<SystemTranslation, { command: string }>
): SystemTranslation {
  const { command, condition } = translation;
  if (command.length <= MAX_COMMAND_CHARS) {
    return translation;
  }
  // Name the part that is actually large. Blaming the conditions unconditionally
  // told a caller who wrote none — `[y'=z+10^900, z'=-y]`, whose 938 characters
  // are all the engine's own expansion of the forcing term — to shorten initial
  // conditions it never supplied.
  const cause =
    (condition?.length ?? 0) * 2 > command.length
      ? 'use shorter initial conditions'
      : 'use a shorter forcing term';
  return {
    error:
      `becomes ${command.length} characters once rewritten as a matrix, above ` +
      `the ${MAX_COMMAND_CHARS}-character limit — ${cause}`,
  };
}

/**
 * The vector condition Giac takes, `Y(0)=[1,0]`, from an already-checked reading.
 *
 * Split from the checking in ode-system-shape.ts because those need only the
 * caller's text
 * while this needs the vector symbol, which is not known until the coefficient
 * matrix has been extracted. Together they made four decisions that are pure
 * string work wait for five engine round trips that a bad condition made
 * pointless.
 */
function buildVectorCondition(vector: string, point: string, values: string[]): string {
  return `${vector}(${point})=[${values.join(',')}]`;
}
