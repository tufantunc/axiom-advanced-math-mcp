import { describe, it, expect, beforeAll } from 'vitest';
import { giacEngine } from '../src/server/giac/index.js';
import { computeHandler } from '../src/server/tools/compute/index.js';
import { calculusHandler } from '../src/server/tools/calculus.js';
import {
  functionOccurrences,
  odeEquationMembers,
  odeMemberConditions,
  readSingleOde,
  singleOdeText,
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
    ["y'(0)=1, y''=-y, y(0)=0", 'sin(x)', "desolve([y''=-y, y'(0)=1, y(0)=0],x,y)"],
    ["y(0)=1, y'(x)=y", 'exp(x)', "desolve([y'=y, y(0)=1],x,y)"],
    ['y(0)=1, dy/dx=y', 'exp(x)', "desolve([y'=y, y(0)=1],x,y)"],
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
    ["desolve([y'(x)=y(x), y(0)=1], x, y)", 'exp(x)'],
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

/**
 * Inputs main refuses and that earlier versions of this change answered
 * WRONGLY, every one with no Verified line: a condition mentioning `y'(x)`
 * read as a second equation (`3*exp(x)`), a member joined with `&&` or `∧`
 * read as one equation, a condition with a bare prime promoted to the
 * equation (`-3*x+3+3*x`), and a delay `y(x-1)` read as the function. Each
 * must stay a refusal: readSingleOde declines, and the text is solved — or
 * refused — exactly as typed.
 */
describe('spellings readSingleOde must not accept', () => {
  it.each([
    // A condition that mentions the derivative at the variable.
    "[y'=y, y(0)+y'(x)=3]",
    "desolve([y'=y, y(0)+y'(x)=3], x, y)",
    "[y'=y, y'(x)-y(0)=5]",
    "[y'(x)=y(x), y(0)+y'(x)=3]",
    // Conjunctions, in every spelling.
    "y'=y and y(0)+y'(x)=3",
    "y'(x)=y(x) and y(0)+y'(x)=3",
    "y'(x)=y(x) or y(0)+y'(x)=3",
    "y'=y && y(0)+y'(x)=3",
    "[y'=y && y(0)+y'(x)=3]",
    "y'(x)=y(x) && y(0)+y'(x)=3",
    "desolve(y'(x)=y(x) && y(0)+y'(x)=3, x, y)",
    "y'(x)=y(x) || y(0)+y'(x)=3",
    "y'(x)=y(x) ∧ y(0)+y'(x)=3",
    "y'(x)=y(x) ∨ y(0)+y'(x)=3",
    "y'(x)=y(x); y(0)+y'(x)=3",
    // A condition with a bare prime is no condition, and no equation either.
    "[y'(x)=y(x), y(0)+y'=3]",
    "desolve([y'(x)=y(x), y(0)+y'=3], x, y)",
    "y'(x)=y(x), y(0)+y'=3",
    "[y'(x)=y(x), y'+y(0)=1]",
    // A delay, a scaled argument, or another variable is not the function.
    "desolve(y'(x)=y(x-1), x, y)",
    "y'(x)=y(x-1)",
    "desolve(y'(x)=y(x/2), x, y)",
    "desolve(y'(t)=y(x), t, y)",
    "y(0)=1, y'=y(x-1)",
    // Shapes main refuses that must stay refused.
    "[y'(x)=y(x), y'=1]",
    "[y'(x)=y(x), y(x)=5]",
    "y(x)=5, y'=y",
    "y(0)=x^2, y'=y",
    "[y'(x)=y(x), y'(x)(0)=1]",
    "y(0)=1, y'=y=2",
    "y(0)=1, y'=y, y(0)=2",
    "y(0)=1, y'=y+y(1)",
    "z(0)=1, y'=y",
    "y(0)=1, z'=z",
    "y(0)=1, y'=y'(0)*y",
    // Unbalanced: bounded as the literal it is.
    "y'=y, y(0)=factorial(10000",
    `[y'=y, y(0)+0*y'(x)=${LONG_VALUE}]`,
  ])('%s is refused, not answered', async (problem) => {
    const r = await computeHandler({ problem });
    const text = allText(r);
    expect(r.isError, text).toBe(true);
    expect(text).not.toMatch(/^Result:/m);
  });

  // A second derivative member stays a condition, so the list stays one
  // equation and keeps the equation's wording, not a system's.
  it.each(["[y'=y, y'(x)=1]", "desolve([y'=y, y'(x)=1], x, y)", "y'=y, y(0)=1, y'(x)=2"])(
    '%s is refused as an equation',
    async (problem) => {
      const r = await computeHandler({ problem });
      const text = allText(r);
      expect(r.isError, text).toBe(true);
      expect(text).toContain('solve_ode cannot solve this equation');
      expect(text).not.toContain('system');
    }
  );

  // Text the reader leaves alone reaches the engine exactly as on main.
  it.each([
    ["desolve(y'=y, y(0)=1, x, y)", 'exp(x)', "desolve((y'=y) and (y(0)=1),x,y)"],
    ["[y'=y, y(0)=1]", 'exp(x)', "desolve([y'=y, y(0)=1],x,y)"],
    ["[y'=z, z'=-y, y(0)=1, z(0)=0]", '[[cos(x),-sin(x)]]', undefined],
  ])('%s is unchanged', async (problem, expected, command) => {
    const r = await computeHandler({ problem });
    const text = allText(r);
    expect(r.isError, text).toBe(false);
    expect(text).toMatch(resultLine(expected));
    if (command !== undefined) expect(text).toContain(`Command: ${command}`);
    expect(text).toMatch(/^Verified: ✓/m);
  });
});

/**
 * The fail-closed gate: an answer to text the extractor CHANGED ships only
 * with a verified substitution. Everywhere else the single-equation path
 * refuses on a disproof only, which is how every wrong answer above shipped.
 */
describe('verification gate on rewritten text', () => {
  // The verifier has no verdict on a condition relating two derivatives at a
  // point, so this answer is correct but unverified: the stated cost.
  const unverifiable = {
    operation: 'solve_ode',
    equation: "[y'=y, y(0)=y'(0)]",
    original_equation: "[y'=y, y(0)=y'(0)]",
    variable: 'x',
    function_name: 'y',
  };

  it('answers the unverified text when the extractor did not change it', async () => {
    const r = await calculusHandler(unverifiable);
    const text = allText(r);
    expect(r.isError, text).toBe(false);
    expect(text).toMatch(/^Result: /m);
    expect(text).not.toMatch(/^Verified: ✓/m);
  });

  it('refuses the same answer when the extractor changed the text', async () => {
    const r = await calculusHandler({ ...unverifiable, single_ode_rewritten: true });
    const text = allText(r);
    expect(r.isError, text).toBe(true);
    expect(text).toContain('its answer could not be verified by substitution');
  });

  it('ships a verified answer to changed text', async () => {
    const r = await calculusHandler({
      ...unverifiable,
      equation: "[y'=y, y(0)=1]",
      original_equation: "[y'=y, y(0)=1]",
      single_ode_rewritten: true,
    });
    const text = allText(r);
    expect(r.isError, text).toBe(false);
    expect(text).toMatch(resultLine('exp(x)'));
  });

  it.each(["y(0)=y'(0), y'=y", "desolve([y(0)=y'(0), y'=y], x, y)"])(
    'reaches the gate from %s',
    async (problem) => {
      const r = await computeHandler({ problem });
      const text = allText(r);
      expect(r.isError, text).toBe(true);
      expect(text).toContain('its answer could not be verified by substitution');
    }
  );
});

describe('functionOccurrences', () => {
  it.each([
    [
      "y'=y(x)",
      [
        { primes: 1, at: 'bare' },
        { primes: 0, at: 'variable' },
      ],
    ],
    [
      "y''( x )+y(0)",
      [
        { primes: 2, at: 'variable' },
        { primes: 0, at: 'point' },
      ],
    ],
    ["y'(L)", [{ primes: 1, at: 'point' }]],
    ['y(x-1)', [{ primes: 0, at: 'other' }]],
    ['y(x/2)', [{ primes: 0, at: 'other' }]],
    ['y(x+0)', [{ primes: 0, at: 'other' }]],
    ["y'(x)(0)", [{ primes: 1, at: 'other' }]],
    ['y(0,1)', [{ primes: 0, at: 'other' }]],
    ['y(', [{ primes: 0, at: 'other' }]],
    // The inner application is read too: the outer one names the function.
    [
      'y(y(0))',
      [
        { primes: 0, at: 'other' },
        { primes: 0, at: 'point' },
      ],
    ],
    // Other identifiers, and a Leibniz numerator, are not the function.
    ["yy'(x)+z(x)+dy/dx", []],
  ])('%s', (text, expected) => {
    expect(functionOccurrences(text, 'y', 'x')).toEqual(expected);
  });
});

describe('readSingleOde', () => {
  it.each([
    ["y(0)=1, y'=y", { equation: "y'=y", conditions: ['y(0)=1'] }],
    [
      "[y'(x)=y(x), y'(0)=1, 2*y(0)=1]",
      { equation: "y'=y(x)", conditions: ["y'(0)=1", '2*y(0)=1'] },
    ],
    ["y(0)+y'(0)=1, y''+y=0", { equation: "y''+y=0", conditions: ["y(0)+y'(0)=1"] }],
    ['y(0)=1, dy/dx=y', { equation: 'dy/dx=y', conditions: ['y(0)=1'] }],
    ['y(0)=1, diff(y(x),x)=y', { equation: 'diff(y(x),x)=y', conditions: ['y(0)=1'] }],
    ["y'(x)=y(x)", { equation: "y'=y(x)", conditions: [] }],
    ["y(L)=0, y''=-y", { equation: "y''=-y", conditions: ['y(L)=0'] }],
  ])('reads %s', (text, expected) => {
    expect(readSingleOde(text, 'y', 'x')).toEqual(expected);
  });

  it.each([
    // 1. balance, and not a system
    ["y'=y, y(0)=factorial(10000"],
    ["[y'=z, z'=-y]"],
    // 2. nothing non-ASCII after normalisation
    ["y(0)=1, y'=y*ω"],
    // 3. no conjunction or relation
    ["y(0)=1, y'=y && 1"],
    ["y(0)=1, y'=y || 1"],
    ["y(0)=1; y'=y"],
    ["y(0)=1, y'=y<2"],
    ["y(0)=1, y'=y>2"],
    ["y(0)=50000!, y'=y"],
    ["y(0)=1, y'=y and 1"],
    ["y(0)=1, y'=y or 1"],
    ["y(0)=1, y'=y xor 1"],
    ["y(0)=1, y'=not(y)"],
    // 4. exactly one top-level `=`
    ["y(0)=1, y'=y=2"],
    ["y(0)=1, y'"],
    // 5. every appearance bare, at the variable, or at a point
    ["y(0)=1, y'=y(x-1)"],
    ["y(y(0))=1, y'=y"],
    // 6. no other primed function, quotient or derivative call
    ["y(0)=1, y'=y+z'"],
    ["y(0)=1, y'=dz/dx"],
    ['y(0)=1, dy/dt=y'],
    ["y(0)=1, y'=diff(z(x),x)"],
    ["y(0)=1, diff(y(x),x)(0)=1, y'=y"],
    // 7. exactly one equation
    ["[y'(x)=y(x), y'=1]"],
    ['y(0)=1, y=2'],
    ['y(0)=1, y(x)=2'],
    ["[y(0)=1, y'(0)=0]"],
    // 8. every other member a condition
    ["y(0)=x^2, y'=y"],
    ["y(0)+y'=3, y'(x)=y(x)"],
    ["z(0)=1, y'=y"],
    ["y(x)=5, y'=y"],
  ])('declines %s', (text) => {
    expect(readSingleOde(text, 'y', 'x')).toBeNull();
  });

  // After the rewrite the classifier reads the applied derivative as the
  // equation, and a derivative at a point as a condition.
  it('feeds the classifier the equation and keeps the point a condition', () => {
    const { text } = singleOdeText("[y'(x)=y(x), y'(0)=1, 2*y(0)=1]", 'y', 'x');
    expect(text).toBe("[y'=y(x), y'(0)=1, 2*y(0)=1]");
    expect(odeEquationMembers(text)).toEqual(['y(x)']);
    expect(odeMemberConditions(text)).toEqual(["y'(0)=1", '2*y(0)=1']);
  });
});

describe('singleOdeText', () => {
  it.each([
    ["y(0)=1, y'=y", "[y'=y, y(0)=1]", true],
    ["y'=y, y(0)=1", "[y'=y, y(0)=1]", true],
    ['(y(0)=1, dy/dx=y)', '[dy/dx=y, y(0)=1]', true],
    ["y'(x)=y(x)", "y'=y(x)", true],
    // Already in Giac's order, or declined: exactly as typed, and not flagged.
    ["[y'=y, y(0)=1]", "[y'=y, y(0)=1]", false],
    ["y'=y", "y'=y", false],
    ["[y'=z, z'=-y]", "[y'=z, z'=-y]", false],
    ["y'=y, y(0)=factorial(10000", "y'=y, y(0)=factorial(10000", false],
    ["[y(0)=1, y''+y=0, y'+y=0]", "[y(0)=1, y''+y=0, y'+y=0]", false],
  ])('%s', (text, expected, rewritten) => {
    expect(singleOdeText(text, 'y', 'x')).toEqual({ text: expected, rewritten });
  });
});
