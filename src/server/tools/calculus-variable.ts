import { giacEngine } from '../giac/index.js';
import { excerpt, printedList, splitTopLevel } from './output-cleanup.js';
import { NAME_CHAR_PATTERN, NAME_PATTERN, unicodeToAscii } from './unicode-normalize.js';

/**
 * The variable of a differentiate, integrate or taylor call: what may be one,
 * what a derivative with respect to a list may cost, and — with the engine —
 * which variable a call that named none means and whether a named one is a
 * symbol at all.
 */

/** The operations whose variable this module checks. */
export function takesVariable(operation: string): boolean {
  return operation === 'differentiate' || operation === 'integrate' || operation === 'taylor';
}

/**
 * The most entries a derivative with respect to a list may have: k variables
 * to order n is a k^n tensor. Measured: `diff(exp(sin(x*y)), [x, y], 10)`
 * (1024 entries) traps the shared worker, and so do 3^7 and 4^6 of the same
 * shape, where 2^9 answers in 0.8 s. Even `diff(x*y, [x, y], 20)` traps, on
 * size alone. Binding on wide lists: 17 variables to order 2 is 289 entries.
 */
const MAX_DERIVATIVE_ENTRIES = 256;

/**
 * The most work a derivative with respect to a list may ask for, in units of
 * `s * (k * (1 + d^2))^n`: the expression's length s, k variables, order n,
 * and d the deepest nesting of function applications, at least 1.
 *
 * The entry cap bounds how many entries there are, not how large each one
 * grows, and the second is what traps the worker: each order multiplies an
 * entry by the product and chain rules. `diff(exp(sin(x*y))*cos(x+y)/(1+x^2+y^2),
 * [x, y], 6)` has 64 entries and traps ("RuntimeError: unreachable"). The trap
 * follows the size of the answer — every one measured came above about 1.3
 * million characters — so the bound estimates that size: k^n entries, each
 * growing by a factor of about 1 + d^2 per order. Length alone undercounts
 * nesting: `tan(tan(tan(tan(tan(x*y)))))` is 28 characters and trapped at
 * [x, y], order 4. Measured, a tower of d tans grows by about d^2 to d^2.5 per
 * order and one of d exps by about d, so d^2 is the bound and errs toward
 * refusing exp towers; at depth 1 the factor is 2, as for any expression.
 *
 * Calibrated on 35 expressions of two to five variables (the measurements are
 * in the PR that added it). The smallest cost that trapped was 136,192
 * (a 133-character sum of twelve terms, [x, y], order 5), eight times this
 * cap; every shape measured at or under the cap answered in 0.3 s with at most
 * 120,000 characters. It still answers the Hessian (n = 2) of a two-variable
 * expression of depth 1 up to 1,024 characters and of depth 2 up to about 160;
 * of a four-variable one up to 256 and about 40; a gradient of ten variables
 * up to about 800.
 *
 * Only for a list of two or more variables. A single variable grows by much
 * less per order — `diff(exp(sin(x)), x, 100)` answers in under a second — and
 * this model would refuse it, so a single variable is bounded by
 * MAX_CALCULUS_ORDER alone.
 */
export const MAX_DERIVATIVE_COST = 16_384;

/**
 * Names Giac reads as constants: differentiating with respect to one is 0.
 * A pattern, not a Set literal — test/operation-coverage.test.ts reads every
 * `new Set([...])` in a handler as operation names it dispatches on. `π` is a
 * letter, so it passes the name check and is caught here; `∞` is not one.
 * `plus_inf` and its siblings answered 0 as variables.
 */
const CONSTANT_NAME = /^(?:e|i|pi|π|infinity|inf|plus_inf|minus_inf|unsigned_inf|euler_gamma)$/u;

/**
 * Names Giac reads as values rather than symbols: `diff(x^2, NULL)` answered
 * 2*x, `diff(x^2, undef)` 0, `diff(x^2, true)` stayed unevaluated, and
 * `diff(x^2, DIGITS)` answered `diff(x^2,12)` — DIGITS is the precision
 * setting. Listed so they are refused before any round trip, with a message
 * that names them; variableValueRefusal asks the engine about every other
 * name, so a setting missing from this list is refused all the same.
 */
const VALUE_NAME = /^(?:NULL|true|false|undef|DIGITS)$/u;

/** A name as Giac reads one, `θ` included — the same rule as unicode-normalize. */
const VARIABLE_NAME = new RegExp(`^${NAME_PATTERN}$`, 'u');

const NAME_CHAR = new RegExp(NAME_CHAR_PATTERN, 'u');

/**
 * The names a variable argument lists: the bracketed list differentiate takes
 * as Giac's gradient, `[x, y]`, or the one name.
 */
function variableNames(variable: unknown): string[] {
  const text = String(variable).trim();
  return text.startsWith('[') && text.endsWith(']')
    ? splitTopLevel(text.slice(1, -1), ',').map((n) => n.trim())
    : [text];
}

function nameRefusal(operation: string, text: string): string | null {
  if (!VARIABLE_NAME.test(text)) {
    return `${operation} needs a variable that is a name, such as x — got "${excerpt(text, 60)}"`;
  }
  if (VALUE_NAME.test(text)) {
    return `${operation} needs a variable, and "${text}" is a value — name the variable, such as x`;
  }
  if (CONSTANT_NAME.test(text)) {
    return `${operation} needs a variable, and "${text}" is a constant — name the variable, such as x`;
  }
  return null;
}

/** The deepest nesting of function applications in `expr`: `tan(tan(x))` is 2, `(1+x)^2` 0. */
export function applicationDepth(expr: string): number {
  const isCall: boolean[] = [];
  let depth = 0;
  let deepest = 0;
  for (let i = 0; i < expr.length; i++) {
    if (expr[i] === '(') {
      const call = i > 0 && NAME_CHAR.test(expr[i - 1]);
      isCall.push(call);
      if (call) deepest = Math.max(deepest, ++depth);
    } else if (expr[i] === ')' && isCall.pop()) {
      depth--;
    }
  }
  return deepest;
}

/**
 * The variable must be a name. `diff(x, 2)` answered the unevaluated
 * `diff(x,2)`, `integrate(x, 2)` a GIAC_ERROR, `taylor(sin(x), 2, 0, 3)` the
 * value 2/3, and `diff(x^2, pi)` the number 0 — each with isError:false.
 *
 * differentiate also takes a bracketed list of names, Giac's gradient:
 * `diff(x^2*y^3, [x, y])`, and with an order the Hessian or higher tensor:
 * `diff(x^2*y^3, [x, y], 2)`. Each name is checked as a single variable is,
 * and the tensor is bounded — see MAX_DERIVATIVE_ENTRIES and
 * MAX_DERIVATIVE_COST.
 */
export function variableRefusal(
  operation: string,
  variable: unknown,
  order: unknown = undefined,
  expression: unknown = ''
): string | null {
  const text = String(variable).trim();
  const isList = operation === 'differentiate' && text.startsWith('[') && text.endsWith(']');
  if (!isList) return nameRefusal(operation, text);
  const names = variableNames(text);
  for (const name of names) {
    const refusal = nameRefusal(operation, name);
    if (refusal) return refusal;
  }
  if (!/^\d+$/.test(String(order ?? '1').trim())) return null;
  const n = order === undefined ? 1 : Number(String(order).trim());
  const k = names.length;
  if (k ** n > MAX_DERIVATIVE_ENTRIES) {
    return (
      `differentiate with ${k} variables to order ${n} gives ` +
      `${k}^${n} entries, more than the ${MAX_DERIVATIVE_ENTRIES} this computes — ` +
      'lower the order or list fewer variables'
    );
  }
  const ascii = unicodeToAscii(String(expression)).replaceAll(/\s+/g, '');
  const depth = Math.max(1, applicationDepth(ascii));
  const growth = 1 + depth ** 2;
  if (k > 1 && ascii.length * (k * growth) ** n > MAX_DERIVATIVE_COST) {
    return (
      `differentiate with ${k} variables to order ${n} of this expression ` +
      `(${ascii.length} characters, functions nested ${depth} deep) is more than ` +
      `this computes: each order multiplies the size of all ${k}^${n} entries — lower ` +
      'the order, list fewer variables, or differentiate a shorter expression'
    );
  }
  return null;
}

/** How each operation is written with its variable named, for a refusal to show. */
const NAMED_FORM: Readonly<Record<string, string>> = {
  differentiate: 'diff(f, x)',
  integrate: 'integrate(f, x)',
  taylor: 'taylor(f, x, 0, 5)',
};

/**
 * Names the extractor's guess passes over as constants (GUESS_CONSTANTS there,
 * whose `π` is `pi` by now and not a name to Giac). Giac reads E and I as
 * names, so they are dropped here by hand.
 */
const CONSTANT_LETTERS = new Set(['e', 'i', 'E', 'I']);

const ASCII_NAME = /^[A-Za-z_]\w*$/;

/** The names `expression` applies as functions — the `f` of `f(x)`. */
function appliedNames(expression: string): Set<string> {
  const applied = new RegExp(`(?<!${NAME_CHAR_PATTERN})(${NAME_PATTERN})\\s*\\(`, 'gu');
  return new Set([...expression.matchAll(applied)].map((m) => m[1]));
}

/**
 * The variable for a call that named none, or the reason none can be chosen.
 *
 * The extractor guesses from the text, and the guess answered a different
 * question with isError:false: `diff(2x+y)` differentiated by y and answered
 * 1, `diff(a*x^2)` by a and answered x^2, `diff(3t^2)` by x — no letter in
 * `3t` stands alone as a word — and answered 0. Here the engine says which
 * names the expression has (`lname`, Giac's own reading of it, so `2x` is
 * 2*x and `pi` is a constant), and more than one is refused rather than
 * picked.
 *
 * One rule of the guess is kept, because callers rely on it and it is not a
 * guess between equals: an ASCII name is the variable over a Greek one, so
 * `diff(sin(ω*t))` is ω*cos(ω*t) — a Greek letter beside an ASCII variable is
 * conventionally a parameter. Two ASCII names, or two Greek ones and no ASCII,
 * are ambiguous. A name the expression applies, `f` in `f(x)`, is a function,
 * not a candidate. No name at all keeps the guess: the expression is constant
 * and any variable gives the same answer.
 */
async function resolveGuessedVariable(
  operation: string,
  args: Record<string, unknown>
): Promise<{ args: Record<string, unknown> } | { error: string }> {
  if (args.variable_guessed !== true) return { args };
  const expression = unicodeToAscii(String(args.expression));
  const named = `name it, as in ${NAMED_FORM[operation] ?? `${operation}(f, x)`}`;
  let names: string[] | undefined;
  try {
    names = printedList(String(await giacEngine.evaluate(`lname(${expression})`)));
  } catch {
    names = undefined;
  }
  if (names === undefined) {
    return { error: `${operation} could not tell which variable is meant — ${named}` };
  }
  const applied = appliedNames(expression);
  const candidates = names.filter((name) => !CONSTANT_LETTERS.has(name) && !applied.has(name));
  const ascii = candidates.filter((name) => ASCII_NAME.test(name));
  const pool = ascii.length > 0 ? ascii : candidates;
  if (pool.length === 0) return { args };
  if (pool.length > 1) {
    return {
      error:
        `${operation} needs the variable when the expression has more than one ` +
        `symbol (${excerpt(pool.join(', '), 60)}) — ${named}`,
    };
  }
  return { args: { ...args, variable: pool[0] } };
}

/**
 * Why a variable is a value to the engine rather than a symbol, or undefined
 * when every name is a symbol.
 *
 * Giac predefines names that look like variables and hold values:
 * `diff(x^2, DIGITS)` answered `diff(x^2,12)` and `diff(x^2, plus_inf)` 0,
 * each with isError:false. The ones measured are refused by name before this
 * runs; this asks the engine about every name, so a setting nobody listed
 * (`epsilon`, `Digits`) is refused too. A symbol is an `identifier` that
 * evaluates to itself. Constants pass this — `pi` is an identifier and is
 * `pi` — and are refused by name.
 *
 * A probe that fails adds no refusal: the command itself runs next, and
 * reports whatever the engine says.
 */
async function variableValueRefusal(
  operation: string,
  variable: unknown
): Promise<string | undefined> {
  const names = variableNames(unicodeToAscii(String(variable)));
  let readings: string[] | undefined;
  try {
    const probe = names.map((n) => `[type(${n}),${n}]`).join(',');
    readings = printedList(String(await giacEngine.evaluate(`[${probe}]`)));
  } catch {
    return undefined;
  }
  if (readings?.length !== names.length) return undefined;
  for (const [index, name] of names.entries()) {
    const [type, value] = printedList(readings[index]) ?? [];
    if (type !== 'identifier' || value !== name) {
      return (
        `${operation} needs a variable, and "${excerpt(name, 60)}" is a value ` +
        `to the CAS (${excerpt(value ?? readings[index], 60)}) — name the variable, such as x`
      );
    }
  }
  return undefined;
}

/**
 * The call's variable as the engine reads it, or the reason it is refused:
 * the omitted variable resolved, the resolved one checked as a name, and every
 * name checked to be a symbol. After every synchronous check (variableRefusal
 * among them), so text those refuse never reaches the engine.
 */
export async function resolveVariable(
  operation: string,
  args: Record<string, unknown>
): Promise<{ args: Record<string, unknown> } | { error: string }> {
  const resolved = await resolveGuessedVariable(operation, args);
  if ('error' in resolved) return resolved;
  const variable = resolved.args.variable;
  const refusal =
    (args.variable_guessed === true ? nameRefusal(operation, String(variable)) : null) ??
    (await variableValueRefusal(operation, variable));
  return refusal ? { error: refusal } : resolved;
}
