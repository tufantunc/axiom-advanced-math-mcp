import { describe, it, expect, beforeAll } from 'vitest';
import { giacEngine } from '../src/server/giac/index.js';
import { computeHandler } from '../src/server/tools/compute/index.js';
import { MAX_DERIVATIVE_COST } from '../src/server/tools/calculus.js';
import { allText } from './helpers/all-text.js';
import { resultLine } from './helpers/result-line.js';

beforeAll(async () => {
  await giacEngine.initialize();
}, 60000);

async function refused(problem: string, message: string): Promise<void> {
  const r = await computeHandler({ problem });
  const text = allText(r);
  expect(r.isError, text).toBe(true);
  expect(text).toContain(message);
  expect(text).not.toMatch(/^Result:/m);
}

async function answers(problem: string, expected: string): Promise<void> {
  const r = await computeHandler({ problem });
  const text = allText(r);
  expect(r.isError, text).toBe(false);
  expect(text).toMatch(resultLine(expected));
}

// With no variable named, each of these answered a derivative, integral or
// series in a variable nobody chose, with isError:false.
describe('an omitted variable — more than one candidate is refused', () => {
  it.each([
    // Differentiated by y: 1.
    ['diff(2x+y)', 'differentiate', 'x, y', 'diff(f, x)'],
    // Differentiated by a: x^2.
    ['diff(a*x^2)', 'differentiate', 'a, x', 'diff(f, x)'],
    ['diff(k1*x^2)', 'differentiate', 'k1, x', 'diff(f, x)'],
    // Integrated in y: 2*x*y+y^2/2.
    ['integrate(2x+y)', 'integrate', 'x, y', 'integrate(f, x)'],
    // Expanded in a.
    ['taylor(sin(a*x))', 'taylor', 'a, x', 'taylor(f, x, 0, 5)'],
    // Two Greek names and no ASCII one: no convention picks either.
    ['diff(sin(θ*φ))', 'differentiate', 'θ, φ', 'diff(f, x)'],
  ])('%s', async (problem, operation, names, form) => {
    await refused(
      problem,
      `${operation} needs the variable when the expression has more than one symbol ` +
        `(${names}) — name it, as in ${form}`
    );
  });
});

describe('an omitted variable — one candidate is the variable', () => {
  it.each([
    // The guess read no letter in `3t` and differentiated by x: 0.
    ['diff(3t^2)', '3*2*t'],
    ['integrate(4u^3)', '4*u^4/4'],
    ['diff(x^2)', '2*x'],
    ['diff(t^2)', '2*t'],
    // An ASCII name is the variable over a Greek parameter.
    ['diff(sin(ω*t))', 'ω*cos(ω*t)'],
    ['diff(α*x^2)', 'α*2*x'],
    ['integrate(cos(ω*t))', 'sin(ω*t)/ω'],
    // Constants are not candidates.
    ['diff(π*r^2)', 'pi*2*r'],
    ['diff(e^x)', 'exp(x)'],
    ['diff(sin(π*θ))', 'pi*cos(pi*θ)'],
    // A function the expression applies is not a candidate.
    ['diff(f(x))', 'diff(f(x),x)'],
    ['taylor(sin(x))', 'x-1/6*x^3+1/120*x^5'],
    // A constant expression: any variable gives the same answer.
    ['diff(5)', '0'],
  ])('%s is %s', answers);
});

describe('a variable the CAS holds a value in is refused', () => {
  const constant = (name: string) =>
    `differentiate needs a variable, and "${name}" is a constant — name the variable, such as x`;
  it.each([
    // Each answered 0: the derivative with respect to an infinity.
    ['diff(x^2, plus_inf)', constant('plus_inf')],
    ['diff(x^2, minus_inf)', constant('minus_inf')],
    ['diff(x^2, unsigned_inf)', constant('unsigned_inf')],
    ['integrate(x, plus_inf)', 'integrate needs a variable, and "plus_inf" is a constant'],
    // Answered `diff(x^2,12)`: DIGITS is the precision setting.
    [
      'diff(x^2, DIGITS)',
      'differentiate needs a variable, and "DIGITS" is a value — name the variable, such as x',
    ],
    ['diff(x^2*y, [x, DIGITS])', 'differentiate needs a variable, and "DIGITS" is a value'],
    // Not listed by name: the engine is asked, and says what it holds.
    [
      'diff(x^2, epsilon)',
      'differentiate needs a variable, and "epsilon" is a value to the CAS (1e-12) — ' +
        'name the variable, such as x',
    ],
    [
      'taylor(sin(x), Digits, 0, 3)',
      'taylor needs a variable, and "Digits" is a value to the CAS (12)',
    ],
    ['diff(x^2, sin)', 'differentiate needs a variable, and "sin" is a value to the CAS'],
  ])('%s', refused);

  it.each([
    // Names that look reserved and are symbols.
    ['diff(DIGIT^2, DIGIT)', '2*DIGIT'],
    ['diff(inf_x^2, inf_x)', '2*inf_x'],
    ['diff(θ^2, θ)', '2*θ'],
    ['diff(x^2*y^3, [x, y])', '[2*x*y^3,x^2*3*y^2]'],
  ])('%s is %s', answers);
});

// The 256-entry cap bounds how many entries a derivative tensor has, not how
// large each grows; the second is what traps the worker.
describe('a derivative tensor is bounded by its cost', () => {
  it('refuses the order that trapped the worker', async () => {
    // 34 * 4^6 = 139,264: "RuntimeError: unreachable" on main.
    await refused(
      'diff(exp(sin(x*y))*cos(x+y)/(1+x^2+y^2), [x, y], 6)',
      'differentiate with 2 variables to order 6 of an expression this long (34 characters) ' +
        'is more than this computes: each order multiplies the size of all 2^6 entries — ' +
        'lower the order, list fewer variables, or differentiate a shorter expression'
    );
  });

  it.each([
    'diff(tan(tan(tan(x*y))), [x, y], 6)',
    'diff(exp(sin(x*y))*cos(x+z)/(1+x^2+y^2+z^2), [x, y, z], 5)',
    'diff(x*y, [x, y], 7)',
  ])('%s is refused', async (problem) => {
    await refused(problem, 'is more than this computes');
  });

  // The cap is inclusive: 1024 characters, two variables, order 2 is
  // 1024 * 4^2 = MAX_DERIVATIVE_COST exactly. Padded with `+0`, which the
  // engine drops, so the Hessian is x^2*y^3's.
  const padded = (length: number) => {
    const base = 'x^2*y^3';
    const rest = length - base.length;
    return rest % 2 === 0
      ? base + '+0'.repeat(rest / 2)
      : base + '+0'.repeat((rest - 3) / 2) + '+00';
  };
  it('answers at the cap and refuses one character past it', async () => {
    const atCap = padded(1024);
    expect(atCap.length * 4 ** 2).toBe(MAX_DERIVATIVE_COST);
    await answers(`diff(${atCap}, [x, y], 2)`, '[[2*y^3,6*x*y^2],[6*x*y^2,6*x^2*y]]');
    const past = padded(1025);
    expect(past.length).toBe(1025);
    await refused(`diff(${past}, [x, y], 2)`, '(1025 characters) is more than this computes');
  });

  it.each([
    [
      'diff(x^3*y^3, [x, y], 3)',
      '[[[6*y^3,18*x*y^2],[18*x*y^2,18*x^2*y]],[[18*x*y^2,18*x^2*y],[18*x^2*y,6*x^3]]]',
    ],
    ['diff(x*y*z*w, [x, y, z, w])', '[y*z*w,x*z*w,x*y*w,x*y*z]'],
    // The order the trap was reported at, one lower.
    [
      'diff(x*y, [x, y], 5)',
      '[[[[[0,0],[0,0]],[[0,0],[0,0]]],[[[0,0],[0,0]],[[0,0],[0,0]]]],[[[[0,0],[0,0]],[[0,0],[0,0]]],[[[0,0],[0,0]],[[0,0],[0,0]]]]]',
    ],
    // A single variable is bounded by the order alone.
    ['diff(exp(sin(x)), x, 60)', ''],
  ])('%s answers', async (problem, expected) => {
    const r = await computeHandler({ problem });
    const text = allText(r);
    expect(r.isError, text).toBe(false);
    if (expected) expect(text).toMatch(resultLine(expected));
  });

  it('answers the Hessian of 1/r in three variables', async () => {
    const r = await computeHandler({ problem: 'diff((x^2+y^2+z^2)^(-1/2), [x, y, z], 2)' });
    expect(r.isError, allText(r)).toBe(false);
    // ∂²(1/r)/∂x² = (2x²-y²-z²)/r^5: checked at (1, 2, 3), r² = 14.
    const at = await giacEngine.evaluate(
      `simplify(subst(${(allText(r).match(/^Result: (.*)$/m) ?? [])[1]}[0][0],[x,y,z],[1,2,3]) - (2-4-9)/14^(5/2))`
    );
    expect(at).toBe('0');
  });

  // The entry cap still binds a wide list: 17 variables to order 2 is 289
  // entries, though its cost, 3 * 34^2 = 3,468, is under the cost cap.
  const names = 'abcdfghjklmnopqrs'.split('');
  it('refuses 17 variables to order 2 on its entries, and answers 16', async () => {
    await refused(
      `diff(a*b, [${names.join(',')}], 2)`,
      'differentiate with 17 variables to order 2 gives 17^2 entries, more than the 256'
    );
    const sixteen = names.slice(0, 16);
    const hessian = sixteen.map((u) =>
      sixteen.map((v) => ((u === 'a' && v === 'b') || (u === 'b' && v === 'a') ? '1' : '0'))
    );
    await answers(
      `diff(a*b, [${sixteen.join(',')}], 2)`,
      `[${hessian.map((row) => `[${row.join(',')}]`).join(',')}]`
    );
  });
});
