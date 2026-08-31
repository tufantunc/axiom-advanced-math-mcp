import { isPrintedZero, splitTopLevel } from './output-cleanup.js';
import { stripEnclosingBrackets } from './compute/arg-parsing.js';
import type { GiacEngineLike } from './compute/hygiene.js';
import { unicodeToAscii } from './unicode-normalize.js';

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
 * Ceiling on the equations in a system, and the largest one that can actually be
 * solved. Both caps here bound the same probe, so the looser one is unreachable:
 * the probe holds every right-hand side three times over a basis of every
 * unknown, which is quadratic in the equation count. Measured with the shortest
 * right-hand side there is (`v0'=v1`), 9 equations produce a 1,681-character
 * probe and 10 produce 2,006 — past MAX_PROBE_CHARS.
 *
 * So this is set to the largest count that can pass rather than to a rounder
 * number above it. At 10 the count check never fired, and a 10-equation system
 * was refused by the character cap instead, which blamed the caller's
 * right-hand sides for a limit their equation count had already made
 * unreachable. Nine refuses ten for the true reason.
 */
const MAX_SYSTEM_EQUATIONS = 9;

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
 * The shape of an initial condition: `y(0)=1`.
 *
 * Defined once because two places need it and they must not disagree. The form
 * is checked BEFORE the member is ever handed to the engine — it used to be
 * checked only in buildVectorCondition, 300 lines downstream, so
 * `[y'=z, z'=-y, ifactor(2^257-1)]` was EXECUTED on the shared worker for the
 * full 10s budget and then rejected as "not of the form y(0)=1". Whatever this
 * does not match is not evaluated at all.
 */
const CONDITION_FORM = /^\s*([A-Za-z_]\w*)\s*\(([^)]*)\)\s*=\s*(.+)$/;

/** One member of a bracketed ODE argument. */
type Member =
  | { kind: 'equation'; fn: string; rhs: string; order: number; wrt?: string }
  | { kind: 'condition'; text: string };

/**
 * Whether the whole string is one balanced `diff(...)` call.
 *
 * Distinguishes the equation `diff(y(x),x)=z` from the initial condition
 * `diff(y(x),x)(0)=0`, whose left side is a diff call APPLIED to a point. A
 * regex that merely looked for `diff(` treated the condition as an equation and
 * refused `[diff(y(x),x,2)=-y, y(0)=1, diff(y(x),x)(0)=0]` — a single
 * second-order ODE — as a system.
 */
function isBareDiffCall(lhs: string): boolean {
  if (!/^diff\s*\(/.test(lhs)) return false;
  let depth = 0;
  for (let i = 0; i < lhs.length; i++) {
    if (lhs[i] === '(') depth++;
    else if (lhs[i] === ')') {
      depth--;
      if (depth === 0) return i === lhs.length - 1;
    }
  }
  return false;
}

/**
 * A derivative's function, its order, and — when the notation states one — the
 * variable it is taken with respect to. `y'` states none; `dy/dt` and
 * `diff(y(t),t)` both do, and discarding it answered them in whatever variable
 * the caller passed separately.
 */
interface DerivativeTarget {
  fn: string;
  order: number;
  wrt?: string;
}

/**
 * The function a derivative is taken of AND its order, for the three spellings
 * the router accepts.
 *
 * The order is load-bearing, not decoration. An earlier version returned only the
 * name, so `y''` and `y'` both reduced to `y` and the emitted body was always the
 * first-order `Y'=A*Y` — `[y''=z, z'=-y]` was answered with the solution to
 * `[y'=z, z'=-y]`. Substituted back into the original it is not a solution, and
 * `main` returned a visibly empty `[]` for that input, so the rewrite turned a
 * useless answer into a confidently wrong one.
 */
function derivativeTarget(lhs: string): DerivativeTarget | undefined {
  const lagrange = /^([A-Za-z_]\w*)('+)$/.exec(lhs);
  // `y'` names no variable, so there is nothing to disagree with.
  if (lagrange) return { fn: lagrange[1], order: lagrange[2].length };
  const leibniz = /^d([A-Za-z_]\w*)\s*\/\s*d([A-Za-z_]\w*)$/.exec(lhs);
  if (leibniz) return { fn: leibniz[1], order: 1, wrt: leibniz[2] };
  if (isBareDiffCall(lhs)) {
    const inner = /^diff\s*\(\s*([A-Za-z_]\w*)/.exec(lhs);
    if (!inner) return undefined;
    // diff(y(x),x,2) — the optional third argument is the order.
    const order = /,\s*[A-Za-z_]\w*\s*,\s*(\d+)\s*\)$/.exec(lhs);
    const wrt = /,\s*([A-Za-z_]\w*)\s*(?:,\s*\d+\s*)?\)$/.exec(lhs);
    return {
      fn: inner[1],
      order: order ? Number(order[1]) : 1,
      ...(wrt ? { wrt: wrt[1] } : {}),
    };
  }
  return undefined;
}

function classify(member: string): Member {
  const text = member.trim();
  const eq = splitTopLevel(text, '=');
  if (eq.length < 2) return { kind: 'condition', text };
  const target = derivativeTarget(eq[0].trim());
  if (target === undefined) return { kind: 'condition', text };
  return {
    kind: 'equation',
    fn: target.fn,
    order: target.order,
    ...(target.wrt === undefined ? {} : { wrt: target.wrt }),
    rhs: eq.slice(1).join('=').trim(),
  };
}

export interface OdeSystem {
  equations: { fn: string; rhs: string; order: number; wrt?: string }[];
  conditions: string[];
}

/**
 * The system in a bracketed ODE argument, or null when it is not one.
 *
 * A bracketed list is also how initial conditions are written, so "more than one
 * member" is not the test — `[y'=2*x, y(0)=1]` is a single equation. Only
 * members whose left side is a derivative NOT applied to a point count.
 */
export function parseOdeSystem(equation: string): OdeSystem | null {
  // Normalized here because this path does NOT go through evalWithLatex, which
  // is where every other Giac call gets unicodeToAscii. Without it `y'=2·z`
  // reached the probe as typed and was refused as "not linear", while the
  // single-equation path solved the same glyph.
  equation = unicodeToAscii(equation);
  const members = splitTopLevel(stripEnclosingBrackets(equation), ',').map(classify);
  const equations = members.filter(
    (m): m is Extract<Member, { kind: 'equation' }> => m.kind === 'equation'
  );
  if (equations.length < 2) return null;
  return {
    equations: equations.map(({ fn, rhs, order, wrt }) => ({ fn, rhs, order, wrt })),
    conditions: members.filter((m) => m.kind === 'condition').map((m) => m.text),
  };
}

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
      /** True when no float is involved, so an exact residual is decisive. */
      exact: boolean;
    }
  | { error: string };

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
  // The probe expands to N x N `grad` entries, so its SIZE is quadratic in the
  // equation count while the input is linear. 25 equations — 166 characters, far
  // inside MAX_EXPRESSION_LENGTH — built a probe that fatally trapped the WASM
  // engine ("memory access out of bounds") and took the shared worker down with
  // it, which `main` did not do for the same input. Bounding the count is what
  // bounds the probe. Nine is well above any system a matrix desolve answers.
  if (system.equations.length > MAX_SYSTEM_EQUATIONS) {
    return {
      error:
        `has ${system.equations.length} equations, and at most ${MAX_SYSTEM_EQUATIONS} ` +
        'can be rewritten as a matrix',
    };
  }

  const functions = system.equations.map((e) => e.fn);
  if (new Set(functions).size !== functions.length) {
    return { error: `differentiates the same function twice: ${functions.join(', ')}` };
  }
  // A matrix system is first-order by construction. Without this the order was
  // dropped and a second-order system got the first-order answer.
  // `i` is Giac's imaginary unit, so it cannot appear in the gradient basis:
  // `grad(2*z,[i,z])` is an error, not a gradient. Without this the standard SIR
  // naming `[s'=..., i'=..., r'=...]` came back as "coefficients that could not
  // be read" with the raw engine string attached — a true refusal whose message
  // named nothing the caller could act on. Measured: `e`, `pi`, `I`, `E` and `j`
  // are all fine as basis entries, so only `i` is listed.
  if (functions.includes('i')) {
    return {
      error:
        "names a function `i`, which is the CAS's imaginary unit and cannot be " +
        'solved for — rename it (for an SIR model, `ii` or `y2`)',
    };
  }
  // Before the PROBE sees any of it, which is the first engine call this makes
  // and 139 lines ahead of the conditions scan. A right-hand side is caller text
  // too, and only its LENGTH was bounded: `10^100000` is nine characters, sailed
  // through MAX_PROBE_CHARS, and trapped the engine inside the probe — taking a
  // concurrent caller's unrelated call down with it, where main answered the same
  // input `[]` in 19ms. Third appearance of one shape: caller text reaching a
  // WASM call ahead of the guard that exists to bound it.
  for (const equation of system.equations) {
    const oversized = implausibleMagnitude(equation.rhs);
    if (oversized !== undefined) {
      return {
        error:
          `has a right-hand side of implausible magnitude (${oversized}) — ` +
          'coefficients and forcing terms are ordinary numbers',
      };
    }
  }

  const higher = system.equations.find((e) => e.order > 1);
  if (higher) {
    return {
      error:
        `differentiates ${higher.fn} ${higher.order} times, and only first-order ` +
        'systems can be rewritten as a matrix — introduce a new function for each ' +
        "derivative (y''=z becomes y'=w, w'=z)",
    };
  }
  if (!/^[A-Za-z_]\w*$/.test(variable)) {
    // It reaches two RegExp constructors below. `x)` produced "Invalid regular
    // expression: Unmatched ')'" as the user-facing message.
    return { error: `names ${JSON.stringify(variable)} as its independent variable` };
  }
  if (functions.includes(variable)) {
    return {
      error:
        `uses ${variable} as both the independent variable and an unknown ` +
        'function — name the variable explicitly, as in desolve([...], t)',
    };
  }

  // AFTER the collision check, which has to win: when the caller omits the
  // variable it is inferred from the text, and for `[dy/dx=z, dz/dx=-y]` the
  // inference picks `z`. Checked first, this guard compared x against z and
  // told the caller to "write the derivatives in z" — z being one of the
  // unknowns, that is impossible advice for a problem they never posed.
  //
  // The notation can name its own differentiation variable, and when it does it
  // is the caller's real intent. `[dy/dt=z, dz/dt=-y]` solved in x was answered
  // in x with isError:false — the t was simply dropped. `y'` names no variable,
  // so it never reaches here.
  const elsewhere = system.equations.find((e) => e.wrt !== undefined && e.wrt !== variable);
  if (elsewhere) {
    return {
      error:
        `differentiates ${elsewhere.fn} with respect to ${elsewhere.wrt}, but was ` +
        `asked to solve in ${variable} — solve in ${elsewhere.wrt}, or write the ` +
        `derivatives in ${variable}`,
    };
  }

  const zeroAll = `[${functions.map((f) => `${f}=0`).join(',')}]`;
  // `z(x)` and `z` are the same unknown. Left applied, `grad(z(x),[y,z])` is
  // [0,0] — the function is opaque to grad — so the matrix came back all zeros
  // and the system was "solved" as Y'=0, answering the constant [[c_0,c_1]].
  // That is a wrong answer, not a refusal, on a notation the single-equation
  // path accepts.
  // A derivative on the RIGHT-hand side, refused before the probe rather than
  // detected after it. Giac evaluates `y'` and `diff(z,x)` to 0 for a plain
  // symbol, so grad, subst and the residual all agree the term was never there —
  // the residual cannot be the backstop here, because the term is gone before it
  // is computed. `[y'=v, v'=-y-0.1*y', y(0)=1, v(0)=0]` therefore lost its damping
  // silently and shipped the UNDAMPED `[[cos(x),-sin(x)]]` with a check mark: the
  // mark is honest about the rewritten system, which is the wrong system. Checked
  // on the raw text, before the rewrite below, since that rewrite is what turns
  // `diff(y(x),x)` into the vanishing `diff(y,x)` spelling.
  const derivativeOnRight = new RegExp(
    `(\\b(${functions.join('|')})\\s*'|\\bdiff\\s*\\(|\\bd(${functions.join('|')})\\s*/\\s*d)`
  );
  const withDerivative = system.equations.find((e) => derivativeOnRight.test(e.rhs));
  if (withDerivative !== undefined) {
    return {
      error:
        `writes a derivative on the right-hand side of ${withDerivative.fn}' — a ` +
        "first-order system's right-hand sides may contain only the unknown " +
        "functions and the independent variable (rewrite y''=… as y'=w, w'=…)",
    };
  }

  const applied = new RegExp(`\\b(${functions.join('|')})\\s*\\(\\s*${variable}\\s*\\)`, 'g');
  const rhss = system.equations.map((e) => e.rhs.replace(applied, '$1'));
  // Anything still applied is not this system's unknown at this point — `z(t)`
  // while solving in x, or `z(x-1)`. Rewriting only `f(variable)` left those
  // opaque to grad, so the matrix came back all zeros and the system was
  // "solved" as Y'=0, answering the constant [[c_0,c_1]] with isError:false.
  // The emitted command even carried the literal nonsense `0(t)`, because subst
  // mapped z->0 inside the application and Giac evaluated it rather than erroring.
  const stillApplied = new RegExp(`\\b(${functions.join('|')})\\s*\\(`);
  const offender = rhss.find((r) => stillApplied.test(r));
  if (offender !== undefined) {
    const name = stillApplied.exec(offender)?.[1] ?? 'a function';
    return {
      error:
        `applies ${name} to an argument other than ${variable}; write it as ` +
        `${name}, or solve in the variable it is applied to`,
    };
  }
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
    return {
      error: `could not be analysed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (raw.includes('GIAC_ERROR')) {
    return { error: `has coefficients that could not be read: ${raw.slice(0, 160)}` };
  }

  const parts = splitTopLevel(stripEnclosingBrackets(raw), ',');
  if (parts.length !== 3) {
    return { error: `has coefficients that could not be read: ${raw.slice(0, 160)}` };
  }
  let [matrix, constants] = parts.map((p) => p.trim());
  const residual = parts[2].trim();
  // Numeric, not textual. Giac prints a FLOAT zero as `0.0` (and `-0.0`) whenever
  // a float survives into the right-hand side, so comparing to the string '0'
  // refused every system with a decimal coefficient — `[y'=0.5*z, z'=-1.5*y]`,
  // a damped oscillator, an SIR model — and told the caller its linear system
  // was not linear. Exact rationals (`z/2`) print as `0` and so were unaffected,
  // which is why this survived a suite full of them.
  const isZero = isPrintedZero;
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
    // The empty check is load-bearing, as it is in isZero: `Number('')` is 0, so
    // without it a malformed reply with a missing entry reads as a negligible
    // residue and the system is accepted instead of refused.
    const text = entry.trim();
    if (text.length === 0) return false;
    const value = Number(text);
    return Number.isFinite(value) && Math.abs(value) < 1e-9;
  };
  const leftover = (text: string): boolean =>
    splitTopLevel(stripEnclosingBrackets(text), ',').some((r) => !isZero(r) && !negligible(r));
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
  // One numeric domain, but only where two domains actually collide.
  //
  // Giac mishandles a coefficient matrix that mixes a float with an exact
  // TRANSCENDENTAL: `[[0,1],[-1.5,ln(2)]]` comes back as an ordinary-looking
  // vector of functions whose residual is 2.1, not 0 — a confidently wrong
  // answer no shape guard can see. Evaluating that matrix to floats makes it
  // 7.6e-12.
  //
  // It needs BOTH. Applying it whenever a float appeared anywhere reached
  // systems with nothing to normalise and made them worse: an all-rational
  // matrix with a decimal only in the FORCING term — `[y'=z, z'=w,
  // w'=(2/7)^3*y-3*(2/7)^2*z+3*(2/7)*w+0.5]` — has a triple root at 2/7, and a
  // 12-digit float matrix splits it, so `desolve` failed outright on a system
  // that answers correctly when the matrix is left exact. Writing `1/2` for
  // `0.5` made the identical system solve, which is not a distinction a caller
  // should have to know. So: the MATRIX must hold both a float and a name.
  //
  // The engine's Digits is 12, so this costs about 11 good significant figures
  // rather than the caller's full double — better than the wrong answer it
  // replaces, and not the same thing as exact.
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
  // The second channel of caller text, guarded the same way and for the same
  // reason: the scan below EVALUATES these, so the magnitude check has to run
  // first or it is checking a worker that is already dead. `y(0)=10^100000`
  // refused with a clean, correct message while having killed the shared worker
  // on the way, and the NEXT unrelated call came back as "Giac worker exited
  // (code 1)" — collateral `main` never causes. The right-hand sides are the
  // first channel and are guarded above; an earlier version of this comment
  // claimed they did not exist, which is how they went unguarded.
  for (const condition of system.conditions) {
    if (!CONDITION_FORM.test(condition)) {
      return { error: `has a member "${condition.slice(0, 60)}" that is not of the form y(0)=1` };
    }
    const oversized = implausibleMagnitude(condition);
    if (oversized !== undefined) {
      return {
        error:
          `gives an initial condition of implausible magnitude (${oversized}) — ` +
          'initial conditions are ordinary numbers',
      };
    }
  }

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
    const flat = (text: string) => text.trim().replace(/\s+/g, '');
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
  // Asked separately, and only after the magnitude guard above. Folded into the
  // same `Promise.all`, a failure on this one — the only member built from caller
  // text — silently cleared the matrix and forcing flags too, reopening the
  // unscanned-float hole and skipping the normalisation that prevents the
  // mixed-domain wrong answer.
  if (system.conditions.length > 0) {
    try {
      const written = `[${system.conditions.join(',')}]`;
      const reply = await evaluate(`[exact(${written}),${written}]`);
      const [asExact, asWritten] = splitTopLevel(stripEnclosingBrackets(reply), ',');
      const flat = (text: string) => text.trim().replace(/\s+/g, '');
      floatInConditions = flat(asExact ?? '') !== flat(asWritten ?? '');
    } catch {
      return {
        error:
          'has initial conditions that could not be examined for decimals, so the ' +
          'accuracy bound that depends on that could not be applied',
      };
    }
  }

  // Giac mishandles a matrix mixing a float with an exact irrational:
  // `[[0,1],[-1.5,ln(2)]]` came back as an ordinary-looking vector whose
  // residual is 2.1, not 0, and evaluating that matrix to floats makes it
  // 7.6e-12. It needs BOTH: normalising whenever a float appeared reached
  // systems with nothing to normalise and made them worse, since a 12-digit
  // float matrix splits a repeated root, and an all-rational matrix with a
  // decimal only in its forcing term failed outright where `1/2` for `0.5`
  // solved it.
  // Wherever the decimal lives, the accuracy cost is the same. Measured worst
  // relative residual over three points, matrix-float against forcing-float:
  // degree 8 is 6.9e-12 / 4.4e-11, degree 10 is 1.2e-9 / 1.5e-9, degree 14 is
  // 2.6e-5 / 5.3e-5 — within a factor of three at every degree, with no plateau
  // and no cliff. A separate, looser threshold for the forcing term rested on a
  // measurement that does not reproduce, and it shipped 5.3e-5 with a check mark
  // while the other channel refused 2.5e-10 as unusable.
  const holdsFloat = floatInMatrix || floatInForcing;

  if (holdsExact && floatInMatrix) {
    try {
      const asFloat = await evaluate(`evalf(${matrix})`);
      if (!asFloat.includes('GIAC_ERROR')) matrix = asFloat.trim().replace(/\s+/g, '');
    } catch {
      // Keep the exact spelling; the answer is then checked as before.
    }
  }

  const constantEntries = splitTopLevel(stripEnclosingBrackets(constants), ',');
  const homogeneous = constantEntries.every(isZero);
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
  if (!homogeneous) {
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
      `max(${constantEntries.map((c) => `size(lvar(denom(${c})))`).join(',')})]`;
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
    const poleFunction = /\b(tan|cot|sec|csc|tanh|coth|sech|csch)\s*\(/;
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
  }
  // Cosmetic, and only for the Command line the caller sees: Giac answers
  // `A*Y+[0,0]` identically to `A*Y`. Kept so a homogeneous system does not
  // display a zero vector it never had; pinned by a test on the emitted command.
  const rhs = homogeneous ? `${matrix}*${vector}` : `${matrix}*${vector}+${constants}`;
  const body = `${vector}'=${rhs}`;

  if (system.conditions.length === 0) {
    return withinLimit(
      `desolve(${body},${variable},${vector})`,
      functions,
      0,
      matrix,
      homogeneous ? '' : constants,
      !holdsFloat
    );
  }
  // Conditions have to become one vector condition: Giac takes `Y(0)=[1,0]`, not
  // the per-function `y(0)=1, z(0)=0` the caller wrote.
  const vectorCondition = buildVectorCondition(system.conditions, functions, vector);
  if ('error' in vectorCondition) return vectorCondition;
  return withinLimit(
    `desolve([${body},${vectorCondition.text}],${variable},${vector})`,
    functions,
    vectorCondition.text.length,
    matrix,
    homogeneous ? '' : constants,
    !holdsFloat && !floatInConditions,
    vectorCondition.text
  );
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
  command: string,
  functions: string[],
  conditionChars: number,
  matrix: string,
  constants: string,
  exact: boolean,
  condition?: string
): SystemTranslation {
  if (command.length <= MAX_COMMAND_CHARS) {
    return { command, functions, matrix, constants, exact, ...(condition ? { condition } : {}) };
  }
  // Name the part that is actually large. Blaming the conditions unconditionally
  // told a caller who wrote none — `[y'=z+10^900, z'=-y]`, whose 938 characters
  // are all the engine's own expansion of the forcing term — to shorten initial
  // conditions it never supplied.
  const cause =
    conditionChars * 2 > command.length
      ? 'use shorter initial conditions'
      : 'use a shorter forcing term';
  return {
    error:
      `becomes ${command.length} characters once rewritten as a matrix, above ` +
      `the ${MAX_COMMAND_CHARS}-character limit — ${cause}`,
  };
}

/**
 * Describes a number in caller text too large to be meant, or undefined.
 *
 * The SIZE of caller text says nothing about the size of the number it denotes:
 * `10^100000` is nine characters, sits at 8% of MAX_COMMAND_CHARS, and fatally
 * traps the engine — recycling the shared worker and degrading whatever else was
 * in flight. `10^10000` does not trap but produces an 80,000-character result.
 *
 * Callers are deliberately not enumerated here. An earlier version named the one
 * channel it was written for, a later round read that as a statement of where
 * the hazard lives, and the right-hand sides went unguarded because of it.
 *
 * Large EXPONENTS only, which is the shape measured to be dangerous — a long
 * literal is MAX_COMMAND_CHARS' job, and this had no branch for one despite an
 * earlier version of this text claiming otherwise. A parenthesised exponent is
 * caught (`10^(50000+50000)` refuses on its first operand), a symbolic one is
 * not, and this is a bound on an observed shape rather than a proof about
 * magnitude in general.
 */
function implausibleMagnitude(text: string): string | undefined {
  // Every `^`, not only the ones whose exponent is a readable literal. Reading a
  // digit run after `^` cannot bound a NESTED exponent: `10^(10^5)` captures "10"
  // and "5" and passed, and it is the same 10^100000 this guard exists to stop —
  // it crashed the shared worker in the conditions scan, where main answers
  // harmlessly. An exponent that is not a small literal is not ordinary-number
  // input either, so anything this cannot read is refused rather than passed.
  for (const power of text.matchAll(/\^\s*\(?\s*([^),\s]+)/g)) {
    const exponent = power[1];
    if (/^\d+$/.test(exponent) && Number(exponent) > 1_000) {
      return `an exponent of ${exponent}`;
    }
    // A NESTED exponent, which reading a digit run cannot bound: `10^(10^5)` was
    // captured as "10" and "5" and passed, and it is the same 10^100000 this
    // exists to stop — it crashed the shared worker in the conditions scan, where
    // main answers harmlessly. Only `^` inside the exponent is refused, not every
    // exponent this cannot read: `2^(1/3)` and `x^(1/2)` are ordinary exact
    // constants and refusing them was a regression of its own.
    if (exponent.includes('^')) {
      return `a nested exponent (${exponent.slice(0, 20)})`;
    }
  }
  return undefined;
}

/**
 * Turns per-function initial conditions into the single vector condition Giac
 * takes for a system. Every function must be given a value at the same point —
 * a partially specified system has no unique solution to name, and Giac would
 * silently ignore the extra conditions rather than reject them.
 */
function buildVectorCondition(
  conditions: string[],
  functions: string[],
  vector: string
): { text: string } | { error: string } {
  const values = new Map<string, string>();
  let point = '0';
  for (const condition of conditions) {
    const parsed = CONDITION_FORM.exec(condition);
    if (!parsed) return { error: `initial condition "${condition}" is not of the form y(0)=1` };
    const [, fn, at, value] = parsed;
    if (!functions.includes(fn)) {
      return {
        error: `initial condition "${condition}" names ${fn}, which the system does not solve for`,
      };
    }
    const existing = values.get(fn);
    if (existing !== undefined && existing !== value.trim()) {
      return {
        error:
          `gives ${fn} two different initial conditions (${existing} and ` +
          `${value.trim()}) — the last one silently won`,
      };
    }
    if (values.size > 0 && point !== at.trim()) {
      return { error: 'gives its initial conditions at different points' };
    }
    point = at.trim();
    values.set(fn, value.trim());
  }
  const missing = functions.filter((f) => !values.has(f));
  if (missing.length > 0) {
    return {
      error:
        `has initial conditions for some functions but not ${missing.join(', ')} — ` +
        'a system needs a value for every function, or none',
    };
  }
  return { text: `${vector}(${point})=[${functions.map((f) => values.get(f)).join(',')}]` };
}
