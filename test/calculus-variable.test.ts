import { describe, it, expect, beforeAll } from 'vitest';
import { giacEngine } from '../src/server/giac/index.js';
import { computeHandler } from '../src/server/tools/compute/index.js';
import { applicationDepth, MAX_DERIVATIVE_COST } from '../src/server/tools/calculus-variable.js';
import { allText } from './helpers/all-text.js';
import { expectAnswer as answers, expectRefused as refused } from './helpers/compute-answer.js';

beforeAll(async () => {
  await giacEngine.initialize();
}, 60000);

/** The text of an answer that is not an error. */
async function expectNoError(problem: string): Promise<string> {
  const r = await computeHandler({ problem });
  const text = allText(r);
  expect(r.isError, text).toBe(false);
  return text;
}

/** The value of `expr` at (x, y, z) = (1, 2, 3), simplified by the engine. */
async function at123(expr: string): Promise<string> {
  return String(await giacEngine.evaluate(`simplify(subst(${expr},[x,y,z],[1,2,3]))`));
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
    // In a list, past a first name that is a symbol: only the engine knows.
    [
      'diff(x^2*y, [x, epsilon])',
      'differentiate needs a variable, and "epsilon" is a value to the CAS (1e-12)',
    ],
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
    // 34 * (2 * 5)^6: "RuntimeError: unreachable" on main.
    await refused(
      'diff(exp(sin(x*y))*cos(x+y)/(1+x^2+y^2), [x, y], 6)',
      'differentiate with 2 variables to order 6 of this expression (34 characters, ' +
        'functions nested 2 deep) is more than this computes: each order multiplies the size ' +
        'of all 2^6 entries — lower the order, list fewer variables, or differentiate a ' +
        'shorter expression'
    );
  });

  it.each([
    'diff(tan(tan(tan(x*y))), [x, y], 6)',
    'diff(exp(sin(x*y))*cos(x+z)/(1+x^2+y^2+z^2), [x, y, z], 5)',
    'diff(x*y, [x, y], 7)',
    // Short but deeply nested, under a cap on length alone: tan five deep
    // trapped at order 4, eight deep returned 8 million characters at order 2.
    'diff(tan(tan(tan(tan(tan(x*y))))), [x, y], 4)',
    'diff(tan(tan(tan(tan(tan(tan(tan(tan(x*y)))))))), [x, y], 2)',
    'diff(tan(tan(tan(tan(x*y)))), [x, y], 2)',
  ])('%s is refused', async (problem) => {
    await refused(problem, 'is more than this computes');
  });

  it.each([
    ['tan(tan(x))', 2],
    ['(1+x)^2', 0],
    ['exp(sin(x*y))*cos(x+y)/(1+x^2+y^2)', 2],
    ['f(g(h(x)))+sin(x)', 3],
    ['x*y', 0],
  ])('the function nesting of %s is %i', (expr, depth) => {
    expect(applicationDepth(expr)).toBe(depth);
  });

  // The cap is inclusive: 1024 characters of depth 1 (none, counted as 1),
  // two variables, order 2 is 1024 * (2 * 2)^2 = MAX_DERIVATIVE_COST exactly. Padded with `+0`, which the
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
    await refused(`diff(${past}, [x, y], 2)`, '(1025 characters, functions nested 1 deep) is more than this computes');
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
    // A tower of tans, one order below the bound's refusal.
    [
      'diff(tan(tan(x*y)), [x, y])',
      '[y*(1+tan(x*y)^2)*(1+tan(tan(x*y))^2),x*(1+tan(x*y)^2)*(1+tan(tan(x*y))^2)]',
    ],
  ])('%s is %s', answers);

  // A single variable is bounded by the order alone: an order the tensor
  // model would refuse (13 * 2^20 is far past the cap) answers, and is the
  // derivative — its value at 0 is the twentieth Taylor coefficient times 20!,
  // computed independently by series.
  it('answers diff(exp(sin(x)), x, 20) in full', async () => {
    const text = await expectNoError('diff(exp(sin(x)), x, 20)');
    const result = (text.match(/^Result: (.*)$/m) ?? [])[1];
    expect(result).toBeTruthy();
    expect(result).not.toContain('diff(');
    const atZero = await giacEngine.evaluate(
      `simplify(subst(${result},x,0) - 20!*coeff(taylor(exp(sin(x)),x=0,20,polynom),x,20))`
    );
    expect(atZero).toBe('0');
  });

  it('answers the Hessian of 1/r in three variables', async () => {
    const text = await expectNoError('diff((x^2+y^2+z^2)^(-1/2), [x, y, z], 2)');
    const hessian = (text.match(/^Result: (.*)$/m) ?? [])[1];
    // At (1, 2, 3), r² = 14: ∂²(1/r)/∂x² = (2x²-y²-z²)/r^5 and
    // ∂²(1/r)/∂x∂y = 3xy/r^5 — a diagonal and an off-diagonal entry.
    expect(await at123(`(${hessian})[0][0] - (2-4-9)/14^(5/2)`)).toBe('0');
    expect(await at123(`(${hessian})[0][1] - 6/14^(5/2)`)).toBe('0');
    expect(await at123(`(${hessian})[1][0] - (${hessian})[0][1]`)).toBe('0');
  });

  // The entry cap still binds a wide list: 17 variables to order 2 is 289
  // entries, though its cost, 3 * (17 * 2)^2 = 3,468, is under the cost cap.
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
