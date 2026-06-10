import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { gradeV2, gradeV2Async } from '../benchmark/graders/grader-v2.js';
import { getDefaultGiacBridge } from '../benchmark/graders/giac-bridge.js';

let prev: string | undefined;
beforeAll(() => {
  prev = process.env.AXIOM_GRADER_V3;
  process.env.AXIOM_GRADER_V3 = '1';
});
afterAll(() => {
  if (prev === undefined) delete process.env.AXIOM_GRADER_V3;
  else process.env.AXIOM_GRADER_V3 = prev;
});

describe('candidate pipeline — sync composition', () => {
  it('recovers ODE answer with label and +C: "y = x^2 + C" vs "x^2"', () => {
    expect(gradeV2('y = x^2 + C', 'x^2').match).toBe(true);
  });

  it('guard: wrong RHS stays wrong through every transform', () => {
    expect(gradeV2('y = x^3 + C', 'x^2').match).toBe(false);
  });

  it('golden invariant: "x = 5" vs scalar "5" still fails', () => {
    expect(gradeV2('x = 5', '5').match).toBe(false);
  });

  it('recovers big-O tail behind an equation prefix (truncated paren)', () => {
    expect(
      gradeV2(
        '\\sin(x) = x - \\frac{x^3}{6} + \\frac{x^5}{120} + \\mathcal{O}(x^7',
        'x-x^3/6+x^5/120'
      ).match
    ).toBe(true);
  });

  it('guard: big-O strip cannot fix a wrong coefficient', () => {
    expect(
      gradeV2(
        '\\sin(x) = x - \\frac{x^3}{3} + \\frac{x^5}{120} + \\mathcal{O}(x^7',
        'x-x^3/6+x^5/120'
      ).match
    ).toBe(false);
  });

  it('recovers "x + 1 \\text{ for } x \\neq 1" vs "x+1"', () => {
    expect(gradeV2('x + 1 \\text{ for } x \\neq 1', 'x+1').match).toBe(true);
  });

  it('recovers "\\lambda = i \\text{ and } \\lambda = -i" vs "i,-i"', () => {
    expect(gradeV2('\\lambda = i \\text{ and } \\lambda = -i', 'i,-i').match).toBe(true);
  });
});

describe('candidate pipeline — symbolic equivalence reaches candidates', () => {
  it("verifies f'(x)-labeled derivative via Giac", async () => {
    const bridge = await getDefaultGiacBridge();
    const giacEval = (e: string) => bridge.evaluate(e);
    const r = await gradeV2Async("f'(x) = \\dfrac{-4x}{(x^2-1)^2}", '-4*x/(x^2-1)^2', {
      giacEval,
    });
    expect(r.match).toBe(true);
  }, 30000);

  it('verifies restated-LHS partial fractions via Giac', async () => {
    const bridge = await getDefaultGiacBridge();
    const giacEval = (e: string) => bridge.evaluate(e);
    const r = await gradeV2Async(
      '\\dfrac{1}{x^2-1} = \\dfrac{1}{2(x-1)} - \\dfrac{1}{2(x+1)}',
      '1/(2*(x-1))-1/(2*(x+1))',
      { giacEval }
    );
    expect(r.match).toBe(true);
  }, 30000);

  it('guard: symbolic stage cannot pass a wrong labeled answer', async () => {
    const bridge = await getDefaultGiacBridge();
    const giacEval = (e: string) => bridge.evaluate(e);
    const r = await gradeV2Async("f'(x) = \\dfrac{-3x}{(x^2-1)^2}", '-4*x/(x^2-1)^2', {
      giacEval,
    });
    expect(r.match).toBe(false);
  }, 30000);
});
