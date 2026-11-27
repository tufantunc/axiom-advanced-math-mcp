import { stripEnclosingBrackets } from './compute/arg-parsing.js';
import { escapeForRegExp, splitTopLevel } from './output-cleanup.js';
import { unicodeToAscii } from './unicode-normalize.js';
import { odeLiteral } from './ode-text-tokens.js';
import {
  bracketChainEnd,
  bracketsBalance,
  closingBracket,
  closingParen,
  derivativeCallBody,
  mentions,
  readOccurrences,
} from './ode-system-shape.js';

/*
 * How Giac will MISREAD a single ODE, read off the form Giac itself prints for
 * it, and the text that may not be handed to Giac to print at all.
 *
 * Split from ode-system-shape.ts, which reads the caller's text, because this
 * half reads GIAC'S text — what `quote(member)` printed — and has one caller,
 * calculus.ts's odeMisreadRefusal. It evaluates nothing and is guarded like the
 * shape half: no `async`, no engine symbol, and no import path to
 * `src/server/giac` (ode-system-shape-boundary.test.ts walks it).
 */

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

/**
 * Every application of something BUILT from `fn` in one printed operand, in
 * text order: a bracket group that is applied, where the group or what it is
 * applied to mentions `fn` — `(2*y)(x-1)`, `(y/2)(2-y)`, `(y(x))(0)`,
 * `[y](x-1)`, `(sin(y))(y)`, and `(sin(x))(y)`, which Giac evaluates as
 * sin(y), not sin(x)*y. Giac prints every applied call wrapped,
 * `(sin(y))(y)`, but a derivative call, so a call's own arguments followed by
 * a bracket — `diff(y(t),t)(0)` in `x` — are read as applied too.
 *
 * Giac's other ways to apply — composition (`@`, `@@`, `∘`) and the `apply`,
 * `map` and `of` commands — never reach this print: equationNameError
 * (ode-name-bounds.ts) refuses each of them in the caller's text before any
 * engine call, and `quote` prints the parse tree without evaluating it, so no
 * admitted spelling prints as one.
 */
function builtApplications(operand: string, fn: string): string[] {
  const found: string[] = [];
  for (const group of operand.matchAll(/[([]/g)) {
    const open = group.index;
    const close = closingBracket(operand, open);
    if (operand[close + 1] !== '(') continue;
    const end = bracketChainEnd(operand, close + 1);
    const appliedTo = operand.slice(close + 1, end < 0 ? undefined : end + 1);
    if (!mentions(operand.slice(open + 1, close), fn) && !mentions(appliedTo, fn)) continue;
    found.push(operand.slice(open, end + 1));
  }
  return found;
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
  if (!bracketsBalance(ascii) || odeLiteral(text) !== undefined) return null;
  return splitTopLevel(stripEnclosingBrackets(ascii), ',')
    .flatMap((m) => splitTopLevel(m, ';'))
    .map((m) => m.trim())
    .filter((m) => m.length > 0);
}

/**
 * What misreadPrintedOde found, worded by the caller. `inCondition` says
 * whether a condition or the equation carries it.
 */
export type OdeMisreading =
  /** `fn` applied at `argument`: not the variable (equation), not a point (condition). */
  | { kind: 'argument'; argument: string; inCondition: boolean }
  /** An application of something built from `fn`, or of something to `fn`. */
  | { kind: 'built'; expression: string; inCondition: boolean }
  /** A quoted expression that holds `fn`, which Giac leaves unread: `'y(x-1)'`. */
  | { kind: 'quoted'; expression: string; inCondition: boolean }
  /** A derivative call at a point, which Giac drops, and its primed spelling. */
  | { kind: 'derivative call'; call: string; primed: string };

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
 * Each operand is asked three questions, in order — applied off its place,
 * built, quoted — and the first answer is its finding:
 *
 *   - `argument`: the EQUATION applies `fn` at anything but exactly the
 *     variable — `y(x-1)`, `y(x/2)`, `y(0)`, `y(f(y))` — a delay, pantograph or
 *     nonlocal equation, which Giac answers as something else (`y'=y(x-1)`
 *     gave `(2*c_0+x^2-2*x)/2`); a CONDITION applies it at anything but a
 *     point (`[y'=y, y(x=0)=1]` answered 0);
 *   - `built`: something built from `fn` is applied, or something is applied
 *     to `fn` (builtApplications): `y'=sin(x)(y)` was solved as y'=sin(y);
 *   - `quoted`: a quoted expression holds `fn` (quotedWithFn):
 *     `y'=quote(y(x-1))` was solved as y'=x-1.
 *
 * The equation's finding is reported first; then a derivative call at a point,
 * `diff(y(x),x)(0)`, anywhere — Giac drops the condition, and it is read as
 * `y'(0)` for the questions above; then the first condition's finding.
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
  let inCondition: OdeMisreading | undefined;
  for (const operand of operands) {
    let read = operand;
    for (const call of derivativeCallsAtPoints(read, fn, variable).reverse()) {
      read =
        read.slice(0, call.start) + primedAt(fn, call.order, call.point) + read.slice(call.end);
    }
    const built = builtApplications(read, fn);
    const rest = built.reduce((t, b) => t.replace(b, '0'), read);
    const restOccurrences = readOccurrences(rest, fn, variable);
    const isCondition = !restOccurrences.some((o) => o.at === 'bare' || o.at === 'variable');
    // A condition is `fn` at a point, so only `other` is off its place there;
    // read outside the built applications, which are reported as built.
    const off = isCondition
      ? restOccurrences.find((o) => o.at === 'other')
      : readOccurrences(read, fn, variable).find((o) => o.at === 'point' || o.at === 'other');
    const quoted = quotedWithFn(read, fn);
    let found: OdeMisreading | undefined;
    if (off?.argument !== undefined) {
      found = { kind: 'argument', argument: off.argument, inCondition: isCondition };
    } else if (built.length > 0) {
      found = { kind: 'built', expression: built[0], inCondition: isCondition };
    } else if (quoted !== undefined) {
      found = { kind: 'quoted', expression: quoted, inCondition: isCondition };
    }
    if (found !== undefined && !isCondition) return found;
    inCondition ??= found;
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
  return inCondition;
}

/**
 * The first quoted expression in printed text that holds `fn`, or undefined.
 *
 * Giac prints `quote(e)` as `'e'`, and the name inside is no occurrence to
 * readOccurrences — a quote is not a prime, but both are `'`, and its
 * lookbehind skips a name after either. Unread, `y'=quote(y(x-1))` was solved
 * as y'=x-1. An OPENING quote follows no name, closing bracket or prime. Which `'`
 * CLOSES a quote cannot be read off the print: `quote(x'*y)` prints `'x'*y'`
 * and `quote(x)*y` prints `'x'*y`. So the expression runs to the end of its
 * bracket group, which may take in more than the quote — `quote(x)*y` is
 * refused too — and never less.
 */
function quotedWithFn(text: string, fn: string): string | undefined {
  for (const quote of text.matchAll(/(?<![\w')\]}])'/g)) {
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
