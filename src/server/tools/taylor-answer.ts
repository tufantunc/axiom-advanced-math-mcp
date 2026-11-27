import { giacEngine } from '../giac/index.js';
import { readableBack, type EvaluatedResponse } from './giac-eval.js';
import {
  escapeForRegExp,
  excerpt,
  nonSeriesTerm,
  printedList,
  stripOrderTerm,
} from './output-cleanup.js';
import { formatErrorResponse, formatToolResponse } from './response-formatter.js';
import { NAME_CHAR_PATTERN, unicodeToAscii } from './unicode-normalize.js';

/** The order taylor expands to when the caller names none — the command's own default. */
export const DEFAULT_TAYLOR_ORDER = 5;

/** A point at infinity, as a caller writes one. */
const INFINITE_POINT = /^[+-]?(?:inf|infinity)$/;

/**
 * Why a series Giac expanded to order `n` at a finite point does not reach
 * that order, or undefined when it does: the order its remainder leaves.
 *
 * Giac writes the remainder of a series as `B^k*order_size(B)`, O(B^k), and
 * writes a series that broke down the same way. An expansion that reached
 * order n at a finite point leaves a remainder of order n+1 or more; one that
 * stopped short leaves less, and stripping the remainder hid it.
 * `taylor(exp(1/x), x, 0, 3)` answered `order_size(x)` — the remainder alone,
 * O(1) — and `taylor(1+x*exp(1/x), x, 0, 3)` answered `1`, both with
 * isError:false.
 *
 * At infinity Giac counts the order from the leading power, so a remainder of
 * any order can close a correct expansion there (`taylor(x^3*exp(1/x), x, inf,
 * 2)` is x^3+x^2+x/2+O(1)); callers apply this at finite points only.
 */
export function seriesShortfall(orders: readonly number[], n: number): number | undefined {
  if (orders.length === 0) return undefined;
  const lowest = Math.min(...orders);
  return lowest <= n ? lowest : undefined;
}

/** The words for a series that stops at remainder order `k`, short of order `n`. */
export function shortfallReason(k: number, n: number): string {
  return k === 0
    ? 'the expansion breaks down at once, leaving nothing but O(1), as it does at an ' +
        'essential singularity such as exp(1/x) at 0 — there is no Taylor series there'
    : `the expansion stops with a remainder of order ${k}, short of the order ${n} asked ` +
        'for, so it does not give every term through that order — as at an essential ' +
        'singularity, or where the expansion runs in fractional powers';
}

/**
 * The most levels of nested applications walked before a point is called
 * unconfirmed: `exp(sin(1/x))` is three. Deeper expressions are refused, not
 * answered unchecked.
 */
const MAX_REGULARITY_LEVELS = 16;

/** Whether printed text names `variable` as a whole name, not inside a longer one. */
function namesVariable(variable: string): (text: string) => boolean {
  const name = new RegExp(
    `(?<!${NAME_CHAR_PATTERN})${escapeForRegExp(variable)}(?!${NAME_CHAR_PATTERN})`,
    'u'
  );
  return (text) => name.test(text);
}

/** The engine's printed list for `command`, read back as ASCII, or undefined. */
async function evaluateList(command: string): Promise<string[] | undefined> {
  try {
    return printedList(String(await giacEngine.evaluate(command)))?.map(unicodeToAscii);
  } catch {
    return undefined;
  }
}

/**
 * The engine's reading of a command built from printed pieces it handed out,
 * or undefined when the command is too long to hand back (readableBack) or a
 * piece did not survive the round trip. Giac lexes some shapes as its
 * undefined marker rather than failing, and an `undef` names no variable:
 * read as a piece, it would pass every check here.
 */
async function readBack(command: string): Promise<string[] | undefined> {
  if (!readableBack(command)) return undefined;
  const list = await evaluateList(command);
  return list?.some((piece) => /\bundef\b|GIAC_ERROR/.test(piece)) ? undefined : list;
}

/** A limit the engine found not to be a finite value, in words. */
function limitWords(printed: string): string {
  if (printed.includes('bounded_function')) return 'it stays bounded but tends to no value';
  if (printed.includes('infinity')) return 'it tends to infinity';
  if (printed.includes('undef')) return 'it tends to no single value';
  return `the CAS gives ${excerpt(printed, 30)}`;
}

/** What the engine prints for a limit that is not a finite value. */
const NOT_A_VALUE = /infinity|undef|bounded_function|limit|order_size|GIAC_ERROR|NaN/;

/**
 * Why `point` is not a regular point of `expression`, or undefined when every
 * function the expression applies — at any depth, and every power whose
 * exponent varies — has an argument with a finite limit there.
 *
 * Giac expands a function whose argument blows up as though it were bounded:
 * exp(1/x) at 0 becomes order_size(x), O(1). Alone that is a remainder of
 * order 0 and is refused, but a factor hides it — `x+x^4*exp(1/x)` printed
 * `x+x^4*order_size(x)`, a remainder of order n+1, and answered `x` with
 * isError:false, though x^4*exp(1/x) grows without bound as x tends to 0
 * from the right. Asking whether each argument has a finite limit is what
 * tells them apart: an analytic function of an argument with a finite limit
 * is regular or has a pole there, which a Laurent series reports honestly.
 *
 * Read with the engine, not the text: `lvar` lists the applications and
 * non-integer powers (`e^(1/x)` is exp(1/x), `2^(1/x)` a power), `op` their
 * arguments, and `limit` where each goes. A limit of the arguments is cheap —
 * they are pieces of the caller's expression, and the expensive limit
 * #57 measured and rejected was of the whole expression over (x-a)^n. A
 * limit that cannot be found, or that fails, is a refusal: the point is
 * then not confirmed regular.
 *
 * Only at a finite point. At infinity a function of x tends to infinity as a
 * matter of course — atan(x) is answered there — and what the expansion
 * printed is checked instead (seriesFormReason).
 */
export async function irregularPointReason(
  expression: string,
  variable: string,
  point: string
): Promise<string | undefined> {
  const mentions = namesVariable(variable);
  const unconfirmed =
    'the point could not be confirmed to be a regular point of the expression — the CAS ' +
    'could not say where the argument of every function it applies tends there';
  let level = [expression];
  for (let depth = 0; level.length > 0; depth++) {
    if (depth === MAX_REGULARITY_LEVELS) return unconfirmed;
    // The caller's own expression goes as it came, as the series command took
    // it; every later level is printed pieces, and is bounded as such.
    const lvar = `lvar([${level.join(',')}])`;
    const kernels = depth === 0 ? await evaluateList(lvar) : await readBack(lvar);
    if (kernels === undefined) return unconfirmed;
    const applied = kernels.filter((k) => k !== variable && mentions(k));
    if (applied.length === 0) return undefined;
    const operands = await readBack(`[${applied.map((k) => `[op(${k})]`).join(',')}]`);
    if (operands?.length !== applied.length) return unconfirmed;
    const args = new Set<string>();
    for (const printed of operands) {
      const list = printedList(printed);
      if (list === undefined) return unconfirmed;
      for (const arg of list) if (arg !== variable && mentions(arg)) args.add(arg);
    }
    level = [...args];
    if (level.length === 0) return undefined;
    const limitsCommand = `[${level.map((arg) => `limit(${arg},${variable},${point})`).join(',')}]`;
    if (!readableBack(limitsCommand)) return unconfirmed;
    const limits = await evaluateList(limitsCommand);
    if (limits?.length !== level.length) return unconfirmed;
    const bad = limits.findIndex((v) => v === '' || NOT_A_VALUE.test(v) || mentions(v));
    if (bad !== -1) {
      return (
        `the expression applies a function to ${excerpt(level[bad], 40)}, which has no ` +
        `finite limit there (${limitWords(limits[bad])}) — the point is a singularity such ` +
        'as exp(1/x) or sin(1/x) has at 0, where there is no Taylor series'
      );
    }
  }
  return undefined;
}

/**
 * Why an expansion's answer is not a series in the variable, or undefined
 * when it is: a sum of integer powers of x-a (of 1/x at infinity) with
 * coefficients free of x, and its remainder (nonSeriesTerm).
 *
 * Giac hands back what it cannot expand as it found it: `taylor(sin(1/x), x,
 * 0, 3)` answered `sin(1/x)`, `ln(x)` at 0 `ln(x)`, `x^x` at 0 a sum over
 * powers of ln(x), and `sin(x)` at infinity `sin((1/x)^-1)` — each with
 * isError:false and no remainder to say so.
 */
export function seriesFormReason(result: string, variable: string): string | undefined {
  const foreign = nonSeriesTerm(result, variable);
  if (foreign === undefined) return undefined;
  return (
    `the expansion still holds ${unicodeToAscii(excerpt(foreign, 40))}, which is not an ` +
    'integer power of the variable — the CAS could not expand it, as for sin(1/x), ln(x) ' +
    'or sqrt(x) at 0, where there is no Taylor series'
  );
}

/**
 * A taylor answer read against the order the caller asked for: the answer as
 * it stands (undefined), a refusal, or the zero polynomial in place of a bare
 * remainder.
 *
 * Refused, in this order: a remainder short of the order (seriesShortfall), a
 * point that is not confirmed regular (irregularPointReason), and an answer
 * that is not a series at all (seriesFormReason).
 *
 * A remainder of order above n with nothing in front of it is an answer:
 * every term through order n is zero (`taylor(x^4, x, 0, 3)` printed
 * `x^4*order_size(x)` where the polynomial is 0). Not on the token alone,
 * though, because a broken expansion can look the same:
 * `taylor(x^5*exp(1/x), x, 0, 3)` prints `x^5*order_size(x)` exactly as
 * `taylor(x^5, x, 0, 3)` does. The zero is answered only when the engine
 * confirms the expression is o((x-a)^n) there — then every Taylor coefficient
 * through n is 0, whatever the expansion printed. Confirming every series the
 * same way was measured and rejected: Giac's limit gives up at about order 50
 * ("Max order reached") on series that are correct, and `taylor(f(x), x, 0,
 * 2)` trapped the worker.
 */
export async function taylorAnswer(
  response: EvaluatedResponse,
  args: Record<string, unknown>,
  giacCommand: string
): Promise<EvaluatedResponse | ReturnType<typeof formatErrorResponse> | undefined> {
  const orders = response.seriesRemainderOrders;
  const point = String(args.point ?? '0').trim();
  const infinite = INFINITE_POINT.test(point);
  const n = args.order === undefined ? DEFAULT_TAYLOR_ORDER : Number(args.order);
  const variable = unicodeToAscii(String(args.variable));
  const expression = unicodeToAscii(String(args.expression));
  const where = `${variable} = ${excerpt(point, 40)}`;
  const refusal = (why: string) =>
    formatErrorResponse(
      `taylor cannot answer this — expanding ${excerpt(String(args.expression), 60)} to ` +
        `order ${n} at ${where}: ${why}`
    );
  const shortfall = orders === undefined || infinite ? undefined : seriesShortfall(orders, n);
  if (shortfall !== undefined) return refusal(shortfallReason(shortfall, n));
  const irregular = infinite
    ? undefined
    : await irregularPointReason(expression, variable, unicodeToAscii(point));
  if (irregular !== undefined) return refusal(irregular);
  const form = seriesFormReason(response.result, variable);
  if (form !== undefined) return refusal(form);
  if (orders === undefined || infinite) return undefined;
  // The remainder alone, with no polynomial in front of it to cut back to. A
  // list (`taylor([sin(x), cos(x)], ...)`) keeps its remainders inside its
  // entries, which stripOrderTerm leaves, and is answered as printed.
  const result = response.result.trim();
  if (result.startsWith('[') || stripOrderTerm(result) !== result) return undefined;
  if (!result.includes('order_size(')) return undefined;
  let limit: string;
  try {
    limit = String(
      await giacEngine.evaluate(
        `limit((${expression})/(${variable}-(${point}))^${n},${variable},${point})`
      )
    ).trim();
  } catch {
    limit = '';
  }
  if (limit !== '0') {
    return refusal(
      'the expansion leaves only its remainder, and the expression is not confirmed to ' +
        `vanish faster than (${variable}-${excerpt(point, 20)})^${n} there`
    );
  }
  return Object.assign(
    formatToolResponse({
      result: '0',
      latex: '0',
      giacCommand,
      notes: [`Every term through order ${n} is zero: the expression vanishes faster at ${where}.`],
    }),
    { result: '0' }
  );
}
