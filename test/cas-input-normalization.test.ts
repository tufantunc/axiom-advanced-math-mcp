import { describe, it, expect, beforeAll } from 'vitest';
import { giacEngine } from '../src/server/giac/index.js';
import { evalWithLatex } from '../src/server/tools/giac-eval.js';
import { computeHandler } from '../src/server/tools/compute/index.js';
import { verifyHandler } from '../src/server/tools/verify/index.js';

beforeAll(async () => {
  await giacEngine.initialize();
}, 60000);

function allText(r: { content: { text: string }[] }): string {
  return r.content.map((c) => c.text).join('\n');
}

describe('evalWithLatex — input unicode normalization', () => {
  it('normalizes a superscript in giacExpr (no micro corruption)', async () => {
    const r = await evalWithLatex({ giacExpr: 'factor(x²-4)', operation: 'factor' });
    const text = allText(r);
    expect(text).toContain('Result: (x-2)*(x+2)');
    expect(text).not.toContain('micro');
  });
  it('normalizes a middot in giacExpr (no undef)', async () => {
    const r = await evalWithLatex({ giacExpr: 'simplify(2·x)', operation: 'simplify' });
    expect(allText(r)).toContain('Result: 2*x');
  });
});

describe('compute end-to-end — input unicode normalization', () => {
  it('factor(x²-4) via computeHandler resolves correctly', async () => {
    const r = await computeHandler({ problem: 'factor(x²-4)' });
    const text = allText(r);
    expect(text).toContain('(x-2)*(x+2)');
    expect(text).not.toContain('micro');
  });
});

// Through the real engine, because the defect was in what Giac SAW: a unit
// test of the string cannot show that `^` is right-associative there, which is
// what turned `10⁸⁰` into 10 rather than into an error.
describe('compute end-to-end — superscript runs', () => {
  it.each([
    ['simplify(10⁸⁰)', `1${'0'.repeat(80)}`],
    // 2^23, not 2^(2^3) = 256 (what it answered) nor (2^2)^3 = 64.
    ['simplify(2²³)', '8388608'],
    ['simplify(x⁻¹)', '1/x'],
    ['simplify(xⁿ⁺¹/xⁿ)', 'x'],
    // Not `2*i`, which is what the unmapped glyph answered.
    ['simplify(2ⁱ)', '2^(i)'],
    // Not the free symbol `x^ni`.
    ['simplify(xⁿⁱ)', 'x^(i*n)'],
    // Not `bitxor(x,2)`, which the doubled caret answered.
    ['simplify(x^²)', 'x^2'],
    // A bracket or digit after the run is a factor, not part of the exponent:
    // not `2^(-y-1)`, not `1/x^12`.
    ['simplify(2⁻¹(y+1))', '(y+1)/2'],
    ['simplify((x+1)⁻¹(x-1))', '(x-1)/(x+1)'],
    ['simplify(x⁻¹2)', '2/x'],
    // A word operator after the run is an operator: not `undef % 7`, not 0,
    // not an `undef` set expression.
    ['simplify(3⁻¹ mod 7)', '-2 % 7'],
    ['simplify(2⁻¹ in [1/2,1])', '1'],
    ['simplify(x⁻¹ union y)', '(1/x) union y'],
    // A range, not `0 .. 1/1000`.
    ['simplify(10⁻³..1)', '(1/1000) .. 1'],
    ['integrate(x, x=10⁻³..1)', '999999/2000000'],
  ])('%s evaluates the exponent as written', async (problem, expected) => {
    const r = await computeHandler({ problem });
    const text = allText(r);
    expect(r.isError, text).toBe(false);
    expect(text).toMatch(
      new RegExp(`^Result: ${expected.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`, 'm')
    );
  });

  // Where this cannot tell a reading from a wrong one, the answer has to be an
  // error. `x⁼` came back as a free symbol; a letter after the run is either a
  // factor or an operator, and Giac refuses the factor.
  it.each([
    ['simplify(x⁼)'],
    ['simplify(x⁻¹y)'],
    ['simplify(x⁻¹ y)'],
    ['simplify(x⁻¹θ)'],
    ['simplify(xⁿ⁺¹y)'],
    ['simplify(x⁻¹𝑦)'],
    ['simplify(x⁻¹Y)'],
    ['simplify(2⁻¹ Pi)'],
    // Superscript brackets are not read (see unicodeToAscii): each of these
    // answered a clean-looking wrong result, verified, while they were.
    ['desolve(y⁽³⁾=0, y)'],
    ['desolve(y⁽¹⁾³=x, y)'],
    ['simplify((a+b)⁽²⁾)'],
  ])('%s is refused rather than answered', async (problem) => {
    const r = await computeHandler({ problem });
    expect(r.isError, allText(r)).toBe(true);
  });
});

// `f⁻¹(x)` reaches Giac as it did on main (see unicodeToAscii), so whatever
// Giac answers shows that it failed — an error or the glyph — and is not one
// of the clean products the written `*` gave.
describe('compute end-to-end — inverse-function notation', () => {
  it.each([
    ['simplify(f⁻¹(x))', 'x/f'],
    ['diff(g⁻¹(t), t)', '1/g'],
    ['simplify(f⁻¹(x) + sin(x)^2 + cos(x)^2 - 1 + tan(x)*cos(x) - sin(x))', 'x/f'],
    ['simplify(f10⁻¹(x))', 'x/f10'],
    ['simplify((f⁺)(x) - (f⁻)(x))', '0'],
  ])('%s is not answered as %s', async (problem, wrong) => {
    const text = allText(await computeHandler({ problem }));
    expect(text).not.toMatch(new RegExp(`^Result: ${wrong.replace('/', '\\/')}$`, 'm'));
    expect(text).toMatch(/^(Result: .*(⁻|undef)|Error: )/m);
  });
});

describe('verify tool — input unicode normalization', () => {
  // Sent raw, `¹` lexes as `undef` and drops the name, so both sides became
  // one `undef(y)` and these were verified with high confidence.
  it.each([
    ['sin⁻¹(x) = cos⁻¹(x)'],
    ['x⁻¹(y) = z⁻¹(y)'],
    ['x⁻¹(y) = x⁺¹(y)'],
    ['x⁻¹√(x) = x⁻¹(√x)'],
    // An exponent ending in a sign has no operand; mapped, `^(+)` is `undef`,
    // and `(f^(+))(x)` and `(f^(-))(x)` were one `undef(x)`.
    ['(f⁺)(x) = (f⁻)(x)'],
    ['(x⁻)(y) = (z⁻)(y)'],
    ['(fⁿ⁻)(x) = (gⁿ⁺)(x)'],
  ])('does not verify %s', async (claim) => {
    const text = allText(await verifyHandler({ claim }));
    expect(text).not.toContain('Verified: TRUE');
  });

  it('reads a multi-digit superscript as one exponent', async () => {
    const r = await verifyHandler({ claim: '2²³ = 8388608' });
    expect(allText(r)).toContain('Verified: TRUE ✓');
  });

  it('verifies an identity written with unicode glyphs', async () => {
    const r = await verifyHandler({ claim: 'x² = x·x' });
    expect(allText(r)).toContain('Verified: TRUE ✓');
  });
});
