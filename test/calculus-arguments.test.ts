import { describe, it, expect, beforeAll } from 'vitest';
import { giacEngine } from '../src/server/giac/index.js';
import { computeHandler } from '../src/server/tools/compute/index.js';
import { MAX_CALCULUS_ORDER } from '../src/server/tools/calculus.js';
import { allText } from './helpers/all-text.js';
import { resultLine } from './helpers/result-line.js';

beforeAll(async () => {
  await giacEngine.initialize();
}, 60000);

/** Giac's print of the all-zero 2^n tensor: `[0,0]` nested n deep. */
function zeroTensor(n: number): string {
  return n === 1 ? '[0,0]' : `[${zeroTensor(n - 1)},${zeroTensor(n - 1)}]`;
}

function factorial(n: number): bigint {
  let f = 1n;
  for (let k = 2n; k <= BigInt(n); k++) f *= k;
  return f;
}

// The arguments of diff, integrate and taylor. Each refusal below was an
// answer to a different problem, shipped with isError:false: the dropped
// argument, the ignored order, the number read as a variable. Through the real
// engine, so the accepted rows assert the mathematics.
describe('calculus arguments — the correct spellings answer', () => {
  it.each([
    ['integrate(x, x, 0, 1)', '1/2'],
    // Giac's range spelling, split into the same two bounds.
    ['integrate(x, x=0..1)', '1/2'],
    ['int(x^2, x)', 'x^3/3'],
    ['integrate(x, x, a, b)', 'b^2/2-a^2/2'],
    ['diff(sin(x), x, 2)', '-sin(x)'],
    // Giac's `x$2` order spelling, split so it is bounded like the third argument.
    ['diff(x^3, x$2)', '6*x'],
    ['diff(x^2, x, 1)', '2*x'],
    ['diff(t^2)', '2*t'],
    // The derivative of an unspecified function stays unevaluated, and that IS
    // the answer — why no result guard refuses an unevaluated `diff(`.
    ['diff(f(x), x)', 'diff(f(x),x)'],
    ['taylor(sin(x), x, 0, 3)', 'x-1/6*x^3'],
    ['taylor(sin(x), x=0, 3)', 'x-1/6*x^3'],
    ['taylor(sin(x), x=0)', 'x-1/6*x^3+1/120*x^5'],
    // A divergent integral is an answer, not a failure marker.
    ['integrate(1/x^2, x, 0, 1)', '+infinity'],
    // Any letter is a name to Giac, not ASCII only: these were refused.
    ['diff(sin(θ), θ)', 'cos(θ)'],
    ['integrate(cos(θ), θ)', 'sin(θ)'],
    ['taylor(sin(θ), θ, 0, 3)', 'θ-1/6*θ^3'],
    ['integrate(cos(θ), θ=0..π)', '0'],
    ['diff(θ^3, θ$2)', '6*θ'],
    // The guessed variable too: this guessed x and answered 0.
    ['diff(sin(θ))', 'cos(θ)'],
    // An ASCII letter wins the guess, so r, not π, is the variable.
    ['diff(π*r^2)', 'pi*2*r'],
    // A bracketed list of names is Giac's gradient.
    ['diff(x^2*y^3, [x, y])', '[2*x*y^3,x^2*3*y^2]'],
    // With an order, the Hessian and higher tensors, as Giac computes them.
    ['diff(x^2*y^3, [x, y], 2)', '[[2*y^3,6*x*y^2],[6*x*y^2,6*x^2*y]]'],
    ['diff(x^3*y, [x, y], 3)', '[[[6*y,6*x],[6*x,0]],[[6*x,0],[0,0]]]'],
    // Six orders of two variables, the most the cost cap allows x*y
    // (3 * 4^6 = 12,288; see MAX_DERIVATIVE_COST): all 0.
    ['diff(x*y, [x, y], 6)', zeroTensor(6)],
    // A Greek PARAMETER before the ASCII variable does not take its place: a
    // single any-script guess answered t*cos(ω*t) and 2/x.
    ['diff(sin(ω*t))', 'ω*cos(ω*t)'],
    ['integrate(cos(ω*t))', 'sin(ω*t)/ω'],
    ['diff(α*x^2)', 'α*2*x'],
    ['solve(α*x=2)', '2/α'],
    ['solve(ω*t=π)', 'pi/ω'],
    // With no ASCII letter, the Greek one is the variable.
    ['solve(θ^2=1)', '{-1, 1}'],
    ['λ^2-3λ+2=0', '{1, 2}'],
    // π is a constant, so the guess passes over it to θ.
    ['diff(sin(π*θ))', 'pi*cos(pi*θ)'],
    // One trailing `;` ends the statement; it is not text after the call.
    ['diff(x^2,x);', '2*x'],
  ])('%s is %s', async (problem, expected) => {
    const r = await computeHandler({ problem });
    expect(r.isError, allText(r)).toBe(false);
    expect(allText(r)).toMatch(resultLine(expected));
  });

  // The ceiling itself is accepted: the bound is inclusive.
  it(`differentiates to order ${MAX_CALCULUS_ORDER}`, async () => {
    const r = await computeHandler({ problem: `diff(1/x, x, ${MAX_CALCULUS_ORDER})` });
    expect(r.isError, allText(r)).toBe(false);
    expect(allText(r)).toMatch(
      resultLine(`${factorial(MAX_CALCULUS_ORDER)}/x^${MAX_CALCULUS_ORDER + 1}`)
    );
  });

  it(`expands a series to order ${MAX_CALCULUS_ORDER}`, async () => {
    const r = await computeHandler({ problem: `taylor(sin(x), x, 0, ${MAX_CALCULUS_ORDER})` });
    const text = allText(r);
    expect(r.isError, text).toBe(false);
    // sin's last term below x^100 is -x^99/99!.
    expect(text).toMatch(
      new RegExp(`^Result: x-1/6\\*x\\^3\\+.*-1/${factorial(99)}\\*x\\^99$`, 'm')
    );
  });
});

describe('calculus arguments — a misread call is refused', () => {
  const order = (op: string, got: string) =>
    `${op}'s order must be a positive integer up to ${MAX_CALCULUS_ORDER} — got "${got}"`;

  it.each([
    // One bound used to be read as an indefinite integral: `x*y`.
    [
      'integrate(x, y, z)',
      'integrate takes a lower and an upper bound — got only "z"; give both, as in ' +
        'integrate(x, x, 0, 1), or neither for the antiderivative',
    ],
    [
      'integrate(x, x, 0, 1, 2)',
      'integrate takes an expression, a variable and optionally a lower and an upper bound, ' +
        'as in integrate(x, x, 0, 1) — got 5 arguments',
    ],
    [
      'integrate(x, x=0..1, 0, 1)',
      'integrate is given its bounds twice — write integrate(x, x, 0, 1) or integrate(x, x=0..1)',
    ],
    // A number as the variable answered the unevaluated `diff(x,2)`.
    ['diff(x, 2)', 'differentiate needs a variable that is a name, such as x — got "2"'],
    ['integrate(x, 2)', 'integrate needs a variable that is a name, such as x — got "2"'],
    ['taylor(sin(x), 2, 0, 3)', 'taylor needs a variable that is a name, such as x — got "2"'],
    [
      'diff(x^2, pi)',
      'differentiate needs a variable, and "pi" is a constant — name the variable, such as x',
    ],
    // parseInt read these as orders that were then ignored or dropped.
    ['diff(sin(x), x, -1)', order('differentiate', '-1')],
    ['diff(sin(x), x, 0)', order('differentiate', '0')],
    ['diff(sin(x), x, 2.5)', order('differentiate', '2.5')],
    // A mixed partial answered the first partial alone.
    ['diff(x^2*y^3, x, y)', order('differentiate', 'y')],
    ['diff(x^3, x$0)', order('differentiate', '0')],
    [
      `diff(1/x, x, ${MAX_CALCULUS_ORDER + 1})`,
      order('differentiate', `${MAX_CALCULUS_ORDER + 1}`),
    ],
    ['diff(x^3, x$2, 2)', 'diff is given the order twice — write diff(f, x, 2) or diff(f, x$2)'],
    [
      'diff(x^2, x, 2, 3)',
      'diff takes an expression, a variable and an optional order, as in diff(sin(x), x, 2) — ' +
        'got 4 arguments',
    ],
    // A symbolic order answered the default order 5.
    ['taylor(sin(x), x, 0, n)', order('taylor', 'n')],
    ['taylor(sin(x), x, 0, 0)', order('taylor', '0')],
    [
      `taylor(sin(x), x, 0, ${MAX_CALCULUS_ORDER + 1})`,
      order('taylor', `${MAX_CALCULUS_ORDER + 1}`),
    ],
    // Trapped the shared worker ("RuntimeError: unreachable") before the bound.
    ['taylor(sin(x)/x, x, 0, 1000000)', order('taylor', '1000000')],
    [
      'taylor(sin(x), x=0, 3, 4)',
      'taylor takes an expression, a variable, a point and an optional order, as in ' +
        'taylor(sin(x), x, 0, 5) — got 4 arguments',
    ],
    ['taylor(sin(x), x=, 3)', 'taylor cannot read this call — the point is empty'],
    // The call never closes: `f(, x)` was read as the expression, `f` as the variable.
    ['diff(f(, x)', 'diff cannot read this call — 1 unclosed parenthesis'],
    // Text after the call was dropped: `2*x`.
    [
      'diff(x^2, x) + 1',
      'diff cannot read this call — it must be a single diff(...) with nothing after the ' +
        'closing parenthesis',
    ],
    ['diff(, x)', 'diff cannot read this call — argument 1 is empty'],
    ['integrate(x, x, , 1)', 'integrate cannot read this call — argument 3 is empty'],
    // splitArgs drops a final empty slot; these fell back to the default.
    ['taylor(sin(x), x, 0, )', 'taylor cannot read this call — argument 4 is empty'],
    ['diff(x^2, x, )', 'diff cannot read this call — argument 3 is empty'],
    ['diff(x^2, )', 'diff cannot read this call — argument 2 is empty'],
    [
      'diff(x^2,x);;',
      'diff cannot read this call — it must be a single diff(...) with nothing after the ' +
        'closing parenthesis',
    ],
    [
      'diff(x^2, π)',
      'differentiate needs a variable, and "π" is a constant — name the variable, such as x',
    ],
    ['diff(x^2, ∞)', 'differentiate needs a variable that is a name, such as x — got "∞"'],
    ['diff(x^2, x²)', 'differentiate needs a variable that is a name, such as x — got "x²"'],
    ['diff(x^2*y^3, [x, 2])', 'differentiate needs a variable that is a name, such as x — got "2"'],
    [
      'diff(x^2*y^3, [x, π])',
      'differentiate needs a variable, and "π" is a constant — name the variable, such as x',
    ],
    [
      'diff(x*y, [x, y], 9)',
      'differentiate with 2 variables to order 9 gives 2^9 entries, more than the 256 this ' +
        'computes — lower the order or list fewer variables',
    ],
    ['diff(x*y, [x, y], n)', order('differentiate', 'n')],
    // Values, not symbols: NULL answered 2*x, undef 0, true stayed unevaluated.
    [
      'diff(inf^2, inf)',
      'differentiate needs a variable, and "inf" is a constant — name the variable, such as x',
    ],
    [
      'diff(x^2, NULL)',
      'differentiate needs a variable, and "NULL" is a value — name the variable, such as x',
    ],
    [
      'diff(x^2, true)',
      'differentiate needs a variable, and "true" is a value — name the variable, such as x',
    ],
    [
      'diff(x^2, false)',
      'differentiate needs a variable, and "false" is a value — name the variable, such as x',
    ],
    [
      'diff(x^2, undef)',
      'differentiate needs a variable, and "undef" is a value — name the variable, such as x',
    ],
    // The gradient list is differentiate's alone.
    ['integrate(x, [x, y])', 'integrate needs a variable that is a name, such as x — got "[x, y]"'],
  ])('%s is refused', async (problem, message) => {
    const r = await computeHandler({ problem });
    const text = allText(r);
    expect(r.isError, text).toBe(true);
    expect(text).toContain(message);
    expect(text).not.toMatch(/^Result:/m);
  });

  // Giac answers a malformed expression inside a well-formed call with its
  // undefined marker; the result guard refuses it whatever input produced it.
  it.each(['diff(x+, x)', 'diff(f(, x), x)'])(
    '%s is refused on its [undef,x] answer',
    async (problem) => {
      const r = await computeHandler({ problem });
      const text = allText(r);
      expect(r.isError, text).toBe(true);
      expect(text).toContain(
        'differentiate cannot answer this — the CAS returned [undef,x] (non-finite result); ' +
          'check the expression for a missing operand or argument'
      );
    }
  );
});
