import { describe, it, expect, beforeAll } from 'vitest';
import { giacEngine } from '../src/server/giac/index.js';
import { computeHandler } from '../src/server/tools/compute/index.js';
import { solveSystemHandler } from '../src/server/tools/solve.js';
import {
  substitutionResidual,
  verifySolveSet,
  verifySystem,
  verifySystemSolutions,
} from '../src/server/tools/self-verify.js';
import { verifyHandler } from '../src/server/tools/verify/index.js';
import { allText } from './helpers/all-text.js';

/**
 * How a substitution residual is read — by solve's self-check and by the
 * verify tool, which share one reader (substitutionResidual).
 *
 * It used to `parseFloat` the evalf'd residual. For `solve(x*k=2, x)` that
 * residual prints as `2.0/k*k-2.0`, which parseFloat reads as 2, so a correct
 * answer came back "Verified: ✗" (and `verify` called `x=2/k satisfies x*k=2`
 * FALSE), while `k*x=2` — residual printed letter-first — verified ✓. Now the
 * residual is read whole, simplified exactly when it still has a symbol, and
 * otherwise disproved only when it stays clear of zero at every sampled value
 * of its parameters. What is left is undecided: no Verified line from solve,
 * UNKNOWN from verify — never ✓/TRUE, and never ✗ by its leading digits.
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

  // The second root, (1-√(4k+1))/2, is a root only for -1/4 ≤ k ≤ 0: at k=13/10
  // it is -0.745 and √(x+k) = 0.745 ≠ x. Main reported this ✗; an "undecided"
  // reading of every symbolic residual had silently dropped the mark.
  it('solve(sqrt(x+k)=x, x) still disproves the extraneous root ✗', async () => {
    const text = await solveText('solve(sqrt(x+k)=x, x)');
    expect(text).toContain('Result: {1/2*(√(4*k+1)+1), 1/2*(-√(4*k+1)+1)}');
    expect(text).toContain('Verified: ✗ (substitution: 1/2 roots satisfy the equation)');
  });

  // 2.5/k*k-2.5 is zero, but Giac's simplify does not cancel a float, and the
  // samples sit at ~1e-16: neither proven nor disproved.
  it('solve(x*k=2.5, x) answers 2.5/k with no Verified line — undecided, not ✓ or ✗', async () => {
    const text = await solveText('solve(x*k=2.5, x)');
    expect(text).toContain('Result: 2.5/k');
    expect(text).not.toContain('Verified:');
  });

  it('solveSystemHandler gives an undecided system no Verified line', async () => {
    const text = allText(
      await solveSystemHandler({ equations: ['x*k=2.5', 'y=1'], variables: ['x', 'y'] })
    );
    expect(text).toContain('Result: (2.5/k, 1)');
    expect(text).not.toContain('Verified:');
  });

  it('solveSystemHandler verifies a parameterised system ✓: (k+1)/2 ± (k-1)/2', async () => {
    const text = allText(
      await solveSystemHandler({ equations: ['x+y=k', 'x-y=1'], variables: ['x', 'y'] })
    );
    expect(text).toContain('Result: (1/2*k+1/2, 1/2*k-1/2)');
    expect(text).toContain('Verified: ✓ (substitution: 1 solution(s) satisfy all equations)');
  });

  // evalf(abs(root)) made Giac expand |z| symbolically for each parameterised
  // complex root: 10 s timeouts and worker traps. abs(evalf(...)) takes ms.
  it('csolve(x^30=k, x) verifies all 30 roots ✓ within a few seconds', async () => {
    const start = Date.now();
    const text = await solveText('csolve(x^30=k, x)');
    expect(text).toContain('Verified: ✓ (substitution: 30/30 roots satisfy the equation)');
    expect(Date.now() - start).toBeLessThan(5_000);
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
    expect(await verifySolveSet('x^2=4', 'x', ['2', '3'])).toEqual({
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

  it('disproves 1e-12+k as a root of x=0 by sampling k, not ✓ by its leading digits', async () => {
    // parseFloat read `1e-12+k` as 1e-12, inside the tolerance.
    expect((await verifySolveSet('x=0', 'x', ['1e-12+k']))?.verified).toBe(false);
  });

  it('disproves 1 as a root of x=k: 1-k is 0.3, 1.3, 0.3 at the samples', async () => {
    expect((await verifySolveSet('x=k', 'x', ['1']))?.verified).toBe(false);
  });

  it('gives no verdict for abs(k) as a root of x=k: abs(k)-k vanishes at every positive k', async () => {
    expect(await verifySolveSet('x=k', 'x', ['abs(k)'])).toBeUndefined();
  });

  it('gives no verdict when one root is proven and another undecided', async () => {
    expect(await verifySolveSet('x=k', 'x', ['k', 'abs(k)'])).toBeUndefined();
  });

  it('still disproves when one root is wrong and another undecided', async () => {
    expect(await verifySolveSet('x=k', 'x', ['k+1', 'abs(k)'])).toEqual({
      verified: false,
      method: 'substitution',
      detail: '0/2 roots satisfy the equation; 1 undecided',
    });
  });
});

describe('verifySystem / verifySystemSolutions: residual verdicts', () => {
  it('verifies a parameterised tuple: (k+1)/2 + (k-1)/2 = k and their difference is 1', async () => {
    expect(await verifySystem(['x+y=k', 'x-y=1'], ['x', 'y'], ['k/2+1/2', 'k/2-1/2'])).toEqual({
      verified: true,
      method: 'substitution',
      detail: '2/2 equations satisfied',
    });
  });

  it('gives no verdict for a tuple whose residual is abs(k)-k', async () => {
    expect(await verifySystem(['x+y=k'], ['x', 'y'], ['abs(k)', '0'])).toBeUndefined();
  });

  it('gives no verdict over tuples when one is proven and one undecided', async () => {
    const tuples = [
      ['k', '0'],
      ['abs(k)', '0'],
    ];
    expect(await verifySystemSolutions(['x+y=k'], ['x', 'y'], tuples)).toBeUndefined();
  });

  it('disproves over tuples when one is wrong (1+2-k) and another undecided', async () => {
    const tuples = [
      ['abs(k)', '0'],
      ['1', '2'],
    ];
    expect(await verifySystemSolutions(['x+y=k'], ['x', 'y'], tuples)).toEqual({
      verified: false,
      method: 'substitution',
      detail: '0/2 solution(s) satisfy all equations; 1 undecided',
    });
  });
});

describe('substitutionResidual: what the reading reports', () => {
  it('reads 2/k*k-2 as exactly 0', async () => {
    expect(await substitutionResidual('(x*k)-(2)', 'x=2/k')).toEqual({
      residual: 'zero',
      printed: '0',
    });
  });

  it('names the sampled values a disproof rests on', async () => {
    expect(await substitutionResidual('(x)-(k)', 'x=1')).toEqual({
      residual: 'nonzero',
      printed: '0.3 at k=13/10, 1.3 at k=23/10, 0.3 at k=7/10',
    });
  });
});

describe('verify tool: the same reader, the same verdicts', () => {
  it.each([
    ['x=2/k satisfies x*k=2', 'TRUE'],
    ['x=2/k satisfies k*x=2', 'TRUE'],
    ['x=3/k satisfies x*k=2', 'FALSE'],
    ['x=1 satisfies x=k', 'FALSE'],
    ['x=abs(k) satisfies x=k', 'UNKNOWN'],
  ])('%s is %s', async (claim, verdict) => {
    expect(allText(await verifyHandler({ claim }))).toContain(`Verified: ${verdict}`);
  });

  it('reports the exact residual of x=2/k in x*k=2 as 0', async () => {
    const parsed = JSON.parse(
      allText(await verifyHandler({ claim: 'x=2/k satisfies x*k=2', format: 'json' }))
    );
    expect(parsed).toMatchObject({ verified: true, evaluated: true, confidence: 'high' });
    expect(parsed.checks_performed).toContain(
      'Substitution: Substituting x=2/k: equation evaluates to 0 ≈ 0 ✓'
    );
  });
});
