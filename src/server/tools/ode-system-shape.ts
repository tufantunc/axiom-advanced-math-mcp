import { stripEnclosingBrackets } from './compute/arg-parsing.js';
import { escapeForRegExp, excerpt, splitTopLevel } from './output-cleanup.js';
import { unicodeToAscii } from './unicode-normalize.js';
import { odeClauses } from './ode-clauses.js';
import {
  conditionBoundError,
  conditionsTogetherError,
  implausibleMagnitude,
} from './ode-condition-bounds.js';

/**
 * Reading an ODE system, and everything decidable about it from the text alone.
 *
 * Separated from the half that talks to the CAS because "no caller text reaches
 * the engine unchecked" should be a property of the module graph rather than a
 * claim in a comment. It was a claim once, and a wrong one — a note asserting
 * the conditions were the only caller text reaching an engine call is why the
 * equation right-hand sides went unguarded for a whole review round.
 *
 * The condition-bounds half of this file's former self lives in
 * ode-condition-bounds.ts, and the dependency runs one way: validateSystemShape
 * charges right-hand sides and conditions through implausibleMagnitude,
 * conditionBoundError and conditionsTogetherError imported from there, while
 * that module imports no symbol from here. That module is guarded by the same
 * three mechanisms as this one and states them in its own header.
 *
 * The invariant is that nothing here EVALUATES anything, and it is checkable
 * rather than asserted. Three mechanisms, and the prose claims only what they
 * cover:
 *
 *   - No `async` and no `await` in this file, and no engine symbol named in it.
 *     Both are text assertions in ode-system-shape-boundary.test.ts.
 *   - No path from this file, from the bounds module it imports, or from any of
 *     the four leaf modules either of them imports, to `src/server/giac`. That
 *     is the real invariant, and only a walk of the import closure can state
 *     it — the same test does that walk, per guarded file.
 *   - An oxlint no-restricted-imports rule in .oxlintrc.json, which is a DENYLIST
 *     of specifier texts and is therefore not the guarantee. It exists to fail fast,
 *     in the editor, on the imports someone is most likely to reach for. Of the 61
 *     modules under src/server/tools, 30 reach the CAS transitively and the rule's
 *     patterns name 4 of those 30, so 26 reachers are unblocked. The closure walk
 *     is what catches those.
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
 * Leibniz notation, `dy/dx` and `d^2y/dx^2`: the one grammar every reader of it
 * shares — derivativeTarget and differentiatedFunction here, the router's ODE
 * test, the extractor's variable inference, and the rewrite to primes in
 * calculus.ts.
 *
 * One grammar because several did not agree. When the rewrite to primes learned
 * `d^2y/dx^2` and these readers did not, `desolve(d^2z/dt^2=-z)` was read as a
 * function y of d and failed, while the same equation without the verb was read
 * as z of t — the same claim spelled two ways getting different answers.
 *
 * Groups: 1 the order above the line, 2 the function, 3 the variable, 4 the
 * order below it. Read on ASCII text: `d²y/dx²` is `d^2y/dx^2` once normalised.
 */
export const LEIBNIZ_QUOTIENT = String.raw`\bd(?:\^(\d+)\s*)?([A-Za-z_]\w*)\s*\/\s*d([A-Za-z_]\w*)(?:\^(\d+))?`;

/** One Leibniz derivative found in equation text. */
export interface LeibnizQuotient {
  /** The quotient as written, after unicodeToAscii. */
  text: string;
  fn: string;
  wrt: string;
  /** The order above the line, 1 when unwritten. */
  order: number;
  /** The order below it. Equal to `order` in any well-formed derivative. */
  orderBelow: number;
}

/** Every Leibniz derivative in `text`, left to right. */
export function leibnizQuotients(text: string): LeibnizQuotient[] {
  return [...unicodeToAscii(text).matchAll(new RegExp(LEIBNIZ_QUOTIENT, 'g'))].map((m) => ({
    text: m[0],
    fn: m[2],
    wrt: m[3],
    order: Number(m[1] ?? '1'),
    orderBelow: Number(m[4] ?? '1'),
  }));
}

/**
 * `text` after unicodeToAscii, with every Leibniz derivative replaced by
 * `replace(quotient)`. Same grammar as leibnizQuotients, so a caller that
 * validated that list rewrites exactly what it validated.
 */
export function replaceLeibnizQuotients(
  text: string,
  replace: (quotient: LeibnizQuotient) => string
): string {
  return unicodeToAscii(text).replaceAll(
    new RegExp(LEIBNIZ_QUOTIENT, 'g'),
    (whole: string, top: string | undefined, fn: string, wrt: string, below: string | undefined) =>
      replace({
        text: whole,
        fn,
        wrt,
        order: Number(top ?? '1'),
        orderBelow: Number(below ?? '1'),
      })
  );
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
  const [leibniz] = leibnizQuotients(lhs);
  if (leibniz !== undefined && leibniz.text === unicodeToAscii(lhs)) {
    // A quotient whose orders disagree (`d^2y/dx`) is no derivative this can
    // name; calculus.ts refuses it by name on the single-equation path.
    return leibniz.order === leibniz.orderBelow
      ? { fn: leibniz.fn, order: leibniz.order, wrt: leibniz.wrt }
      : undefined;
  }
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
 * accepts — `y'`, `dy/dx` (and `d^2y/dx^2`), and `diff(y(x),x)`.
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
  const [leibniz] = leibnizQuotients(eq);
  if (leibniz) return leibniz.fn;
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
 * The classified members of a bracketed ODE argument.
 *
 * Shared by parseOdeSystem and odeMemberConditions so the two cannot disagree
 * about what a member IS. They would have: parseOdeSystem returns null below the
 * two-derivative threshold, so the single-equation path needs the members of a
 * list it does not call a system, and reading them with a second splitter is how
 * this file's earlier pairs of readers came to know different spellings.
 *
 * Normalized here because this path does NOT go through evalWithLatex, which is
 * where every other Giac call gets unicodeToAscii. Without it `y'=2·z` reached
 * the probe as typed and was refused as "not linear", while the single-equation
 * path solved the same glyph.
 */
function odeMembers(equation: string): Member[] {
  return splitTopLevel(stripEnclosingBrackets(unicodeToAscii(equation)), ',').map(classify);
}

/**
 * The initial conditions written as MEMBERS of a bracketed ODE argument.
 *
 * For the path that does NOT get validateSystemShape: `[y'=2*x, y(0)=1]` is one
 * equation, parseOdeSystem returns null for it, and its condition is inside the
 * equation argument rather than beside it — so the conditions the caller wrote
 * are invisible to a guard that only looks at the trailing arguments. Measured,
 * `desolve([y'=y, y(0)=50000!], x, y)` is the comma form's request with brackets
 * and killed the shared worker exactly the same way.
 *
 * Returns members, not a verdict: whether an unbounded one is refused is the
 * caller's business, and conditionBoundError is the rule.
 */
export function odeMemberConditions(equation: string): string[] {
  return odeMembers(equation)
    .filter((m): m is Extract<Member, { kind: 'condition' }> => m.kind === 'condition')
    .map((m) => m.text)
    .filter((text) => !takesUnappliedDerivative(text));
}

/**
 * The members of a single-equation ODE argument that are the EQUATION, not one
 * of its initial conditions: everything odeMemberConditions leaves out.
 *
 * The single-equation path bounds these with implausibleEquationMagnitude, as
 * validateSystemShape bounds a system's right-hand sides. Nothing did:
 * `desolve(y'=y*10^100000, x, y)` trapped the shared Giac worker ("memory
 * access out of bounds"), where the same text inside a system is refused.
 */
export function odeEquationMembers(equation: string): string[] {
  return (
    odeMembers(equation)
      .filter((m) => m.kind === 'equation' || takesUnappliedDerivative(m.text))
      // A bare derivative on the left carries no number; its right side does.
      .map((m) => (m.kind === 'equation' ? m.rhs : m.text))
  );
}

/**
 * Whether a member classify called a condition is in fact the equation: it
 * takes a derivative that is not applied at a point.
 *
 * classify calls every member whose left side is not a bare derivative a
 * condition, which is right for a system and wrong for the one equation of a
 * single ODE: `y''+y=sin(x)+…` was charged as an initial condition, so past 280
 * characters it was refused as "an initial condition of 316 characters", where
 * `y''=-y+sin(x)+…` was solved.
 *
 * A derivative AT a point stays a condition, so every condition shape keeps the
 * condition bounds: `y'(0)=0`, `diff(y(x),x)(0)=0`, `2*y(0)=1` and the Robin
 * form `y(0)+y'(0)=1`. `y'(x)` applied at the independent VARIABLE is the
 * derivative itself, but this reads no variable: the extractor rewrites it to
 * `y'` first (readSingleOde), so it reaches here as an equation.
 * Members arrive normalised (odeMembers), so `y′` is already `y'`.
 */
function takesUnappliedDerivative(text: string): boolean {
  // Every prime of the run, then not a bracket: `y''(0)` must not match as
  // `y'` followed by a second prime.
  if (/[A-Za-z_]\w*'+(?!')(?!\s*\()/.test(text)) return true;
  if (leibnizQuotients(text).length > 0) return true;
  for (const call of text.matchAll(/\b(?:diff|derive|deriver)\s*\(/g)) {
    let depth = 0;
    for (let i = call.index + call[0].length - 1; i < text.length; i++) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')' && --depth === 0) {
        if (!/^\s*\(/.test(text.slice(i + 1))) return true;
        break;
      }
    }
  }
  return false;
}

/** Where one appearance of the solved-for function stands. */
export interface FunctionOccurrence {
  /** The primes written after the name: 0 for `y`, 2 for `y''`. */
  primes: number;
  /**
   * `bare` — `y`, `y'`, not applied; `variable` — applied at exactly the
   * independent variable, `y(x)`, `y''( x )`; `point` — applied at one argument
   * that mentions neither the variable nor the function, `y(0)`, `y'(L)`;
   * `other` — anything else: `y(x-1)`, `y(x/2)`, `y(x+0)`, `y(y(0))`,
   * `y'(x)(0)`, `y(0,1)`, an unclosed bracket.
   */
  at: 'bare' | 'variable' | 'point' | 'other';
}

/**
 * An occurrence with what it is applied at, absent only when bare: the
 * argument of a single application, `x-1` for `y(x-1)`, and the bracket
 * groups as written otherwise, `(x-1)(0)` for `y(x-1)(0)`.
 */
interface ReadOccurrence extends FunctionOccurrence {
  argument?: string;
}

/** Whether `name` appears in `text` as a whole identifier. */
function mentions(text: string, name: string): boolean {
  return new RegExp(String.raw`(?<![\w'])${escapeForRegExp(name)}(?!\w)`).test(text);
}

/** The index of the `)` closing the `(` at `open`, or -1. */
function closingParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return i;
  }
  return -1;
}

/** The index of the bracket closing the `(`, `[` or `{` at `open`, or -1. */
function closingBracket(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if ('([{'.includes(text[i])) depth++;
    else if (')]}'.includes(text[i]) && --depth === 0) return i;
  }
  return -1;
}

/** The end of the run of bracket groups that opens at `open`, or -1 if one is unclosed. */
function bracketChainEnd(text: string, open: number): number {
  let close = closingParen(text, open);
  while (close >= 0) {
    const next = /^\s*\(/.exec(text.slice(close + 1));
    if (!next) return close;
    close = closingParen(text, close + next[0].length);
  }
  return close;
}

/**
 * Every appearance of `fn` in `text`, with its primes and where it is applied
 * relative to `variable`. Read on ASCII text.
 *
 * Exported for reuse: whether `y(x-1)` is a function of the variable or a
 * delayed argument is the same question wherever an ODE's text is read.
 */
export function functionOccurrences(
  text: string,
  fn: string,
  variable: string
): FunctionOccurrence[] {
  return readOccurrences(text, fn, variable).map(({ primes, at }) => ({ primes, at }));
}

/** functionOccurrences, with each single application's argument. */
function readOccurrences(text: string, fn: string, variable: string): ReadOccurrence[] {
  const name = new RegExp(String.raw`(?<![\w'])${escapeForRegExp(fn)}(?!\w)('*)`, 'g');
  return [...text.matchAll(name)].map((m): ReadOccurrence => {
    const primes = m[1].length;
    const rest = text.slice(m.index + m[0].length);
    const open = /^\s*\(/.exec(rest);
    if (!open) return { primes, at: 'bare' };
    const start = m.index + m[0].length + open[0].length - 1;
    const close = closingParen(text, start);
    if (close < 0 || /^\s*\(/.test(text.slice(close + 1))) {
      const end = bracketChainEnd(text, start);
      return { primes, at: 'other', argument: text.slice(start, end < 0 ? undefined : end + 1) };
    }
    const arg = text.slice(start + 1, close).trim();
    if (arg === variable) return { primes, at: 'variable', argument: arg };
    const isPoint =
      arg.length > 0 &&
      splitTopLevel(arg, ',').length === 1 &&
      !mentions(arg, variable) &&
      !mentions(arg, fn);
    return { primes, at: isPoint ? 'point' : 'other', argument: arg };
  });
}

/**
 * The operands of the boolean joins in one printed member, flattened: Giac
 * prints `y'=y and y(0)=1` — and `&&`, `∧`, `and(` alike — as
 * `((y'=y) and (y(0)=1))`, and a longer chain nests, so each operand is
 * stripped of its brackets and split again.
 */
function printedOperands(member: string): string[] {
  const text = stripEnclosingBrackets(member);
  const operands: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (depth !== 0 || /\w/.test(text[i - 1] ?? ' ')) continue;
    const op = /^(?:and|or|xor)(?!\w)/.exec(text.slice(i));
    if (op === null) continue;
    operands.push(text.slice(start, i));
    start = i + op[0].length;
    i = start - 1;
  }
  operands.push(text.slice(start));
  const parts = operands.map((o) => o.trim()).filter((o) => o.length > 0);
  return parts.length === 1 ? parts : parts.flatMap(printedOperands);
}

/**
 * `diff(fn(v),v)` or `diff(fn,v)`, optionally with an order — a derivative of
 * `fn` taken with respect to the variable — as the whole body of a call.
 * Group 1 is the order.
 */
function derivativeCallBody(fn: string, variable: string): RegExp {
  const f = escapeForRegExp(fn);
  const v = escapeForRegExp(variable);
  return new RegExp(String.raw`^\s*${f}\s*(?:\(\s*${v}\s*\))?\s*,\s*${v}\s*(?:,\s*(\d+)\s*)?$`);
}

/** One `diff(y(x),x)(p)`: where it stands, its order and its point. */
interface DerivativeCallAtPoint {
  start: number;
  end: number;
  order: number;
  point: string;
}

/** Every derivative call of `fn` with respect to `variable` applied at one point. */
function derivativeCallsAtPoints(
  text: string,
  fn: string,
  variable: string
): DerivativeCallAtPoint[] {
  const body = derivativeCallBody(fn, variable);
  const found: DerivativeCallAtPoint[] = [];
  for (const call of text.matchAll(/\b(?:diff|derive|deriver)\s*\(/g)) {
    const open = call.index + call[0].length - 1;
    const close = closingParen(text, open);
    if (close < 0) continue;
    const order = body.exec(text.slice(open + 1, close));
    const at = /^\s*\(/.exec(text.slice(close + 1));
    if (order === null || at === null) continue;
    const pointOpen = close + at[0].length;
    const pointClose = closingParen(text, pointOpen);
    if (pointClose < 0) continue;
    found.push({
      start: call.index,
      end: pointClose + 1,
      order: order[1] === undefined ? 1 : Number(order[1]),
      point: text.slice(pointOpen + 1, pointClose).trim(),
    });
  }
  return found;
}

/** `fn` with `order` primes applied at `point`: `y''(0)`. */
function primedAt(fn: string, order: number, point: string): string {
  return `${fn}${"'".repeat(order)}(${point})`;
}

/** The start of the identifier ending just before `at`, or `at` if none. */
function calleeStart(text: string, at: number): number {
  const callee = /[A-Za-z_]\w*\s*$/.exec(text.slice(0, at));
  return callee === null ? at : callee.index;
}

/**
 * The operand of `@` in printed (balanced, unspaced) text that ends just
 * before `at` (left) or starts at `at` (right): a bracket group, with its
 * callee on the left, or a name or number with its primes.
 */
function compositionOperand(text: string, at: number, side: 'left' | 'right'): string {
  if (side === 'right') {
    if (text[at] === '(') return text.slice(at, closingParen(text, at) + 1);
    return /^[\w.]*'*/.exec(text.slice(at))?.[0] ?? '';
  }
  if (text[at - 1] !== ')') return /[\w.]*'*$/.exec(text.slice(0, at))?.[0] ?? '';
  let depth = 0;
  let open = at - 1;
  for (; open >= 0; open--) {
    if (text[open] === ')') depth++;
    else if (text[open] === '(' && --depth === 0) break;
  }
  return text.slice(calleeStart(text, open), at);
}

/**
 * Every application of something BUILT from `fn` in one printed operand, in
 * text order: a bracket group that is applied, where the group or what it is
 * applied to mentions `fn` — `(2*y)(x-1)`, `(y/2)(2-y)`, `(y(x))(0)`,
 * `[y](x-1)`, `(sin(y))(y)`, and `(sin(x))(y)`, which Giac evaluates as
 * sin(y), not sin(x)*y — a composition with `fn` as an operand, and apply,
 * map or of with `fn` among the arguments. Giac prints every applied call
 * wrapped, `(sin(y))(y)`, but a derivative call, so a call's own arguments
 * followed by a bracket — `diff(y(t),t)(0)` in `x` — are read as applied too.
 */
function builtApplications(operand: string, fn: string): { start: number; text: string }[] {
  const found: { start: number; text: string }[] = [];
  for (const group of operand.matchAll(/[([]/g)) {
    const open = group.index;
    const close = closingBracket(operand, open);
    if (operand[close + 1] !== '(') continue;
    const end = bracketChainEnd(operand, close + 1);
    const appliedTo = operand.slice(close + 1, end < 0 ? undefined : end + 1);
    if (!mentions(operand.slice(open + 1, close), fn) && !mentions(appliedTo, fn)) continue;
    found.push({ start: open, text: operand.slice(open, end + 1) });
  }
  for (const op of operand.matchAll(/@+/g)) {
    const left = compositionOperand(operand, op.index, 'left');
    const right = compositionOperand(operand, op.index + op[0].length, 'right');
    if (mentions(left, fn) || mentions(right, fn)) {
      found.push({ start: op.index - left.length, text: `${left}${op[0]}${right}`.trim() });
    }
  }
  for (const call of operand.matchAll(/(?:\b(?:apply|map)|'of')\(/g)) {
    const open = call.index + call[0].length - 1;
    const close = closingParen(operand, open);
    if (splitTopLevel(operand.slice(open + 1, close), ',').some((a) => mentions(a, fn))) {
      found.push({ start: call.index, text: operand.slice(call.index, close + 1) });
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

/**
 * The first string literal or comment marker in an ODE's text — `"`, `#`,
 * `//` or the opener of a block comment — or undefined.
 *
 * Every bracket count this text goes through (validateExpression's,
 * bracketsBalance's, splitTopLevel's) counts a bracket inside a string or a
 * comment, and Giac's parser does not. So `y'=y+"(")+ifactor(2^64+1)+(")"`
 * balances for all of them, while Giac closes `quote(` — and `desolve(` — at
 * the `)` after the string and evaluates what follows: the quote meant to read
 * the text without evaluating it ran ifactor. Measured the same with a block
 * comment holding `(`, and with `#` up to a newline. No equation holds any of
 * them, so the text is refused rather than lexed a second time here.
 */
export function odeLiteral(text: string): string | undefined {
  return /["#]|\/[*/]/.exec(text)?.[0];
}

/**
 * The members of a single ODE's text, each to be handed to Giac's `quote` on
 * its own: split at top-level `,` and `;` (a statement separator, which no
 * quote could hold), or null when the brackets do not balance — a member
 * with a stray `)` would close the quote early and evaluate what follows —
 * or the text holds an odeLiteral, which hides a bracket from the count.
 */
export function odeMembersToQuote(text: string): string[] | null {
  const ascii = unicodeToAscii(text);
  if (!bracketsBalance(ascii) || odeLiteral(ascii) !== undefined) return null;
  return splitTopLevel(stripEnclosingBrackets(ascii), ',')
    .flatMap((m) => splitTopLevel(m, ';'))
    .map((m) => m.trim())
    .filter((m) => m.length > 0);
}

/** What misreadPrintedOde found, worded by the caller. */
export type OdeMisreading =
  /** The equation applies `fn` at `argument`, not at the variable. */
  | { kind: 'argument'; argument: string }
  /** An application of something built from `fn`, in the equation or a condition. */
  | { kind: 'built'; expression: string; inCondition: boolean }
  /** A derivative call at a point, which Giac drops, and its primed spelling. */
  | { kind: 'derivative call'; call: string; primed: string }
  /** A condition applies `fn` at `argument`, which is not a point: `y(x=0)=1`. */
  | { kind: 'condition argument'; argument: string }
  /** A quoted expression that holds `fn`, which Giac leaves unread: `'y(x-1)'`. */
  | { kind: 'quoted'; expression: string; inCondition: boolean };

/**
 * How Giac will MISREAD a single ODE, read off the form Giac itself prints
 * for it — `quote(member)` for each of odeMembersToQuote's members — or
 * undefined when it reads the function only bare, at the variable, or (in a
 * condition) at a point.
 *
 * Read on the printed form because Giac's own parser decides whether `A(B)`
 * is a product or an application, and no reading of the caller's text kept up:
 * `y(1-y)`, `y(ln(y))` and `y(1-y)(2-y)` are products, `y(f(y))`,
 * `(y/2)(2-y)` and `2y(x-1)` applications, and four rounds of text rules
 * refused the first kind or answered the second. Printed, a product carries
 * its `*` — `y*(1-y)`, `(2*y)(x-1)` — so a name followed by a bracket IS an
 * application, and `(y')'` is `y''`.
 *
 * Seven findings, in order:
 *
 *   1. the EQUATION applies `fn` at anything but exactly the variable —
 *      `y(x-1)`, `y(x/2)`, `y(0)`, `y(f(y))` — a delay, pantograph or
 *      nonlocal equation, which Giac answers as something else
 *      (`y'=y(x-1)` gave `(2*c_0+x^2-2*x)/2`);
 *   2. the equation applies something built from `fn`, or applies something
 *      to `fn` (builtApplications): `y'=sin(x)(y)` was solved as y'=sin(y);
 *   3. the equation quotes an expression that holds `fn` (quotedWithFn):
 *      `y'=quote(y(x-1))` was solved as y'=x-1;
 *   4. a derivative call at a point, `diff(y(x),x)(0)`, anywhere — Giac drops
 *      the condition; read as `y'(0)` for 1 and 2;
 *   5. a condition applies something built from `fn`: `(2*y)(0)=1`;
 *   6. a condition applies `fn` at anything but a point: `[y'=y, y(x=0)=1]`
 *      answered 0;
 *   7. a condition quotes an expression that holds `fn`.
 *
 * An operand is the equation when, with its built applications taken out, it
 * holds `fn` bare or at the variable — its derivative prints as `y'` or
 * `diff(y(x),x)`, so it always does; every other operand is a condition,
 * where `fn` at a point is what a condition is.
 */
export function misreadPrintedOde(
  printed: string[],
  fn: string,
  variable: string
): OdeMisreading | undefined {
  const primesFolded = printed.map((p) => {
    const nested = new RegExp(String.raw`\((${escapeForRegExp(fn)}'+)\)'`, 'g');
    let read = p;
    for (let before = ''; before !== read;) {
      before = read;
      read = read.replaceAll(nested, "$1'");
    }
    return read;
  });
  const operands = primesFolded
    .flatMap((p) => splitTopLevel(stripEnclosingBrackets(p), ','))
    .flatMap(printedOperands);
  let inCondition: { start: number; text: string } | undefined;
  let conditionOff: string | undefined;
  let conditionQuote: string | undefined;
  for (const operand of operands) {
    let read = operand;
    for (const call of derivativeCallsAtPoints(read, fn, variable).reverse()) {
      read =
        read.slice(0, call.start) + primedAt(fn, call.order, call.point) + read.slice(call.end);
    }
    const built = builtApplications(read, fn);
    const rest = built.reduce((t, b) => t.replace(b.text, '0'), read);
    const restOccurrences = readOccurrences(rest, fn, variable);
    const quoted = quotedWithFn(read, fn);
    const isEquation = restOccurrences.some((o) => o.at === 'bare' || o.at === 'variable');
    if (!isEquation) {
      inCondition ??= built[0];
      conditionOff ??= restOccurrences.find((o) => o.at === 'other')?.argument;
      conditionQuote ??= quoted;
      continue;
    }
    const off = readOccurrences(read, fn, variable).find(
      (o) => o.at === 'point' || o.at === 'other'
    );
    if (off?.argument !== undefined) return { kind: 'argument', argument: off.argument };
    if (built.length > 0) return { kind: 'built', expression: built[0].text, inCondition: false };
    if (quoted !== undefined) return { kind: 'quoted', expression: quoted, inCondition: false };
  }
  for (const member of primesFolded) {
    const [call] = derivativeCallsAtPoints(member, fn, variable);
    if (call !== undefined) {
      return {
        kind: 'derivative call',
        call: member.slice(call.start, call.end),
        primed: primedAt(fn, call.order, call.point),
      };
    }
  }
  if (inCondition !== undefined) {
    return { kind: 'built', expression: inCondition.text, inCondition: true };
  }
  if (conditionOff !== undefined) return { kind: 'condition argument', argument: conditionOff };
  return conditionQuote === undefined
    ? undefined
    : { kind: 'quoted', expression: conditionQuote, inCondition: true };
}

/**
 * The first quoted expression in printed text that holds `fn`, or undefined.
 *
 * Giac prints `quote(e)` as `'e'`, and the name inside is no occurrence to
 * readOccurrences — a quote is not a prime, but both are `'`, and its
 * lookbehind skips a name after either. Unread, `y'=quote(y(x-1))` was solved
 * as y'=x-1. An OPENING quote follows no name, closing bracket or prime;
 * `'of'` is Giac's composition and builtApplications' finding. Which `'`
 * CLOSES a quote cannot be read off the print: `quote(x'*y)` prints `'x'*y'`
 * and `quote(x)*y` prints `'x'*y`. So the expression runs to the end of its
 * bracket group, which may take in more than the quote — `quote(x)*y` is
 * refused too — and never less.
 */
function quotedWithFn(text: string, fn: string): string | undefined {
  for (const quote of text.matchAll(/(?<![\w')\]}])'/g)) {
    if (text.startsWith("of'", quote.index + 1)) continue;
    let depth = 0;
    let end = quote.index + 1;
    for (; end < text.length; end++) {
      const ch = text[end];
      if ('([{'.includes(ch)) depth++;
      else if (')]}'.includes(ch) && --depth < 0) break;
    }
    const expression = text.slice(quote.index, end).trim();
    if (mentions(expression.slice(1), fn)) return expression;
  }
  return undefined;
}

/**
 * Whether every derivative CALL in `member` is `diff(fn(v),v)` or `diff(fn,v)`,
 * optionally with an order, taken with respect to the variable and not applied
 * at a point. Any other call — of another function, with respect to another
 * name, or applied, `diff(y(x),x)(0)` — is nothing this reader can classify.
 */
function derivativeCallsAreOfFn(member: string, fn: string, variable: string): boolean {
  const body = derivativeCallBody(fn, variable);
  for (const call of member.matchAll(/\b(?:diff|derive|deriver)\s*\(/g)) {
    const open = call.index + call[0].length - 1;
    const close = closingParen(member, open);
    if (close < 0 || /^\s*\(/.test(member.slice(close + 1))) return false;
    if (!body.test(member.slice(open + 1, close))) return false;
  }
  return true;
}

/** A single ODE read into its one equation and its conditions. */
export interface SingleOde {
  /** The equation, with `y'(x)` written `y'`. */
  equation: string;
  /** Every other member, exactly as typed, in the caller's order. */
  conditions: string[];
}

/**
 * A single ODE's text read into `{ equation, conditions }`, or null when this
 * cannot say with certainty which member is the equation — and null means the
 * caller passes the text through exactly as typed, which is main's behaviour.
 *
 * Two spellings came back as errors, and the first two attempts to accept them
 * shipped wrong answers. `y(0)=1, y'=y` reached desolve condition-first, and
 * Giac reads the FIRST member as the equation; `y'(x)=y(x)` Giac leaves
 * unevaluated. Rewriting `y'(x)` across the whole list turned the condition
 * `y(0)+y'(x)=3` into a second equation and shipped `3*exp(x)`; restricting
 * that to the one "equation-like" member still read a member joined with `&&`
 * as one, promoted `y(0)+y'=3` to the equation when the rewrite declined, and
 * read `y(x-1)` — a delay — as the function. Each was a test that ACCEPTED too
 * much. So this accepts only a shape it can name in full, and declines the rest:
 *
 *   1. brackets balance (a system needs two equation members, so rule 7
 *      declines one without asking parseOdeSystem);
 *   2. the members are odeClauses's: split at top-level commas and at the
 *      conjunctions Giac reads as one, `and`, `&&` and `∧`, so
 *      `y'(x)=y(x) and y(0)=1` is the same two members as the list spelling;
 *      nothing non-ASCII survives in a member;
 *   3. no member holds `&`, `|`, `;`, `<`, `>`, `!`, or and/or/xor/not — what
 *      is left of a join after the split is a join this does not read;
 *   4. every member has exactly one top-level `=`;
 *   5. every appearance of `fn` is bare, at exactly the variable, or at a point
 *      that mentions neither the variable nor `fn` (functionOccurrences) —
 *      enforced by 7 and 8, since an `other` appearance makes a member
 *      neither an equation nor a condition;
 *   6. no other identifier is primed, every Leibniz quotient is of `fn` with
 *      respect to the variable, and every derivative call is of `fn`;
 *   7. exactly one member is the EQUATION: `fn` only bare or at the variable,
 *      and at least one derivative of it;
 *   8. every other member is a CONDITION: `fn` at a point at least once and
 *      nowhere else, no derivative call or quotient, and no mention of the
 *      variable.
 *
 * Every condition is returned exactly as typed, so the condition bounds read
 * what the caller wrote. Only the equation is rewritten.
 */
export function readSingleOde(text: string, fn: string, variable: string): SingleOde | null {
  const ascii = unicodeToAscii(text);
  if (!bracketsBalance(ascii)) return null;
  let equation: string | undefined;
  const conditions: string[] = [];
  for (const member of odeClauses(ascii).map((m) => m.trim())) {
    if (/[^\x20-\x7E]/.test(member.replaceAll(/\s/g, ' '))) return null;
    if (/[&|;<>!]/.test(member) || /\b(?:and|or|xor|not)\b/i.test(member)) return null;
    if (splitTopLevel(member, '=').length !== 2) return null;
    const occurrences = functionOccurrences(member, fn, variable);
    for (const primed of member.matchAll(/(?<![\w'])([A-Za-z_]\w*)'/g)) {
      if (primed[1] !== fn) return null;
    }
    const quotients = leibnizQuotients(member);
    if (quotients.some((q) => q.fn !== fn || q.wrt !== variable)) return null;
    if (!derivativeCallsAreOfFn(member, fn, variable)) return null;
    const hasDerivativeCall = /\b(?:diff|derive|deriver)\s*\(/.test(member);
    const isEquation =
      occurrences.every((o) => o.at === 'bare' || o.at === 'variable') &&
      (occurrences.some((o) => o.primes > 0) || quotients.length > 0 || hasDerivativeCall);
    const isCondition =
      occurrences.length > 0 &&
      occurrences.every((o) => o.at === 'point') &&
      quotients.length === 0 &&
      !hasDerivativeCall &&
      !mentions(member, variable);
    if (isEquation) {
      if (equation !== undefined) return null;
      equation = member;
    } else if (isCondition) {
      conditions.push(member);
    } else {
      return null;
    }
  }
  if (equation === undefined) return null;
  const applied = new RegExp(
    String.raw`(?<![\w'])(${escapeForRegExp(fn)}'+)\s*\(\s*${escapeForRegExp(variable)}\s*\)`,
    'g'
  );
  return { equation: equation.replaceAll(applied, '$1'), conditions };
}

/**
 * The text a single ODE is solved as, and whether it differs from what the
 * caller typed: `[equation, condition, …]` when readSingleOde reads it and the
 * typed text is not already that, otherwise `text` exactly.
 *
 * Already that means the equation comes first, needs no `y'(x)` rewrite, and
 * the members are a bracketed list or one comma-free argument: `[y'=y,
 * y(0)=1]`, and `y'=y and y(0)=1`, Giac's own IVP spelling, go through as
 * typed. `y'=y, y(0)=1` unbracketed is two arguments, and is rewritten.
 *
 * `rewritten` is what calculus.ts's fail-closed gate keys on: an answer to a
 * text this changed ships only with a verified substitution.
 */
export function singleOdeText(
  text: string,
  fn: string,
  variable: string
): { text: string; rewritten: boolean } {
  const read = readSingleOde(text, fn, variable);
  if (read === null) return { text, rewritten: false };
  const ascii = unicodeToAscii(text);
  const members = odeClauses(ascii).map((m) => m.trim());
  const oneArgument = splitTopLevel(stripEnclosingBrackets(ascii), ',').length === 1;
  const unchanged =
    members[0] === read.equation &&
    (oneArgument || text.trim().startsWith('[')) &&
    members.slice(1).every((m, i) => m === read.conditions[i]);
  if (unchanged) return { text, rewritten: false };
  const solved =
    read.conditions.length === 0
      ? read.equation
      : `[${[read.equation, ...read.conditions].join(', ')}]`;
  return { text: solved, rewritten: true };
}

/** Whether every `(` and `[` in `text` closes, in order, and nothing else does. */
function bracketsBalance(text: string): boolean {
  const open: string[] = [];
  for (const ch of text) {
    if (ch === '(' || ch === '[') open.push(ch === '(' ? ')' : ']');
    else if ((ch === ')' || ch === ']') && open.pop() !== ch) return false;
  }
  return open.length === 0;
}

/**
 * The system in a bracketed ODE argument, or null when it is not one.
 *
 * A bracketed list is also how initial conditions are written, so "more than one
 * member" is not the test — `[y'=2*x, y(0)=1]` is a single equation. Only
 * members whose left side is a derivative NOT applied to a point count.
 */
export function parseOdeSystem(equation: string): OdeSystem | null {
  const members = odeMembers(equation);
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

  const applied = new RegExp(String.raw`\b(${functions.join('|')})\s*\(\s*${variable}\s*\)`, 'g');
  const rhss = system.equations.map((e) => e.rhs.replace(applied, '$1'));
  // Anything still applied is not this system's unknown at this point — `z(t)`
  // while solving in x, or `z(x-1)`. Rewriting only `f(variable)` left those
  // opaque to grad, so the matrix came back all zeros and the system was
  // "solved" as Y'=0, answering the constant [[c_0,c_1]] with isError:false.
  // The emitted command even carried the literal nonsense `0(t)`, because subst
  // mapped z->0 inside the application and Giac evaluated it rather than erroring.
  const stillApplied = new RegExp(String.raw`\b(${functions.join('|')})\s*\(`);
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
      return { error: `has a member "${excerpt(condition, 60)}" that is not of the form y(0)=1` };
    }
    parsedConditions.push(parsed);
    // Bounded here because the conditions reach an engine call with nothing else
    // measuring them: MAX_PROBE_CHARS and MAX_COMMAND_CHARS, both in
    // ode-system.ts, bound the probe and the finished command and run only after
    // this function has returned.
    const unbounded = conditionBoundError(condition);
    if (unbounded !== undefined) return { error: unbounded };
  }

  // And once more over the conditions TOGETHER — see conditionsTogetherError.
  const together = conditionsTogetherError(system.conditions);
  if (together !== undefined) return { error: together };

  if (parsedConditions.length === 0) return { functions, rhss };
  const read = readConditions(parsedConditions, functions);
  if ('error' in read) return read;
  return { functions, rhss, conditions: read };
}

/**
 * Reads and cross-checks the per-function initial conditions.
 *
 * Every function must have a value and every value the same point; the vector
 * text Giac takes is assembled separately, once the vector symbol is known. A
 * partially specified system has no unique solution to name, and Giac would
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
