import { describe, it, expect, beforeAll } from 'vitest';
import { giacEngine } from '../src/server/giac/index.js';
import { computeHandler } from '../src/server/tools/compute/index.js';
import { odeEquationMembers, odeMemberConditions } from '../src/server/tools/ode-system-shape.js';
import { allText } from './helpers/all-text.js';
import { resultLine } from './helpers/result-line.js';

/**
 * The equation of a single ODE, bounded like a system's right-hand sides.
 *
 * Only the conditions were: `desolve(y'=y*10^100000, x, y)` is twenty-six
 * characters and trapped the shared Giac worker ("memory access out of
 * bounds"), taking any call queued behind it down too, where the same
 * right-hand side inside a system is refused before the engine sees it.
 *
 * The refusal is asserted by its wording, not by isError or by a later call
 * answering: an unguarded call also ends in an error — the trap's — and the
 * worker is recycled behind it, so both pass without the guard.
 */
beforeAll(async () => {
  await giacEngine.initialize();
}, 60000);

const refusal = 'solve_ode cannot solve this equation — it has a term of implausible magnitude';

describe('single-equation magnitude', () => {
  it.each([
    ["desolve(y'=y*10^100000, x, y)", 'an exponent of 100000'],
    ["desolve(y'=y*50000!, x, y)", 'a factorial of 50000'],
    ["y'=y*10^100000", 'an exponent of 100000'],
    ['desolve(dy/dx=y*10^100000, x, y)', 'an exponent of 100000'],
    ['desolve(d^2y/dx^2=y*10^100000, x, y)', 'an exponent of 100000'],
    // Every spelling of the power the reader knows, normalised first.
    ["desolve(y'=y*10¹⁰⁰⁰⁰⁰, x, y)", 'an exponent of 100000'],
    ["desolve(y'=y*10**100000, x, y)", 'an exponent of 100000'],
    ["desolve(y'=y*10^(10^5), x, y)", 'an exponent this cannot bound (10^5)'],
    // The term may stand on the left, beside the derivative.
    ["y'' + 10^100000*y = 0", 'an exponent of 100000'],
    // And inside the bracketed form, beside a condition.
    ["desolve([y'=y*10^100000, y(0)=1], x, y)", 'an exponent of 100000'],
    // A power of a symbol is no magnitude, but a number inside it still is.
    ["desolve(y'=y*x^(10^100000), x, y)", 'an exponent of 100000'],
    ["desolve(y'=sin(10^100000)*y, x, y)", 'an exponent of 100000'],
    // A call on numbers is a number: sqrt(2)^200000 is 2^100000.
    ["desolve(y'=y*sqrt(2)^200000, x, y)", 'an exponent of 200000'],
    // The cost, stated: numbers are read by the conditions' rule, which refuses
    // any exponent over 1,000 although Giac answers 2^4096 (1,234 digits).
    ["desolve(y'=y*2^4096, x, y)", 'an exponent of 4096'],
  ])('%s is refused before the engine', async (problem, reason) => {
    const r = await computeHandler({ problem });
    const text = allText(r);
    expect(r.isError, text).toBe(true);
    expect(text).toContain(`${refusal} (${reason}`);
  });

  // The equation is argument zero: its refusal outranks a condition's.
  it('names the equation when a condition is oversized too', async () => {
    const r = await computeHandler({ problem: "desolve(y'=y*10^100000, y(0)=50000!, x, y)" });
    const text = allText(r);
    expect(r.isError, text).toBe(true);
    expect(text).toContain(`${refusal} (an exponent of 100000`);
    expect(text).not.toContain('initial condition');
  });

  // The order of a Leibniz quotient is not a power: it keeps its own refusal.
  it('leaves a Leibniz order to its own refusal', async () => {
    const r = await computeHandler({ problem: "y'=d^10000000y/dx^10000000" });
    const text = allText(r);
    expect(r.isError, text).toBe(true);
    expect(text).toContain('is of order above 10, the most this solves');
    expect(text).not.toContain('implausible magnitude');
  });

  // Powers of symbols are not magnitudes, however large the exponent: Giac
  // answers these, where the conditions' reading refused every one of them.
  it.each([
    ["desolve(y'=y^2, x, y)", '[1/(-x+c_0)]'],
    ["desolve(y'=x^(1/2)*y, x, y)", 'c_0*exp(2*x*√x/3)'],
    ["desolve(y''+y=sin(x)^2, x, y)", 'c_0*cos(x)+c_1*sin(x)+(cos(2*x)+3)/6'],
    ["desolve(y'=tan(x)^2, x, y)", 'c_0-x+tan(x)'],
    ["desolve(y'=exp(x)^2*y, x, y)", 'c_0*exp(exp(2*x)/2)'],
    ["desolve(y'=x^4000*y, x, y)", 'c_0*exp(x^4001/4001)'],
    // Numbers below the bound, as the system path's 10^90 pair.
    ["desolve(y'=y*2^20, x, y)", 'c_0*exp(1048576*x)'],
    ["desolve(y'=y*10^90, x, y)", `c_0*exp(1${'0'.repeat(90)}*x)`],
    // An equation with the derivative on the right is the equation, not a condition.
    ['desolve(sin(x)=y\'\'+y, x, y)', 'c_0*cos(x)+c_1*sin(x)+(-2*x*cos(x)+sin(x))/4'],
    ["y''+y=0", 'c_0*cos(x)+c_1*sin(x)'],
    ["desolve(y''+y=sin(x), y(0)=0, y'(0)=1, x, y)", '5/4*sin(x)+(-2*x*cos(x)+sin(x))/4'],
  ])('%s is still solved', async (problem, expected) => {
    const r = await computeHandler({ problem });
    const text = allText(r);
    expect(r.isError, text).toBe(false);
    expect(text).toMatch(resultLine(expected));
  });

  // The conditions keep their own bounds and wording, whatever surrounds the
  // application, and a system keeps its own.
  it.each([
    ["desolve(y'=y, y(0)=50000!, x, y)", 'it gives an initial condition of implausible magnitude'],
    ["desolve([y'=y, y(0)=50000!], x, y)", 'it gives an initial condition of implausible magnitude'],
    [
      `desolve([y'=y, 1*y(0)=${Array(150).fill('9').join('/')}], x, y)`,
      'it gives an initial condition of 306 characters, above the 280',
    ],
    [
      "desolve([y''=-y, y(0)=1142!, diff(y(x),x)(0)=1142!], x, y)",
      'it gives initial conditions of implausible magnitude together',
    ],
    [
      "[y'=z*10^100000, z'=-y]",
      'solve_ode cannot solve this system — it has a right-hand side of implausible magnitude',
    ],
  ])('%s keeps its refusal', async (problem, reason) => {
    const r = await computeHandler({ problem });
    const text = allText(r);
    expect(r.isError, text).toBe(true);
    expect(text).toContain(reason);
  });
});

/**
 * The one equation of a single ODE is not one of its conditions.
 *
 * Every member whose left side was not a bare derivative was called a
 * condition, so `y''+y=…` was charged against the 280-character condition
 * bound and refused as "an initial condition of 316 characters", where the
 * same equation written `y''=-y+…` was solved.
 */
describe('equation and condition members', () => {
  it.each([
    ["[y''+y=0, y(0)=1, y'(0)=0]", ['y(0)=1', "y'(0)=0"], ["y''+y=0"]],
    ["[y'=y, y(0)=1]", ['y(0)=1'], ['y']],
    ["y''+y=sin(x)", [], ["y''+y=sin(x)"]],
    // A function at a point is a condition however it is spelled.
    ['[y(a+1)=2, y(0)]', ['y(a+1)=2', 'y(0)'], []],
    // A derivative AT a point is a condition, whatever surrounds it.
    ["[y'=y, 2*y(0)=1]", ['2*y(0)=1'], ['y']],
    ["[y'=y, y(0)+y'(0)=1]", ["y(0)+y'(0)=1"], ['y']],
    [
      '[diff(y(x),x,2)=-y, y(0)=1, diff(y(x),x)(0)=0]',
      ['y(0)=1', 'diff(y(x),x)(0)=0'],
      ['-y'],
    ],
    ["y''(0)=1", ["y''(0)=1"], []],
    // One not at a point is the equation, on either side and in any notation.
    ["sin(x)=y''+y", [], ["sin(x)=y''+y"]],
    ['[d^2y/dx^2+y=0, y(0)=1]', ['y(0)=1'], ['d^2y/dx^2+y=0']],
    ['[diff(y(x),x)+y=0, y(0)=1]', ['y(0)=1'], ['diff(y(x),x)+y=0']],
  ])('%s', (equation, conditions, equations) => {
    expect(odeMemberConditions(equation)).toEqual(conditions);
    expect(odeEquationMembers(equation)).toEqual(equations);
  });

  it('solves a long equation whose left side is not a bare derivative', async () => {
    const forcing = Array.from({ length: 32 }, (_, k) => `sin(${k + 1}*x)`).join('+');
    const problem = `desolve(y''+y=${forcing}, x, y)`;
    expect(forcing.length).toBeGreaterThan(280);
    const r = await computeHandler({ problem });
    const text = allText(r);
    expect(r.isError, text).toBe(false);
    expect(text).not.toContain('initial condition');
    // The general solution, not only a particular one that substitutes back.
    expect(text).toMatch(/^Result: c_0\*cos\(x\)\+c_1\*sin\(x\)\+/m);
    expect(text).toMatch(/^Verified: ✓ \(substitution: substitutes back into y''\+y=sin\(1\*x\)/m);
  });
});
