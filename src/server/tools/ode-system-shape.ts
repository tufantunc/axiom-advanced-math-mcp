import { stripEnclosingBrackets } from './compute/arg-parsing.js';
import { nestingDepth, splitTopLevel } from './output-cleanup.js';
import { unicodeToAscii } from './unicode-normalize.js';

/**
 * Reading an ODE system, and everything decidable about it from the text alone.
 *
 * Separated from the half that talks to the CAS because "no caller text reaches
 * the engine unchecked" should be a property of the module graph rather than a
 * claim in a comment. It was a claim once, and a wrong one — a note asserting
 * the conditions were the only caller text reaching an engine call is why the
 * equation right-hand sides went unguarded for a whole review round.
 *
 * The invariant is that nothing here EVALUATES anything, and it is checkable
 * rather than asserted. Three mechanisms, and the prose claims only what they
 * cover:
 *
 *   - No `async` and no `await` in this file, and no engine symbol named in it.
 *     Both are text assertions in ode-system-shape-boundary.test.ts.
 *   - No path from this file, or from any of the three leaf modules it imports, to
 *     `src/server/giac`. That is the real invariant, and only a walk of the import
 *     closure can state it — the same test does that walk, per guarded file.
 *   - An oxlint no-restricted-imports rule in .oxlintrc.json, which is a DENYLIST
 *     of specifier texts and is therefore not the guarantee. It exists to fail fast,
 *     in the editor, on the imports someone is most likely to reach for. Of the 60
 *     modules under src/server/tools, 30 reach the CAS transitively and the rule
 *     names 4 of them, so 26 are unblocked. The closure walk is what catches those.
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
 * Ceiling on a single initial condition, as written by the caller.
 *
 * Its own number rather than MAX_COMMAND_CHARS in ode-system.ts, which is
 * measured for the finished command: the two bound different text
 * against different limits, and borrowing one for the other hides the
 * measurement.
 *
 * Sized from the WORST shape, not the cheapest. A flat product survives to 994
 * characters, but the same call on `y(0)=9/9/9/…` answers at 566 and traps at
 * 606, and on `y(0)=1!!!…` at 726 — so a bound justified by the product would
 * have carried a third of the headroom it claimed. 280 keeps a factor of two
 * below the worst measured, and costs nothing: a real initial condition is a
 * number and rarely passes thirty characters.
 *
 * This bound is also the ONLY thing guarding the channel. The factorial shape
 * does not throw — `exact([y(0)=1!!!…])` RETURNS a normal-looking answer and
 * leaves the worker dead — so nothing downstream notices: `isFatalWasmTrap` is
 * never consulted, and the try/catch around the call never runs.
 */
const MAX_CONDITION_CHARS = 280;

/**
 * Ceiling on how deeply a single initial condition may nest.
 *
 * Its own number for the same reason the one above is: MAX_ENGINE_DEPTH is
 * measured for handing a RESULT back to `latex(...)`, and borrowing it here
 * would be the mistake the length bound was just corrected for. Measured on
 * `exact([y(0)=sqrt(1+…),z(0)=0])`, function nesting is refused gracefully at
 * depth 100, burns the whole per-call budget at 200, and kills the worker at
 * 400. Grouping parentheses are harmless past 600, so this refuses a little more
 * than it must — one number cannot tell the two apart, and the conservative end
 * is the one that does not take the worker down.
 */
const MAX_CONDITION_DEPTH = 100;

/**
 * The shape of an initial condition: `y(0)=1`.
 *
 * Defined once because two places need it and they must not disagree. The form
 * is checked BEFORE the member is ever handed to the engine — it used to be
 * checked only while assembling the vector condition, over in ode-system.ts, so
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
 * Giac's spellings of the derivative operator.
 *
 * One list, because two places need it and they disagreed: derivativeOnRight
 * already recorded that "listing only `diff` missed `derive` and `deriver`, Giac's
 * own aliases for it", while isBareDiffCall below listed only `diff`. So
 * isDerivativeEquation — which reads through derivativeTarget to isBareDiffCall —
 * did not recognise `derive(z)=5`, and 57 arguments that had been refused by name
 * were folded in as conditions instead and reported as an unsatisfiable
 * initial-value problem.
 */
const DERIVATIVE_CALL = /^(diff|derive|deriver)\s*\(/;

/**
 * Whether the whole string is one balanced derivative call.
 *
 * Distinguishes the equation `diff(y(x),x)=z` from the initial condition
 * `diff(y(x),x)(0)=0`, whose left side is a diff call APPLIED to a point. A
 * regex that merely looked for `diff(` treated the condition as an equation and
 * refused `[diff(y(x),x,2)=-y, y(0)=1, diff(y(x),x)(0)=0]` — a single
 * second-order ODE — as a system.
 */
function isBareDiffCall(lhs: string): boolean {
  if (!DERIVATIVE_CALL.test(lhs)) return false;
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
    const inner = /^(?:diff|derive|deriver)\s*\(\s*([A-Za-z_]\w*)/.exec(lhs);
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

/**
 * The function a SINGLE equation differentiates, for every spelling the router
 * accepts — `y'`, `dy/dx`, and `diff(y(x),x)`.
 *
 * Exported so the extractor and this file cannot disagree about it. They did:
 * the extractor had its own reader that knew two of the three, so for the
 * `diff(y(x),x)` spelling prompts/index.ts advertises it returned undefined, and
 * every rule keyed on "the equation differentiates something else" silently
 * stopped applying — an unknowns list naming functions the equation never
 * mentions was accepted and dropped, which is the defect those rules exist to
 * prevent.
 *
 * derivativeTarget alone is not enough: it is anchored, so it reads `y''` but not
 * the `y''+y` of `y''+y=0`. The unanchored scans are the fallback for that, and
 * they run on the whole equation because a normalised left side is not
 * guaranteed here.
 */
export function differentiatedFunction(equation: string): string | undefined {
  const eq = unicodeToAscii(equation).trim();
  const sides = splitTopLevel(eq, '=');
  const target = derivativeTarget((sides[0] ?? eq).trim());
  if (target) return target.fn;
  const lagrange = /\b([A-Za-z_]\w*)'/.exec(eq);
  if (lagrange) return lagrange[1];
  const leibniz = /\bd([A-Za-z_]\w*)\s*\/\s*d[A-Za-z_]/.exec(eq);
  if (leibniz) return leibniz[1];
  return /\bdiff\s*\(\s*([A-Za-z_]\w*)/.exec(eq)?.[1];
}

/**
 * Whether a bracketed member is an EQUATION rather than a condition.
 *
 * The same test classify() applies — derivativeTarget on the left side — so the
 * extractor and this file cannot disagree about which members are equations.
 *
 * This replaced two weaker mechanisms in the extractor: a list of
 * derivative-operator NAMES, which had to be kept in step with derivativeTarget
 * by hand and was not, and a before/after comparison of the parsed equation set,
 * which measured zero rejections on every corpus tried. The reason to prefer this
 * one is provable rather than anecdotal: it IS classify()'s equation test, so
 * folding a member it calls a condition can never add an equation and can never
 * change what parseOdeSystem reads — checked by brute force over member
 * spellings, and the fold changed the parsed equation set on none of them.
 *
 * What it cannot do is predict GIAC. `y'(x)=0` is a condition to classify() and
 * an equation to Giac. The extractor narrows that gap by refusing a condition
 * whose point MENTIONS the independent variable — a syntactic proxy for Giac's
 * reading, not a proof of it. Endpoints that do not mention the variable, symbolic
 * ones included, still fold.
 *
 * `y'(0)=0` is a condition and must stay one: derivativeTarget is anchored, so
 * `y'(0)` is not a derivative target while `y'` is. That is the whole distinction,
 * and it is why the prime cannot be the discriminator.
 */
export function isDerivativeEquation(member: string): boolean {
  const sides = splitTopLevel(unicodeToAscii(member).trim(), '=');
  if (sides.length < 2) return false;
  return derivativeTarget((sides[0] ?? '').trim()) !== undefined;
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
 * Everything decidable from the text alone, before any engine call.
 *
 * Extracted so that "no caller text reaches the engine unchecked" is the call
 * order rather than a claim in a comment. It was a claim, and it was wrong: a
 * comment asserting the conditions were the only caller text reaching an engine
 * call is why the right-hand sides went unguarded for a round, and the four
 * condition checks below used to run AFTER five round trips that a bad
 * condition made pointless.
 *
 * Contains no `await`, which is what makes the boundary safe to move.
 */
export function validateSystemShape(
  system: OdeSystem,
  variable: string
):
  | {
      functions: string[];
      rhss: string[];
      /** Present exactly when the caller gave conditions; absent is "none". */
      conditions?: { point: string; values: string[] };
    }
  | { error: string } {
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
  // Before the PROBE sees any of it — the first engine call the translation makes,
  // and one this file cannot reach. A right-hand side is caller text
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
  // Name-agnostic, and every spelling of the call. Anchoring the prime to the
  // system's own unknowns missed `w'` on a name it does not solve for, and
  // listing only `diff` missed `derive` and `deriver`, Giac's own aliases for it.
  // Both reproduced the defect this guard exists to stop, verbatim.
  const derivativeOnRight =
    /\b[A-Za-z_]\w*\s*'|\b(diff|derive|deriver)\s*\(|\bd[A-Za-z_]\w*\s*\/\s*d[A-Za-z_]/;
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
  // The second channel of caller text, bounded here because this is where caller
  // text is bounded — the scan that evaluates these runs only after this function
  // returns, and this function makes no engine call at all. That used to be an
  // argument about ordering: `y(0)=10^100000` refused with a clean, correct
  // message while having killed the shared worker in the scan that produced the
  // refusal, and the next unrelated call came back as "Giac worker exited (code
  // 1)".
  //
  // SIZE is bounded here — length, depth and magnitude — and that much is a
  // property of the call graph rather than a claim. COST is not: a condition
  // value is `(.+)`, so `y(0)=ifactor(2^257-1)` is twenty-one characters, depth
  // one, and still wedges the shared worker for its whole budget. main does the
  // same, so it is not a regression — but this channel is bounded, not closed,
  // and saying otherwise is how the last four of these were missed.
  const parsedConditions: RegExpExecArray[] = [];
  for (const condition of system.conditions) {
    // Matched once, and the match is what readConditions consumes. Checking the
    // form here and then again there left a second refusal in readConditions
    // that nothing can reach, wording the same problem differently — so an edit
    // to the sentence a caller sees would have left the unreachable copy quietly
    // disagreeing.
    const parsed = CONDITION_FORM.exec(condition);
    if (!parsed) {
      return { error: `has a member "${condition.slice(0, 60)}" that is not of the form y(0)=1` };
    }
    parsedConditions.push(parsed);
    // Length AND depth, both bounded here because the conditions reach an engine
    // call with nothing else measuring them: MAX_PROBE_CHARS and MAX_COMMAND_CHARS,
    // both in ode-system.ts, bound the probe and the finished command and run only
    // after this function has returned.
    //
    // Two shapes, because they trap differently and neither bound catches the
    // other. Measured on `exact([y(0)=1*2*2*…,z(0)=0])`, a FLAT condition answers
    // at 1,015 characters and traps at 1,415, killing the worker; further up it
    // exhausts the JS stack instead, which left the worker running and corrupted
    // rather than recycled. A NESTED one traps at 2,415 characters — inside any
    // length bound that would allow the flat case — which is why depth is
    // measured separately.
    if (condition.length > MAX_CONDITION_CHARS) {
      return {
        error:
          `gives an initial condition of ${condition.length} characters, above the ` +
          `${MAX_CONDITION_CHARS} this tool accepts`,
      };
    }
    if (nestingDepth(condition) > MAX_CONDITION_DEPTH) {
      return {
        error:
          `gives an initial condition nested ${nestingDepth(condition)} deep, above ` +
          `the ${MAX_CONDITION_DEPTH} this tool accepts`,
      };
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

  if (parsedConditions.length === 0) return { functions, rhss };
  const read = readConditions(parsedConditions, functions);
  if ('error' in read) return read;
  return { functions, rhss, conditions: read };
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
  // The exponent TOKEN, not the rest of the term. `[^),\\s]+` ran past the end of
  // the exponent, so `x^2+x^3` captured "2+x^3", saw a `^` in it and refused an
  // ordinary polynomial — and the verdict flipped on a space, since `x^2 + x^3`
  // captured just "2". The bare form is a digit run; the parenthesised form is
  // the balanced group, which is what a nested exponent hides inside.
  for (const power of text.matchAll(/\^\s*(\()?/g)) {
    const at = (power.index ?? 0) + power[0].length;
    let exponent: string;
    if (power[1] === undefined) {
      exponent = /^\d*/.exec(text.slice(at))?.[0] ?? '';
    } else {
      let depth = 1;
      let i = at;
      for (; i < text.length && depth > 0; i += 1) {
        if (text[i] === '(') depth += 1;
        else if (text[i] === ')') depth -= 1;
      }
      exponent = text.slice(at, i - 1);
    }
    if (/^\d+$/.test(exponent.trim()) && Number(exponent.trim()) > 1_000) {
      return `an exponent of ${exponent.trim()}`;
    }
    // A NESTED exponent, which reading a digit run cannot bound: `10^(10^5)` was
    // captured as "10" and "5" and passed, and it is the same 10^100000 this
    // exists to stop. `+` and `-` count too — `10^(50000+50000)` is the example
    // an earlier version of this comment wrongly claimed was already caught.
    if (/[\^+-]/.test(exponent) && !/^\s*-?\d+\s*$/.test(exponent)) {
      const digits = exponent.match(/\d+/g) ?? [];
      if (exponent.includes('^') || digits.some((d) => Number(d) > 1_000)) {
        return `an exponent this cannot bound (${exponent.slice(0, 20)})`;
      }
    }
  }
  return undefined;
}

/**
 * Reads and cross-checks the per-function initial conditions.
 *
 * Every function must have a value and every value the same point; the vector
 * text Giac takes is assembled separately, once the vector symbol is known. Every function must be given a value at the same point —
 * a partially specified system has no unique solution to name, and Giac would
 * silently ignore the extra conditions rather than reject them.
 */
function readConditions(
  parsedConditions: RegExpExecArray[],
  functions: string[]
): { point: string; values: string[] } | { error: string } {
  const values = new Map<string, string>();
  let point = '0';
  for (const parsed of parsedConditions) {
    const [condition, fn, at, value] = parsed;
    if (!functions.includes(fn)) {
      return {
        error: `names ${fn} in an initial condition ("${condition}"), which it does not solve for`,
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
  // `string[]`, not the Map: this is the line that proves every function has a
  // value, so it is the line that should hand back something which cannot be
  // missing one. Returning the Map left `.get()` optional at the far end and made
  // "never call this without conditions" an unwritten rule enforced by a
  // different predicate in a different function — the emitted command would have
  // been `Y(0)=[undefined,undefined]`.
  return { point, values: functions.map((f) => values.get(f) as string) };
}
