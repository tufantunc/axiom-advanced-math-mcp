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
  // the largest n admitted (about 1.5s), 98 the smallest refused.
  it('admits (x+1)^97 as a coefficient and refuses (x+1)^98', () => {
    expect(odeCostError("y'=(x+1)^97*y")).toBeUndefined();
    expect(odeCostError("y'=(x+1)^98*y")).toMatch(
      /expands too far \(\(x\+1\)\^98\): its terms times their digits come to about 3,020, above the 3,000/
    );
  });

  // The figures MAX_EXPANSION's docblock quotes, so they cannot go stale.
  it.each([
    [150, '6,969'],
    [200, '12,302'],
  ])('estimates (x+1)^%i*y at %s', (n, estimate) => {
    expect(odeCostError(`y'=(x+1)^${n}*y`)).toContain(`come to about ${estimate},`);
  });

  // An exponent Giac evaluates to an integer expands like the literal: each of
  // these timed out on this branch's first version, which read only literals.
  // One it cannot evaluate is charged as unbounded once the base is a sum.
  it.each([
    ["y'=pow(x+1,200)*y", 'pow(x+1,200)', 'about 12,302'],
    ["y'=(x+1)^abs(200)*y", '(x+1)^abs(200)', 'about 12,302'],
    ["y'=(x+1)^(5!*2)*y", '(x+1)^(5!*2)', 'about 17,653'],
    ["y'=(x+1)^foo(3)*y", '(x+1)^foo(3)', 'too many to count'],
  ])('refuses %s, whose exponent is a constant expression', (equation, culprit, estimate) => {
    expect(odeCostError(equation)).toContain(
      `expands too far (${culprit}): its terms times their digits come to ${estimate}`
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
  // creates expansion. This sum's own estimate is about 4,500 — 32 terms of a
  // 140-digit norm — and it is admitted because it is a sum; the same numbers
  // multiplied are refused.
  it('charges products and powers, not sums', () => {
    const powers = Array.from({ length: 30 }, (_, k) => `x^${k + 1}`);
    expect(odeCostError(`y'=y+10^140+${powers.join('+')}`)).toBeUndefined();
    expect(odeCostError(`y'=y+10^140*(${powers.join('+')})`)).toMatch(/expands too far/);
    expect(odeCostError("(y'=(x+1)^90*y) and (y(0)=1)")).toBeUndefined();
  });

  // A decimal base is a float to Giac and is not raised: `1.0001^1000` is a
  // coefficient of about 1.105, answered in 21ms on main.
  it('does not expand a power of a decimal', () => {
    expect(odeCostError("y''+1.0001^1000*y=0")).toBeUndefined();
  });

  // Linear in the tree: an 8 KB sum or product of distinct symbols took
  // 250ms of event-loop time when every node copied its degree map.
  it.each([
    ['sum', '+'],
    ['product', '*'],
  ])('reads an 8 KB %s of distinct symbols quickly', (_shape, operator) => {
    const names = Array.from({ length: 2_700 }, (_, i) => `a${i.toString(36)}`);
    const started = performance.now();
    odeCostError(`y'=${names.join(operator)}`);
    expect(performance.now() - started).toBeLessThan(50);
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
    // A power of a number is charged its exponent times over, whatever its sign
    // or spelling.
    ["y'=y*2^4096", 1234],
    ["(y'=y) and (y(0)=pow(10,400)+1)", 400],
    ["(y'=y) and (y(0)=10^-400)", 400],
    // A decimal literal is an exact rational to height: 1e-400 is 1/10^400.
    ["(y'=y) and (y(0)=1e-400)", 400],
    // A factorial of a constant counts the digits of its value, rounded up.
    ["(y'=y) and (y(0)=(1/2+100)!)", 160],
    // Giac's hexadecimal and binary literals are exact integers too: 340 hex
    // digits is 410 decimal ones, and this held the worker 10s.
    [`y''+(0x${'F'.repeat(340)}+2)*y=0`, 410],
    [`y''+(0b${'1'.repeat(1200)}+2)*y=0`, 362],
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
    "(y'=y) and (y(0)=0xFF)",
    // Floats raised: compound growth, which main answered.
    "y'=y*1.01^100",
    "y'=0.05*y*(1+0.07/12)^360",
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

  // Nesting of every kind counts against the bound — brackets, signs, powers
  // and `!` — so the folds can never recurse past it.
  it.each([
    ['a long chain of signs', `y'=${'-'.repeat(8_000)}y`],
    ['a long chain of powers', `y'=${'x^'.repeat(2_000)}2`],
    ['a long chain of factorials', `y'=x${'!'.repeat(8_000)}`],
    ['juxtaposed brackets past the depth bound', `y'=${'('.repeat(150)}1)(2)(3`],
  ])('refuses %s as nested too deep', (_shape, text) => {
    expect(odeCostError(text)).toMatch(/nested more than 100 deep/);
  });

  // FLAT chains are one level, however long: these overflowed the stack when
  // sums and products were binary.
  it.each([
    ['a long chain of separators', `y'=y${'='.repeat(8_000)}`],
    ['a long run of digits and spaces', `y'=y+${'1 '.repeat(4_000)}`],
    ['unbalanced closers', "y'=y)))]]"],
    ['nothing at all', ''],
    // Characters the tokenizer reads as separators and an equation may hold:
    // the `&&` and `∧` joins and letters the engine reads as plain symbols.
    ['stray separators', "y'=y&&&λ∧ω"],
  ])('admits %s without throwing', (_shape, text) => {
    expect(odeCostError(text)).toBeUndefined();
  });

  // Before the tree, the name check refuses what an equation is not written
  // with: these two rows were admitted here before it.
  it.each([
    [`y'=y+${'.'.repeat(8_000)}`, 'contains a range "..", which an equation is not written with'],
    ["y'=$y;@%", 'contains "$", which an equation is not written with'],
    ["y'=y;@#%", 'holds #, which the CAS reads as a string, a comment'],
  ])('refuses %#', (text, reason) => {
    expect(odeCostError(text)).toContain(reason);
  });
});

/**
 * The NAMES the text gives the CAS (equationNameError in ode-name-bounds.ts,
 * run first by odeCostError). The end-to-end rows, with timings and a
 * concurrent caller, are in input-bounds.test.ts; this is the rule itself, on
 * the texts the two paths hand it — the folded command of a single equation,
 * and a system's right-hand sides and conditions in brackets.
 */
describe('the names an equation gives the CAS', () => {
  const instead =
    'an equation may use elementary functions such as sin, exp, ln, sqrt and Heaviside, ' +
    'and parameters or functions of its own';
  const command = (name: string): string =>
    `calls ${name}, which the CAS runs as a command rather than reading as part of an equation — `;
  // Called on constants: a value the caller can compute on its own.
  const calls = (name: string): string =>
    `${command(name)}compute ${name}(…) on its own first and write the value in; ${instead}`;
  // Called on the variable: a term to write out.
  const callsOnX = (name: string): string =>
    `${command(name)}write the term in closed form; ${instead}`;
  const names = (name: string): string =>
    `names ${name}, which the CAS reserves for its own commands and syntax — remove or ` +
    `rename it; ${instead}`;
  const contains = (what: string): string =>
    `contains ${what}, which an equation is not written with — ${instead}`;

  it.each([
    // The commands the task measured, in every position the folds put them.
    ["y'=y+0*ifactor(2^257-1)", calls('ifactor')],
    ["(y'=y+0*ifactor(2^257-1)) and (y(0)=1)", calls('ifactor')],
    ["y'=y+0*ifactor(2^257-1) && y(0)=1", calls('ifactor')],
    ["y'=y+0*ifactor(2^257-1) ∧ y(0)=1", calls('ifactor')],
    ["[y'=y+0*ifactor(2^257-1), y(0)=1]", calls('ifactor')],
    ['[z+0*ifactor(2^257-1),-y]', calls('ifactor')],
    ["y'=y+0*nextprime(10^140)", calls('nextprime')],
    ["y'=y+0*isprime(10^140+1)", calls('isprime')],
    ["y'=y+0*ithprime(10^7)", calls('ithprime')],
    ["y'=y+0*factor(x^200-1)", callsOnX('factor')],
    ["y'=y+0*sum(1/k,k,1,10^9)", callsOnX('sum')],
    ["y'=y+0*product(k,k,1,30000)", callsOnX('product')],
    ["y'=y+0*seq(k,k,1,10^7)", callsOnX('seq')],
    ["y'=y*besselJ(0,x)", callsOnX('besselJ')],
    ["y'=y+pi*nextprime(10^140*pi)", calls('nextprime')],
    // A quote's contents are read like any other text.
    ["y'=y+quote(ifactor(2^257-1))", calls('ifactor')],
    ["y'=y+0*quote(quote(nextprime(10^140)))", calls('nextprime')],
    // A list index is a call to the CAS too.
    ["y'=y+0*ithprime[7]", calls('ithprime')],
    // A prime does not make a command a name of the caller's.
    ["y'=y+0*seq'(k,k,1,10^7)", callsOnX('seq')],
    // Bare names: a loop calls nothing, a group applies one, and a bare
    // command runs.
    ["y'=y+0*(while 1 do 1 od)", names('while')],
    ["y'=y+0*(for k from 1 to 10^9 do od)", names('for')],
    ["y'=y+0*(repeat 1 until 0)", names('repeat')],
    ["y'=y+0*(ifactor)(2^257-1)", names('ifactor')],
    ["y'=y+0*restart", names('restart')],
    ["y'=y+0*restart'", names('restart')],
    ["y'=x mod 2", names('mod')],
    // A CAS variable with a value: main answered c_0*exp(x*1e-12).
    ["y'=epsilon*y", names('epsilon')],
    // A leading underscore is a unit, and `_seq(k,k,1,3)` runs seq.
    ["y'=y+0*_seq(k,k,1,10^7)", callsOnX('_seq')],
    ["y'=y+0*_ifactor(2^257-1)", calls('_ifactor')],
    // Operators no name shows.
    ["y'=y+0*(k$(k=1..10^7))", contains('"$"')],
    ['diff(y(x),x$(10^7))+y(x)=0', contains('"$"')],
    ['diff(y(x),x$2^30)+y(x)=0', contains('"$"')],
    ["y'=y+0*((f->f(f))(f->f(f)))", contains('">"')],
    ["y'=y+0*(g(k):=g(k+1))", contains('":"')],
    ["y'=y+0*(sin@@10)(x)", contains('"@"')],
    ["y'=y+0*{1}", contains('"{"')],
    ["y'=y+0*(1..10)", contains('a range ".."')],
    // `&^` and `.^` are powers the expansion bound does not see: the `&^300`
    // spelling held the worker 10s on this branch's first version.
    ["y'=y*((x+1)&^300)", contains('"&"')],
    ["y'=y*((x+1)&*(x+2))", contains('"&"')],
    [
      "y'=y*((x+1).^300)",
      'contains "." outside a number, which the CAS reads as an elementwise operator — ' +
        `write a decimal with its digits, as 0.5; ${instead}`,
    ],
    // Glyphs the engine reads as commands: `∑(1/(k^3+2),k,1,10^4)` held the
    // worker 10s on this branch's first version, which admitted every glyph.
    ["y'=y+∑(1/(k^3+2),k,1,10^4)", contains('"∑"')],
    ["y'=y+Σ(k,k,1,10^9)", contains('"Σ"')],
    ["y'=y+∫(x^2,x)", contains('"∫"')],
    ["y'=∂(x^2,x)*y", contains('"∂"')],
    ["y'=y+0*(3→q)", contains('"→"')],
    ["y'=y∘y", contains('"∘"')],
  ])('refuses %s', (text, reason) => {
    expect(odeCostError(text)).toBe(reason);
  });

  // The derivative order is summed over the text: three `x$100` in one call
  // timed out where one answers.
  it.each([
    ['diff(y(x),x$101)+y(x)=0', 101],
    ['diff(y(x),x$100,x$100,x$100)+y(x)=0', 300],
  ])('refuses %s, an order of %i', (text, order) => {
    expect(odeCostError(text)).toBe(
      `repeats its variable ${order} times with $, above the 100 this tool accepts as the ` +
        'order of a derivative — lower the order'
    );
  });

  it.each([
    // The equations the task names, and the spellings they reach the CAS in.
    "y'=r*y*(1-y/K)",
    "y'=r*y*ln(K/y)",
    "y'=y(ln(y))",
    "y'+y=exp(-x)",
    "y''+y=sin(2*x)",
    "y''+4*y=Heaviside(x-1)",
    "y''+y=Dirac(x-1)",
    "(y'+2*y=Heaviside(x-pi)) and (y(0)=0)",
    '[z+exp(x),-y]',
    // The caller's own parameters and functions are inert symbols to the CAS,
    // in Greek letters too.
    "y'=f(x)*y+g(x)",
    "D*y''=y",
    "L*I'+R*I=V",
    "y'=lambda*y+beta*gamma",
    "y'=-λ*y+ω*θ",
    // Constants, joins, decimals and the derivative spellings.
    "y'=pi*y+e+i*infinity",
    "y'=0.5*y+2.*x+.25",
    "y'=y AND y(0)=1",
    "y'=y or y(0)=1",
    "y'=y &&& y(0)=1",
    'diff(y(x),x)=y(x)',
    'diff(y(x),x$2)+y(x)=0',
    'diff(y(x),x$50,x$50)+y(x)=0',
    "y'=abs(x)+sign(x)+erf(x)+max(x,1)+floor(x)+Gamma(3)+Si(x)+Ci(x)+Ei(x)",
  ])('admits %s', (text) => {
    expect(odeCostError(text)).toBeUndefined();
  });
});
