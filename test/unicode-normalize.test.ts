import { describe, it, expect } from 'vitest';
import { unicodeToAscii } from '../src/server/tools/unicode-normalize.js';

describe('unicodeToAscii', () => {
  it.each([
    // Every existing case parenthesised its argument, so the bare form was
    // never exercised: `√2` became the free symbol `sqrt2`, and
    // `simplify(√2*√2)` answered `sqrt2^2` instead of 2.
    ['√2', 'sqrt(2)'],
    ['√x', 'sqrt(x)'],
    ['√2*√2', 'sqrt(2)*sqrt(2)'],
    ['√2+√3', 'sqrt(2)+sqrt(3)'],
    // The ORDER of the replacements, which is load-bearing and was unenforced:
    // `π` has to become `pi` before the `√` rules look at the argument, or `√π`
    // falls through to the bare replacement and becomes the free symbol
    // `sqrtpi` — so `simplify(√π*√π)` answered `sqrtpi^2` instead of pi.
    ['√π', 'sqrt(pi)'],
    ['√π*√π', 'sqrt(pi)*sqrt(pi)'],
    ['√(π)', 'sqrt(pi)'],
    ['x²+√5', 'x^2+sqrt(5)'],
    // Nothing to take an argument from: left as the word, so the engine
    // reports it rather than this inventing an operand.
    ['√', 'sqrt'],
    // The parenthesised rule also normalises the space away, which the bare
    // rule cannot do — it only matches an identifier or a number.
    ['√ (x+1)', 'sqrt(x+1)'],
  ])('gives a bare √ its argument: %s', (input, expected) => {
    expect(unicodeToAscii(input)).toBe(expected);
  });

  it('replaces √ with sqrt', () => {
    expect(unicodeToAscii('√(1-x^2)')).toBe('sqrt(1-x^2)');
    expect(unicodeToAscii('-1/2*2*x*(√(1-x^2))^-1')).toBe('-1/2*2*x*(sqrt(1-x^2))^-1');
  });

  it('replaces π with pi', () => {
    expect(unicodeToAscii('π/2')).toBe('pi/2');
  });

  it('replaces unicode superscripts ⁰-⁹', () => {
    expect(unicodeToAscii('x²')).toBe('x^2');
    expect(unicodeToAscii('x³+x²+x¹+x⁰')).toBe('x^3+x^2+x^1+x^0');
    expect(unicodeToAscii('x⁴⁵⁶⁷⁸⁹')).toBe('x^456789');
  });

  // Each digit used to be replaced on its own, so a multi-digit superscript
  // became a tower: `10⁸⁰` reached Giac as `10^8^0`, which it reads
  // right-associatively as 10^(8^0), and `simplify(10⁸⁰)` answered 10 as a
  // SUCCESS. Every row above was one digit wide, which is how it went unseen.
  it.each([
    ['10⁸⁰', '10^80'],
    ['2²³', '2^23'],
    ['1000!⁹⁹', '1000!^99'],
    ['x¹⁰⁰', 'x^100'],
    // Two runs stay two exponents: only ADJACENT superscripts are one number.
    ['x²+x³', 'x^2+x^3'],
    ['x²·y¹²', 'x^2*y^12'],
  ])('reads a run of superscript digits as one exponent: %s', (input, expected) => {
    expect(unicodeToAscii(input)).toBe(expected);
  });

  // The rest of the Superscripts block was not mapped at all, so each glyph
  // reached Giac as part of an identifier and came back as a confident answer:
  // `simplify(x⁻¹)` answered the free symbol `x⁻`, `simplify(2ⁱ)` answered
  // `2*i`. A signed integer or a single letter stays bare — the benchmark
  // grader's own form for `x^{-1}` and `x^{n}` — and anything longer is
  // bracketed, because `^` binds tighter than `+`: `xⁿ⁺¹` as `x^n+1` is a
  // different expression.
  it.each([
    ['x⁻¹', 'x^-1'],
    ['x⁻¹²', 'x^-12'],
    ['xⁿ', 'x^n'],
    ['2ⁱ', '2^i'],
    ['xⁿ⁺¹', 'x^(n+1)'],
    // Meaningless as an exponent — mapped so compute rejects it, rather than
    // Giac reading it as the identifier `x⁼`.
    ['x⁼', 'x^(=)'],
  ])('reads a mixed superscript run as one exponent: %s', (input, expected) => {
    expect(unicodeToAscii(input)).toBe(expected);
  });

  // `⁽ ⁾` are out of scope: grouping, derivative order and iterate are three
  // readings of one spelling, and each answered some input wrongly as a
  // verified success. Unmapped, they end a run, so only the glyphs between
  // them are read — and Giac, measured, answers these as it did on main: an
  // error, or an answer showing the glyph.
  it.each([
    ['y⁽³⁾', 'y⁽^3⁾'],
    ['x⁽²⁾', 'x⁽^2⁾'],
    ['2⁽³⁾', '2⁽^3⁾'],
    ['(a+b)⁽²⁾', '(a+b)⁽^2⁾'],
    ['y⁽¹⁾³', 'y⁽^1⁾^3'],
  ])('leaves superscript brackets unmapped: %s', (input, expected) => {
    expect(unicodeToAscii(input)).toBe(expected);
  });

  // Joined with nothing between them, two letters were one identifier:
  // `simplify(xⁿⁱ)` answered `x^ni`, a free symbol, as a success. The product
  // is written out, and so is a digit beside a letter, since `n2` is a name too.
  it.each([
    ['xⁿⁱ', 'x^(n*i)'],
    ['x²ⁿ', 'x^(2*n)'],
    ['xⁿ²', 'x^(n*2)'],
  ])('writes the product inside a superscript run: %s', (input, expected) => {
    expect(unicodeToAscii(input)).toBe(expected);
  });

  // A superscript's end is visible; `^`'s is not. Followed by an operand, the
  // exponent read the operand in — bare, `x^-1y` answers `1/x^y`; bracketed,
  // `x^(-1)(y+1)` answers `x^(-y-1)`, since Giac applies a bracket group to
  // the exponent before it; and a space is juxtaposition, not a boundary.
  // Before a digit, a bracket, `.` or `√` — none of which can begin a word —
  // the product the typography means is written out.
  it.each([
    ['2⁻¹(y+1)', '2^(-1)*(y+1)'],
    ['(x+1)⁻¹(x-1)', '(x+1)^(-1)*(x-1)'],
    ['2⁻¹ (y+1)', '2^(-1)* (y+1)'],
    ['x⁻¹√2', 'x^(-1)*sqrt(2)'],
    // A bracket LATER is not a bracket next: these keep the product.
    ['x⁻¹√(x+1)', 'x^(-1)*sqrt(x+1)'],
    ['x⁻¹2(y)', 'x^(-1)*2(y)'],
    // A digit, bare, would extend the exponent: `x^-12` is not x⁻¹·2.
    ['x⁻¹2', 'x^(-1)*2'],
    ['x⁻¹ 2', 'x^(-1)* 2'],
    ['2ⁿ3', '2^(n)*3'],
    ['x⁻¹.5', 'x^(-1)*.5'],
    // Any digit, not ASCII only: bare, `x^-1₂` answered `1/x^₂`.
    ['x⁻¹₂', 'x^(-1)*₂'],
  ])('writes the product before a non-letter operand: %s', (input, expected) => {
    expect(unicodeToAscii(input)).toBe(expected);
  });

  // Between a NAME and a bracket, nothing local tells a power times a factor
  // from an inverse function: `x⁻¹(y+1)` and `f⁻¹(x)` are one shape. The
  // product answered `f⁻¹(x)` as `x/f` and `g⁻¹(t)`'s derivative as `1/g`,
  // clean-looking where main showed the glyph. So the run gets main's
  // one-glyph-at-a-time reading — and not the raw run, whose `¹` Giac lexes
  // as `undef`, which let verify prove `x⁻¹(y) = z⁻¹(y)`.
  it.each([
    ['f⁻¹(x)', 'f⁻^1(x)'],
    ['x⁻¹(y+1)', 'x⁻^1(y+1)'],
    ['y1⁻¹(x)', 'y1⁻^1(x)'],
    ['12a⁻¹(x)', '12a⁻^1(x)'],
    ['f10⁻¹(x)', 'f10⁻^1(x)'],
    ['x12⁻¹(y+1)', 'x12⁻^1(y+1)'],
    // Long trailing digits, so the window behind the run is known to reach
    // the name's letter: cut short, `a1234567890` reads as a number.
    ['theta2024⁻¹(x)', 'theta2024⁻^1(x)'],
    ['a1234567890⁻¹(x)', 'a1234567890⁻^1(x)'],
    ['x⁻¹ (y+1)', 'x⁻^1 (y+1)'],
    ['𝑓⁻¹(x)', '𝑓⁻^1(x)'],
    ['xⁿ⁺¹²(y)', 'xⁿ⁺^1^2(y)'],
  ])('reads a run between a name and a bracket as main did: %s', (input, expected) => {
    expect(unicodeToAscii(input)).toBe(expected);
  });

  // An exponent that ENDS in a sign has no operand to end on. Mapped, `^(+)`
  // is `undef` to Giac, and as a function head `undef(x)` — so
  // `(f⁺)(x) = (f⁻)(x)` verified. Such a run gets main's reading instead.
  it.each([
    ['f⁺', 'f⁺'],
    ['x⁻', 'x⁻'],
    ['0⁺', '0⁺'],
    ['fⁿ⁻', 'fⁿ⁻'],
    ['e⁻ᵗ', 'e⁻ᵗ'],
    ['x²⁻', 'x^2⁻'],
    ['(f⁺)(x)', '(f⁺)(x)'],
  ])('reads a run ending in a sign as main did: %s', (input, expected) => {
    expect(unicodeToAscii(input)).toBe(expected);
  });

  // The name is read from a window behind the run; near the start of a long
  // text that window must still be the text's start, not its end.
  it('reads an early run between a name and a bracket as main did, in a long text', () => {
    const tail = ` + ${'a+'.repeat(40)}a`;
    expect(unicodeToAscii(`f⁻¹(x)${tail}`)).toBe(`f⁻^1(x)${tail}`);
  });

  // Before a LETTER it cannot: a word may be an operand or one of Giac's word
  // operators, and a `*` in front of an operator answered as a success —
  // `simplify(3⁻¹ mod 7)` gave `undef % 7`, `2⁻¹ in [1/2,1]` gave 0, and a
  // list of operators to skip was incomplete twice over. Bracketed and left
  // alone, Giac itself decides: measured, it REFUSES `x^(-1)y`, `x^(-1) y`,
  // `x^(-1)θ` and `x^(-1)sin(x)`, and reads `x^(-1) union y`, `2^(-1) in […]`
  // and `3^(-1)mod 7` correctly.
  it.each([
    ['x⁻¹y', 'x^(-1)y'],
    ['xⁿy', 'x^(n)y'],
    ['x⁻¹ y', 'x^(-1) y'],
    ['x⁻¹θ', 'x^(-1)θ'],
    // Outside the BMP, as pasted math italics are: read one code unit at a
    // time, `𝑦` is not a letter and `x^-1𝑦` answered `1/x^𝑦`.
    ['x⁻¹𝑦', 'x^(-1)𝑦'],
    // Any case: bare, `x^-1Y` answered `1/x^Y` and `2^-1 Pi` answered `1/2^pi`.
    ['x⁻¹Y', 'x^(-1)Y'],
    ['A⁻¹B', 'A^(-1)B'],
    ['2⁻¹ Pi', '2^(-1) Pi'],
    // Any whitespace, not only a space: bare, `x^-1\ty` answered `1/x^y`.
    ['x⁻¹\ty', 'x^(-1)\ty'],
    ['xⁿ⁺¹y', 'x^(n+1)y'],
    ['x⁻¹π', 'x^(-1)pi'],
    ['x⁻¹_a', 'x^(-1)_a'],
    ['3⁻¹ mod 7', '3^(-1) mod 7'],
    ['3⁻¹mod 7', '3^(-1)mod 7'],
    ['2⁻¹ in [1/2,1]', '2^(-1) in [1/2,1]'],
    ['x⁻¹ union y', 'x^(-1) union y'],
    ['xⁿ and y', 'x^(n) and y'],
  ])('brackets, and writes no product, before a letter: %s', (input, expected) => {
    expect(unicodeToAscii(input)).toBe(expected);
  });

  // An operator is a boundary already, so an atomic exponent stays bare.
  it.each([
    ['x⁻¹+1', 'x^-1+1'],
    ['x⁻¹ + 1', 'x^-1 + 1'],
    ['x⁻¹)', 'x^-1)'],
    ['x⁻¹,y', 'x^-1,y'],
    // `.` is a decimal point only before a digit. Before another `.` it is
    // Giac's range operator, and a `*` in front of it made `10⁻³..1` answer
    // `0 .. 1/1000`.
    ['10⁻³..1', '10^-3..1'],
    ['xⁿ..1', 'x^n..1'],
    ['2ⁿ⁺¹..3', '2^(n+1)..3'],
  ])('leaves an atomic exponent bare before an operator: %s', (input, expected) => {
    expect(unicodeToAscii(input)).toBe(expected);
  });

  // KNOWN WRONG, pinned so that changing it is a decision: an all-digit run is
  // left bare whatever follows, because that is what one-digit input has always
  // produced. Measured, `simplify(x²y)` answers `(x^y)^2`. Writing `*` here
  // would fix it and change the output of every `x²` followed by an operand.
  it('leaves an all-digit exponent bare before an operand (x²y — known wrong)', () => {
    expect(unicodeToAscii('x²y')).toBe('x^2y');
  });

  // After a caret the superscript IS the exponent. Adding a second one made
  // `x^^2`, which Giac reads as XOR: `simplify(x^²)` answered `bitxor(x,2)`.
  it.each([
    ['x^²', 'x^2'],
    ['x**²', 'x^2'],
    ['x^⁻¹', 'x^-1'],
    ['x^²³', 'x^23'],
    // The same caret, when the exponent also needs its product written.
    ['x^⁻¹2', 'x^(-1)*2'],
    ['x**⁻¹2', 'x^(-1)*2'],
    ['x^⁻¹y', 'x^(-1)y'],
  ])('adds no second caret after ^ or **: %s', (input, expected) => {
    expect(unicodeToAscii(input)).toBe(expected);
  });

  // Deliberately out of scope, pinned so the boundary is a decision rather
  // than an accident: modifier letters (`ˣ`, U+02E3) are an open-ended
  // alphabet outside the Superscripts block, and a subscript names a variable.
  it.each([['eˣ'], ['x₁']])('leaves %s alone', (input) => {
    expect(unicodeToAscii(input)).toBe(input);
  });

  it('replaces × with * and ÷ with /', () => {
    expect(unicodeToAscii('2 × 3 ÷ 4')).toBe('2 * 3 / 4');
  });

  it('returns string unchanged when no Unicode math chars present', () => {
    expect(unicodeToAscii('sqrt(2)*x^2 + 3')).toBe('sqrt(2)*x^2 + 3');
  });

  it('handles multiple Unicode chars in one string', () => {
    expect(unicodeToAscii('√(π × x²)')).toBe('sqrt(pi * x^2)');
  });

  it('maps the middot · to multiplication', () => {
    expect(unicodeToAscii('2·x')).toBe('2*x');
  });
  it('still maps superscript ² to ^2 (regression)', () => {
    expect(unicodeToAscii('x²-4')).toBe('x^2-4');
  });
  it('leaves ASCII input unchanged', () => {
    expect(unicodeToAscii('factor(x^2-4)')).toBe('factor(x^2-4)');
  });
});
