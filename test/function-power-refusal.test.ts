import { describe, it, expect, beforeAll } from 'vitest';
import { giacEngine } from '../src/server/giac/index.js';
import { computeHandler } from '../src/server/tools/compute/index.js';
import { verifyHandler } from '../src/server/tools/verify/index.js';
import {
  functionPowerRefusal,
  superscriptRefusal,
  unicodeToAscii,
} from '../src/server/tools/unicode-normalize.js';
import { allText } from './helpers/all-text.js';
import { resultLine } from './helpers/result-line.js';

/**
 * Two notations Giac reads as something other than what the caller wrote.
 *
 * `sin^2(x)` (and `sin²(x)`) is a power of the FUNCTION to Giac, not of its
 * value. Before the refusal: `limit(sin^2(x), x, 0)` answered a lambda,
 * `simplify(sin^2(x))` the lambda `(x)->(sin(x)^x)^2`, `integrate(sin^2(x), x)`
 * shipped a GIAC_ERROR as its Result, and verify refuted `sin²(x)+cos²(x)=1` —
 * all with isError:false.
 *
 * `eˣ` is a modifier letter, not a superscript: it reached Giac as part of an
 * identifier, so `diff(eˣ, x)` answered 0 and `integrate(x·eˣ, x)` answered
 * `eˣ*x^2/2`.
 */
beforeAll(async () => {
  await giacEngine.initialize();
}, 60000);

describe('function powers', () => {
  it.each([
    ['integrate(sin^2(x), x)', 'sin', 'sin(x)^2, and its inverse as asin(x)'],
    ['limit(sin²(x), x, 0)', 'sin', 'sin(x)^2, and its inverse as asin(x)'],
    ['simplify(sin**2(x))', 'sin', 'sin(x)^2'],
    ['diff(cos^3(x), x)', 'cos', 'cos(x)^3'],
    ['sin^(2)(x)', 'sin', 'sin(x)^(2)'],
    ['sin^-1(x)', 'sin', 'sin(x)^-1, and its inverse as asin(x)'],
    // Hyperbolic names, spaces around the caret, and the argument without
    // brackets, which Giac reads the same way.
    ['diff(sinh^2(x), x)', 'sinh', 'sinh(x)^2, and its inverse as asinh(x)'],
    ['sin ^ 2 (x)', 'sin', 'sin(x)^2'],
    ['integrate(sin^2 x, x)', 'sin', 'sin(x)^2'],
    ['simplify(sin^2x)', 'sin', 'sin(x)^2'],
    // Beyond the trigonometric names: each of these answered a lambda.
    ['limit(asec^2(x), x, 2)', 'asec', 'asec(x)^2'],
    ['simplify(log10^2(x))', 'log10', 'log10(x)^2'],
    ['simplify(abs^2(x))', 'abs', 'abs(x)^2'],
  ])('%s is refused', async (problem, name, fix) => {
    const r = await computeHandler({ problem });
    const text = allText(r);
    expect(r.isError, text).toBe(true);
    expect(text).toContain(`raises the function ${name}, not its value — write the power after`);
    expect(text).toContain(`e.g. ${fix}`);
  });

  // The inverse is named only where it exists: log^-1 is not alog.
  it.each([
    ['log^2(x)', 'log(x)^2'],
    ['ln^2(x)', 'ln(x)^2'],
  ])('names no inverse for %s', async (problem, fix) => {
    const text = allText(await computeHandler({ problem }));
    expect(text).toContain(`e.g. ${fix}`);
    expect(text).not.toContain('inverse');
  });

  it.each([
    ['integrate(sin(x)^2, x)', '1/2*x-1/4*sin(2*x)'],
    ['limit(sin(x)^2/x^2, x, 0)', '1'],
    ['diff(exp(x)^2, x)', '2*exp(x)*exp(x)'],
  ])('%s, the power after the call, is answered', async (problem, expected) => {
    const r = await computeHandler({ problem });
    const text = allText(r);
    expect(r.isError, text).toBe(false);
    expect(text).toMatch(resultLine(expected));
  });

  // Verify gets the same rule as compute: unevaluated, never a refutation.
  it('leaves sin²(x)+cos²(x)=1 unevaluated rather than refuting it', async () => {
    const text = allText(await verifyHandler({ claim: 'sin²(x)+cos²(x)=1' }));
    expect(text).toContain('Verified: UNKNOWN');
    expect(text).toContain('raises the function sin, not its value');
    expect(text).not.toContain('FALSE');
    const written = allText(await verifyHandler({ claim: 'sin(x)^2+cos(x)^2=1' }));
    expect(written).toContain('Verified: TRUE');
    // A true identity that was refuted as FALSE through a name outside sin/cos.
    const asec = allText(await verifyHandler({ claim: 'asec^2(x)=acos(1/x)^2' }));
    expect(asec).toContain('Verified: UNKNOWN');
    expect(asec).not.toContain('FALSE');
  });

  it.each([
    'sin(x)^2',
    'x^2*sin(x)',
    '2^sin(x)',
    'asinc(x)',
    // A name that merely ends like a function is not one.
    'basin^2(x)',
  ])('reads %s as written', (text) => {
    expect(functionPowerRefusal(unicodeToAscii(text))).toBeUndefined();
  });
});

describe('superscript letters', () => {
  // `ˣ ʸ` are spacing modifier letters, `ᵃ` a phonetic one.
  it.each(['diff(eˣ, x)', 'integrate(x·eˣ, x)', 'simplify(xʸ)', 'diff(eᵃ, x)'])('%s is refused', async (problem) => {
    const r = await computeHandler({ problem });
    const text = allText(r);
    expect(r.isError, text).toBe(true);
    expect(text).toContain('is not read as an exponent — write the exponent with ^ instead');
  });

  it('leaves eˣ=2 unevaluated in verify', async () => {
    const text = allText(await verifyHandler({ claim: 'eˣ=2' }));
    expect(text).toContain('Verified: UNKNOWN');
    expect(text).toContain('the superscript letter `ˣ` is not read as an exponent');
  });

  // U+1D62–U+1D6A, beside the phonetic superscripts, are SUBSCRIPTS: `xᵢ` is a
  // variable, and Giac answers it.
  it('leaves a subscript letter alone', async () => {
    expect(superscriptRefusal('xᵢ+1')).toBeUndefined();
    expect(superscriptRefusal('aᵦ*aᵦ')).toBeUndefined();
    const text = allText(await computeHandler({ problem: 'simplify(xᵢ+xᵢ)' }));
    expect(text).toMatch(resultLine('2*xᵢ'));
  });

  // ⁿ and ⁱ are in the Superscripts block and still read as exponents.
  it('still maps ⁿ', async () => {
    expect(superscriptRefusal('xⁿ*x')).toBeUndefined();
    const text = allText(await computeHandler({ problem: 'simplify(xⁿ*x)' }));
    expect(text).toMatch(resultLine('x^(n+1)'));
  });
});
