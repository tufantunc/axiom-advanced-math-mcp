import { describe, it, expect, beforeAll } from 'vitest';
import { giacEngine } from '../src/server/giac/index.js';
import { evalWithLatex } from '../src/server/tools/giac-eval.js';

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
      giacExpr: 'solve(x^2-4,x)',
      operation: 'solve',
      resultTransform: () => 'TRANSFORMED',
    });
    expect(allText(r)).toContain('Result: TRANSFORMED');
  });
});
