import { describe, it, expect, beforeAll, vi } from 'vitest';
import { giacEngine } from '../src/server/giac/index.js';
import { computeHandler } from '../src/server/tools/compute/index.js';
import { allText } from './helpers/all-text.js';
import { resultLine } from './helpers/result-line.js';

/**
 * The argument of ifactor / isprime / euler, read as the integer it denotes.
 *
 * It used to go through Number.parseInt, which stops at the first character it
 * cannot read and rounds past 2^53. Every row below the literal one answered a
 * different number with isError:false: `ifactor(2^8+1)` factored 2,
 * `ifactor(12*5)` factored 12, `ifactor(3.5)` factored 3, and
 * `ifactor(12345678901234567890)` factored a rounded neighbour.
 */
beforeAll(async () => {
  await giacEngine.initialize();
}, 60000);

describe('number-theory arguments', () => {
  it.each([
    ['ifactor(360)', '2^3*3^2*5'],
    ['ifactor(2^8+1)', '257'],
    ['ifactor(2⁸+1)', '257'],
    ['ifactor(12*5)', '2^2*3*5'],
    ['ifactor(-360)', '-2^3*3^2*5'],
    // Past 2^53: exact, where parseInt rounded to a neighbour.
    ['ifactor(12345678901234567890)', '2*3^2*5*101*3541*3607*3803*27961'],
    // Below 2 the value is its own answer, sign kept as on the main path.
    ['ifactor(0)', '0'],
    ['ifactor(1)', '1'],
    ['ifactor(-1)', '-1'],
  ])('%s factors as %s', async (problem, expected) => {
    const r = await computeHandler({ problem });
    const text = allText(r);
    expect(r.isError, text).toBe(false);
    expect(text).toMatch(resultLine(expected));
  });

  // The Result line is the function's value. It used to be n itself, with the
  // answer only in the notes: `euler(12)` answered 12 and `isprime(97)` 97.
  it.each([
    ['isprime(97)', 'true', '97 is prime.'],
    ['isprime(2^5-1)', 'true', '31 is prime.'],
    ['isprime(12)', 'false', '12 is not prime.'],
    ['isprime(1)', 'false', '1 is not prime.'],
    ['isprime(0)', 'false', '0 is not prime.'],
    // The largest prime below 2^53, the edge of what this answers.
    ['isprime(2^53-111)', 'true', '9007199254740881 is prime.'],
    ['euler(3*4)', '4', 'Euler totient φ(12) = 4'],
    ['euler(36)', '12', 'Euler totient φ(36) = 12'],
    ['euler(97)', '96', 'Euler totient φ(97) = 96'],
    ['euler(1)', '1', 'Euler totient φ(1) = 1'],
    // 6361 × 69431 × 20394401, all three below 2^53.
    ['euler(2^53-1)', '9005653101120000', 'Euler totient φ(9007199254740991) = 9005653101120000'],
  ])('%s answers %s', async (problem, expected, statement) => {
    const r = await computeHandler({ problem });
    const text = allText(r);
    expect(r.isError, text).toBe(false);
    expect(text).toMatch(resultLine(expected));
    expect(text).toContain(statement);
  });

  // The number report rides along for n ≥ 1, and agrees with the answer.
  it.each([
    ['euler(12)', '4', ['Euler totient φ(12): 4', 'Prime: No', 'Divisors: 1, 2, 3, 4, 6, 12']],
    ['isprime(97)', 'true', ['Prime: Yes', 'Euler totient φ(97): 96']],
  ])('keeps the number report beside %s', async (problem, expected, lines) => {
    const text = allText(await computeHandler({ problem }));
    expect(text).toMatch(resultLine(expected));
    for (const line of lines) expect(text).toContain(line);
  });

  // As text "false" is a truthy string: the envelope carries a real boolean.
  it.each([
    ['isprime(12)', false],
    ['isprime(97)', true],
  ])('%s is a boolean in the JSON envelope', async (problem, expected) => {
    const r = await computeHandler({ problem, format: 'json' });
    const envelope = JSON.parse(allText(r));
    expect(envelope.result_type).toBe('boolean');
    expect(envelope.data.value).toBe(expected);
  });

  // The report is about |n|: for -7 it said "Prime: Yes" beside Giac's false.
  it('answers isprime of a negative number without the report of its absolute value', async () => {
    const r = await computeHandler({ problem: 'isprime(-7)' });
    const text = allText(r);
    expect(r.isError, text).toBe(false);
    expect(text).toMatch(resultLine('false'));
    expect(text).toContain('-7 is not prime.');
    expect(text).not.toContain('Prime: Yes');
  });

  // Only a value of the function's own kind is an answer; anything else Giac
  // hands back is an error, not a Result line.
  it.each([
    ['isprime(97)', 'undef'],
    ['euler(12)', 'GIAC_ERROR: euler(12) Error: Bad Argument Type'],
    // Only the exact check refuses these: an unevaluated echo, a bracketed
    // undef, a float and a symbolic remainder all look like answers otherwise.
    ['isprime(97)', 'isprime(97)'],
    ['isprime(97)', '[undef]'],
    ['isprime(97)', '1'],
    ['euler(12)', '4.0'],
    ['euler(12)', 'euler(12)'],
    ['euler(12)', '4*x'],
  ])('%s refuses %s from the engine', async (problem, reply) => {
    const spy = vi.spyOn(giacEngine, 'evaluate').mockResolvedValueOnce(reply);
    try {
      const r = await computeHandler({ problem });
      const text = allText(r);
      expect(r.isError, text).toBe(true);
      expect(text).toContain(`gave no answer: ${reply.slice(0, 20)}`);
    } finally {
      spy.mockRestore();
    }
  });

  // Refused, not truncated or rounded.
  it.each([
    ['ifactor(3.5)', '3.5 is built from a decimal number'],
    ['isprime(7/2)', '7/2 is not an integer'],
    ['ifactor(foo)', 'foo is not an integer'],
    ['ifactor(x +)', 'x + is not an integer'],
    // Past 2^53 Giac's primality test is probabilistic: isprime(10^999+7)
    // says true in under a second. Refused rather than reported as proven.
    ['isprime(2^61-1)', '2305843009213693951 is too large to answer exactly'],
    ['euler(2^64)', '18446744073709551616 is too large to answer exactly'],
    // At the edge: 2^53+1 is read as 2^53 by a JS number, so the report would
    // describe its neighbour.
    ['isprime(2^53)', '9007199254740992 is too large to answer exactly'],
    ['euler(2^53+1)', '9007199254740993 is too large to answer exactly'],
    // φ is defined on n ≥ 1: Giac answers euler(0) with 0, and the report gave
    // euler(-12) the totient of 12.
    ['euler(0)', 'φ(0) has no value'],
    ['euler(-12)', 'φ(-12) has no value'],
    // Built from a float: the integer is an artifact of Giac's floats, not the
    // caller's number. floor(1e30) factored 999999999999998612509741285376.
    ['ifactor(2.0)', '2.0 is built from a decimal number'],
    ['ifactor(floor(1e30))', 'floor(1e30) is built from a decimal number'],
    ['isprime(12*0.5)', '12*0.5 is built from a decimal number'],
    // Bounded before evaluation: 2^100000 crashed the shared Giac worker, and
    // 10^(10^7) came back "not an integer" from Integer_too_large_for_display.
    ['ifactor(2^100000)', '2^100000 is too large to work with here'],
    ['isprime(10^(10^7))', '10^(10^7) is too large to work with here'],
    // The magnitude reader is trusted to the ODE path's depth and no deeper.
    [`ifactor(${'('.repeat(101)}2${')'.repeat(101)})`, '(more than 100 nested brackets)'],
    ['ifactor()', 'number must be a finite integer, e.g. ifactor(360)'],
  ])('%s is refused', async (problem, reason) => {
    const r = await computeHandler({ problem });
    const text = allText(r);
    expect(r.isError, text).toBe(true);
    expect(text).toContain(reason);
  });

  // Only a bare call is this route's: the rest of the expression used to be
  // dropped, so `ifactor(6)*2` answered 2*3 and `isprime(7)+1` answered 7.
  it.each([
    ['ifactor(6)*2', '12'],
    ['ifactor(2)/3', '2/3'],
  ])('%s is evaluated whole, as %s', async (problem, expected) => {
    const r = await computeHandler({ problem });
    const text = allText(r);
    expect(r.isError, text).toBe(false);
    expect(text).toMatch(resultLine(expected));
  });

  // At the depth bound itself the argument is still read, and read exactly.
  it('evaluates an argument 100 brackets deep', async () => {
    const problem = `ifactor(${'('.repeat(100)}2^8+1${')'.repeat(100)})`;
    const r = await computeHandler({ problem });
    const text = allText(r);
    expect(r.isError, text).toBe(false);
    expect(text).toMatch(resultLine('257'));
  });

  // The factorization is short; the integer quoted in the note is not.
  it('quotes a long evaluated integer in the note through excerpt', async () => {
    const r = await computeHandler({ problem: 'ifactor(3*2^900)' });
    const text = allText(r);
    expect(r.isError, text).toBe(false);
    expect(text).toMatch(resultLine('2^900*3'));
    expect(text.length).toBeLessThan(300);
  });
});
