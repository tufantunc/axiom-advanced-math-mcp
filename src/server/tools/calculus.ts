import { formatErrorResponse, COMPONENT_ORDER_PREFIX } from './response-formatter.js';
import { validateExpression } from './expression-validator.js';
import { evalWithLatex, type EvaluatedResponse } from './giac-eval.js';
import type { VerificationResult } from './self-verify.js';
import { detectFailure } from './compute/silent-failure.js';
import { excerpt, splitTopLevel } from './output-cleanup.js';
import { stripEnclosingBrackets } from './compute/arg-parsing.js';
import { unicodeToAscii, NAME_PATTERN } from './unicode-normalize.js';
import { giacEngine } from '../giac/index.js';
import { verifyIntegrate, verifyOdeSystem, verifyOdeSolution } from './self-verify.js';
import {
  leibnizQuotients,
  odeEquationMembers,
  parseOdeSystem,
  replaceLeibnizQuotients,
  type LeibnizQuotient,
} from './ode-system-shape.js';
import { translateOdeSystem } from './ode-system.js';
import { implausibleEquationMagnitude } from './ode-condition-bounds.js';

/** Giac's spelling of a limit's direction: from the right, from the left, both sides. */
type GiacLimitDirection = '1' | '-1' | '0';

/**
 * Each spelling of a limit's direction, as Giac's own: `1` from the right, `-1`
 * from the left, and `0` both sides, as with no direction at all.
 * Every spelling but `+` used to become -1, so Giac's own `1` — and `right`,
 * `2`, a two-sided `0` — answered the left-hand limit as a success:
 * `limit(1/x, x, 0, 1)` was -infinity. Anything not here names no side and is
 * refused rather than read as one. A Map, so no inherited key is a spelling.
 */
const LIMIT_DIRECTIONS: ReadonlyMap<string, GiacLimitDirection> = new Map([
  ['+', '1'],
  ['+1', '1'],
  ['1', '1'],
  ['-', '-1'],
  ['-1', '-1'],
  ['0', '0'],
]);

function buildSimpleCommand(operation: string, args: Record<string, unknown>): string {
  switch (operation) {
    case 'differentiate': {
      const expr = args.expression as string;
      const v = args.variable as string;
      const ord = args.order === undefined ? 1 : Number(args.order);
      if (ord > 1) return `diff(${expr},${v},${ord})`;
      return `diff(${expr},${v})`;
    }
    case 'integrate': {
      const expr = args.expression as string;
      const v = args.variable as string;
      const lo = args.lower_bound as string | undefined;
      const hi = args.upper_bound as string | undefined;
      if (lo !== undefined && hi !== undefined) return `int(${expr},${v},${lo},${hi})`;
      return `int(${expr},${v})`;
    }
    case 'limit': {
      const expr = args.expression as string;
      const v = args.variable as string;
      const pt = args.point as string;
      if (args.direction === undefined) return `limit(${expr},${v},${pt})`;
      const dir = LIMIT_DIRECTIONS.get(String(args.direction));
      // Thrown, as a command that cannot be built is in this file: refused
      // here, where the command is built, so no path to it can fall back on
      // the two-sided limit for a side it does not recognise.
      if (dir === undefined) {
        throw new Error(
          `unknown limit direction \`${excerpt(String(args.direction), 60)}\` — use + ` +
            '(from the right), - (from the left), or leave it out for both sides'
        );
      }
      return `limit(${expr},${v},${pt},${dir})`;
    }
    case 'taylor': {
      const expr = args.expression as string;
      const v = args.variable as string;
      const pt = (args.point as string) ?? '0';
      const n = args.order === undefined ? 5 : Number(args.order);
      return `taylor(${expr},${v}=${pt},${n})`;
    }
    case 'solve_ode': {
      const eq = args.equation as string;
      const v = (args.variable as string) ?? 'x';
      const fn = (args.function_name as string) ?? 'y';
      const ic = args.initial_conditions as string | undefined;
      if (ic) return `desolve([${eq},${ic}],${v},${fn})`;
      return `desolve(${eq},${v},${fn})`;
    }
    default:
      throw new Error(`Unknown calculus operation: ${operation}`);
  }
}

interface BuiltCommand {
  expr: string;
  /** Present only for a rewritten system: the functions, in component order. */
  functions?: string[];
  /** Present only for a rewritten system: what the answer is checked against. */
  system?: {
    matrix: string;
    constants: string;
    variable: string;
    condition?: string;
  };
}

/**
 * The single place an operation becomes a Giac command.
 *
 * Async because one case needs the CAS to build its command: a list-form ODE
 * system is rewritten into the matrix form Giac solves, which takes a probe for
 * the coefficient matrix. Keeping that here rather than in the handler is what
 * lets `calculusHandler` stay a linear validate -> build -> eval pipeline.
 */
async function buildGiacExpression(
  operation: string,
  args: Record<string, unknown>
): Promise<BuiltCommand> {
  if (operation === 'solve_ode') {
    const system = parseOdeSystem(args.equation as string);
    if (system) {
      const translated = await translateOdeSystem(
        system,
        (args.variable as string) ?? 'x',
        giacEngine
      );
      // Thrown, not returned: the handler's existing catch turns it into
      // formatErrorResponse, which is this file's convention for a command that
      // cannot be built.
      if ('error' in translated) {
        throw new Error(`solve_ode cannot solve this system — it ${translated.error}`);
      }
      return {
        expr: translated.command,
        functions: translated.functions,
        system: {
          matrix: translated.matrix,
          constants: translated.constants,
          variable: (args.variable as string) ?? 'x',
          ...(translated.condition ? { condition: translated.condition } : {}),
        },
      };
    }
  }
  return { expr: buildSimpleCommand(operation, args) };
}

/**
 * The highest order differentiate and taylor accept.
 *
 * Measured on the engine, not chosen for taste: `taylor(exp(sin(x)), x, 0, 200)`
 * traps the shared Giac worker ("RuntimeError: unreachable") and 150 times out,
 * where 100 answers in about 3 s; `taylor(sin(x)/x, x, 0, 5000)` traps too.
 * `diff(1/x, x, 100000)` shipped "GIAC_ERROR: Polynomial exponent overflow" as
 * its Result. No ceiling makes every expression safe — the cost depends on the
 * expression as much as the order — but 100 keeps the worst shape measured
 * inside the timeout and is far past any series a caller reads.
 */
export const MAX_CALCULUS_ORDER = 100;

/**
 * Names Giac reads as constants: differentiating with respect to one is 0.
 * A pattern, not a Set literal — test/operation-coverage.test.ts reads every
 * `new Set([...])` in a handler as operation names it dispatches on. `π` is a
 * letter, so it passes the name check and is caught here; `∞` is not one.
 */
const CONSTANT_NAME = /^(?:e|i|pi|π|infinity|euler_gamma)$/u;

/** A name as Giac reads one, `θ` included — the same rule as unicode-normalize. */
const VARIABLE_NAME = new RegExp(`^${NAME_PATTERN}$`, 'u');

function nameRefusal(operation: string, text: string): string | null {
  if (!VARIABLE_NAME.test(text)) {
    return `${operation} needs a variable that is a name, such as x — got "${excerpt(text, 60)}"`;
  }
  if (CONSTANT_NAME.test(text)) {
    return `${operation} needs a variable, and "${text}" is a constant — name the variable, such as x`;
  }
  return null;
}

/**
 * The variable must be a name. `diff(x, 2)` answered the unevaluated
 * `diff(x,2)`, `integrate(x, 2)` a GIAC_ERROR, `taylor(sin(x), 2, 0, 3)` the
 * value 2/3, and `diff(x^2, pi)` the number 0 — each with isError:false.
 *
 * differentiate also takes a bracketed list of names, Giac's gradient:
 * `diff(x^2*y^3, [x, y])`. Each is checked as a single variable is. An order
 * beside a list is refused rather than passed on, since it names no variable.
 */
function variableRefusal(
  operation: string,
  variable: unknown,
  order: unknown = undefined
): string | null {
  const text = String(variable).trim();
  if (operation === 'differentiate' && text.startsWith('[') && text.endsWith(']')) {
    const names = splitTopLevel(text.slice(1, -1), ',').map((n) => n.trim());
    for (const name of names) {
      const refusal = nameRefusal(operation, name);
      if (refusal) return refusal;
    }
    if (order !== undefined) {
      return (
        `differentiate takes an order with one variable, not a list — write ` +
        `diff(f, x, 2), or list the variables for the gradient`
      );
    }
    return null;
  }
  return nameRefusal(operation, text);
}

/**
 * The order must be a positive integer, bounded before the engine sees it.
 * Accepts the extractor's text or a number.
 */
function orderRefusal(operation: string, order: unknown): string | null {
  if (order === undefined) return null;
  const text = String(order).trim();
  const n = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!(n >= 1 && n <= MAX_CALCULUS_ORDER)) {
    return (
      `${operation}'s order must be a positive integer up to ${MAX_CALCULUS_ORDER} — ` +
      `got "${excerpt(text, 60)}"`
    );
  }
  return null;
}

/**
 * Shared by differentiate, integrate and taylor: the extractor's verdict on the
 * call's shape first (arity, balance, an empty argument), then the variable.
 */
function calculusArgsRefusal(operation: string, args: Record<string, unknown>): string | null {
  if (typeof args.argument_refusal === 'string') return args.argument_refusal;
  if (!args.expression) return `'expression' is required for ${operation}`;
  if (!args.variable) return `'variable' is required for ${operation}`;
  return variableRefusal(operation, args.variable, args.order);
}

function validateDifferentiate(args: Record<string, unknown>): string | null {
  return calculusArgsRefusal('differentiate', args) ?? orderRefusal('differentiate', args.order);
}

function validateIntegrate(args: Record<string, unknown>): string | null {
  return calculusArgsRefusal('integrate', args);
}

function validateLimit(args: Record<string, unknown>): string | null {
  if (!args.expression) return "'expression' is required for limit";
  if (!args.variable) return "'variable' is required for limit";
  if (!args.point) return "'point' is required for limit";
  return null;
}

function validateTaylor(args: Record<string, unknown>): string | null {
  return calculusArgsRefusal('taylor', args) ?? orderRefusal('taylor', args.order);
}

function validateSolveOde(args: Record<string, unknown>): string | null {
  if (!args.equation) return "'equation' is required for solve_ode";
  // Before validateExpression and before any engine call, because the whole
  // point of the bound is that the text never reaches the CAS: on ed5917e
  // `desolve(y'=y, y(0)=50000!, x, y)` came back "memory access out of
  // bounds" having killed the shared worker, and a call queued behind it got
  // "Giac worker exited (code 1)".
  //
  // Checked ahead of `unsupported_argument` because the equation is argument
  // zero and a condition folded into it outranks anything found among the
  // trailing arguments — the extractor sets both when the same argument is at
  // fault, and this is the one that says what is actually wrong.
  //
  // Worded for one equation. The system path reaches the identical rule
  // through validateSystemShape and words it "cannot solve this system", so
  // the two prefixes are the only difference between them.
  // The equation itself, bounded as validateSystemShape bounds a system's
  // right-hand sides. Only conditions were: `desolve(y'=y*10^100000, x, y)` is
  // twenty-six characters and trapped the shared worker ("memory access out of
  // bounds"), where the same right-hand side in a system is refused. First,
  // because the equation is argument zero. A system is left to its own check,
  // which words the refusal for a system.
  const equationText =
    typeof args.original_equation === 'string' ? args.original_equation : String(args.equation);
  if (parseOdeSystem(equationText) === null) {
    for (const member of odeEquationMembers(equationText)) {
      // `d^2y/dx^2` is an order, not a power: a quotient's order is bounded by
      // rewriteLeibniz, which names it, so it is not read as a magnitude here.
      const oversized = implausibleEquationMagnitude(replaceLeibnizQuotients(member, (q) => q.fn));
      if (oversized !== undefined) {
        return (
          `solve_ode cannot solve this equation — it has a term of implausible magnitude ` +
          `(${oversized}) — coefficients and forcing terms are ordinary numbers`
        );
      }
    }
  }
  const conditionRefusal = args.condition_refusal;
  if (typeof conditionRefusal === 'string') {
    return `solve_ode cannot solve this equation — it ${conditionRefusal}`;
  }
  // Refused, not ignored. The extractor folds the arguments it recognises —
  // identifiers name the variable and the function, `y(0)=1` shapes are
  // conditions — and reports the first it does not, because dropping one is
  // how `desolve(y'=y, y(0)=1)` came to answer the general solution as if it
  // satisfied the condition.
  const unsupported = args.unsupported_argument;
  if (typeof unsupported === 'string') {
    return (
      `solve_ode does not understand the argument "${excerpt(unsupported, 60)}" — ` +
      'give the equation, then any conditions as y(0)=1, then the variable ' +
      "and the function, as in desolve(y'=y, y(0)=1, x, y)"
    );
  }
  return null;
}

function validateParams(operation: string, args: Record<string, unknown>): string | null {
  switch (operation) {
    case 'differentiate':
      return validateDifferentiate(args);
    case 'integrate':
      return validateIntegrate(args);
    case 'limit':
      return validateLimit(args);
    case 'taylor':
      return validateTaylor(args);
    case 'solve_ode':
      return validateSolveOde(args);
    default:
      return `Unknown operation: ${operation}`;
  }
}

function buildVerifyCallback(
  operation: string,
  args: Record<string, unknown>,
  system: BuiltCommand['system']
): ((result: string) => Promise<VerificationResult | undefined>) | undefined {
  const isIndefiniteIntegral =
    operation === 'integrate' && args.lower_bound === undefined && args.upper_bound === undefined;
  if (isIndefiniteIntegral) {
    return (result: string) =>
      verifyIntegrate(args.expression as string, args.variable as string, result);
  }
  // A rewritten system is checked against Y' = A*Y + b. The shape guards in the
  // handler catch an answer that is visibly not one (`[]`, `undef`, `poly1[`);
  // this catches one that looks entirely ordinary and simply is not a solution.
  if (system) {
    return (result: string) =>
      verifyOdeSystem(
        system.matrix,
        system.constants,
        system.variable,
        result,
        (expr: string) => giacEngine.evaluate(expr),
        system.condition
      );
  }
  // A single equation gets the same treatment, with one ordering constraint
  // the system path does not have: this callback runs INSIDE evalWithLatex,
  // before the `[]`/`GIAC_ERROR`/`infinity` sentinels that turn an unsolvable
  // IVP into a clean refusal. Verifying an answer those sentinels are about to
  // refuse would be a wasted round trip at best and a verdict attached to an
  // error at worst, so the callback declines first and computes a verdict only
  // for an answer that passes the same scan the guard refuses on. The scan is
  // shared (singleEquationFailure) so the two cannot drift — this file already
  // paid once for letting a sentinel and its copy diverge.
  if (operation === 'solve_ode') {
    const original = args.original_equation;
    if (typeof original !== 'string' || original.length === 0) return undefined;
    // The evaluation cache keys on the NORMALIZED command, so the verdict must
    // be a function of normalized text too — a callback fed the raw spelling
    // could cache a decline under the key an ASCII caller shares (a `y²` call
    // declined by the verifier, then `y^2` reading that cached absence and
    // shipping a disproved answer the ASCII spelling refuses). Normalizing
    // here is also what lets the unicode caller get its own verdict: the
    // verifier's residual round trip needs the ASCII form regardless.
    const originalAscii = unicodeToAscii(original);
    const conditionSourceAscii = unicodeToAscii(args.equation as string);
    return async (result: string) => {
      if (singleEquationFailure(result.trim()) !== null) return undefined;
      return verifyOdeSolution(
        originalAscii,
        (args.function_name as string) ?? 'y',
        (args.variable as string) ?? 'x',
        result.trim(),
        (expr) => giacEngine.evaluate(expr).then(String),
        conditionSourceAscii
      );
    };
  }
  return undefined;
}

/**
 * The shape scan a single-equation answer gets: the shared failure detector on
 * a synthesized `Result:` line, plus the `infinity` arm that is specific to
 * solutions.
 *
 * `infinity` is here and not in detectFailure because it is not a failure in
 * general — `integrate(1/x^2, x, 0, 1)` correctly diverges — but no SOLUTION of
 * an ODE is infinity. The solution-vector guard has had this arm all along; the
 * single-equation path did not, so an inconsistent BVP shipped "infinity" as
 * the answer at isError:false: `desolve(y''=-y, y(pi/2)=1, y'(0)=0)`, which
 * looks ordinary and is in fact unsatisfiable.
 *
 * Per BRANCH, not over the whole print. Giac answers `2*y*y'=1` with three
 * branches of which the first is `infinity`; scanning the text refused the
 * request and threw away the two correct +/-sqrt(x-c_1) branches with it. Only
 * an answer whose every branch is non-finite is no answer.
 */
function singleEquationFailure(resultText: string): string | null {
  const branches = splitTopLevel(stripEnclosingBrackets(resultText), ',');
  const everyBranchInfinite =
    resultText.length > 0 && branches.every((b) => /(^|\W)infinity(\W|$)/.test(b));
  return (
    detectFailure(`Result: ${resultText}`) ?? (everyBranchInfinite ? 'non-finite result' : null)
  );
}

function solutionVectorGuard(
  response: EvaluatedResponse,
  hasConditions: boolean
): ReturnType<typeof formatErrorResponse> | undefined {
  // `undef` as a whole token is what fixes the observed case: matching it as
  // a substring refused `[y'=k_undefined*z, z'=-y]`, which Giac solves
  // correctly, because the coefficient's NAME contains it.
  //
  // Reading only the Result line is defence in depth, not that fix — the
  // other two sentinels carry punctuation (`poly1[`, `ilaplace(`) so a bare
  // coefficient named `ilaplace_k` does not trip them either. It is here
  // because the `Command:` line echoes caller text and a sentinel added
  // later may not be as punctuated.
  // The typed value, not a scrape of the rendered block. evalWithLatex returns
  // `result` for exactly this, and it exists because this file used to read its
  // own `Verified: ✗` glyph back out of the display. A `^Result:(.*)$` scrape
  // also stops at the first newline, and a truncated answer handed to the
  // substituter would be a manufactured residual — a manufactured
  // disproof, which is the one thing this check must never produce.
  const result = response.result.trim();
  // The shared detector decides the three checks it already owns — an empty
  // result, a GIAC_ERROR, and a non-finite token — and this path adds only
  // what is specific to a solution VECTOR. Re-deriving them here had let the
  // two drift: `detectFailure` token-matches `NaN`, `Inf` and `-Inf`, and this
  // copy did not, so a non-finite component would have shipped as a solution.
  //
  // It is given a synthesized `Result:` line rather than the whole response,
  // which is what keeps an earlier fix: the `Command:` line echoes the
  // caller's own text, so scanning the full response refused
  // `[y'=k_undefined*z, z'=-y]` for a coefficient's NAME.
  //
  // `infinity` stays local. It is not a failure in general — `integrate(1/x^2,
  // x, 0, 1)` correctly diverges to `+infinity` and detectFailure is right to
  // pass it — but neither an infinite COMPONENT of a solution vector nor an
  // `integrate(…,x,0,+infinity)` the engine never evaluated is a solution.
  // Token-matched so a coefficient named `infinity_k` is not caught by its own
  // name.
  //
  // Reached by `[y'=z, z'=-y+x^x]`, which answers `[[infinity,infinity]]`, and
  // by four forcing terms that come back with an unevaluated
  // `integrate(…,x,0,+infinity)`: exp(exp(x)), Gamma(x), log(x)^2,
  // exp(x)*sin(exp(x)). The pole rule cannot refuse any of them — `denom(x^x)`
  // does not mention x, and none is tan/cotan/tanh — so this arm is the only
  // guard on that answer. An earlier version of this comment called the arm
  // unreachable; `x^x` was the counterexample, and the row named
  // 'refuses an infinite solution component' in handler-seam.test.ts pins it.
  //
  // `ilaplace(` has never been observed without `poly1[` beside it — over 120
  // random matrices and every shape tried here — so no input discriminates
  // that arm and no test can pin it. Recorded so the next reader does not go
  // looking for the test that is missing.
  const unfinished =
    detectFailure(`Result: ${result}`) !== null ||
    /poly1\[|ilaplace\(/.test(result) ||
    /(^|\W)infinity(\W|$)/.test(result);
  // Reachable again. This branch was removed when verifyOdeSystem could only
  // say ✓ or nothing; it can now prove failure for an exact system, and a
  // disproved answer must not ship — `[y'=z, z'=-y+sqrt(x)]` was going out as
  // the homogeneous solution with success:true.
  //
  // Read from the value, not from the rendered glyph. Testing for `Verified: ✗`
  // coupled this guard to a display character: renaming the label or
  // reordering the formatter would have stopped it firing silently.
  const disproved = response.verification?.verified === false;
  if (unfinished || disproved) {
    // The initial-condition hint only when there were any: a 10-equation
    // cycle with none was being told to check conditions it never supplied.
    if (disproved && !unfinished) {
      return formatErrorResponse(
        'solve_ode cannot solve this system — the CAS returned an answer that ' +
          'does not satisfy it'
      );
    }
    const hint = hasConditions ? '; check the initial conditions' : '';
    return formatErrorResponse(
      `solve_ode cannot solve this system — the CAS could not finish it${hint}`
    );
  }
  return undefined;
}

/**
 * A differentiate, integrate or taylor answer that carries the engine's failure
 * markers is refused rather than shipped.
 *
 * Giac does not reject a malformed expression inside a call, it answers it:
 * `diff(x+, x)` is `[undef,x]`. The input checks catch the shapes measured, and
 * this catches the marker whatever input puts it there — on the typed result,
 * not the rendered block, whose `Command:` line echoes the caller's text.
 */
function unfinishedAnswerGuard(
  operation: string,
  result: string
): ReturnType<typeof formatErrorResponse> | undefined {
  const failure = detectFailure(`Result: ${result.trim()}`);
  if (failure === null) return undefined;
  return formatErrorResponse(
    `${operation} cannot answer this — the CAS returned ${excerpt(result.trim(), 60)} ` +
      `(${failure}); check the expression for a missing operand or argument`
  );
}

async function singleEquationGuard(
  response: EvaluatedResponse,
  args: Record<string, unknown>
): Promise<ReturnType<typeof formatErrorResponse> | undefined> {
  // The single-equation path has no solution VECTOR to check, but it can still
  // be handed something that is visibly not an answer, and it had no guard at
  // all: `desolve(y'=y, y(0)=1, y(1)=2, x, y)` — over-determined — shipped
  // `Result: []` as the answer with isError:false, and so did a condition on a
  // function the equation never mentions.
  //
  // Only reachable since conditions written as separate arguments stopped being
  // dropped. Dropping them meant Giac was never asked an unsatisfiable
  // question, so fixing that drop is what made this path able to produce `[]`.
  //
  // Same delegation as the solution-vector guard, and the same synthesized
  // `Result:` line
  // for the same reason: the `Command:` line echoes the caller's own text, so
  // scanning the whole response would refuse an equation for a coefficient's
  // name.
  const resultText = response.result.trim();
  const failure = singleEquationFailure(resultText);
  if (failure !== null) {
    // The IVP diagnosis only where the caller actually wrote conditions —
    // `equation` differs from `original_equation` exactly when some were folded
    // in. Unconditionally, it told callers of `desolve(y'=log(y), x, y)`, who
    // supplied none, that their conditions could not all be satisfied, and sent
    // them looking in the wrong place for a Giac limitation.
    const foldedConditions = args.equation !== args.original_equation;
    let why: string;
    if (failure === 'empty result' && foldedConditions) {
      why =
        'the CAS returned no solution, which for an initial-value problem ' +
        'usually means the conditions cannot all be satisfied';
    } else if (failure === 'empty result') {
      why = 'the CAS returned no solution for this equation';
    } else {
      why = `the CAS returned ${failure}`;
    }
    return formatErrorResponse(`solve_ode cannot solve this equation — ${why}`);
  }
  // The residual check, and the reason the guards above are not the defence.
  // Each of them scans the ANSWER's shape for a sentinel, so each has to
  // predict what a wrong answer looks like. Three rounds of syntactic guards
  // on the condition arguments closed the reported spelling and left the field
  // next door — `y(x)=5`, then `y(x+0)=5`, then `y(0)=x^2` — because an
  // argument Giac reads as a second equation produces an answer that looks
  // entirely ordinary. This asks the only question that settles it: does the
  // thing about to be shipped solve the equation the caller wrote.
  //
  // Refuses on a DISPROOF only. verifyOdeSolution returns no verdict when it
  // cannot substitute, when the answer is too large to hand back, or when a
  // nonzero residual does not survive numeric evaluation — and "I did not
  // check" must not become an accusation.
  //
  // This fires, and on families nothing else covers. An earlier version of
  // this note claimed no input reached it — false, and expensively so: the
  // argument guard in extractOde scans the trailing ARGUMENTS, so a condition
  // written inside the equation walks straight past it. Both spellings reach
  // here and are refused, where main answers each with a non-solution:
  //
  //   desolve(y'=y and y(x)=5, x, y)      residual -5
  //   desolve([y'=y, y(x)=5], x, y)       residual -5
  //   desolve(y'=y and y(0)=x^2, x, y)    residual 2*x*exp(x)
  //   desolve([y'=y, y(0)=x^2], x, y)     residual 2*x*exp(x)
  //
  // Believing that note is why the reachable path went untested, and that is
  // how a version of the verifier that refused `y'=y and(y(0)=1)` — a correct
  // answer, Giac's own syntax — shipped unnoticed.
  //
  // The argument guard stays in front of it for the arguments it does cover:
  // no round-trip, and it can name the offending argument, which a residual
  // cannot.
  //
  // The CONDITIONS reach it as a second argument, from `args.equation` — the
  // command the handler was given to run, `(y'=y) and (y(0)=1)` where the
  // caller wrote `desolve(y'=y, y(0)=1, x, y)`. Neither text alone carries
  // both halves: `original_equation` is deliberately the caller's own words,
  // so the residual cannot be checked against a fold that mangled the
  // equation, and the conditions the fold added exist only in the built
  // command. Handing over both, rather than re-deriving the conditions here,
  // is the same choice the system path makes with `system.condition`: two
  // independent computations over one string can disagree, and this handler
  // already paid for that once by re-parsing the caller's argument to recover
  // a boolean.
  //
  // That last argument used to be inert — the path read only
  // `verified === false`, and a missed condition never produces one (see
  // everyConditionHolds for why no sound disproof of a condition is
  // available) — and the paragraph here said so. It is live now: the verdict
  // it feeds is the same one the `Verified:` line renders, so a condition the
  // answer misses withdraws the mark from a line that exists.
  //
  // Two mutations, two different referents, measured separately on the wired
  // version:
  //
  //   delete the argument at the call site
  //     (in buildVerifyCallback's callback)      -> 1 row fails — the handler
  //     row asserting the mark says "and meets the conditions"
  //   make the FUNCTION ignore the parameter
  //     (checkConditions handed equation instead
  //      of conditionSource ?? equation)         -> 17 rows fail
  //
  // The wiring and the semantics are each pinned; the numbers are close enough
  // that reading one as the other would mislead, which is why both are here.
  //
  // Displaying the verdict was the follow-up this comment used to record, and
  // it is done: the verify callback above computes it before the guards run
  // only for answers the sentinels accept, and this branch reads it from
  // `response.verification` instead of recomputing it.
  const original = args.original_equation;
  if (typeof original === 'string' && original.length > 0) {
    const verdict = response.verification;
    if (verdict?.verified === false) {
      return formatErrorResponse(`solve_ode cannot solve this equation — ${verdict.detail}`);
    }
  }
  // Fail-closed where the extractor changed the caller's text (readSingleOde
  // reordered the members or rewrote `y'(x)`): the answer ships only with a
  // verified substitution. Everywhere else this path refuses on a DISPROOF
  // only, and that is how eleven answers to rewritten text shipped wrong —
  // each with no Verified line at all, because the residual check proved the
  // member Giac solved and had no verdict on the rest. The cost is stated:
  // `y(0)=y'(0), y'=y` is answered correctly but cannot be verified, so it is
  // refused.
  if (args.single_ode_rewritten === true && response.verification?.verified !== true) {
    return formatErrorResponse(
      'solve_ode cannot solve this equation — its answer could not be verified by ' +
        'substitution, and an equation whose members were reordered or rewritten is ' +
        'answered only when it is'
    );
  }
  return undefined;
}

/**
 * The highest Leibniz order rewritten to primes.
 *
 * The order is caller digits, and the rewrite spells it out: with no ceiling
 * `y'=d^10000000y/dx^10000000` (31 bytes) built a ten-million-character equation
 * and took this process from 82 MB to 783 MB, and a larger order exhausts the
 * heap of the server every caller shares. Order 1000 already traps the Giac
 * worker. Hand-written ODEs stop long before 10.
 */
const MAX_LEIBNIZ_ORDER = 10;

/**
 * Why one Leibniz derivative cannot be rewritten to primes for this equation,
 * or undefined when it can.
 *
 * Every quotient must be the function being solved for, taken with respect to
 * the variable, at one well-formed order. A quotient of ANOTHER function cannot
 * be left in place: Giac reads `dx/dt` as the quotient of two constants, and the
 * residual check, which substitutes into the same text, then certified the
 * misreading — `desolve(dy/dt = -dx/dt, t, y)` answered `(c_0*dt-dx*t)/dt` with
 * "Verified: ✓" where it used to be refused.
 */
function leibnizRefusal(
  quotient: LeibnizQuotient,
  fn: string,
  variable: string
): string | undefined {
  const written = excerpt(quotient.text, 20);
  if (quotient.order !== quotient.orderBelow) {
    return `its derivative ${written} has different orders above and below the line`;
  }
  if (quotient.order < 1) return `${written} is not a derivative — its order is 0`;
  if (quotient.order > MAX_LEIBNIZ_ORDER) {
    return `its derivative ${written} is of order above ${MAX_LEIBNIZ_ORDER}, the most this solves`;
  }
  if (quotient.fn !== fn) {
    return (
      `it differentiates ${excerpt(quotient.fn, 60)}, but the function being solved ` +
      `for is ${excerpt(fn, 60)}`
    );
  }
  if (quotient.wrt !== variable) {
    return (
      `it differentiates ${excerpt(fn, 60)} with respect to ${excerpt(quotient.wrt, 60)}, ` +
      `but the variable is ${excerpt(variable, 60)}`
    );
  }
  return undefined;
}

/**
 * A single equation's Leibniz derivatives, `dy/dx` and `d^2y/dx^2`, rewritten
 * to the `y'` and `y''` Giac reads.
 *
 * Giac has no Leibniz notation. It reads `dy/dx` as the quotient of two unknowns
 * named `dy` and `dx`, so `desolve(dy/dx=y, y(0)=1, x, y)` answered `[dy/dx]`
 * with isError:false: a wrong answer presented as a result, and the residual
 * check could not catch it because the caller's own equation carried the same
 * quotient. The system path translates the notation itself (ode-system.ts);
 * this is the single-equation counterpart.
 *
 * Every quotient is checked before anything is rewritten (leibnizRefusal), and
 * both texts are rewritten, the command and `original_equation`, so the residual
 * check substitutes into the equation that was actually solved. The conditions
 * are folded into `equation`, so checking it covers both.
 */
function rewriteLeibniz(
  args: Record<string, unknown>
): { args: Record<string, unknown> } | { error: string } {
  const equation = args.equation;
  if (typeof equation !== 'string' || parseOdeSystem(equation) !== null) return { args };
  const quotients = leibnizQuotients(equation);
  // Untouched when there is no quotient, so every other spelling reaches the
  // engine exactly as before.
  if (quotients.length === 0) return { args };
  const fn = (args.function_name as string) ?? 'y';
  const variable = (args.variable as string) ?? 'x';
  const refusal = quotients
    .map((quotient) => leibnizRefusal(quotient, fn, variable))
    .find((reason) => reason !== undefined);
  if (refusal !== undefined) return { error: `solve_ode cannot solve this equation — ${refusal}` };
  const toPrimes = (text: string): string =>
    replaceLeibnizQuotients(text, (quotient) => `${quotient.fn}${"'".repeat(quotient.order)}`);
  const original = args.original_equation;
  return {
    args: {
      ...args,
      equation: toPrimes(equation),
      ...(typeof original === 'string' ? { original_equation: toPrimes(original) } : {}),
    },
  };
}

export async function calculusHandler(input: Record<string, unknown>) {
  try {
    const operation = input.operation as string;

    const paramError = validateParams(operation, input);
    if (paramError) return formatErrorResponse(paramError);

    const leibniz = operation === 'solve_ode' ? rewriteLeibniz(input) : { args: input };
    if ('error' in leibniz) return formatErrorResponse(leibniz.error);
    const { args } = leibniz;

    const exprToValidate =
      operation === 'solve_ode' ? (args.equation as string) : (args.expression as string);
    const validationError = validateExpression(exprToValidate);
    if (validationError) return formatErrorResponse(validationError.message);

    const { expr: giacExpr, functions, system } = await buildGiacExpression(operation, args);
    // From the translation, not a second parse of the caller's text. Re-running
    // unicodeToAscii, splitTopLevel and classify over the whole argument to
    // recover one boolean also made this handler depend on the parser's
    // internals rather than on what buildGiacExpression handed back — and two
    // independent computations over the same string can disagree.
    const hasConditions = system?.condition !== undefined;
    const verify = buildVerifyCallback(operation, args, system);
    // Through `notes`, not appended to the formatted content: formatToolResponse
    // owns line order and puts notes before the "The answer is" summary. Pushed
    // onto content it landed after the sentence presenting the answer, which for
    // an IVP is the only thing saying which component is which.
    const response = await evalWithLatex({
      giacExpr,
      operation,
      verify,
      ...(functions ? { notes: [`${COMPONENT_ORDER_PREFIX} ${functions.join(', ')}`] } : {}),
    });
    if (functions) {
      const refusal = solutionVectorGuard(response, hasConditions);
      if (refusal) return refusal;
    } else if (operation === 'solve_ode') {
      const refusal = await singleEquationGuard(response, args);
      if (refusal) return refusal;
    } else if (operation !== 'limit' && !response.isError) {
      const refusal = unfinishedAnswerGuard(operation, response.result);
      if (refusal) return refusal;
    }
    return response;
  } catch (error) {
    return formatErrorResponse(error instanceof Error ? error.message : String(error));
  }
}
