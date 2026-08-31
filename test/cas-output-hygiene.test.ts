import { describe, it, expect, beforeAll } from 'vitest';
import { giacEngine } from '../src/server/giac/index.js';
import { evalWithLatex, toLatex } from '../src/server/tools/giac-eval.js';
import { tryExactResult } from '../src/server/tools/exact-arithmetic.js';
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

describe('LaTeX display-mode hygiene on the live path', () => {
  // giac-eval.ts strips \dfrac -> \frac and removes \displaystyle/\textstyle
  // before emitting the LaTeX line. Nothing asserted that until now — the only
  // test that ever mentioned \dfrac exercised a private copy inside a handler
  // that has since been deleted as dead code.
  //
  // Honest scope note: with the bundled Giac build, `latex(2/17)` already
  // returns \frac (verified), so the \dfrac branch specifically looks
  // unreachable today and this test cannot prove it fires. What it does pin is
  // the observable contract — a LaTeX line IS emitted, and it carries no
  // display-mode markers — which is what breaks if the stripping is dropped and
  // Giac's output ever changes.
  it('emits a LaTeX line with no display-mode markers', async () => {
    const result = await evalWithLatex({ giacExpr: 'simplify(2/17)', operation: 'simplify' });
    const text = allText(result);

    const latexLine = text.split('\n').find((l) => l.startsWith('LaTeX: '));
    // Positive control: without this the assertions below pass vacuously on a
    // response that emitted no LaTeX at all.
    expect(latexLine, `no LaTeX line in:\n${text}`).toBeDefined();

    expect(latexLine).toContain('\\frac');
    for (const marker of ['\\dfrac', '\\displaystyle', '\\textstyle']) {
      expect(latexLine, marker).not.toContain(marker);
    }
  });
});

describe('toLatex strips the quotes Giac wraps latex() output in', () => {
  // Giac returns latex() results wrapped in literal double quotes — verified:
  // `latex(1/3)` -> "\"\\frac{1}{3}\"". stripQuotes is therefore load-bearing,
  // and one of the three former inline copies of this pipeline omitted it, so
  // `compute "sqrt(8)" --latex` shipped `LaTeX: "2\cdot \sqrt{2}"` with the
  // quotes included. These pin the quote-free property on the composed paths,
  // not just on stripQuotes in isolation.
  it('returns LaTeX with no surrounding quote characters', async () => {
    const latex = await toLatex('1/3');
    expect(latex, 'Giac produced no LaTeX at all').toBeDefined();
    expect(latex).toBe('\\frac{1}{3}');
    expect(latex).not.toContain('"');
  });

  it('the exact-value path emits quote-free LaTeX', async () => {
    // tryExactResult's Giac fallback is the path that had the missing step.
    // sqrt(8) takes it; a plain rational takes a hand-built fast path instead.
    const exact = await tryExactResult('sqrt(8)', Math.sqrt(8));
    expect(exact, 'no exact result for sqrt(8)').toBeTruthy();
    expect(exact?.latex, 'no LaTeX on the exact result').toBeDefined();
    expect(exact?.latex).not.toContain('"');
  });
});
