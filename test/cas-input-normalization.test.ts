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
  ])('%s evaluates the exponent as written', async (problem, expected) => {
    const r = await computeHandler({ problem });
    const text = allText(r);
    expect(r.isError, text).toBe(false);
    expect(text).toMatch(new RegExp(`^Result: ${expected.replace(/[*/^()]/g, '\\$&')}$`, 'm'));
  });

  // Where no reading is right, the answer has to be an error — each of these
  // came back as a success before, either as a free symbol or, for `x⁻¹y`,
  // written bare, as `1/x^y`.
  it.each([['simplify(x⁼)'], ['simplify(x⁻)'], ['simplify(x⁻¹y)']])(
    '%s is refused rather than answered',
    async (problem) => {
      const r = await computeHandler({ problem });
      expect(r.isError, allText(r)).toBe(true);
    }
  );
});

describe('verify tool — input unicode normalization', () => {
  it('reads a multi-digit superscript as one exponent', async () => {
    const r = await verifyHandler({ claim: '2²³ = 8388608' });
    expect(allText(r)).toContain('Verified: TRUE ✓');
  });

  it('verifies an identity written with unicode glyphs', async () => {
    const r = await verifyHandler({ claim: 'x² = x·x' });
    expect(allText(r)).toContain('Verified: TRUE ✓');
  });
});
