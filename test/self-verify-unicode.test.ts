import { describe, it, expect, beforeAll } from 'vitest';
import { giacEngine } from '../src/server/giac/index.js';
import { computeHandler } from '../src/server/tools/compute/index.js';
import {
  verifyFactor,
  verifyIntegrate,
  verifySolveSet,
  verifySystem,
} from '../src/server/tools/self-verify.js';
import { allText } from './helpers/all-text.js';
import { resultLine } from './helpers/result-line.js';

/**
 * Self-verification of a caller who writes superscripts.
 *
 * The answer was computed from normalised text, but the verifier was handed the
 * caller's own: Giac reads `x²` as one identifier, so the check compared the
 * answer with a different expression and a correct result shipped as
 * `Verified: ✗` — `integrate(x⁻¹, x)` answered `ln(abs(x))`, `integrate(x², x)`
 * answered `x^3/3`, `factor(x²-4)` answered `(x-2)*(x+2)`, each "disproved".
 */
beforeAll(async () => {
  await giacEngine.initialize();
}, 60000);

describe('self-verification of superscript input', () => {
  it.each([
    ['integrate(x⁻¹, x)', 'ln(abs(x))', 'differentiation: derivative of the result equals'],
    ['integrate(x², x)', 'x^3/3', 'differentiation: derivative of the result equals'],
    ['integrate(x³+x², x)', 'x^4/4+x^3/3', 'differentiation: derivative of the result equals'],
    ['factor(x²-4)', '(x-2)*(x+2)', 'expand: expand(factored) equals the original'],
    ['factor(x³-x)', 'x*(x-1)*(x+1)', 'expand: expand(factored) equals the original'],
  ])('%s answers %s, verified', async (problem, expected, check) => {
    const r = await computeHandler({ problem });
    const text = allText(r);
    expect(r.isError, text).toBe(false);
    expect(text).toMatch(resultLine(expected));
    expect(text).toContain(`Verified: ✓ (${check}`);
  });

  // Normalising the caller's text must not make every answer pass: a wrong
  // answer to the same superscript input is still disproved.
  it('still disproves a wrong antiderivative of x²', async () => {
    expect((await verifyIntegrate('x²', 'x', 'x^3/3')).verified).toBe(true);
    expect((await verifyIntegrate('x²', 'x', 'x^3')).verified).toBe(false);
    expect((await verifyIntegrate('x⁻¹', 'x', 'ln(abs(x))')).verified).toBe(true);
    expect((await verifyIntegrate('x⁻¹', 'x', 'ln(x)^2')).verified).toBe(false);
  });

  it('still disproves a wrong factorisation of x²-4', async () => {
    expect((await verifyFactor('x²-4', '(x-2)*(x+2)')).verified).toBe(true);
    expect((await verifyFactor('x²-4', '(x-2)*(x+3)')).verified).toBe(false);
  });

  it('checks roots and system solutions against the normalised equation', async () => {
    const roots = await verifySolveSet('x²=4', 'x', ['-2', '2']);
    expect(roots).toEqual({
      verified: true,
      method: 'substitution',
      detail: '2/2 roots satisfy the equation',
    });
    expect((await verifySolveSet('x²=4', 'x', ['3'])).verified).toBe(false);
    // x=1, y=2: 1²+2 = 3 and 1-2 = -1.
    const system = await verifySystem(['x²+y=3', 'x-y=-1'], ['x', 'y'], ['1', '2']);
    expect(system.verified).toBe(true);
    expect(system.detail).toBe('2/2 equations satisfied');
    expect((await verifySystem(['x²+y=3', 'x-y=-1'], ['x', 'y'], ['2', '3'])).verified).toBe(
      false
    );
  });
});
