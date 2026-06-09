import { describe, it, expect, beforeAll } from 'vitest';
import { giacEngine } from '../src/server/giac/index.js';
import { evalWithLatex } from '../src/server/tools/giac-eval.js';
import type { VerificationResult } from '../src/server/tools/self-verify.js';
import { algebraHandler } from '../src/server/tools/algebra.js';
import { calculusHandler } from '../src/server/tools/calculus.js';
import { solveEquationHandler, solveSystemHandler, parseSolutions, parseTuple } from '../src/server/tools/solve.js';
import { computeHandler } from '../src/server/tools/compute/index.js';

beforeAll(async () => {
  await giacEngine.initialize();
}, 60000);

function allText(r: { content: { text: string }[] }): string {
  return r.content.map((c) => c.text).join('\n');
}

describe('evalWithLatex — verify callback + methodNote', () => {
  it('attaches verification from the verify callback', async () => {
    const r = await evalWithLatex({
      giacExpr: 'factor(x^2-4)',
      operation: 'factor',
      verify: async () => ({ verified: true, method: 'expand', detail: 'ok' }),
    });
    expect(allText(r)).toContain('Verified: ✓ (expand: ok)');
  });
  it('passes methodNote through', async () => {
    const r = await evalWithLatex({
      giacExpr: 'csolve(x^2+1,x)',
      operation: 'solve',
      methodNote: 'csolve (escalated)',
      verify: async () => ({ verified: true, method: 'substitution', detail: '2/2' }),
    });
    expect(allText(r)).toContain('Method: csolve (escalated)');
  });
  it('does not re-invoke verify on a cache hit', async () => {
    let calls = 0;
    const verifyFn = async (): Promise<VerificationResult> => {
      calls++;
      return { verified: true, method: 'expand', detail: 'x' };
    };
    await evalWithLatex({ giacExpr: 'simplify(2*x+3*x)', operation: 'simplify', verify: verifyFn });
    await evalWithLatex({ giacExpr: 'simplify(2*x+3*x)', operation: 'simplify', verify: verifyFn });
    expect(calls).toBe(1);
  });
});

describe('factor / integrate annotation', () => {
  it('factor: shows a verified line', async () => {
    const r = await algebraHandler({ operation: 'factor', expression: 'x^2-4' });
    expect(allText(r)).toContain('Verified: ✓ (expand:');
  });
  it('indefinite integrate: shows a verified line', async () => {
    const r = await calculusHandler({ operation: 'integrate', expression: '2*x', variable: 'x' });
    expect(allText(r)).toContain('Verified: ✓ (differentiation:');
  });
  it('definite integrate: no verification line', async () => {
    const r = await calculusHandler({
      operation: 'integrate',
      expression: 'x',
      variable: 'x',
      lower_bound: '0',
      upper_bound: '1',
    });
    expect(allText(r)).not.toContain('Verified:');
  });
  it('simplify: no verification line (not in scope)', async () => {
    const r = await algebraHandler({ operation: 'simplify', expression: 'x+x' });
    expect(allText(r)).not.toContain('Verified:');
  });
});

describe('solve escalation + verification (D + C)', () => {
  it('real roots verify with no escalation note', async () => {
    const r = await solveEquationHandler({ equation: 'x^2-4', variable: 'x' });
    const t = allText(r);
    expect(t).toContain('Result: {-2, 2}');
    expect(t).toContain('Verified: ✓ (substitution: 2/2 roots satisfy the equation)');
    expect(t).not.toContain('Method:');
  });
  it('escalates to csolve for complex-only roots', async () => {
    const r = await solveEquationHandler({ equation: 'x^2+1', variable: 'x' });
    const t = allText(r);
    expect(t).toContain('Result: {i, -i}');
    expect(t).toContain('Method: csolve');
    expect(t).toContain('Verified: ✓');
  });
  it('verifies a system solution tuple', async () => {
    const r = await solveSystemHandler({ equations: ['x+y=3', 'x-y=1'], variables: ['x', 'y'] });
    const t = allText(r);
    expect(t).toContain('Result: (2, 1)');
    expect(t).toContain('Verified: ✓');
  });
});

describe('solve parse helpers', () => {
  it('parseSolutions handles list[...] and bare [...] shapes', () => {
    expect(parseSolutions('list[-2,2]')).toEqual(['-2', '2']);
    expect(parseSolutions('list[i,-i]')).toEqual(['i', '-i']);
    expect(parseSolutions('[0.739085133215]')).toEqual(['0.739085133215']); // fsolve shape
    expect(parseSolutions('[]')).toEqual([]);
  });
  it('parseSolutions only strips the list[ wrapper, not a name starting with list', () => {
    expect(parseSolutions('listvar')).toEqual(['listvar']);
  });
  it('parseTuple parses a single tuple and rejects non-tuples', () => {
    expect(parseTuple('(2, 1)')).toEqual(['2', '1']);
    expect(parseTuple('{-2, 2}')).toEqual([]);
  });
});

describe('compute json envelope — verification field', () => {
  it('carries a verified status for a solved equation', async () => {
    const r = await computeHandler({ problem: 'solve(x^2-4,x)', format: 'json' });
    const env = JSON.parse(allText(r));
    expect(env.verification).toBeDefined();
    expect(env.verification.status).toBe('verified');
  });
});
