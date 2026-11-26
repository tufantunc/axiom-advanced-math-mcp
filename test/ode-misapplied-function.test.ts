import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { giacEngine } from '../src/server/giac/index.js';
import { computeHandler } from '../src/server/tools/compute/index.js';
import { misreadPrintedOde, odeMembersToQuote } from '../src/server/tools/ode-system-shape.js';
import { allText } from './helpers/all-text.js';
import { resultLine } from './helpers/result-line.js';

/**
 * A single ODE that Giac MISREADS: the unknown function applied anywhere but
 * at exactly the variable, or an expression built from it applied as a
 * function. Giac answered each with isError:false and a wrong answer on main:
 *
 *   y'=y(x-1)            (2*c_0+x^2-2*x)/2   — a delay equation
 *   y'=y(x/2)            (4*c_0+x^2)/4       — a pantograph equation
 *   y'=y(0)              c_0
 *   y'=2y(x-1)           c_0+x^2-2*x         — Giac reads (2*y)(x-1)
 *   y'=(y/2)(2-y)        c_0*exp(-x/2)+2     — Giac applies, not multiplies
 *   y'=apply(y,x-1)      c_0
 *
 * Whether `A(B)` is a product or an application is Giac's parser's call, and
 * four rounds of rules over the caller's text missed it in both directions —
 * the logistic `y'=y(1-y)` was refused. So the refusal reads the form Giac
 * prints for `quote(member)`, where a product carries its `*`.
 */
beforeAll(async () => {
  await giacEngine.initialize();
}, 60000);

afterEach(() => {
  vi.restoreAllMocks();
});

const refusal = (at: string, variable = 'x'): string =>
  `solve_ode cannot solve this equation — it applies y at ${at} rather than at the ` +
  `variable ${variable}, a delay or functional equation, which this does not solve`;

const builtRefusal = (expression: string): string =>
  `solve_ode cannot solve this equation — the CAS reads ${expression} as an expression ` +
  'built from y applied as a function, which this does not solve — write a product with *, ' +
  'and y only at the variable x';

const callRefusal = (call: string, primed: string): string =>
  `solve_ode cannot solve this equation — it writes a derivative at a point as ${call}, ` +
  `which the CAS drops — write it ${primed}`;

const conditionRefusal = (expression: string): string =>
  `solve_ode cannot solve this equation — it gives a condition that applies y through ` +
  `${expression} — write a condition at a point, as y(0)=1 or y'(0)=0`;

async function refused(problem: string): Promise<string> {
  const r = await computeHandler({ problem });
  const text = allText(r);
  expect(r.isError, text).toBe(true);
  expect(text).not.toMatch(/^Result:/m);
  return text;
}

describe('the function applied off the variable is refused', () => {
  it.each([
    ["y'=y(x-1)", 'x-1'],
    ["desolve(y'=y(x-1), x, y)", 'x-1'],
    ["y'=y(x/2)", 'x/2'],
    ["desolve(y'=y(x/2), x, y)", 'x/2'],
    ["y'=y(0)", '0'],
    ["desolve(y'=y(0), x, y)", '0'],
    ["y''+y(0)=0", '0'],
    ["y'=y(x+0)", 'x+0'],
    ["y'=y+y(1)", '1'],
    ["y'=y''(0)", '0'],
    ["y'=y(y(0))", 'y(0)'],
    // Giac applies y here: a name inside an unknown call is not shared.
    ["y'=y(f(y))", 'f(y)'],
    ["y'=y(sin(x))", 'sin(x)'],
    ["y'=y'(1-y)", '1-y'],
    // Every derivative notation, and a coefficient written with *.
    ["y'(x)=y(x-1)", 'x-1'],
    ['dy/dx=y(x-1)', 'x-1'],
    ['desolve(diff(y(x),x)=y(x-1), x, y)', 'x-1'],
    ["y'=2*y(x-1)", 'x-1'],
    ["y'=-y(x-1)", 'x-1'],
    // Brackets Giac prints away.
    ["y'=(y)(x-1)", 'x-1'],
    ["y'=1(y)(x-1)", 'x-1'],
    ["y'=y(x-1)(0)", 'x-1'],
    // A derivative call at a point in the equation is y' there.
    ["y'=diff(y(x),x)(0)", '0'],
    // With conditions beside it, in every joining.
    ["[y'=y(x-1), y(0)=1]", 'x-1'],
    ["y(0)=1, y'=y(x-1)", 'x-1'],
    ["y'=y(x-1) and y(0)=1", 'x-1'],
    ["desolve(y'=y(x-1), y(0)=1, x, y)", 'x-1'],
  ])('%s applies y at %s', async (problem, at) => {
    expect(await refused(problem)).toContain(refusal(at));
  });

  // A system is read by its own path, and worded for a system.
  it('leaves a system to its own refusal', async () => {
    expect(await refused("[y'=y(x-1)+z, z'=-y]")).toContain(
      'solve_ode cannot solve this system — it applies y to an argument other than x'
    );
  });

  it.each(["desolve(y'=y(x), t, y)", 'dy/dt=y(x)'])(
    '%s applies y at x where the variable is t',
    async (problem) => {
      expect(await refused(problem)).toContain(refusal('x', 't'));
    }
  );

  // The bounds run first, so oversized text never reaches the engine — not
  // even to be quoted.
  it('leaves an oversized condition to its own refusal', async () => {
    expect(await refused("desolve(y'=y(x-1), y(0)=50000!, x, y)")).toContain(
      'it gives an initial condition of implausible magnitude'
    );
  });
});

describe('an expression built from y and applied is refused', () => {
  it.each([
    // A number against the name: Giac's (2*y)(x-1); main gave c_0+x^2-2*x.
    ["y'=2y(x-1)", '(2*y)(x-1)'],
    ["desolve(y'=2y(x-1), x, y)", '(2*y)(x-1)'],
    ["y'=2e0y(x-1)", '(2.0*y)(x-1)'],
    // At the variable too: desolve answered c_0+integrate(2*t(x),x).
    ["y'=2y(x)", '(2*y)(x)'],
    ['desolve(diff(y(x),x)=2y(x), x, y)', '(2*y)(x)'],
    ["y'=y(1-y)(x)", '(y*(1-y))(x)'],
    // Giac applies when the brackets share no name, or a `/` is involved.
    ["y'=(-y)(x-1)", '(-y)(x-1)'],
    ["y'=(y/2)(2-y)", '(y/2)(2-y)'],
    ["y'=(1-y/2)(1+y)", '(1-y/2)(1+y)'],
    ["y'=(x+y)(x/2)", '(x+y)(x/2)'],
    ["y'=(x*y)(x/2)", '(x*y)(x/2)'],
    ["y'=(y+1)(x+2)", '(y+1)(x+2)'],
    ["y'=(y^2)(x^2)", '(y^2)(x^2)'],
    ["y'=x1(y)(x-1)", '(x1(y))(x-1)'],
    ["y'=[y](x-1)", '[y](x-1)'],
    // Composition, apply, map and of.
    ["y'=(y@(x->x-1))(x)", '(y@( (x)->x-1))(x)'],
    ["y'=y@(x->x-1)", 'y@( (x)->x-1)'],
    ["y'=y@@2", 'y@@2'],
    ["y'=compose(y,x->x-1)(x)", '(compose(y, (x)->x-1))(x)'],
    ["y'=apply(y,x-1)", 'apply(y,x-1)'],
    ["desolve(y'=apply(y,x-1), x, y)", 'apply(y,x-1)'],
    ["y'=map(x-1,y)", 'map(x-1,y)'],
    ["y'=of(y,x-1)", "'of'(y,x-1)"],
  ])('%s', async (problem, expression) => {
    expect(await refused(problem)).toContain(builtRefusal(expression));
  });
});

/**
 * Products as Giac reads them, each answered exactly as on main — 15fc328
 * through 2031883 refused one family or another of them as delay equations.
 */
describe("Giac's products still solve", () => {
  it.each([
    ["y'=y(1-y)", '[1/(-c_0*exp(-x)+1)]', undefined],
    ["desolve(y'=y(1-y), x, y)", '[1/(-c_0*exp(-x)+1)]', undefined],
    ["desolve(y'=y(ln(y)), x, y)", '[exp(exp(x-c_0))]', undefined],
    ["desolve(y'=y(ln(y)), y(0)=2, x, y)", '[exp(exp(x+ln(ln(2))))]', undefined],
    ["y'=y(1-ln(y))", '[exp(exp(-x+c_0)+1)]', undefined],
    ["y'=-y(ln(y))", '[exp(exp(-x-c_0))]', undefined],
    ["y'=y(sqrt(y))", '[(2/(c_0-x))^2]', undefined],
    ["desolve(x*y'=y(ln(y)), x, y)", '[exp(x*exp(-c_0))]', undefined],
    ["y'=(sin(y)+1)(sin(y)-1)", '[atan(-x+c_0)+n_1*pi]', undefined],
    [
      "y'=y(1-y)(2-y)",
      '[(-exp(2*x)+√(-c_0*exp(2*x)+c_0^2)+c_0)/(-exp(2*x)+c_0),(-exp(2*x)-√(-c_0*exp(2*x)+c_0^2)+c_0)/(-exp(2*x)+c_0)]',
      undefined,
    ],
    [
      'desolve(diff(y(x),x)=y(x)(1-y(x)), x, y)',
      '[1/(-c_0*exp(-x)+1)]',
      'diff(y(x),x)=y(x)(1-y(x)) exactly)',
    ],
    [
      "desolve(y'(x)=(1+y(x))(1-y(x)), x, y)",
      '[(c_0*exp(-2*x)+1)/(-c_0*exp(-2*x)+1)]',
      "y'=(1+y(x))(1-y(x)) exactly)",
    ],
    [
      'desolve(diff(y(x),x)=(1+y(x))(1-y(x)), y(0)=0, x, y)',
      '[(-exp(-2*x)+1)/(exp(-2*x)+1)]',
      'diff(y(x),x)=(1+y(x))(1-y(x)) exactly and meets the conditions)',
    ],
    ["y'=(1+y)(1-y)", '[(c_0*exp(-2*x)+1)/(-c_0*exp(-2*x)+1)]', "y'=(1+y)(1-y) exactly)"],
    [
      "[y'=(1+y)(1-y), y(0)=0]",
      '[(-exp(-2*x)+1)/(exp(-2*x)+1)]',
      "y'=(1+y)(1-y) exactly and meets the conditions)",
    ],
    [
      "y'=(x+y)(x+1)",
      'c_0*exp((x^2+2*x)/2)-x+√pi*erf(1/2*(x+1)*exp(ln(2)/2))*exp((x^2+2*x-ln(2)+1)/2)',
      undefined,
    ],
    ["y'=y'(1-y')", '[c_0]', undefined],
    // Brackets Giac prints away.
    ["y'=y(+x)", 'c_0*exp(x)', undefined],
    ["desolve(y'=y((x)), x, y)", 'c_0*exp(x)', undefined],
    ["y'=2(y)", 'c_0*exp(2*x)', "y'=2(y) exactly)"],
  ])('%s', async (problem, expected, verified) => {
    const r = await computeHandler({ problem });
    const text = allText(r);
    expect(r.isError, text).toBe(false);
    expect(text).toMatch(resultLine(expected));
    if (verified !== undefined) {
      expect(text).toContain(`Verified: ✓ (substitution: substitutes back into ${verified}`);
    }
  });

  it.each([
    ["y'=y", 'c_0*exp(x)', "y'=y exactly)"],
    ["[y'=y, y(0)=1]", 'exp(x)', "y'=y exactly and meets the conditions)"],
    ["y(0)=1, y'=y", 'exp(x)', "y'=y exactly and meets the conditions)"],
    ["desolve(y'(x)=y(x), y(0)=1, x, y)", 'exp(x)', "y'=y(x) exactly and meets the conditions)"],
    ["y'=y and y(0)=1", 'exp(x)', "y'=y exactly and meets the conditions)"],
    ["y'=y && y(0)=1", 'exp(x)', "y'=y exactly and meets the conditions)"],
    ["desolve(y'=y ∧ y(0)=1, x, y)", 'exp(x)', "y'=y exactly and meets the conditions)"],
    ["[y''=-y, y(0)=1, y'(0)=0]", 'cos(x)', "y''=-y exactly and meets the conditions)"],
  ])('the control %s solves', async (problem, expected, verified) => {
    const r = await computeHandler({ problem });
    const text = allText(r);
    expect(r.isError, text).toBe(false);
    expect(text).toMatch(resultLine(expected));
    expect(text).toContain(`Verified: ✓ (substitution: substitutes back into ${verified}`);
  });

  // Conditions at a point, however written.
  it.each([
    ["[y'=y, 2*y(0)=1]", '1/2*exp(x)'],
    ["[y'=y, y(0)+y'(0)=4]", '2*exp(x)'],
    ["[y''=-y, y(0)=0, y'(1)+y(1)=1]", '1/(cos(1)+sin(1))*sin(x)'],
    ["[y'=y, (y')(0)=1]", 'exp(x)'],
    ["[y'=y, y((0))=1]", 'exp(x)'],
  ])('the condition in %s is read', async (problem, expected) => {
    const r = await computeHandler({ problem });
    const text = allText(r);
    expect(r.isError, text).toBe(false);
    expect(text).toMatch(resultLine(expected));
  });
});

/**
 * Giac drops a condition written as a derivative CALL at a point, and
 * answered as if it were absent: `[y''=-y, y(0)=1, diff(y(x),x)(0)=0]` gave
 * cos(x)+c_1*sin(x), the Robin `diff(y(x),x)(1)+y(1)=1` 1/sin(1)*sin(x).
 */
describe('a derivative call at a point is refused with the spelling that works', () => {
  it.each([
    ["[y''=-y, y(0)=0, diff(y(x),x)(1)+y(1)=1]", 'diff(y(x),x)(1)', "y'(1)"],
    ["[y'=y, diff(y(x),x)(0)+y(0)=2]", 'diff(y(x),x)(0)', "y'(0)"],
    ["y''=-y and y(0)=1 and diff(y(x),x)(0)+y(0)=3", 'diff(y(x),x)(0)', "y'(0)"],
    ["[y''=-y, y(0)=1, diff(y(x),x)(0)=0]", 'diff(y(x),x)(0)', "y'(0)"],
    ['desolve([diff(y(x),x,2)=-y, y(0)=1, diff(y(x),x)(0)=0], x, y)', 'diff(y(x),x)(0)', "y'(0)"],
    ["[y'''=-y', y(0)=1, y'(0)=0, diff(y(x),x,2)(0)=-1]", 'diff(y(x),x,2)(0)', "y''(0)"],
  ])('%s', async (problem, call, primed) => {
    expect(await refused(problem)).toContain(callRefusal(call, primed));
  });

  it('leaves an oversized condition to its own refusal', async () => {
    expect(await refused("[y''=-y, y(0)=1142!, diff(y(x),x)(0)=1142!]")).toContain(
      'it gives initial conditions of implausible magnitude together'
    );
  });
});

describe('an expression built from y in a condition is the condition’s fault', () => {
  it.each([
    ["[y'=y, (2*y)(0)=1]", '(2*y)(0)'],
    ["desolve([y'=y, (2*y)(0)=1], x, y)", '(2*y)(0)'],
    ["[y'=y, (y+y')(0)=4]", "(y+y')(0)"],
    ["y'=y and (2*y)(0)=1", '(2*y)(0)'],
    // Giac answered cos(x)+c_1*sin(x), dropping it.
    ["[y''=-y, y'(x)(0)=0, y(0)=1]", "(y'(x))(0)"],
  ])('%s', async (problem, expression) => {
    expect(await refused(problem)).toContain(conditionRefusal(expression));
  });
});

/**
 * The refusal adds nothing when Giac cannot say how it reads the text: the
 * solve goes ahead exactly as it would have, and the CAS's own answer or
 * error stands.
 */
describe('a quote that fails adds no refusal', () => {
  it('passes text Giac prints as undef to the CAS', async () => {
    // `y'y` lexes as one undefined name.
    expect(await refused("y'=y'y(x-1)")).toContain('the CAS returned Giac error');
  });

  it('passes a statement separator to the CAS', async () => {
    expect(await refused("y'=y; y(0)=1")).toContain('the CAS returned Giac error');
  });

  it('solves as before when the quote throws', async () => {
    const evaluate = giacEngine.evaluate.bind(giacEngine);
    vi.spyOn(giacEngine, 'evaluate').mockImplementation((expression: string) =>
      expression.startsWith('quote(') ? Promise.reject(new Error('down')) : evaluate(expression)
    );
    const r = await computeHandler({ problem: "y'=y" });
    expect(allText(r)).toMatch(resultLine('c_0*exp(x)'));
    // The misread is not caught, so the delay is answered as main answered it.
    const delay = await computeHandler({ problem: "y'=y(x-1)" });
    expect(allText(delay)).toMatch(resultLine('(2*c_0+x^2-2*x)/2'));
  });

  it('solves as before when the quote prints undef', async () => {
    const evaluate = giacEngine.evaluate.bind(giacEngine);
    vi.spyOn(giacEngine, 'evaluate').mockImplementation((expression: string) =>
      expression.startsWith('quote(') ? Promise.resolve('undef') : evaluate(expression)
    );
    const delay = await computeHandler({ problem: "y'=y(x-1)" });
    expect(allText(delay)).toMatch(resultLine('(2*c_0+x^2-2*x)/2'));
  });
});

describe('odeMembersToQuote', () => {
  it.each([
    ["[y'=y, y(0)=1]", ["y'=y", 'y(0)=1']],
    ["y(0)=1, y'=y", ['y(0)=1', "y'=y"]],
    ["y'=y; y(0)=1", ["y'=y", 'y(0)=1']],
    ["(y'=y) and (y(0)=1)", ["(y'=y) and (y(0)=1)"]],
  ])('%s', (text, members) => {
    expect(odeMembersToQuote(text)).toEqual(members);
  });

  // A stray bracket would close the quote early and evaluate what follows.
  it.each(["y'=y), purge(x", "y'=y(", "[y'=y"])('%s is not quoted', (text) => {
    expect(odeMembersToQuote(text)).toBeNull();
  });
});

describe('misreadPrintedOde', () => {
  const read = (printed: string[], variable = 'x') => misreadPrintedOde(printed, 'y', variable);

  it.each([
    [["y'=(y(x-1))"], 'x-1'],
    [["y'=(y(0))"], '0'],
    [["y'=(y'(1-y))"], '1-y'],
    // `(y')'` is y'': the equation, with y applied at 0 in it.
    [["(y')'+y(0)=0"], '0'],
    [["((y')')'=(y(1))"], '1'],
    [["((y'=(y(x-1))) and (y(0)=1))"], 'x-1'],
    [["(((y(0)=1) and ((y'=(y(x-1)))))) and (y'(0)=2)"], 'x-1'],
    [["(y(0)=1) xor (y'=(y(2)))"], '2'],
    [["((y(0)=1) or (y'=(y(2))))"], '2'],
    [["[y(0)=1,y'=(y(x/2))]"], 'x/2'],
    [['y(0)=1', "y'=(y(x/2))"], 'x/2'],
    [["y'=(diff(y(x),x)(0))"], '0'],
    [["y'=(diff(y(x),x)(x-1))"], 'x-1'],
    // `(y')'(x-1)` is y'' at x-1.
    [["y'=((y')'(x-1))"], 'x-1'],
    // `or` inside `floor` is no join.
    [["y(0)*floor(x)+y'=0"], '0'],
    // Never printed so, but read: a chained application names its brackets.
    [["y'=y(x-1)(0)"], '(x-1)(0)'],
  ])('%j applies y at %s', (printed, argument) => {
    expect(read(printed)).toEqual({ kind: 'argument', argument });
  });

  it('reads the variable it is given', () => {
    expect(read(["y'=(y(x))"], 't')).toEqual({ kind: 'argument', argument: 'x' });
    expect(read(["y'=(y(t))"], 't')).toBeUndefined();
  });

  it.each([
    [["y'=((2*y)(x-1))"], '(2*y)(x-1)'],
    [["y'=((y(x))(0))"], '(y(x))(0)'],
    [["y'=((y*(1-y))(x))"], '(y*(1-y))(x)'],
    [["y'=([y](x-1))"], '[y](x-1)'],
    [["y'=((sin(y))(y))"], '(sin(y))(y)'],
    [["y'=((-y)(x)(0)+1)"], '(-y)(x)(0)'],
    [["y'=(y@( (x)->x-1))"], 'y@( (x)->x-1)'],
    [["y'=(sin(x)@y)"], 'sin(x)@y'],
    [["y'=(2@y)"], '2@y'],
    [["y'=(y'@sin)"], "y'@sin"],
    [["y'=(sin@y')"], "sin@y'"],
    [["y'=(apply(y,x-1))"], 'apply(y,x-1)'],
    [["y'=(map(x-1,y))"], 'map(x-1,y)'],
    [["y'=('of'(y,x-1))"], "'of'(y,x-1)"],
    // The first in the text.
    [["y'=(apply(y,0)+(-y)(x-1))"], 'apply(y,0)'],
    [["y'=((-y)(x-1)+apply(y,0))"], '(-y)(x-1)'],
  ])('%j applies %s', (printed, expression) => {
    expect(read(printed)).toEqual({ kind: 'built', expression, inCondition: false });
  });

  it.each([
    [["y'=y"]],
    [["y'=(y(x))"]],
    [["(y')'+y=0"]],
    [["y'=(y*(1-y))"]],
    [["y'=(y*ln(y))"]],
    [["y'(x)=(y(x)*(1-(y(x))))"]],
    [["y'=(f(x)*y(x))"]],
    [["y'=(unapply(y,x))"]],
    [["y'=(z@sin+apply(f,x)+map(x,z)+'of'(z,x))"]],
    [["y'=(mapy(y)+yy@sin+(z)(x)+(yy)(x))"]],
    [["((y'=y) and (y(0)=1))"]],
    [["[y'=y,y(0)=1,y'(0)=0,2*y(0)=1,y(0)+y'(0)=1,y(L)=0,y(1)=(2*y(0))]"]],
    [["y'=y", '(y(0)=1) and (y(1)=2)']],
  ])('%j is read as written', (printed) => {
    expect(read(printed)).toBeUndefined();
  });

  it.each([
    [["[y'=y,diff(y(x),x)(0)+y(0)=2]"], 'diff(y(x),x)(0)', "y'(0)"],
    [["[(y')'=(-y),diff(y(x),x,2)(0)=1]"], 'diff(y(x),x,2)(0)', "y''(0)"],
    [["y'=y", 'diff(y,x)(L)=1'], 'diff(y,x)(L)', "y'(L)"],
    // Ahead of a condition's built application.
    [["y'=y", '(2*y)(0)=1', 'diff(y(x),x)(0)=1'], 'diff(y(x),x)(0)', "y'(0)"],
  ])('%j writes %s', (printed, call, primed) => {
    expect(read(printed)).toEqual({ kind: 'derivative call', call, primed });
  });

  it.each([
    [["[y'=y,(2*y)(0)=1]"], '(2*y)(0)'],
    [["y'=y", "(y+y')(0)=4"], "(y+y')(0)"],
    [["(y'(x))(0)=0", '(2*y)(0)=1'], "(y'(x))(0)"],
    // A derivative call of another variable is not y' at a point.
    [["y'=y", 'diff(y(t),t)(0)=1'], '(y(t),t)(0)'],
  ])('%j has %s in a condition', (printed, expression) => {
    expect(read(printed)).toEqual({ kind: 'built', expression, inCondition: true });
  });

  // The equation's is reported, wherever it stands.
  it('reports the equation ahead of a condition', () => {
    expect(read(['(2*y)(0)=1', "y'=((-y)(x-1))"])).toEqual({
      kind: 'built',
      expression: '(-y)(x-1)',
      inCondition: false,
    });
  });
});
