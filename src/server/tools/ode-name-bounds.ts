import { GIAC_FREE_GLYPHS, GIAC_RESERVED_NAMES } from './giac-reserved-names.js';
import { excerpt } from './output-cleanup.js';
import {
  MAGNITUDE_OPERATORS,
  bareName,
  foldPrimes,
  literalReason,
  odeLiteral,
  quotedReason,
  tokenizeMagnitude,
  type MagnitudeToken,
} from './ode-text-tokens.js';
import { POWERED_FUNCTIONS } from './unicode-normalize.js';

/**
 * What ODE text may NAME when it reaches the CAS — the functions, keywords and
 * operators the engine would run — as opposed to what its numbers and powers
 * cost (ode-cost-bounds.ts) or how large they are (ode-condition-bounds.ts).
 * Two rules, one per channel:
 *
 *   - conditionCallError: an initial condition is a NUMBER, so it may call
 *     only the elementary functions and the unknowns, and a free user
 *     function is refused with the rest.
 *   - equationNameError: an EQUATION may name its own parameters and
 *     functions freely, so it is refused only what the CAS reserves —
 *     GIAC_RESERVED_NAMES, generated from the engine — beyond a measured-cheap
 *     allowlist, and the operators and glyphs no name shows.
 *
 * Text-only, like ode-cost-bounds.ts and ode-text-tokens.ts: no `async`, no
 * engine symbol, and no import path to `src/server/giac`.
 * ode-system-shape-boundary.test.ts checks all three for this file.
 *
 * Measured on main (32a9232), one input per fresh worker, 10s budget: the
 * equation calls `desolve(y'=y+0*ifactor(2^257-1), x, y)` and
 * `[y'=z+0*ifactor(2^257-1), z'=-y]`, the loops `y'=y+0*(while 1 do 1 od)`,
 * `…(for k from 1 to 10^9 do od)` and `…(repeat 1 until 0)`, and the quoted
 * `y'=y+quote(ifactor(2^257-1))` each held the worker the full 10s;
 * `y'=y+0*seq(k,k,1,10^7)`, `…(k$(k=1..10^7))` and `x$(10^7)` killed it
 * ("RuntimeError: unreachable"). On this branch's first version, which
 * admitted every non-ASCII character, `y'=y+∑(1/(k^3+2),k,1,10^4)` held it
 * 10s as `sum` (the engine reads `∑` and `Σ` as `sum`), and
 * `y'=y*((x+1)&^300)` 10s as a power the expansion bound never saw.
 */

/**
 * The derivative operator's spellings: Giac's `diff` and its aliases `derive`
 * and `deriver`. ode-system-shape.ts builds DERIVATIVE_CALL from this list, so
 * the shape reader and the condition call check cannot disagree about which
 * names are the derivative.
 */
export const DERIVATIVE_NAMES = ['diff', 'derive', 'deriver'] as const;

/**
 * What an initial condition may call besides the unknowns and the derivative:
 * Giac's elementary one-argument functions (POWERED_FUNCTIONS, the list
 * unicode-normalize.ts keeps of them), the three spellings readMagnitude
 * already bounds (`factorial`, `Gamma`, `pow`), and `round`, the rounding
 * function POWERED_FUNCTIONS lacks beside `floor` and `ceil`.
 *
 * An ALLOWLIST, because what an initial condition calls is a cost the size
 * bounds cannot see: `ifactor(2^257-1)` denotes a 78-digit number and burns
 * the budget. A DENYLIST of the number-theory names would be
 * ode-condition-bounds.ts's most-repeated defect in another form: `comb`,
 * `perm`, `ithprime`, `sum`, `fib` and every name not yet thought of would
 * each have been the next escape.
 *
 * Every name here was measured cheap on a 78-digit and a 2,863-digit argument:
 * `sqrt`, `ln`, `exp`, `sin`, `atan` and the rest answer in under 30ms in both
 * `exact([y(0)=…,z(0)=0])` and the single-equation fold. What is NOT cheap is
 * an exact ROOT of a large integer — `sqrt(3^1000+2)` times out in the fold —
 * and that is a size the height bound in ode-cost-bounds.ts refuses, because
 * the solver forms such roots itself from bare numbers.
 *
 * The cost is stated: a free user function is refused too. `y(0)=g(2)` and
 * `y(0)=myfactorial(50000)` came back symbolic and cheap, and are now refused,
 * because the text cannot tell `g` from `ifactor` and a condition is a number.
 */
const CONDITION_FUNCTIONS: ReadonlySet<string> = new Set([
  ...POWERED_FUNCTIONS,
  'factorial',
  'Gamma',
  'pow',
  'round',
]);

/** The CAS's constants an equation may name; none of them is a command. */
const CONSTANTS: ReadonlySet<string> = new Set([
  'pi',
  'Pi',
  'PI',
  'e',
  'i',
  'infinity',
  'inf',
  'oo',
  'euler_gamma',
]);

/**
 * What an EQUATION may name of the CAS's own, besides what a condition may
 * call: the step and impulse functions forcing terms are written with, the
 * remaining special functions an equation states rather than computes, the
 * derivative spellings, the constants, `and`/`AND` (the single-equation path
 * folds its conditions in with `and`), `or`, and `quote`.
 *
 * `or` because ode-clauses.ts declines an `or`-joined equation rather than
 * cutting it, with its own wording; it is a boolean, not a command. `quote`
 * because what it holds is read here like the rest of the text, and that is
 * the bound: a quote is no shelter — `desolve` evaluates what it holds — so
 * `quote(ifactor(…))` is refused for its `ifactor`. A quote of free names is
 * cheap and left to odeMisreadRefusal, which says what the quote does to y.
 *
 * Every function here was measured cheap in the places an equation puts it,
 * one input per fresh worker: as a forcing term (`y'=y+F(x)`), as a
 * coefficient (`y'=F(x)*y`), on a 140-digit constant (`y'=y+0*F(10^140+7)`),
 * and as the right side of a second-order equation on `3^140+2` — each
 * answered in under 100ms; input-bounds.test.ts times the last two shapes.
 * CONDITION_FUNCTIONS is included whole, so a condition folded into the
 * equation is never refused here for a call its own check admitted.
 *
 * An ALLOWLIST over the CAS's names, and only over them: a name the CAS does
 * not reserve (GIAC_RESERVED_NAMES) is the caller's own — `r`, `K`, `lambda`,
 * `f(x)`, `g(x)` — and is admitted, because to the CAS it is an inert symbol
 * and costs nothing. That is the difference from the condition rule, which
 * refuses `g(2)` because a condition is a number. What is refused is every
 * other name the CAS gives a meaning to: `ifactor`, `nextprime`, `ithprime`,
 * `factor`, `seq`, `sum`, `product`, `eval`, `apply`, and the loop keywords
 * `for`, `while` and `repeat`, which hold the worker with no call at all. A
 * denylist of those would have been the condition check's lesson again: the
 * next name not thought of is the next escape, and the CAS reserves 2,093
 * names besides every `_` name.
 * The cost is stated: an equation that writes `besselJ(0,x)`, `int(…)` or
 * `sum(…)` is refused and told to write the term in closed form.
 */
const EQUATION_NAMES: ReadonlySet<string> = new Set([
  ...CONDITION_FUNCTIONS,
  ...DERIVATIVE_NAMES,
  ...CONSTANTS,
  'sign',
  'Heaviside',
  'Dirac',
  'Si',
  'Ci',
  'Ei',
  'max',
  'min',
  'and',
  'AND',
  'or',
  'quote',
]);

/**
 * Giac's repeated-variable spelling of a derivative's order, `diff(y(x),x$2)`,
 * admitted where every other `$` is refused: a NAME repeated a literal number
 * of times, the counts summed over the whole text at most MAX_REPEATED_ORDER.
 * `x$100` answers in 248ms as the hundredth-order `diff(y(x),x$100)+y(x)=0`;
 * `x$(10^7)` killed the worker ("RuntimeError: unreachable"), and three
 * `x$100` in one call timed out where one answers — hence the sum. The count
 * must END the argument: `x$2^30` is `x$(2^30)` to the CAS, and `x$2*k` is
 * not read here at all.
 *
 * The ceiling is calculus.ts's MAX_CALCULUS_ORDER, restated because this file
 * imports no module that can reach the engine; giac-reserved-names.test.ts pins
 * the two equal.
 */
const REPEATED_ORDER = /([A-Za-z_]\w*)\s*\$\s*(\d+)(?=\s*(?:[),\]]|$))/g;
export const MAX_REPEATED_ORDER = 100;

/**
 * The `&&` join (and `&&&`, which the engine reads the same; ode-clauses.ts
 * steps over any run of two or more). A lone `&` is refused: `&^` and `&*` are
 * the engine's power and product, and `(x+1)&^300` is a power no cost reader
 * sees.
 */
const CONJUNCTION = /&&+/g;

/** The logical-and glyph, the one non-ASCII join the engine reads as `and`. */
const AND_GLYPH = '∧';

/**
 * Whether a character is one a number can be written with: digits, names for
 * constants and functions, the tokenizer's operators, the derivative prime and
 * the `=` that joins a condition. Anything else is an operator a number does
 * not need and a cost no reader sees: Giac's `$` builds a sequence
 * (`(2^900+k)$(k=1..10000)` is ten thousand numbers and no call), `..` is a
 * range, `:=` assigns, `@` composes, and a quoted string can name a function.
 * `**` and the typeset minus `−` never reach here; unicodeToAscii rewrites
 * them to `^` and `-`.
 */
function isNumberCharacter(character: string): boolean {
  return /[\w\s.'=]/.test(character) || MAGNITUDE_OPERATORS.includes(character);
}

/**
 * Whether a character is one an EQUATION can be written with, once its `&&`
 * joins and admitted `x$2` orders are taken out: the number characters, the
 * `∧` join, and a non-ASCII letter the engine reads as a plain symbol
 * (GIAC_FREE_GLYPHS: `λ`, `ω`). Every other character is an operator or glyph
 * an equation does not need and a cost no name shows: `$` builds a sequence,
 * `:=` and `→` assign and `;` sequences, `->` builds a function
 * (`(f->f(f))(f->f(f))` recurses forever with free names only), `@` and `∘`
 * compose and `@@` iterates, `{}` is a block, `|` substitutes, a lone `&` is
 * an elementwise operator, and `∑`, `Σ`, `∫` and `∂` are `sum`, `sum`, `int`
 * and `diff` to the engine.
 */
function isEquationCharacter(character: string): boolean {
  return isNumberCharacter(character) || character === AND_GLYPH || GIAC_FREE_GLYPHS.has(character);
}

/**
 * Why text is not written with `admits`'s characters, or undefined: a string,
 * comment or escape first, worded as odeMisreadRefusal words it over the whole
 * equation, then a stray character, then a range. `what` is what the text is
 * ("a number", "an equation"); `instead` says what to write.
 */
function unwrittenError(
  text: string,
  admits: (character: string) => boolean,
  what: string,
  instead: string
): string | undefined {
  const literal = odeLiteral(text);
  if (literal !== undefined) return literalReason(literal);
  const stray = [...text].find((character) => !admits(character));
  if (stray !== undefined)
    return `contains "${stray}", which ${what} is not written with — ${instead}`;
  if (text.includes('..')) {
    return `contains a range "..", which ${what} is not written with — ${instead}`;
  }
  return undefined;
}

/**
 * Why an initial condition's CALLS are too costly to evaluate, or undefined.
 * `condition` is normalised text; the phrase continues "cannot solve this … —
 * it ".
 *
 * Its SUBJECT first: a condition constrains one of the `unknowns`, and a
 * subject that is not one is worded as such rather than as a call — main
 * folded `ifactor(2^257-1)=1` in as a condition and burned the budget on it.
 * Then every bracket, by what precedes it: an operator, a number or nothing is
 * grouping; a name is a call, admitted when it is an unknown, a derivative
 * spelling or in CONDITION_FUNCTIONS; and a closing bracket applies the group
 * it closes — `diff(y(x),x)(0)` was judged at `diff`'s own bracket, and
 * `(ifactor)(N)`, a call with no name in front of it, is judged by the names
 * inside the group.
 */
export function conditionCallError(
  condition: string,
  unknowns: readonly string[]
): string | undefined {
  const asNumber = 'give the value itself, as in y(0)=1';
  // This check reaches a condition before odeMisreadRefusal does, and the
  // same character should not be named two ways.
  const unwritten = unwrittenError(condition, isNumberCharacter, 'a number', asNumber);
  if (unwritten !== undefined) return unwritten;
  const admits = (name: string): boolean => {
    const bare = bareName(name);
    return (
      CONDITION_FUNCTIONS.has(bare) ||
      (DERIVATIVE_NAMES as readonly string[]).includes(bare) ||
      unknowns.includes(bare)
    );
  };
  const tokens = foldPrimes(tokenizeMagnitude(condition));
  const [subject, opens] = tokens;
  if (subject?.kind === 'name' && opens?.text === '(' && !admits(subject.text)) {
    const solved = unknowns.join(' or ');
    return (
      `gives a condition on ${excerpt(subject.text, 30)}(…), but the function solved for is ` +
      `${solved} — write it as ${unknowns[0] ?? 'y'}(0)=1`
    );
  }
  // A quote is refused as odeMisreadRefusal refuses one it finds in what the
  // engine prints — `y(0)=quote(y(1))` is not y at 1 to Giac — and here, before
  // any engine call, because the quote could as well hold `ifactor(…)`.
  const quoted = (open: number): string => {
    const inner = tokens
      .slice(open + 1, closingIndex(tokens, open))
      .map((t) => t.text)
      .join('');
    const fn = subject?.kind === 'name' ? bareName(subject.text) : '';
    return quotedReason(
      excerpt(`'${inner}'`, 60),
      unknowns.includes(fn) ? fn : (unknowns[0] ?? 'y'),
      true
    );
  };
  const calls = (name: string): string =>
    `calls ${excerpt(name, 30)} — an initial condition is a number, so compute ` +
    `${excerpt(name, 30)}(…) on its own first and give the value it returns`;
  for (const [i, token] of tokens.entries()) {
    if (token.kind !== 'op' || (token.text !== '(' && token.text !== '[')) continue;
    const before = tokens[i - 1];
    if (before?.kind === 'name') {
      if (before.text === 'quote') return quoted(i);
      if (!admits(before.text)) return calls(before.text);
      continue;
    }
    if (before?.text !== ')' && before?.text !== ']') continue;
    const opener = before.text === ')' ? '(' : '[';
    let depth = 0;
    let at = i - 1;
    for (; at >= 0; at -= 1) {
      if (tokens[at]?.text === before.text) depth += 1;
      else if (tokens[at]?.text === opener && --depth === 0) break;
    }
    if (tokens[at - 1]?.kind === 'name') continue;
    const foreign = tokens
      .slice(Math.max(at, 0), i - 1)
      .find((t) => t.kind === 'name' && !admits(t.text));
    if (foreign !== undefined) return calls(foreign.text);
    if (opener === '[') return `applies a list as a function — ${asNumber}`;
  }
  return undefined;
}

/** The index of the bracket closing the one at `open`, or the end. */
function closingIndex(tokens: MagnitudeToken[], open: number): number {
  let depth = 0;
  let close = open;
  for (; close < tokens.length; close += 1) {
    const text = tokens[close]?.text;
    if (text === '(' || text === '[') depth += 1;
    else if ((text === ')' || text === ']') && --depth === 0) break;
  }
  return close;
}

/**
 * Why an ODE's text names something too costly to hand the CAS, or undefined.
 * `text` is normalised; the phrase continues "cannot solve this … — it ".
 *
 * Over everything the solver will read — the single-equation path's folded
 * command, a system's right-hand sides and conditions — so a name is judged
 * wherever it stands: after an `and`, `&&` or `∧` join, in a condition written
 * first, in a member list, or inside `quote(…)`.
 *
 * Judged by NAME, called or bare: `for k from 1 to 10^9 do od` calls nothing,
 * `(ifactor)(N)` applies a group, and a bare `restart` runs. A name with a
 * leading `_` is refused too: the CAS reads it as a unit, and `_seq(k,k,1,3)`
 * runs `seq`. And a `.` that is not part of a number is refused: `.^` is the
 * engine's elementwise power, which no cost reader sees.
 */
export function equationNameError(text: string): string | undefined {
  const instead =
    'an equation may use elementary functions such as sin, exp, ln, sqrt and ' +
    'Heaviside, and parameters or functions of its own';
  let orders = 0;
  const unjoined = text
    .replaceAll(CONJUNCTION, ' ')
    .replaceAll(REPEATED_ORDER, (whole, name: string, order: string) => {
      orders += Number(order);
      return name;
    });
  if (orders > MAX_REPEATED_ORDER) {
    return (
      `repeats its variable ${orders} times with $, above the ${MAX_REPEATED_ORDER} this ` +
      'tool accepts as the order of a derivative — lower the order'
    );
  }
  const unwritten = unwrittenError(unjoined, isEquationCharacter, 'an equation', instead);
  if (unwritten !== undefined) return unwritten;
  const tokens = foldPrimes(tokenizeMagnitude(text));
  if (tokens.some((token) => token.kind === 'separator' && token.text === '.')) {
    return (
      'contains "." outside a number, which the CAS reads as an elementwise operator — ' +
      `write a decimal with its digits, as 0.5; ${instead}`
    );
  }
  for (const [i, token] of tokens.entries()) {
    if (token.kind !== 'name') continue;
    const name = bareName(token.text);
    if (EQUATION_NAMES.has(name)) continue;
    if (!GIAC_RESERVED_NAMES.has(name) && !name.startsWith('_')) continue;
    const shown = excerpt(name, 30);
    const next = tokens[i + 1]?.text;
    if (next !== '(' && next !== '[') {
      return (
        `names ${shown}, which the CAS reserves for its own commands and syntax — ` +
        `remove or rename it; ${instead}`
      );
    }
    // Advice by what the call is given: a constant is a value the caller can
    // compute on its own; a call on the variable is a term to write out.
    const inside = tokens.slice(i + 2, closingIndex(tokens, i + 1));
    const constant = inside.every((t) => t.kind !== 'name' || CONSTANTS.has(bareName(t.text)));
    const advice = constant
      ? `compute ${shown}(…) on its own first and write the value in`
      : 'write the term in closed form';
    return `calls ${shown}, which the CAS runs as a command rather than reading as part of an equation — ${advice}; ${instead}`;
  }
  return undefined;
}
