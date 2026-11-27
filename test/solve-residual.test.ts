import { describe, it, expect, beforeAll } from 'vitest';
import { giacEngine } from '../src/server/giac/index.js';
import { computeHandler } from '../src/server/tools/compute/index.js';
import { verifySolveSet, verifySystem } from '../src/server/tools/self-verify.js';
import { allText } from './helpers/all-text.js';

/**
 * How the substitution check reads a residual.
 *
 * It used to `parseFloat` the evalf'd residual. For `solve(x*k=2, x)` that
 * residual prints as `2.0/k*k-2.0`, which parseFloat reads as 2, so a correct
 * answer came back "Verified: ✗", while `k*x=2` (residual printed with a letter
 * first) verified ✓. The same prefix read would certify `1e-12+k` as a root of
 * `x=0`. A residual is now simplified exactly, read whole, and anything still
 * symbolic is undecided: no Verified line, never ✓ and never ✗.
 */

beforeAll(async () => {
  await giacEngine.initialize();
}, 60000);

async function solveText(problem: string): Promise<string> {
  return allText(await computeHandler({ problem }));
}

describe('solve: a parameterised root substitutes back exactly', () => {
  it.each(['solve(x*k=2, x)', 'solve(k*x=2, x)'])('%s answers 2/k and verifies ✓', async (p) => {
    const text = await solveText(p);
    expect(text).toContain('Result: 2/k');
    expect(text).toContain('Verified: ✓ (substitution: 1/1 roots satisfy the equation)');
  });

  it('solve(a*x^2=b, x) answers ±√(a*b)/a and verifies both roots ✓', async () => {
    const text = await solveText('solve(a*x^2=b, x)');
    expect(text).toContain('Result: {√(a*b)/a, -√(a*b)/a}');
    expect(text).toContain('Verified: ✓ (substitution: 2/2 roots satisfy the equation)');
  });
});

describe('verifySolveSet: residual verdicts', () => {
  it('verifies the exact parameterised root 2/k of x*k=2', async () => {
    expect(await verifySolveSet('x*k=2', 'x', ['2/k'])).toEqual({
      verified: true,
      method: 'substitution',
      detail: '1/1 roots satisfy the equation',
    });
  });

  it('disproves 3/k as a root of x*k=2: the residual simplifies to 1', async () => {
    expect((await verifySolveSet('x*k=2', 'x', ['3/k']))?.verified).toBe(false);
  });

  it('disproves a wrong numeric root: 3^2-4 = 5', async () => {
    const v = await verifySolveSet('x^2=4', 'x', ['2', '3']);
    expect(v).toEqual({
      verified: false,
      method: 'substitution',
      detail: '1/2 roots satisfy the equation',
    });
  });

  it('disproves a wrong complex root: (1+i)^2+1 = 1+2i, |1+2i| = √5', async () => {
    expect((await verifySolveSet('x^2+1', 'x', ['1+i']))?.verified).toBe(false);
  });

  it('disproves a root at a pole: 1/x at x=0 is infinite', async () => {
    expect((await verifySolveSet('1/x=1', 'x', ['0']))?.verified).toBe(false);
  });

  it('gives no verdict for 1e-12+k as a root of x=0, not ✓ by its leading digits', async () => {
    // parseFloat read `1e-12+k` as 1e-12, inside the tolerance.
    expect(await verifySolveSet('x=0', 'x', ['1e-12+k'])).toBeUndefined();
  });

  it('gives no verdict for a residual that stays symbolic (1-k)', async () => {
    expect(await verifySolveSet('x=k', 'x', ['1'])).toBeUndefined();
  });

  it('gives no verdict when one root is proven and another undecided', async () => {
    expect(await verifySolveSet('x^2=4', 'x', ['2', 'k'])).toBeUndefined();
  });

  it('still disproves when one root is wrong and another undecided', async () => {
    expect(await verifySolveSet('x^2=4', 'x', ['3', 'k'])).toEqual({
      verified: false,
      method: 'substitution',
      detail: '0/2 roots satisfy the equation; 1 undecided',
    });
  });
});

describe('verifySystem: residual verdicts', () => {
  it('verifies a parameterised tuple: (k+1)/2 + (k-1)/2 = k and their difference is 1', async () => {
    expect(await verifySystem(['x+y=k', 'x-y=1'], ['x', 'y'], ['k/2+1/2', 'k/2-1/2'])).toEqual({
      verified: true,
      method: 'substitution',
      detail: '2/2 equations satisfied',
    });
  });

  it('gives no verdict for a residual that stays symbolic (3-k)', async () => {
    expect(await verifySystem(['x+y=k'], ['x', 'y'], ['1', '2'])).toBeUndefined();
  });
});
