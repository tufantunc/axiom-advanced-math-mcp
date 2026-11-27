import { giacEngine } from '../giac/index.js';
import { escapeForRegExp, excerpt, splitTopLevel } from './output-cleanup.js';
import { unicodeToAscii } from './unicode-normalize.js';

/**
 * The variable of a differentiate, integrate or taylor call, as the engine
 * reads it: the checks here need a round trip, so they run after the
 * synchronous ones in calculus.ts and before the command does.
 */

/** How each operation is written with its variable named, for a refusal to show. */
const NAMED_FORM: Readonly<Record<string, string>> = {
  differentiate: 'diff(f, x)',
  integrate: 'integrate(f, x)',
  taylor: 'taylor(f, x, 0, 5)',
};

/** Names the extractor's guess passes over as constants; Giac reads E and I as names. */
const CONSTANT_LETTERS = new Set(['e', 'i', 'E', 'I']);

const ASCII_NAME = /^[A-Za-z_]\w*$/;

/** The members of a Giac list as it prints one, or undefined when `printed` is not a list. */
function printedList(printed: string): string[] | undefined {
  const t = printed.trim();
  if (!t.startsWith('[') || !t.endsWith(']')) return undefined;
  const inner = t.slice(1, -1).trim();
  return inner === '' ? [] : splitTopLevel(inner, ',').map((m) => m.trim());
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
export async function resolveGuessedVariable(
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
  const candidates = names.filter(
    (name) =>
      !CONSTANT_LETTERS.has(name) &&
      !new RegExp(`(?<![\\p{L}\\p{N}_])${escapeForRegExp(name)}\\s*\\(`, 'u').test(expression)
  );
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
 * Why a variable the caller named is a value to the engine rather than a
 * symbol, or undefined when every name is a symbol.
 *
 * Giac predefines names that look like variables and hold values:
 * `diff(x^2, DIGITS)` answered `diff(x^2,12)` and `diff(x^2, plus_inf)` 0,
 * each with isError:false. calculus.ts refuses the ones measured by name; this
 * asks the engine about every name, so a setting nobody listed (`epsilon`,
 * `Digits`) is refused too. A symbol is an `identifier` that evaluates to
 * itself. Constants pass this — `pi` is an identifier and is `pi` — and are
 * refused by name before it runs.
 *
 * A probe that fails adds no refusal: the command itself runs next, and
 * reports whatever the engine says.
 */
export async function variableValueRefusal(
  operation: string,
  variable: unknown
): Promise<string | undefined> {
  const text = unicodeToAscii(String(variable).trim());
  const names =
    text.startsWith('[') && text.endsWith(']')
      ? splitTopLevel(text.slice(1, -1), ',').map((n) => n.trim())
      : [text];
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
