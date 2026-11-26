import { describe, it, expect, beforeAll } from 'vitest';
import { giacEngine } from '../src/server/giac/index.js';
import { computeHandler } from '../src/server/tools/compute/index.js';
import { extractOde } from '../src/server/tools/compute/extractors.js';
import { allText } from './helpers/all-text.js';
import { resultLine } from './helpers/result-line.js';

/**
 * A single equation written in Leibniz notation.
 *
 * Giac has no such notation: it reads `dy/dx` as the quotient of two unknowns
 * named `dy` and `dx`. Before the rewrite, `desolve(dy/dx=y, y(0)=1, x, y)`
 * answered `Result: [dy/dx]` with isError:false — a wrong answer shipped as a
 * result, and the residual check could not catch it because the caller's own
 * equation carried the same quotient.
 */
beforeAll(async () => {
  await giacEngine.initialize();
}, 60000);

describe('single-equation Leibniz derivatives', () => {
  it.each([
    ['desolve(dy/dx=y, y(0)=1, x, y)', 'exp(x)'],
    ['desolve(dy/dx=y, x, y)', 'c_0*exp(x)'],
    // Second order, ASCII and superscript spellings alike.
    ["desolve(d^2y/dx^2=-y, y(0)=1, y'(0)=0, x, y)", 'cos(x)'],
    ["desolve(d²y/dx²=-y, y(0)=1, y'(0)=0, x, y)", 'cos(x)'],
  ])('%s answers %s, verified', async (problem, expected) => {
    const r = await computeHandler({ problem });
    const text = allText(r);
    expect(r.isError, text).toBe(false);
    expect(text).toMatch(resultLine(expected));
    expect(text).not.toMatch(/dy\/dx|dx\^2/);
    // The residual check ran against the rewritten equation, not the quotient.
    expect(text).toMatch(/^Verified: ✓/m);
  });

  // The quotient names the variable, with and without the verb, and the
  // implicit route reads the function from it too.
  it.each([
    ['desolve(dy/dt=y)', 'c_0*exp(t)', "desolve(y'=y,t,y)"],
    ['dy/dt=y', 'c_0*exp(t)', "desolve(y'=y,t,y)"],
    ['dz/dt=z', 'c_0*exp(t)', "desolve(z'=z,t,z)"],
    // Second order without the verb: the router's ODE test reads the order too,
    // where it used to send these to solve_equation as an equation in `d`.
    ['d^2y/dt^2=-y', 'c_0*cos(t)+c_1*sin(t)', "desolve(y''=-y,t,y)"],
    ['d²y/dt²=-y', 'c_0*cos(t)+c_1*sin(t)', "desolve(y''=-y,t,y)"],
    // With the verb, the shared reader reads the order: this was a function y
    // of `d` and failed, while the verbless spelling was read as z of t.
    ['desolve(d^2z/dt^2=-z)', 'c_0*cos(t)+c_1*sin(t)', "desolve(z''=-z,t,z)"],
    // A quotient anywhere in the text names the variable, not only a leading one.
    ['[dy/dt=y, y(0)=1]', 'exp(t)', "desolve([y'=y, y(0)=1],t,y)"],
  ])('%s is a function of the quotient’s variable', async (problem, expected, command) => {
    const r = await computeHandler({ problem });
    const text = allText(r);
    expect(r.isError, text).toBe(false);
    expect(text).toMatch(resultLine(expected));
    expect(text).toContain(`Command: ${command}`);
  });

  it('infers the variable from the quotient when none is named', () => {
    const { args } = extractOde('desolve(dy/dt=y)');
    expect(args.variable).toBe('t');
    expect(args.function_name).toBe('y');
  });

  // Rewriting either of these to primes would answer a different question.
  it.each([
    ['desolve(dy/dt=y, x, y)', 'it differentiates y with respect to t, but the variable is x'],
    ['desolve(d^2y/dx=-y, x, y)', 'its derivative d^2y/dx has different orders above and below'],
    ['desolve(d^0y/dx^0=y, x, y)', 'd^0y/dx^0 is not a derivative — its order is 0'],
    // Another function's quotient stays a quotient of two constants to Giac, and
    // the residual check certified the misreading: these answered
    // `(c_0*dt-dx*t)/dt` and `(c_0*dx+dz*x)/dx` with "Verified: ✓".
    [
      'desolve(dy/dt = -dx/dt, t, y)',
      'it differentiates x, but the function being solved for is y',
    ],
    ['dy/dt = -dx/dt', 'it differentiates x, but the function being solved for is y'],
    ['desolve(dy/dx=dz/dx, x, y)', 'it differentiates z, but the function being solved for is y'],
    // The order is spelled out as primes, so it is bounded before anything is
    // built: ten million took the process from 82 MB to 783 MB, and 1000 trapped
    // the Giac worker.
    [
      "y'=d^10000000y/dx^10000000",
      'its derivative d^10000000y/dx^10000… is of order above 10, the most this solves',
    ],
    ["y'=d^1000y/dx^1000", 'its derivative d^1000y/dx^1000 is of order above 10'],
  ])('%s is refused', async (problem, reason) => {
    const r = await computeHandler({ problem });
    const text = allText(r);
    expect(r.isError, text).toBe(true);
    expect(text).toContain(`solve_ode cannot solve this equation — ${reason}`);
  });

  // The system path translates the notation itself and is left alone.
  it('leaves a Leibniz system to the system path', async () => {
    const r = await computeHandler({
      problem: 'desolve([dy/dt=z, dz/dt=-y], y(0)=1, z(0)=0, t)',
    });
    const text = allText(r);
    expect(r.isError, text).toBe(false);
    expect(text).toMatch(resultLine('[[cos(t),-sin(t)]]'));
  });
});
