import { describe, it, expect, beforeAll } from 'vitest';
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

  it.each([
    ['isprime(2^5-1)', 'Prime: Yes', 'Euler totient φ(31): 30'],
    ['euler(3*4)', 'Prime: No', 'Euler totient φ(12): 4'],
  ])('%s analyses the integer it denotes', async (problem, prime, totient) => {
    const r = await computeHandler({ problem });
    const text = allText(r);
    expect(r.isError, text).toBe(false);
    expect(text).toContain(prime);
    expect(text).toContain(totient);
  });

  // Refused, not truncated or rounded.
  it.each([
    ['ifactor(3.5)', '3.5 is built from a decimal number'],
    ['isprime(7/2)', '7/2 is not an integer'],
    ['ifactor(foo)', 'foo is not an integer'],
    ['ifactor(x +)', 'x + is not an integer'],
    // analyzeNumberCore works in JS numbers, so it would report on 2^61 rounded.
    ['isprime(2^61-1)', '2305843009213693951 is too large to analyse exactly'],
    // Built from a float: the integer is an artifact of Giac's floats, not the
    // caller's number. floor(1e30) factored 999999999999998612509741285376.
    ['ifactor(2.0)', '2.0 is built from a decimal number'],
    ['ifactor(floor(1e30))', 'floor(1e30) is built from a decimal number'],
    ['isprime(12*0.5)', '12*0.5 is built from a decimal number'],
    // Bounded before evaluation: 2^100000 crashed the shared Giac worker, and
    // 10^(10^7) came back "not an integer" from Integer_too_large_for_display.
    ['ifactor(2^100000)', '2^100000 is too large to work with here'],
    ['isprime(10^(10^7))', '10^(10^7) is too large to work with here'],
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

  // The factorization is short; the integer quoted in the note is not.
  it('quotes a long evaluated integer in the note through excerpt', async () => {
    const r = await computeHandler({ problem: 'ifactor(3*2^900)' });
    const text = allText(r);
    expect(r.isError, text).toBe(false);
    expect(text).toMatch(resultLine('2^900*3'));
    expect(text.length).toBeLessThan(300);
  });
});
