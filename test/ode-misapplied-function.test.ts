import { describe, it, expect, beforeAll } from 'vitest';
import { giacEngine } from '../src/server/giac/index.js';
import { computeHandler } from '../src/server/tools/compute/index.js';
import { derivativeCallAtPoint, misappliedArgument } from '../src/server/tools/ode-system-shape.js';
import { allText } from './helpers/all-text.js';
import { resultLine } from './helpers/result-line.js';

/**
 * A single ODE whose equation applies the unknown function anywhere but at
 * exactly the variable. Giac answered each of these with isError:false and a
 * wrong answer, measured on b795f92:
 *
 *   y'=y(x-1)            (2*c_0+x^2-2*x)/2   — a delay equation
 *   y'=y(x/2)            (4*c_0+x^2)/4       — a pantograph equation
 *   y'=y(0)              c_0                 — y' is the constant y(0)
 *   y''+y(0)=0           c_0*x+c_1
 *   y'=y(x+0)            c_0+integrate(t(x),x)
 *   desolve(y'=y(x),t,y) c_0+t*` t`(x)       — the function at another name
 *   y'=y(x-1)(0)         c_0-x
 *
 * None of them has a closed form this solves, so each must be refused.
 */
beforeAll(async () => {
  await giacEngine.initialize();
}, 60000);

const refusal = (at: string, variable = 'x'): string =>
  `solve_ode cannot solve this equation — it applies y at ${at} rather than at the ` +
  `variable ${variable}, a delay or functional equation, which this does not solve`;

describe('an equation that applies the function off the variable is refused', () => {
  it.each([
    ["y'=y(x-1)", 'x-1'],
    ["desolve(y'=y(x-1), x, y)", 'x-1'],
    ["y'=y(x/2)", 'x/2'],
    ["desolve(y'=y(x/2), x, y)", 'x/2'],
    ["y'=y(0)", '0'],
    ["desolve(y'=y(0), x, y)", '0'],
    ["y''+y(0)=0", '0'],
    ["desolve(y''+y(0)=0, x, y)", '0'],
    ["y'=y(x+0)", 'x+0'],
    ["desolve(y'=y(x+0), x, y)", 'x+0'],
    // Every derivative notation.
    ["y'(x)=y(x-1)", 'x-1'],
    ["desolve(y'(x)=y(x-1), x, y)", 'x-1'],
    ['dy/dx=y(x-1)', 'x-1'],
    ['desolve(dy/dx=y(x-1), x, y)', 'x-1'],
    ['desolve(diff(y(x),x)=y(x-1), x, y)', 'x-1'],
    // With conditions beside it, in every joining.
    ["[y'=y(x-1), y(0)=1]", 'x-1'],
    ["desolve([y'=y(x-1), y(0)=1], x, y)", 'x-1'],
    ["y(0)=1, y'=y(x-1)", 'x-1'],
    ["y'=y(x-1) and y(0)=1", 'x-1'],
    ["desolve(y'=y(x-1) and y(0)=1, x, y)", 'x-1'],
    ["desolve(y'=y(x-1), y(0)=1, x, y)", 'x-1'],
    // Applied twice: Giac answered `y'=y(x-1)(0)` with c_0-x.
    ["y'=y(x-1)(0)", '(x-1)(0)'],
    ["desolve(y'=y(x-1)(0), x, y)", '(x-1)(0)'],
    // A bracketed name is applied as the bare one.
    ["y'=(y)(x-1)", 'x-1'],
    ["desolve(y'=(y)(x-1), x, y)", 'x-1'],
    ["desolve(y'=(y)(x/2), x, y)", 'x/2'],
    ["desolve(y'=( y )( x-1 ), x, y)", 'x-1'],
    ["y'=((y))(x-1)", 'x-1'],
    ["y'=2*(y)(x-1)", 'x-1'],
    // A derivative call at a point inside the equation is y' there.
    ["y'=diff(y(x),x)(0)", '0'],
    ["desolve(y'=diff(y(x),x)(0), x, y)", '0'],
    // The equation is argument zero, so it outranks a condition refusal.
    ["desolve(y'=y(x-1), y(0)=50000!, x, y)", 'x-1'],
  ])('%s', async (problem, at) => {
    const r = await computeHandler({ problem });
    const text = allText(r);
    expect(r.isError, text).toBe(true);
    expect(text).toContain(refusal(at));
    expect(text).not.toMatch(/^Result:/m);
  });

  it.each(["desolve(y'=y(x), t, y)", 'dy/dt=y(x)', 'desolve(dy/dt=y(x), t, y)'])(
    '%s applies y at x where the variable is t',
    async (problem) => {
      const r = await computeHandler({ problem });
      const text = allText(r);
      expect(r.isError, text).toBe(true);
      expect(text).toContain(refusal('x', 't'));
    }
  );
});

describe('the function at exactly the variable, and conditions at a point, still solve', () => {
  it.each([
    ["y'=y", 'c_0*exp(x)', "y'=y exactly)"],
    ["desolve(y'=y, x, y)", 'c_0*exp(x)', "y'=y exactly)"],
    ["desolve(y'(x)=y(x), y(0)=1, x, y)", 'exp(x)', "y'=y(x) exactly and meets the conditions)"],
    ["y(0)=1, y'=y", 'exp(x)', "y'=y exactly and meets the conditions)"],
    ["desolve(y'=y, y(0)=1, x, y)", 'exp(x)', "y'=y exactly and meets the conditions)"],
    ["y'=y and y(0)=1", 'exp(x)', "y'=y exactly and meets the conditions)"],
    ["y'=y && y(0)=1", 'exp(x)', "y'=y exactly and meets the conditions)"],
    ["desolve(y'=y and(y(0)=1), x, y)", 'exp(x)', "y'=y exactly and meets the conditions)"],
    ["desolve(y'=y ∧ y(0)=1, x, y)", 'exp(x)', "y'=y exactly and meets the conditions)"],
    ["[y''=-y, y(0)=1, y'(0)=0]", 'cos(x)', "y''=-y exactly and meets the conditions)"],
    [
      "desolve(y''=-y, y(0)=1, y'(0)=0, x, y)",
      'cos(x)',
      "y''=-y exactly and meets the conditions)",
    ],
  ])('%s', async (problem, expected, verified) => {
    const r = await computeHandler({ problem });
    const text = allText(r);
    expect(r.isError, text).toBe(false);
    expect(text).toMatch(resultLine(expected));
    expect(text).toContain(`Verified: ✓ (substitution: substitutes back into ${verified}`);
  });

  // Conditions that scale or combine the function at a point.
  it.each([
    ["[y'=y, 2*y(0)=1]", '1/2*exp(x)'],
    ["[y'=y, y(0)+y'(0)=4]", '2*exp(x)'],
  ])('%s', async (problem, expected) => {
    const r = await computeHandler({ problem });
    const text = allText(r);
    expect(r.isError, text).toBe(false);
    expect(text).toMatch(resultLine(expected));
  });
});

const callRefusal = (call: string, primed: string): string =>
  `solve_ode cannot solve this equation — it writes a derivative at a point as ${call}, ` +
  `which the CAS drops — write it ${primed}`;

/**
 * Giac drops a condition written as a derivative CALL at a point, and answered
 * as if it were absent (b795f92):
 *
 *   [y''=-y, y(0)=1, diff(y(x),x)(0)=0]       cos(x)+c_1*sin(x)
 *   [y''=-y, y(0)=0, diff(y(x),x)(1)+y(1)=1]  1/sin(1)*sin(x)
 *
 * The primed spelling the refusal names answers each correctly.
 */
describe('a derivative call at a point is refused with the spelling that works', () => {
  it.each([
    ["[y''=-y, y(0)=0, diff(y(x),x)(1)+y(1)=1]", 'diff(y(x),x)(1)', "y'(1)"],
    ["desolve([y''=-y, y(0)=0, diff(y(x),x)(1)+y(1)=1], x, y)", 'diff(y(x),x)(1)', "y'(1)"],
    ["[y'=y, diff(y(x),x)(0)+y(0)=2]", 'diff(y(x),x)(0)', "y'(0)"],
    ["desolve([y'=y, diff(y(x),x)(0)+y(0)=2], x, y)", 'diff(y(x),x)(0)', "y'(0)"],
    ["y''=-y and y(0)=1 and diff(y(x),x)(0)+y(0)=3", 'diff(y(x),x)(0)', "y'(0)"],
    ["desolve(y''=-y and y(0)=1 and diff(y(x),x)(0)+y(0)=3, x, y)", 'diff(y(x),x)(0)', "y'(0)"],
    ["[y''=-y, y(0)=1, diff(y(x),x)(0)=0]", 'diff(y(x),x)(0)', "y'(0)"],
    ['desolve([diff(y(x),x,2)=-y, y(0)=1, diff(y(x),x)(0)=0], x, y)', 'diff(y(x),x)(0)', "y'(0)"],
    ["[y'''=-y', y(0)=1, y'(0)=0, diff(y(x),x,2)(0)=-1]", 'diff(y(x),x,2)(0)', "y''(0)"],
  ])('%s', async (problem, call, primed) => {
    const r = await computeHandler({ problem });
    const text = allText(r);
    expect(r.isError, text).toBe(true);
    expect(text).toContain(callRefusal(call, primed));
    expect(text).not.toMatch(/^Result:/m);
  });

  // Ranked after the conditions' own bounds, which name a more specific fault.
  it('leaves an oversized condition to its own refusal', async () => {
    const r = await computeHandler({ problem: "[y''=-y, y(0)=1142!, diff(y(x),x)(0)=1142!]" });
    expect(allText(r)).toContain('it gives initial conditions of implausible magnitude together');
  });

  it.each([
    ["[y''=-y, y(0)=0, y'(1)+y(1)=1]", '1/(cos(1)+sin(1))*sin(x)'],
    ["[y'=y, y'(0)+y(0)=2]", 'exp(x)'],
    ["y''=-y and y(0)=1 and y'(0)+y(0)=3", 'cos(x)+2*sin(x)'],
    ["desolve([diff(y(x),x,2)=-y, y(0)=1, y'(0)=0], x, y)", 'cos(x)'],
  ])('the primed spelling %s solves', async (problem, expected) => {
    const r = await computeHandler({ problem });
    const text = allText(r);
    expect(r.isError, text).toBe(false);
    expect(text).toMatch(resultLine(expected));
  });

  // A statement separator keeps the condition apart from the equation, so the
  // CAS's own refusal stands rather than a misapplication.
  it("leaves y'=y; y(0)=1 to the CAS", async () => {
    const r = await computeHandler({ problem: "y'=y; y(0)=1" });
    const text = allText(r);
    expect(r.isError, text).toBe(true);
    expect(text).toContain('solve_ode cannot solve this equation — the CAS returned Giac error');
  });
});

describe('derivativeCallAtPoint', () => {
  it.each([
    ["[y'=y, diff(y(x),x)(0)+y(0)=2]", 'diff(y(x),x)(0)', "y'(0)"],
    ['diff(y(x),x,2)(0)=1', 'diff(y(x),x,2)(0)', "y''(0)"],
    ['diff(y,x)(L)=1', 'diff(y,x)(L)', "y'(L)"],
    ['derive(y(x),x)( 0 )=1', 'derive(y(x),x)( 0 )', "y'(0)"],
    ['diff((y)(x),x)(0)=1', 'diff(y(x),x)(0)', "y'(0)"],
  ])('%s', (text, call, primed) => {
    expect(derivativeCallAtPoint(text, 'y', 'x')).toEqual({ call, primed });
  });

  it.each([
    "[y'=y, y'(0)=1]",
    'diff(y(x),x)=y',
    'diff(z(x),x)(0)=1',
    'diff(y(t),t)(0)=1',
    'diff(y(x),x)(0',
  ])('%s has none', (text) => {
    expect(derivativeCallAtPoint(text, 'y', 'x')).toBeUndefined();
  });
});

describe('misappliedArgument', () => {
  it.each([
    ["y'=y(x-1)", 'x-1'],
    ["y'=y(x/2)", 'x/2'],
    ["y'=y(0)", '0'],
    ["y'(x)=y(x-1)", 'x-1'],
    ['dy/dx=y(x-1)', 'x-1'],
    ['diff(y(x),x)=y(x-1)', 'x-1'],
    ["y'=y(0,1)", '0,1'],
    ["y'=y(y(0))", 'y(0)'],
    ["[y'=y(x-1), y(0)=1]", 'x-1'],
    ["y(0)=1 and y'=y(x-1)", 'x-1'],
    ["y'=y && y(0)=1 && y'=y(x-1)", 'x-1'],
    ["y'=y or y'=y(x-1)", 'x-1'],
    ["y'=y(x-1) ∧ y(0)=1", 'x-1'],
    ["y'=y(x-1); y(0)=1", 'x-1'],
    ["y'=(y)(x-1)", 'x-1'],
    ["y'=((y))(x-1)", 'x-1'],
    ["y'=( y' )(x-1)", 'x-1'],
    ["y'=diff(y(x),x)(0)", '0'],
    ["y'=diff(y(x),x)(x-1)", 'x-1'],
    // A call's argument list is not a redundant bracket.
    ["y'=y'(y)", 'y'],
    ["y'=y(x-1)(0)", '(x-1)(0)'],
    ["y'=y(x)(0)+1", '(x)(0)'],
    // `or` inside `floor` is no connective, nor is one inside a bracket.
    ["y'=floor(x)+y(0)", '0'],
    ["y'=(1 or y(0))", '0'],
    ["y'=y(x)(0", '(x)(0'],
  ])('%s applies y at %s', (text, at) => {
    expect(misappliedArgument(text, 'y', 'x')).toBe(at);
  });

  it.each([
    "y'=y",
    "y'=y(x)",
    "y''( x )+y(x)=0",
    "y'(x)=y(x)",
    'diff(y(x),x)=y(x)',
    'dy/dx=y',
    // Conditions, whichever way they are joined to the equation.
    "[y'=y, y(0)=1]",
    "y(0)=1, y'=y",
    "y'=y and y(0)=1",
    "y'=y and(y(0)=1)",
    "(y'=y) and (y(0)=1)",
    "y'=y && y(0)=1",
    "y'=y&&y(0)=1",
    "y'=y &&& y(0)=1",
    "y'=y AND y(0)=1",
    "y'=y ∧ y(0)=1",
    "y'=y∧y(0)=1",
    "y'=y ∨ y(0)=1",
    "y'=y || y(0)=1",
    "y'=y xor y(0)=1",
    "[y''=-y, y(0)=1, y'(0)=0]",
    "[y'=y, 2*y(0)=1]",
    "[y'=y, y(0)+y'(0)=1]",
    "[y''=-y, y(0)=1, diff(y(x),x)(0)=0]",
    // A derivative call at a point is read as y' there: a condition.
    "[y''=-y, y(0)=0, diff(y(x),x)(1)+y(1)=1]",
    "[y'=y, diff(y(x),x)(0)+y(0)=2]",
    "y''=-y and y(0)=1 and diff(y(x),x)(0)+y(0)=3",
    // Two calls rewritten: the second must be read where it stands, or the
    // condition reads as garbage with y at a point beside y bare.
    "[y'=y, diff(y(x),x)(0)+diff(y(x),x)(1)=2]",
    // A statement separator splits like a comma.
    "y'=y; y(0)=1",
    // Bracketed names that are arguments, not the function applied.
    "y'=(y)",
    "y'=f (y)(x-1)",
    "y'=g(x) (y)(x-1)",
    "[y'=y, y(1)=2*y(0)]",
    "[y'=y, y(L)=0]",
    // A condition applied twice is still a condition.
    "[y''=-y, y'(x)(0)=0]",
    // Another name, or a name that merely contains y.
    "y'=yy(x-1)+z(x-1)+y_1(0)",
    // Not split inside a bracket or an identifier.
    "y'=band(y)",
  ])('%s applies y nowhere else', (text) => {
    expect(misappliedArgument(text, 'y', 'x')).toBeUndefined();
  });

  it('reads the variable it is given', () => {
    expect(misappliedArgument("y'=y(x)", 'y', 't')).toBe('x');
    expect(misappliedArgument("y'=y(t)", 'y', 't')).toBeUndefined();
  });
});
