import { giacEngine } from '../giac/index.js';
import { formatToolResponse, formatErrorResponse } from './response-formatter.js';
import { analyzeNumberCore } from './number-utils.js';
import { identifySequenceCore } from './sequence-utils.js';
import { excerpt, nestingDepth } from './output-cleanup.js';
import { implausibleMagnitude } from './ode-condition-bounds.js';
import { unicodeToAscii } from './unicode-normalize.js';

const INTEGER = /^-?\d+$/;

/**
 * A decimal or exponent literal, or a call that makes one. An integer derived
 * from a float is an artifact of Giac's reduced-precision floats, not the number
 * the caller wrote: `ifactor(floor(1e30))` factored 999999999999998612509741285376,
 * which is neither 10^30 nor the double nearest it.
 */
const FLOAT_SOURCE = /\d\.\d*|\.\d|\d[eE][+-]?\d|\b(?:evalf|approx)\s*\(/;

/** The bracket depth the magnitude reader is trusted with, as on the ODE path. */
const MAX_ARGUMENT_DEPTH = 100;

/**
 * The integer a number-theory call is about, as exact decimal text.
 *
 * compute hands over the caller's argument as written (`expression`). It used to
 * be read with Number.parseInt, which stops at the first character it cannot
 * read and rounds past 2^53, so each of these answered something else with
 * isError:false: `ifactor(2^8+1)` factored 2, `ifactor(12*5)` factored 12,
 * `ifactor(3.5)` factored 3, `isprime(2^61-1)` analysed 2, and
 * `ifactor(12345678901234567890)` factored a neighbouring number.
 *
 * A plain integer literal is used as written. Anything else is evaluated, and
 * only an exact integer is accepted: `3.5`, `7/2` and a free symbol are refused
 * rather than truncated, and so is any argument built from a float. Before
 * evaluating, the argument is bounded with the ODE path's magnitude reader:
 * `ifactor(2^100000)` (17 characters) crashed the shared Giac worker.
 *
 * A numeric `number` argument is still accepted from direct callers, up to
 * 2^53, past which a JS number is no longer the integer the caller meant.
 */
async function resolveInteger(
  args: Record<string, unknown>,
  example: string
): Promise<{ value: string } | { error: string }> {
  const notInteger = `number must be a finite integer, e.g. ${example}`;
  if (typeof args.expression === 'string') {
    const text = unicodeToAscii(args.expression).trim();
    if (text.length === 0) return { error: notInteger };
    const quoted = excerpt(text, 60);
    const literal = text.replace(/^\+/, '');
    if (INTEGER.test(literal)) return { value: literal };
    if (FLOAT_SOURCE.test(text)) {
      return { error: `${quoted} is built from a decimal number — ${notInteger}` };
    }
    const oversized =
      nestingDepth(text) > MAX_ARGUMENT_DEPTH
        ? `more than ${MAX_ARGUMENT_DEPTH} nested brackets`
        : implausibleMagnitude(text);
    if (oversized !== undefined) {
      return { error: `${quoted} is too large to work with here (${oversized})` };
    }
    const value = (await giacEngine.evaluate(text)).trim();
    if (INTEGER.test(value)) return { value };
    return { error: `${quoted} is not an integer — ${notInteger}` };
  }
  const n = args.number;
  if (typeof n !== 'number' || !Number.isSafeInteger(n)) return { error: notInteger };
  return { value: String(n) };
}

async function primeFactorize(value: string) {
  // Quoted in the note through excerpt: an evaluated argument such as
  // 3*2^20000 is thousands of digits, where the factorization is short.
  const shown = excerpt(value, 60);
  const magnitude = BigInt(value) < 0n ? -BigInt(value) : BigInt(value);
  if (magnitude < 2n) {
    // The value itself, sign included, as on the main path: -1 is -1.
    return formatToolResponse({
      result: value,
      notes: [`${value} has no prime factors.`],
    });
  }
  try {
    // Giac factors the exact integer, sign included: ifactor(-360) is
    // -2^3*3^2*5.
    const result = await giacEngine.evaluate(`ifactor(${value})`);
    return formatToolResponse({
      result: result.trim(),
      notes: [`Prime factorization of ${shown}: ${result.trim()}`],
    });
  } catch (error) {
    return formatErrorResponse(error instanceof Error ? error.message : String(error));
  }
}

async function sequenceIdentify(terms: number[]) {
  const { lines, isError } = await identifySequenceCore(terms);
  if (isError) {
    return formatErrorResponse('Could not identify sequence pattern. Try providing more terms.');
  }
  const mainResult = lines.find((l) => l.startsWith('Formula:'))?.replace('Formula: ', '') ?? '';
  return formatToolResponse({ result: mainResult, notes: lines });
}

async function runPrimeFactorize(args: Record<string, unknown>) {
  if (args.expression === undefined && args.number === undefined) {
    return formatErrorResponse("'number' is required for prime_factorize");
  }
  const resolved = await resolveInteger(args, 'ifactor(360)');
  if ('error' in resolved) return formatErrorResponse(resolved.error);
  return await primeFactorize(resolved.value);
}

/**
 * isprime(n) and euler(n), answered by Giac on the exact integer.
 *
 * Both used to share the number report, whose Result line is n itself:
 * `euler(12)` answered 12 and `isprime(97)` answered 97, with the actual answer
 * only in the notes. The report also works on |n|, so `isprime(-7)` said
 * "Prime: Yes" where Giac says false, and `euler(-12)` showed φ(12) for a
 * totient that has no value.
 *
 * The answer comes from Giac on the exact integer. Up to 2^53 it is proven.
 * Past it Giac's isprime is a probable-prime test, not a proof: isprime(10^999+7)
 * says true in a fifth of a second. A `false` there is still certain (a witness
 * of compositeness was found), so only a `true` carries probablePrimeNote,
 * whose `Warning:` prefix puts it in the JSON envelope's `warnings`: that is how
 * a structured caller tells a probable true from a proven one. euler rests on
 * the same test for its factors and has no such hedge to give, so it stays
 * refused past 2^53.
 *
 * The report beside the answer is about |n|, so it is attached only for n ≥ 1,
 * where it describes the same number, and only up to 2^53, past which a JS
 * number is no longer that number.
 */
async function runIntegerFunction(name: 'isprime' | 'euler', args: Record<string, unknown>) {
  if (args.expression === undefined && args.number === undefined) {
    return formatErrorResponse(`'number' is required for ${name}`);
  }
  const resolved = await resolveInteger(args, name === 'isprime' ? 'isprime(97)' : 'euler(12)');
  if ('error' in resolved) return formatErrorResponse(resolved.error);
  const { value } = resolved;
  const shown = excerpt(value, 60);
  if (name === 'euler' && BigInt(value) < 1n) {
    // Giac answers euler(0) with 0 and refuses a negative; φ is defined on n ≥ 1.
    return formatErrorResponse(
      `Euler's totient is defined for positive integers — φ(${shown}) has no value`
    );
  }
  const n = Number(value);
  const proven = Number.isSafeInteger(n);
  if (name === 'euler' && !proven) {
    return formatErrorResponse(
      `${excerpt(value, 20)} is too large to answer exactly — the limit is ` +
        `${Number.MAX_SAFE_INTEGER}`
    );
  }
  // Giac's isprime of a negative number is false while |n| fits a 32-bit int,
  // and the primality of |n| past it: isprime(-7) is false, isprime(-4294967291)
  // is true. A prime is at least 2, so below that the answer needs no engine.
  const answer =
    name === 'isprime' && BigInt(value) < 2n ? 'false' : await engineAnswer(`${name}(${value})`);
  const answered =
    name === 'isprime' ? answer === 'true' || answer === 'false' : INTEGER.test(answer);
  if (!answered) {
    return formatErrorResponse(`${name}(${shown}) gave no answer: ${excerpt(answer, 60)}`);
  }
  if (name === 'euler') {
    const report = n >= 1 ? await analyzeNumberCore(n) : [];
    return formatToolResponse({
      result: answer,
      notes: [`Euler totient φ(${shown}) = ${answer}`, ...report],
    });
  }
  if (answer === 'true' && !proven) {
    return formatToolResponse({ result: answer, notes: [probablePrimeNote(shown)] });
  }
  const statement = `${shown} is ${answer === 'true' ? '' : 'not '}prime.`;
  const report = proven && n >= 1 ? await analyzeNumberCore(n) : [];
  return formatToolResponse({ result: answer, notes: [statement, ...report] });
}

/**
 * Giac's reply to a call, or the reason it gave none, for the caller's
 * "gave no answer" check to refuse. A prime literal of a few thousand digits
 * outlasts the evaluation timeout: 2^19937-1 typed out (6002 digits) does,
 * where 2^11213-1 (3376 digits) answers in about 4 s.
 */
async function engineAnswer(call: string): Promise<string> {
  try {
    return (await giacEngine.evaluate(call)).trim();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * The note on an isprime `true` past 2^53.
 *
 * It does not claim that no counterexample is known. The engine is GeoGebra's
 * Giac on its bundled GMP, whose version is not pinned here, and whether that
 * test is BPSW or Miller–Rabin on fixed-seed bases decides the claim: composites
 * that pass fixed-base Miller–Rabin have been constructed and published.
 */
function probablePrimeNote(shown: string): string {
  return (
    `Warning: ${shown} is a probable prime — above 2^53 the primality test is ` +
    'probabilistic, not a proof.'
  );
}

async function runSequenceIdentify(args: Record<string, unknown>) {
  const seq = args.sequence as number[] | undefined;
  if (!seq || seq.length < 3)
    return formatErrorResponse(
      "'sequence' array with at least 3 terms is required for sequence_identify"
    );
  return await sequenceIdentify(seq);
}

export async function numberTheoryHandler(args: Record<string, unknown>) {
  try {
    const operation = args.operation as string;

    if (operation === 'prime_factorize') return await runPrimeFactorize(args);
    if (operation === 'isprime' || operation === 'euler') {
      return await runIntegerFunction(operation, args);
    }
    if (operation === 'sequence_identify') return await runSequenceIdentify(args);

    return formatErrorResponse(`Unknown operation: ${operation}`);
  } catch (error) {
    return formatErrorResponse(error instanceof Error ? error.message : String(error));
  }
}
