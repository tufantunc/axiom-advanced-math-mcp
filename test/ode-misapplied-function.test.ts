import { describe, it, expect, beforeAll } from 'vitest';
import { giacEngine } from '../src/server/giac/index.js';
import { computeHandler } from '../src/server/tools/compute/index.js';
import {
  appliedExpression,
  derivativeCallAtPoint,
  misappliedArgument,
} from '../src/server/tools/ode-system-shape.js';
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

const builtRefusal = (expression: string): string =>
  `solve_ode cannot solve this equation — it applies y through ${expression} rather than at ` +
  'the variable x, a delay or functional equation, which this does not solve';

/**
 * Something BUILT from y and applied, which Giac answers as it answers
 * `y(x-1)` (e480674):
 *
 *   (-y)(x-1)            (2*c_0-x^2+2*x)/2
 *   (+y)(x-1), (1*y)(x-1) (2*c_0+x^2-2*x)/2
 *   (y@(x->x/2))(x)      (4*c_0+x^2)/4
 *   apply(y,x-1)         c_0
 */
describe('an expression built from y and applied is refused', () => {
  it.each([
    ["desolve(y'=(-y)(x-1), x, y)", '(-y)(x-1)'],
    ["y'=(-y)(x-1)", '(-y)(x-1)'],
    ["desolve(y'=(+y)(x-1), x, y)", '(+y)(x-1)'],
    ["desolve(y'=(1*y)(x-1), x, y)", '(1*y)(x-1)'],
    ["desolve(y'=(y@(x->x-1))(x), x, y)", '(y@(x->x-1))(x)'],
    ["desolve(y'=(y@(x->x/2))(x), x, y)", '(y@(x->x/2))(x)'],
    ["y'=(y@(x->x/2))(x)", '(y@(x->x/2))(x)'],
    ["desolve(y'=y@(x->x-1), x, y)", 'y@(x->x-1)'],
    ["desolve(y'=apply(y,x-1), x, y)", 'apply(y,x-1)'],
    ["y'=apply(y,x-1)", 'apply(y,x-1)'],
    ["desolve(y'=map(x-1,y), x, y)", 'map(x-1,y)'],
    ["desolve(y'=apply(y',0), x, y)", "apply(y',0)"],
    ["desolve(y'=x1(y)(x-1), x, y)", 'x1(y)(x-1)'],
    ["[y'=(-y)(x-1), y(0)=1]", '(-y)(x-1)'],
    ["desolve(y'=(-y)(x-1), y(0)=1, x, y)", '(-y)(x-1)'],
  ])('%s', async (problem, expression) => {
    const r = await computeHandler({ problem });
    const text = allText(r);
    expect(r.isError, text).toBe(true);
    expect(text).toContain(builtRefusal(expression));
    expect(text).not.toMatch(/^Result:/m);
  });

  // A number before a bracket is a product, so the name inside is y itself.
  it.each(["desolve(y'=1(y)(x-1), x, y)", "y'=1(y)(x-1)"])(
    '%s applies y at x-1',
    async (problem) => {
      const r = await computeHandler({ problem });
      expect(allText(r)).toContain(refusal('x-1'));
    }
  );

  it.each([
    // A redundant round bracket around the argument is the argument.
    ["desolve(y'=y((x)), x, y)", 'c_0*exp(x)'],
    ["y'=y((x))", 'c_0*exp(x)'],
    ["desolve(y'=y( (x) )+1, x, y)", 'c_0*exp(x)-1'],
    ["[y'=y, y((0))=1]", 'exp(x)'],
    ["[y'=y, (y')(0)=1]", 'exp(x)'],
    // Products, not applications.
    ["desolve(y'=2(y), x, y)", 'c_0*exp(2*x)'],
    ["desolve(y'=(y+1)*(x+2), x, y)", 'c_0*exp((x^2+4*x)/2)-1'],
  ])('%s still solves', async (problem, expected) => {
    const r = await computeHandler({ problem });
    const text = allText(r);
    expect(r.isError, text).toBe(false);
    expect(text).toMatch(resultLine(expected));
  });
});

/**
 * Giac reads `A(B)` as a PRODUCT when B writes bare a name A writes —
 * `y(1-y)` is `y*(1-y)`, `(x+y)(x+1)` a product — and as an application only
 * when it shares none. 15fc328 refused every one of these, the logistic
 * equation among them, as a delay equation; main answers each.
 */
describe('a product written by juxtaposition still solves', () => {
  it.each([
    ["y'=y(1-y)", '[1/(-c_0*exp(-x)+1)]', undefined],
    ["desolve(y'=y(1-y), x, y)", '[1/(-c_0*exp(-x)+1)]', undefined],
    ["y'=y(y+1)", '[exp(x)/(-exp(x)+c_0)]', undefined],
    ["y'=x*y(1-y)", '[exp(1/2*x^2)/(exp(1/2*x^2)-c_0)]', undefined],
    ["y'=(y)(1-y)", '[1/(-c_0*exp(-x)+1)]', "y'=(y)(1-y) exactly)"],
    ["y'=(y)(y-1)", '[1/(-c_0*exp(x)+1)]', "y'=(y)(y-1) exactly)"],
    ["y'=(1+y)(1-y)", '[(c_0*exp(-2*x)+1)/(-c_0*exp(-2*x)+1)]', "y'=(1+y)(1-y) exactly)"],
    [
      "[y'=(1+y)(1-y), y(0)=0]",
      '[(-exp(-2*x)+1)/(exp(-2*x)+1)]',
      "y'=(1+y)(1-y) exactly and meets the conditions)",
    ],
    ["y'=-(y-1)(y-2)", '[(-c_0*exp(-x)+2)/(-c_0*exp(-x)+1)]', "y'=-(y-1)(y-2) exactly)"],
    ["y'=(y+1)(y-1)", '[(c_0*exp(2*x)+1)/(-c_0*exp(2*x)+1)]', "y'=(y+1)(y-1) exactly)"],
    ["y'=(2+y)(3-y)", '[(2*c_0*exp(-5*x)+3)/(-c_0*exp(-5*x)+1)]', "y'=(2+y)(3-y) exactly)"],
    [
      "y'=(y-1)(y-2)(y-3)",
      '[(-2*exp(2*x)+√(-c_0*exp(2*x)+c_0^2)+2*c_0)/(-exp(2*x)+c_0),(-2*exp(2*x)-√(-c_0*exp(2*x)+c_0^2)+2*c_0)/(-exp(2*x)+c_0)]',
      undefined,
    ],
    [
      "y'=(x+y)(x+1)",
      'c_0*exp((x^2+2*x)/2)-x+√pi*erf(1/2*(x+1)*exp(ln(2)/2))*exp((x^2+2*x-ln(2)+1)/2)',
      undefined,
    ],
    [
      "y'=(y^2+1)(y)",
      '[√(c_0*exp(2*x)-c_0^2*exp(2*x)^2)/(-c_0*exp(2*x)+1),-√(c_0*exp(2*x)-c_0^2*exp(2*x)^2)/(-c_0*exp(2*x)+1)]',
      undefined,
    ],
  ])('%s', async (problem, expected, verified) => {
    const r = await computeHandler({ problem });
    const text = allText(r);
    expect(r.isError, text).toBe(false);
    expect(text).toMatch(resultLine(expected));
    if (verified !== undefined) {
      expect(text).toContain(`Verified: ✓ (substitution: substitutes back into ${verified}`);
    }
  });
});

/**
 * A number written against the name: Giac lexes `2y(x-1)` as `(2*y)(x-1)`,
 * and e480674 did not see `y` behind the digit (c_0+x^2-2*x).
 */
describe('a coefficient does not hide the function', () => {
  it.each([
    ["y'=2y(x-1)", 'x-1'],
    ["desolve(y'=2y(x-1), x, y)", 'x-1'],
    ["y'=3y(x/2)", 'x/2'],
    ["y'=0.5y(x-1)", 'x-1'],
    ["y'=2y(0)", '0'],
    ["y'=y+3y(0)", '0'],
    ["desolve(y'=y+3y(0), x, y)", '0'],
    // A product applied: (y*(1-y))(x-1) to Giac.
    ["y'=y(1-y)(x-1)", '(1-y)(x-1)'],
  ])('%s applies y at %s', async (problem, at) => {
    const r = await computeHandler({ problem });
    const text = allText(r);
    expect(r.isError, text).toBe(true);
    expect(text).toContain(refusal(at));
  });

  it.each([
    ["y'=(2y)(x-1)", '(2y)(x-1)'],
    ["y'=2y(x)", '2y(x)'],
    ["desolve(y'=2y(x), x, y)", '2y(x)'],
    // Shares no bare name, so applied: main answered (y^2)(x^2) (5*c_0+x^5)/5.
    ["y'=(y+1)(x+2)", '(y+1)(x+2)'],
    ["y'=(y^2)(x^2)", '(y^2)(x^2)'],
    ["desolve(y'=(y^2)(x^2), x, y)", '(y^2)(x^2)'],
    // A name inside a call is not counted: main gave c_0+x*a(sin(a))+x*sin(a).
    ["y'=(a+y)(sin(a))", '(a+y)(sin(a))'],
  ])('%s applies y through %s', async (problem, expression) => {
    const r = await computeHandler({ problem });
    const text = allText(r);
    expect(r.isError, text).toBe(true);
    expect(text).toContain(builtRefusal(expression));
  });
});

const conditionRefusal = (expression: string): string =>
  `solve_ode cannot solve this equation — it gives a condition that applies y through ` +
  `${expression} — write a condition at a point, as y(0)=1 or y'(0)=0`;

describe('an expression built from y in a condition is the condition’s fault', () => {
  it.each([
    ["[y'=y, (2*y)(0)=1]", '(2*y)(0)'],
    ["desolve([y'=y, (2*y)(0)=1], x, y)", '(2*y)(0)'],
    ["[y'=y, (y+y')(0)=4]", "(y+y')(0)"],
    ["y'=y and (2*y)(0)=1", '(2*y)(0)'],
  ])('%s', async (problem, expression) => {
    const r = await computeHandler({ problem });
    const text = allText(r);
    expect(r.isError, text).toBe(true);
    expect(text).toContain(conditionRefusal(expression));
  });
});

describe('appliedExpression', () => {
  it.each([
    ["y'=(-y)(x-1)", '(-y)(x-1)'],
    ["y'=(1*y)(x-1)", '(1*y)(x-1)'],
    ["y'=x1(y)(x-1)", 'x1(y)(x-1)'],
    ["y'=x1 (y)(x-1)", 'x1 (y)(x-1)'],
    ["y'=(-y)(x)(0)+1", '(-y)(x)(0)'],
    ["y'=(-y)(x-1", '(-y)(x-1'],
    ["y'=(y@(x->x-1))(x)", '(y@(x->x-1))(x)'],
    ["y'=y@(x->x/2)", 'y@(x->x/2)'],
    ["y'=sin(x)@y", 'sin(x)@y'],
    ["y'=sin@@2@y", '2@y'],
    ["y'=y'@sin", "y'@sin"],
    ["y'=sin@y'", "sin@y'"],
    ["y'=apply(y,x-1)", 'apply(y,x-1)'],
    ["y'=map(x-1,y)", 'map(x-1,y)'],
    ["y'=apply(y,0", 'apply(y,0'],
    // The first in the text, whichever shape.
    ["y'=apply(y,0)+(-y)(x-1)", 'apply(y,0)'],
    ["y'=(-y)(x-1)+apply(y,0)", '(-y)(x-1)'],
    ["y'=2y(x)", '2y(x)'],
    ["y'=0.5 y(x)", '0.5 y(x)'],
    ["y'=(2y)(x-1)", '(2y)(x-1)'],
    ["y'=(y+x)(sin(x))", '(y+x)(sin(x))'],
    // A call's result applied is never a product, shared name or not.
    ["y'=sin(y)(y)", 'sin(y)(y)'],
    // A lambda's names are bound, not shared.
    ["y'=(y@(x->x-1))(x)", '(y@(x->x-1))(x)'],
  ])('%s applies %s', (text, expression) => {
    expect(appliedExpression(text, 'y', 'x')).toEqual({ expression, inCondition: false });
  });

  it.each([
    "y'=y",
    "y'=y(x)",
    "y'=y((x))",
    // A bare bracketed name is the name; misappliedArgument reads where.
    "y'=(y)(x-1)",
    "y'=(y)(x)",
    "y'=2(y)",
    "y'=(y+1)*(x+2)",
    "y'=sin(x)(y)",
    "y'=(x+1)(z)",
    "y'=z@sin+apply(f,x)+map(x,z)",
    "y'=mapy(y)+apply_y(y)+yy@sin",
    // A derivative call at a point is y' there.
    "[y'=y, diff(y(x),x)(0)=1]",
    // Products: the brackets share a bare name.
    "y'=(1+y)(1-y)",
    "y'=(x+y)(x+1)",
    "y'=(y-1)(y-2)(y-3)",
    "y'=-(y-1)(y-2)",
    "y'=(y^2+1)(y)",
    "y'=2y(1-y)",
    "y'=(2*y)(x-y)",
  ])('%s applies nothing built from y', (text) => {
    expect(appliedExpression(text, 'y', 'x')).toBeUndefined();
  });

  it.each([
    ["[y'=y, (2*y)(0)=1]", { expression: '(2*y)(0)', inCondition: true }],
    ["[y'=y, (y+y')(0)=4]", { expression: "(y+y')(0)", inCondition: true }],
    // The equation's is reported first, wherever it stands.
    ["[(2*y)(0)=1, y'=(-y)(x-1)]", { expression: '(-y)(x-1)', inCondition: false }],
    ["[y'=y+(-y)(x-1)*0, (2*y)(0)=1]", { expression: '(-y)(x-1)', inCondition: false }],
  ])('%s', (text, expected) => {
    expect(appliedExpression(text, 'y', 'x')).toEqual(expected);
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
    // A bracket that writes y bare multiplies it, unless y is primed; a name
    // inside a call is not counted, and y applied is not bare.
    ["y'=y'(1-y)", '1-y'],
    ["y'=y(sin(y))", 'sin(y)'],
    ["y'=y(f(y))", 'f(y)'],
    ["y'=y(y')", "y'"],
    // The product's own inner application is still read: y*(y(0)+y).
    ["y'=y(y(0)+y)", '0'],
    ["y'=y(1-y)(x-1)", '(1-y)(x-1)'],
    // A number against the name does not hide it.
    ["y'=2y(x-1)", 'x-1'],
    ["y'=y+3y(0)", '0'],
    ["y'=0.5y(x-1)", 'x-1'],
    // A number before a bracket multiplies.
    ["y'=1(y)(x-1)", 'x-1'],
    ["y'=2.5 (y)(x-1)", 'x-1'],
    // A redundant round bracket is read through, a square one is a list.
    ["y'=y((x-1))", '(x-1)'],
    ["y'=y((0))", '(0)'],
    ["y'=y([x])", '[x]'],
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
    "y'=x1(y)(x-1)",
    // Products.
    "y'=y(1-y)",
    "y'=x*y(1-y)",
    "y'=y(x+y)",
    // Another name: x1y is one identifier.
    "y'=x1y(x-1)+y",
    // Nor is a name after a prime y: Giac lexes `y'y(x-1)` as undef(x-1), and
    // the CAS's own error stands.
    "y'=y'y(x-1)",
    "y'=y((x))",
    "y'=y( ( x ) )",
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
