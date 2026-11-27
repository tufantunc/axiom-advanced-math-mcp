import { describe, it, expect } from 'vitest';
import { odeCostError } from '../src/server/tools/ode-cost-bounds.js';

/**
 * The pure half of the ODE cost bounds: what odeCostError decides from text.
 * The end-to-end rows — the same inputs through computeHandler, with timings
 * and a concurrent caller — are in input-bounds.test.ts.
 *
 * Every refused row here was measured to burn the full 10s budget on main, and
 * every admitted edge to answer; the numbers are in ode-cost-bounds.ts.
 */
describe('the expansion estimate', () => {
  // The calibration: `y'=(x+1)^n*y` is the costliest position measured. 97 is
  // the largest n admitted (about 1.5s), 99 the smallest refused.
  it('admits (x+1)^97 as a coefficient and refuses (x+1)^99', () => {
    expect(odeCostError("y'=(x+1)^97*y")).toBeUndefined();
    expect(odeCostError("y'=(x+1)^99*y")).toMatch(
      /expands too far \(\(x\+1\)\^99\): its terms times their digits come to about 3,080, above the 3,000/
    );
  });

  it.each([
    // Measured to time out on main: the coefficient form of each.
    ["y'=(x+1)^5000*y", '(x+1)^5000'],
    ["y'=(x+1)^200*y", '(x+1)^200'],
    // A second symbol multiplies the monomials: 861 terms at n=40.
    ["y'=(x+a+1)^40*y", '(x+a+1)^40'],
    // Composition, which no per-power exponent cap sees: 6.4s each on main.
    ["y'=(x+1)^99*(x+2)^99*y", '(x+1)^99'],
    ["y'=((x+1)^14+1)^14*y", '((x+1)^14+1)^14'],
    // A forcing term: timed out at n=1500 on main, 4.7s at n=400.
    ["y''+y=(x+1)^1500", '(x+1)^1500'],
    // Transcendental atoms expand like symbols do.
    ["y'=(sin(x)+cos(x))^200*y", '(sin(x)+cos(x))^200'],
  ])('refuses %s, naming %s', (equation, culprit) => {
    const reason = odeCostError(equation);
    expect(reason).toMatch(/has a term that expands too far/);
    expect(reason).toContain(`(${culprit})`);
    expect(reason).toMatch(/substitute one symbol for a bracketed sum/);
  });

  it.each([
    // A power of ONE symbol is one term however high: 25ms on main.
    "y'=x^5000*y",
    "y'=sin(x)^5000*y",
    // A product of two such terms is two terms.
    "y'=(x^5000+1)*y",
    // Degree, not the multinomial, bounds a one-symbol base: 81 terms.
    "y'=(x^2+x+1)^40*y",
    // A symbolic or fractional exponent is not expanded at all.
    "y'=(x+1)^n*y",
    "y'=(x+1)^(1/2)*y",
    // Ordinary equations.
    "y''+3*y'+2*y=exp(x)",
    "y''+y=sin(x)^2",
  ])('admits %s', (equation) => {
    expect(odeCostError(equation)).toBeUndefined();
  });

  // A sum is as large as the parts the caller wrote; only a product or a power
  // creates expansion. A long polynomial is admitted, and a condition folded
  // in with `and` is not multiplied by the equation it is joined to.
  it('charges products and powers, not sums or the `and` join', () => {
    const polynomial = Array.from({ length: 300 }, (_, k) => `x^${k}`).join('+');
    expect(odeCostError(`y'=y+${polynomial}`)).toBeUndefined();
    expect(odeCostError("(y'=(x+1)^90*y) and (y(0)=1)")).toBeUndefined();
  });
});

describe('the height of the problem’s numbers', () => {
  // The edge, measured: a discriminant squares the y' coefficient, so 10^150
  // stays under the 10^308.25 root cliff (71ms) and 10^160 does not (timeout).
  it('admits a 150-digit coefficient and refuses a 160-digit one', () => {
    expect(odeCostError("y''+(10^150+1)*y'+y=0")).toBeUndefined();
    expect(odeCostError("y''+(10^160+1)*y'+y=0")).toMatch(
      /numbers that come to 160 digits together \(10\^160\), above the 150/
    );
  });

  it.each([
    // Each timed out on main; each is a root the SOLVER forms.
    ["y''+(10^400+1)*y=0", 400],
    ["y'=y+1/(x^2+10^400+1)", 400],
    ["y'=(10^400+1)*y^2+1", 400],
    ["(y'=2*sqrt(y)) and (y(0)=10^400+1)", 401],
    // A product of two coefficients each under the bound: the system form of
    // this timed out on main.
    ['[(10^160+1)*z, -(10^160+3)*y]', 321],
    // A quotient counts its denominator as well as its numerator.
    ["y''+(10^80+1)/(10^80+3)*y'+y=0", 161],
    // The condition counts with the equation, because they are solved together.
    ["(y''+10^80*y=0) and (y(0)=10^80)", 160],
    // A power of a number is charged its exponent times over.
    ["y'=y*2^4096", 1234],
  ])('refuses %s at %i digits', (text, digits) => {
    expect(odeCostError(text)).toMatch(
      new RegExp(`numbers that come to ${digits} digits together .*above the 150`)
    );
  });

  it.each([
    // The cheap numbers, so the bound cannot drift into ordinary input.
    "(y'=y) and (y(0)=sqrt(2))",
    "(y'=y) and (y(0)=1.5!)",
    "(y'=y) and (y(0)=20!)",
    "(y'=y) and (y(L)=pi/2)",
    "y'=0.001*y+1e-5",
  ])('admits %s', (text) => {
    expect(odeCostError(text)).toBeUndefined();
  });

  // The stated cost of summing over the whole problem: its coefficients
  // count together, so a long polynomial of written coefficients runs out of
  // height. 1..50 is log10(50!) = 64.5 digits and admitted; 1..120 is 199.
  it('counts many small coefficients together, which is its cost', () => {
    const polynomial = (n: number) =>
      Array.from({ length: n }, (_, k) => `${k + 1}*x^${k}`).join('+');
    expect(odeCostError(`y'=y+${polynomial(50)}`)).toBeUndefined();
    expect(odeCostError(`y'=y+${polynomial(120)}`)).toMatch(/199 digits together/);
  });

  it('reads the normalised text, as the engine does', () => {
    expect(odeCostError("(y'=y) and (y(0)=√(3^1000+2))")).toMatch(/478 digits together/);
  });
});

describe('the tree never throws and always bounds', () => {
  it('refuses nesting past the depth bound, with what to do about it', () => {
    const deep = `y'=${'('.repeat(101)}x${')'.repeat(101)}*y`;
    expect(odeCostError(deep)).toMatch(/nested more than 100 deep.*remove redundant brackets/);
    const shallow = `y'=${'('.repeat(100)}x${')'.repeat(100)}*y`;
    expect(odeCostError(shallow)).toBeUndefined();
  });

  it.each([
    ['a long chain of signs', `y'=${'-'.repeat(8_000)}y`],
    ['a long chain of powers', `y'=${'x^'.repeat(2_000)}2`],
    ['juxtaposed brackets past the depth bound', `y'=${'('.repeat(150)}1)(2)(3`],
    ['unbalanced closers', "y'=y)))]]"],
    ['nothing at all', ''],
    ['stray separators', "y'=$y;@#%"],
  ])('returns a verdict on %s', (_shape, text) => {
    expect(() => odeCostError(text)).not.toThrow();
  });
});
