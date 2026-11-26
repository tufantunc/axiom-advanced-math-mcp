import { describe, it, expect, beforeAll } from 'vitest';
import { giacEngine } from '../src/server/giac/index.js';
import { computeHandler } from '../src/server/tools/compute/index.js';
import {
  equationFirst,
  odeEquationMembers,
  odeMemberConditions,
  primesAtVariableUnapplied,
} from '../src/server/tools/ode-system-shape.js';
import { allText } from './helpers/all-text.js';
import { resultLine } from './helpers/result-line.js';

/**
 * Two spellings of an ordinary single ODE that came back as errors.
 *
 * A condition written BEFORE the equation: `y(0)=1, y'=y` reached desolve with
 * the condition first, as separate arguments, and was "the CAS returned Giac
 * error" — Giac reads the first member as the equation — where `[y'=y, y(0)=1]`
 * answers exp(x).
 *
 * A derivative applied at the variable: `desolve(y'(x)=y(x), x, y)` was "the
 * CAS returned unevaluated derivative" — Giac answers `[(function_diff(y))(x)]`
 * for it — and, because its left side is an application, it was charged as an
 * initial condition against the 280-character bound.
 */
beforeAll(async () => {
  await giacEngine.initialize();
}, 60000);

const LONG_VALUE = `1*${Array(150).fill('9').join('/')}`;
const FORCING = Array.from({ length: 32 }, (_, k) => `sin(${k + 1}*x)`).join('+');

describe('single-equation ODE spellings', () => {
  it.each([
    // The condition first, verbless, in every notation and bracketing.
    ["y(0)=1, y'=y", 'exp(x)', "desolve([y'=y, y(0)=1],x,y)"],
    ['y(0)=1, dy/dt=y', 'exp(t)', "desolve([y'=y, y(0)=1],t,y)"],
    ["[y(0)=1, y'=y]", 'exp(x)', "desolve([y'=y, y(0)=1],x,y)"],
    ["y(0)=1, y'(0)=0, y''=-y", 'cos(x)', "desolve([y''=-y, y(0)=1, y'(0)=0],x,y)"],
    // Unbracketed, the equation-first order reached desolve as separate
    // arguments too, and answered `[]`.
    ["y'=y, y(0)=1", 'exp(x)', "desolve([y'=y, y(0)=1],x,y)"],
    // And with the verb, inside the brackets.
    ["desolve([y(0)=1, y'=y], x, y)", 'exp(x)', "desolve([y'=y, y(0)=1],x,y)"],
  ])('%s is the initial-value problem', async (problem, expected, command) => {
    const r = await computeHandler({ problem });
    const text = allText(r);
    expect(r.isError, text).toBe(false);
    expect(text).toMatch(resultLine(expected));
    expect(text).toContain(`Command: ${command}`);
    // Substituted into the EQUATION: the first member of the text the residual
    // check reads must be it, not the condition.
    const equation = command.slice('desolve(['.length).split(',')[0];
    expect(text).toContain(
      `Verified: ✓ (substitution: substitutes back into ${equation} exactly and meets the conditions)`
    );
  });

  it.each([
    ["desolve(y'(x)=y(x), x, y)", 'c_0*exp(x)', "y'=y(x)"],
    ["y'(x)=y(x)", 'c_0*exp(x)', "y'=y(x)"],
    ["desolve(y'(t)=y(t), t, y)", 'c_0*exp(t)', "y'=y(t)"],
    ["desolve(y''(x)+y(x)=0, x, y)", 'c_0*cos(x)+c_1*sin(x)', "y''+y(x)=0"],
  ])('%s is the derivative at the variable', async (problem, expected, equation) => {
    const r = await computeHandler({ problem });
    const text = allText(r);
    expect(r.isError, text).toBe(false);
    expect(text).toMatch(resultLine(expected));
    expect(text).toContain(`Verified: ✓ (substitution: substitutes back into ${equation} exactly)`);
  });

  it.each([
    ["desolve(y'(x)=y(x), y(0)=1, x, y)", 'exp(x)'],
    ["[y'(x)=y(x), y(0)=1]", 'exp(x)'],
    ["y(0)=1, y'(x)=y(x)", 'exp(x)'],
  ])('%s meets its condition', async (problem, expected) => {
    const r = await computeHandler({ problem });
    const text = allText(r);
    expect(r.isError, text).toBe(false);
    expect(text).toMatch(resultLine(expected));
    expect(text).toContain(
      "Verified: ✓ (substitution: substitutes back into y'=y(x) exactly and meets the conditions)"
    );
  });

  // The 280-character bound is a CONDITION's. At the variable, the applied
  // spelling is the equation and is bounded as one, by magnitude.
  it('solves a long equation written with applied derivatives', async () => {
    expect(FORCING.length).toBeGreaterThan(280);
    const r = await computeHandler({ problem: `desolve(y''(x)+y(x)=${FORCING}, x, y)` });
    const text = allText(r);
    expect(r.isError, text).toBe(false);
    expect(text).not.toContain('initial condition');
    expect(text).toMatch(/^Result: c_0\*cos\(x\)\+c_1\*sin\(x\)\+/m);
    expect(text).toMatch(/^Verified: ✓ \(substitution: substitutes back into y''\+y\(x\)=sin/m);
  });
});

/**
 * Every condition keeps its bounds, whichever order it is written in and
 * whatever the equation beside it is spelled as. A reclassification that
 * drops a bound is the regression to guard against.
 */
describe('conditions keep their bounds', () => {
  it.each([
    ["y(0)=50000!, y'=y", 'it gives an initial condition of implausible magnitude'],
    [`y(0)=${LONG_VALUE}, y'=y`, 'it gives an initial condition of 306 characters, above the 280'],
    [
      `desolve([y'(0)=${LONG_VALUE}, y''(x)=-y(x)], x, y)`,
      'it gives an initial condition of 307 characters, above the 280',
    ],
    [
      `[2*y(0)=${LONG_VALUE}, y'=y]`,
      'it gives an initial condition of 308 characters, above the 280',
    ],
    [
      `[y(0)+y'(0)=${LONG_VALUE}, y'(x)=y(x)]`,
      'it gives an initial condition of 312 characters, above the 280',
    ],
    [
      "desolve([y''(x)=-y(x), y'(0)=50000!], x, y)",
      'it gives an initial condition of implausible magnitude',
    ],
    // Condition first, verbless: the together bound the verb route applies.
    [
      "[diff(y(x),x)(0)=1142!, y(0)=1142!, y''=-y]",
      'it gives initial conditions of implausible magnitude together',
    ],
    [
      "[y''=-y, y(0)=1142!, diff(y(x),x)(0)=1142!]",
      'it gives initial conditions of implausible magnitude together',
    ],
    // The equation keeps its own bound in the applied spelling.
    [
      "desolve(y'(x)=y(x)*10^100000, x, y)",
      'it has a term of implausible magnitude (an exponent of 100000',
    ],
    // A trailing condition at the variable is still refused by name: that is
    // a second equation, which the rewrite of the EQUATION does not touch.
    ["desolve(y'(x)=y(x), y'(x)=0, x, y)", 'does not understand the argument "y\'(x)=0"'],
  ])('%s keeps its refusal', async (problem, reason) => {
    const r = await computeHandler({ problem });
    const text = allText(r);
    expect(r.isError, text).toBe(true);
    expect(text).toContain(reason);
  });
});

describe('primesAtVariableUnapplied', () => {
  it.each([
    ["y'(x)=y(x)", "y'=y(x)"],
    ["y''( x )+y=0", "y''+y=0"],
    ["[y'(x)=y(x), y'(0)=1]", "[y'=y(x), y'(0)=1]"],
    // Points, other functions and other variables are left as written.
    ["y'(0)=1", "y'(0)=1"],
    ["y'(L)=1", "y'(L)=1"],
    ["y'(x+0)=5", "y'(x+0)=5"],
    ["y'(xx)=5", "y'(xx)=5"],
    ["z'(x)=y", "z'(x)=y"],
    ["yy'(x)=1", "yy'(x)=1"],
    ['y(x)=1', 'y(x)=1'],
  ])('%s', (text, expected) => {
    expect(primesAtVariableUnapplied(text, 'y', 'x')).toBe(expected);
  });

  // After the rewrite the classifier reads the applied derivative as the
  // equation, and a derivative at a point as a condition.
  it('feeds the classifier the equation and keeps the point a condition', () => {
    const rewritten = primesAtVariableUnapplied("[y'(x)=y(x), y'(0)=1, 2*y(0)=1]", 'y', 'x');
    expect(odeEquationMembers(rewritten)).toEqual(['y(x)']);
    expect(odeMemberConditions(rewritten)).toEqual(["y'(0)=1", '2*y(0)=1']);
  });
});

describe('equationFirst', () => {
  it.each([
    ["y(0)=1, y'=y", "[y'=y, y(0)=1]"],
    ["y'=y, y(0)=1", "[y'=y, y(0)=1]"],
    ["[y(0)=1, y''+y=0, y'(0)=0]", "[y''+y=0, y(0)=1, y'(0)=0]"],
    ['(y(0)=1, dy/dt=y)', '[dy/dt=y, y(0)=1]'],
    // Already in Giac's order, a lone equation, a system, no equation at all
    // and two equation-like members are all left exactly as written.
    ["[y'=y, y(0)=1]", "[y'=y, y(0)=1]"],
    ["y'=y", "y'=y"],
    ["[y'=z, z'=-y]", "[y'=z, z'=-y]"],
    ["[y(0)=1, y'(0)=0]", "[y(0)=1, y'(0)=0]"],
    ["[y''+y=0, y'+y=0]", "[y''+y=0, y'+y=0]"],
    ["[y(0)=1, y''+y=0, y'+y=0]", "[y(0)=1, y''+y=0, y'+y=0]"],
    // Unbalanced text is not rebracketed: its tail stays the literal the
    // condition bound reads.
    ["y'=y, y(0)=factorial(10000", "y'=y, y(0)=factorial(10000"],
    ["y(0)=1], y'=y", "y(0)=1], y'=y"],
  ])('%s', (text, expected) => {
    expect(equationFirst(text)).toBe(expected);
  });
});
