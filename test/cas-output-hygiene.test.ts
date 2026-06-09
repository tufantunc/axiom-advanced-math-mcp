import { describe, it, expect, beforeAll } from 'vitest';
import { giacEngine } from '../src/server/giac/index.js';
import { evalWithLatex } from '../src/server/tools/giac-eval.js';
import { solveEquationHandler, solveSystemHandler } from '../src/server/tools/solve.js';
import { computeHandler } from '../src/server/tools/compute/index.js';

beforeAll(async () => {
  await giacEngine.initialize();
}, 60000);

function allText(r: { content: { text: string }[] }): string {
  return r.content.map((c) => c.text).join('\n');
}

describe('evalWithLatex — generic output hygiene', () => {
  it('A: strips surrounding quotes from latex() output', async () => {
    const r = await evalWithLatex({ giacExpr: 'factor(x^2-4)', operation: 'factor' });
    const text = allText(r);
    expect(text).toMatch(/LaTeX: /);
    expect(text).not.toContain('LaTeX: "');
  });

  it('B: strips the order_size big-O remainder from a series', async () => {
    const r = await evalWithLatex({ giacExpr: 'series(exp(x),x,0,4)', operation: 'series' });
    const text = allText(r);
    expect(text).not.toContain('order_size');
    expect(text).toContain('Result: 1+x+1/2*x^2+1/6*x^3+1/24*x^4');
  });

  it('applies an optional resultTransform before formatting', async () => {
    const r = await evalWithLatex({
      giacExpr: 'solve(x^4-16,x)',
      operation: 'solve',
      resultTransform: () => 'TRANSFORMED',
    });
    expect(allText(r)).toContain('Result: TRANSFORMED');
  });

  it('does not cross-contaminate cache between raw and transformed calls', async () => {
    const raw = await evalWithLatex({ giacExpr: 'solve(x^2-9,x)', operation: 'solve' });
    const transformed = await evalWithLatex({
      giacExpr: 'solve(x^2-9,x)',
      operation: 'solve',
      resultTransform: () => 'XFORM',
    });
    expect(allText(raw)).toContain('Result: list[-3,3]');
    expect(allText(transformed)).toContain('Result: XFORM');
  });
});

describe('solve handlers — list→set normalization (D)', () => {
  it('renders two roots as a set', async () => {
    const r = await solveEquationHandler({ equation: 'x^2-4', variable: 'x' });
    expect(allText(r)).toContain('Result: {-2, 2}');
  });
  it('renders a single root bare', async () => {
    const r = await solveEquationHandler({ equation: 'x-3', variable: 'x' });
    expect(allText(r)).toContain('Result: 3');
  });
  it('renders a system solution as a tuple', async () => {
    const r = await solveSystemHandler({
      equations: ['x+y=3', 'x-y=1'],
      variables: ['x', 'y'],
    });
    expect(allText(r)).toContain('Result: (2, 1)');
  });
  it('keeps a valid latex for a solved set (derived from raw, not undef)', async () => {
    const r = await solveEquationHandler({ equation: 'x^2-4', variable: 'x' });
    const text = allText(r);
    expect(text).not.toContain('undef');
    expect(text).toMatch(/LaTeX: .*-2/);
  });
});

describe('compute json envelope — solution set parsing (D)', () => {
  it('parses a two-root solve into two structured solutions', async () => {
    const r = await computeHandler({ problem: 'solve(x^2-4,x)', format: 'json' });
    const env = JSON.parse(allText(r));
    expect(env.data.count).toBe(2);
    expect(env.data.solutions).toEqual(['-2', '2']);
  });
});
