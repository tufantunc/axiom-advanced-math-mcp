import { describe, it, expect, beforeAll } from 'vitest';
import { giacEngine } from '../src/server/giac/index.js';
import { evalWithLatex } from '../src/server/tools/giac-eval.js';
import { computeHandler } from '../src/server/tools/compute/index.js';
import { verifyHandler } from '../src/server/tools/verify/index.js';
import { resultLine } from './helpers/result-line.js';

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
    expect(text).toMatch(resultLine(expected));
  });

  // Where this cannot tell a reading from a wrong one, the answer has to be an
  // error: a letter after the run is either a factor or an operator, and Giac
  // refuses the factor.
  it.each([
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

// A run with no confident reading is refused with a message that names it:
// each of these was a clean wrong answer under some reading — `2ⁱ²` answered
// -2, the limit answered 1, `f⁻¹(x)` answered `x/f`.
describe('compute end-to-end — ambiguous superscripts are refused', () => {
  it.each([
    ['simplify(2ⁱ²)', 'ⁱ²'],
    ['simplify(2ⁿ²)', 'ⁿ²'],
    ['simplify(x⁻ⁿ²)', '⁻ⁿ²'],
    ['limit(x⁻¹ sin(2*x), x, 0)', '⁻¹'],
    ['limit(x⁻² sin(x), x, 0)', '⁻²'],
    ['simplify(x⁻¹ sin(x))', '⁻¹'],
    ['simplify(f⁻¹(x))', '⁻¹'],
    ['simplify(f ⁻¹(x))', '⁻¹'],
    ['diff(g⁻¹(t), t)', '⁻¹'],
    ['simplify(x⁻¹(y+1))', '⁻¹'],
    ['simplify((f⁺)(x) - (f⁻)(x))', '⁺'],
    ['simplify(x⁻)', '⁻'],
    ['limit(1/x, x, 0⁻)', '⁻'],
    // Two runs split only by spaces, and digits printed into a run's exponent.
    ['simplify(x⁻¹ ⁿ)', '⁻¹'],
    ['simplify(x² ⁻¹(z))', '²'],
    ['simplify(x²12 ⁻¹(z))', '⁻¹'],
    // A name of any length: bounded to 64, a longer one read as no name.
    [`simplify(x⁻¹ ${'a'.repeat(70)}(x))`, '⁻¹'],
  ])('%s is refused, naming %s', async (problem, run) => {
    const r = await computeHandler({ problem });
    const text = allText(r);
    expect(r.isError, text).toBe(true);
    expect(text).toMatch(/^Error: .*superscript .* has more than one reading/m);
    expect(text).toContain(`\`${run}\``);
  });

  // A lone sign is a one-sided limit point more often than anything: the
  // refusal says how to write the direction, and that spelling works.
  it('points a one-sided limit at the direction argument', async () => {
    const refused = allText(await computeHandler({ problem: 'limit(x*ln(x), x, 0⁺)' }));
    expect(refused).toContain('limit(f, x, a, +)');
    const r = await computeHandler({ problem: 'limit(1/x, x, 0, +)' });
    expect(r.isError, allText(r)).toBe(false);
    expect(allText(r)).toMatch(resultLine('+infinity'));
  });

  // Not refused, and not answered either: `π` ends at the run after it, so
  // Giac gets `x^(n)pi^2(y)` and rejects the juxtaposition. While the name
  // read on through `²`, this answered `(xⁿpi^y)^2` as a success.
  it('lets Giac refuse xⁿπ²(y) rather than answering it', async () => {
    const r = await computeHandler({ problem: 'simplify(xⁿπ²(y))' });
    expect(r.isError, allText(r)).toBe(true);
    expect(allText(r)).not.toMatch(/superscript/);
  });

  // In json, the refusal is the envelope every other failure is.
  it('refuses in the json envelope when json is asked for', async () => {
    const r = await computeHandler({ problem: 'simplify(2ⁱ²)', format: 'json' });
    expect(r.isError).toBe(true);
    const body = JSON.parse(allText(r)) as { success: boolean; display: string };
    expect(body.success).toBe(false);
    expect(body.display).toContain('`ⁱ²`');
  });

  // The glyphs that are NOT runs keep reaching Giac as glyphs, where each of
  // these answered a clean wrong result while they were mapped.
  it.each([
    ['simplify(x⁼⁼)', 'x'],
    ['simplify(2⁼¹¹)', '2048'],
  ])('%s is not answered as %s', async (problem, wrong) => {
    const text = allText(await computeHandler({ problem }));
    expect(text).not.toMatch(resultLine(wrong));
    expect(text).toMatch(/^(Result: .*[⁰¹²³⁴-⁹⁺⁻⁼ⁱⁿ]|Error: )/mu);
  });

  // A call after an OPERATOR is not a call after the run.
  it('still answers x⁻¹ + sin(x)', async () => {
    const r = await computeHandler({ problem: 'simplify(x⁻¹ + sin(x))' });
    expect(r.isError, allText(r)).toBe(false);
    expect(allText(r)).toMatch(resultLine('(x*sin(x)+1)/x'));
  });
});

describe('verify tool — input unicode normalization', () => {
  // Not verified either way: unevaluated, with the run named.
  it.each([
    ['x⁻¹ sin(x) = x⁻¹ cos(x)', '⁻¹'],
    ['2ⁱ² = -2', 'ⁱ²'],
    ['limit(x⁻¹ sin(2*x), x, 0) = 1', '⁻¹'],
    ['f ⁻¹(x) = x/f', '⁻¹'],
    ['x⁻¹ f2(x) = x⁻¹ g2(x)', '⁻¹'],
    ['f_⁻¹(x) = x/f_', '⁻¹'],
    ['(f⁺)(x) = (f⁻)(x)', '⁺'],
    // Two runs split by a space: each of these verified.
    ['x⁻¹ ⁿ = 1/x', '⁻¹'],
    ['x² ⁻¹(z) = sqrt(x)*z', '²'],
    ['x²  ⁻¹(z) = sqrt(x)*z', '²'],
    ['x⁻¹\tⁿ = 1/x', '⁻¹'],
    ['x²12  ⁻¹(z) = z*x^(1/212)', '⁻¹'],
    // Names longer than any window: each verified while one bounded the look.
    [`x⁻¹ ${'a'.repeat(70)}(x) = x⁻¹ ${'b'.repeat(70)}(x)`, '⁻¹'],
    [`f${'1'.repeat(70)}⁻¹(x) = x/f${'1'.repeat(70)}`, '⁻¹'],
  ])('leaves %s unevaluated, naming %s', async (claim, run) => {
    const r = await verifyHandler({ claim, format: 'json' });
    const body = JSON.parse(allText(r)) as {
      verified: boolean;
      evaluated: boolean;
      confidence: string;
      checks_performed: string[];
      explanation: string;
    };
    expect(body.verified).toBe(false);
    expect(body.evaluated).toBe(false);
    expect(body.confidence).toBe('low');
    expect(body.checks_performed).toEqual(['superscript_reading']);
    expect(body.explanation).toMatch(/superscript .* has more than one reading/);
    expect(body.explanation).toContain(`\`${run}\``);
  });

  // Not refused, but not verified either: both sides are unreadable to Giac.
  // While the refusal and the normaliser disagreed, this got a verdict.
  it('leaves x⁻¹π²(2) = x⁻¹π²(3) unevaluated', async () => {
    const r = await verifyHandler({ claim: 'x⁻¹π²(2) = x⁻¹π²(3)', format: 'json' });
    const body = JSON.parse(allText(r)) as {
      verified: boolean;
      evaluated: boolean;
      checks_performed: string[];
    };
    expect(body).toMatchObject({ verified: false, evaluated: false });
    expect(body.checks_performed).not.toContain('superscript_reading');
  });

  it('says why in the text format too', async () => {
    const text = allText(await verifyHandler({ claim: '2ⁱ² = -2' }));
    expect(text).toContain('Verified: UNKNOWN');
    expect(text).toContain('Could not check the claim: the superscript `ⁱ²`');
  });

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
    // Joined, these glyphs spell Giac operators: `==`, `=nop`, `++`, `--`.
    ['x⁼⁼ = x'],
    ['x⁼² = x²'],
    ['2⁼¹¹ = 2048'],
    ['(f¹⁼⁼)(x) = (g¹⁼⁼)(x)'],
    ['(f⁺⁺ⁿ)(x) = (g⁺⁺ⁿ)(x)'],
    ['(f⁻⁻ⁿ)(x) = (g⁻⁻ⁿ)(x)'],
    ['(a+b)ⁿ⁺⁻¹(a+b) = (a+b)ⁿ'],
    ['(x+1)⁻⁻¹(x+1) = (x+1)²'],
    // A name CALL after the run: bracketed, `x^(-1) sin(x)` is `undef(x)`
    // inside a claim, and both sides were that one `undef(x)`.
    ['x⁻¹ sin(x) = x⁻¹ cos(x)'],
    ['x⁻² sin(x) = x⁻¹ sin(x)'],
    ['x⁻¹sin(x) = x⁻¹cos(x)'],
    ['x⁻¹ f(x) = x⁻¹ g(x)'],
    ['xⁿ⁺¹ sin(x) = xⁿ sin(x)'],
    // A space between the name and the run.
    ['f ⁻¹(x) = x/f'],
    // `ⁿ²`, read as the product n·2.
    ['2ⁿ² = 4ⁿ'],
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
