import { describe, it, expect } from 'vitest';
import {
  ambiguousSuperscript,
  caretExponentRefusal,
  superscriptRefusal,
  unicodeToAscii,
} from '../src/server/tools/unicode-normalize.js';

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

  // The rest of the block's superscript half was not mapped at all, so each glyph
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
    ['x²ⁿ⁻¹', 'x^(2*n-1)'],
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
  ])('reads a run between a name and a bracket glyph by glyph: %s', (input, expected) => {
    expect(unicodeToAscii(input)).toBe(expected);
  });

  // Only a well-formed term becomes one exponent: a sign, then operands joined
  // by single signs. Joined any other way, the glyphs spell Giac OPERATORS —
  // `⁼⁼` is `==`, a leading `⁼` is `=nop`, `⁺⁺ⁿ` is `++n` — and `x⁼² = x²`,
  // `(f¹⁼⁼)(x) = (g¹⁼⁼)(x)` and `(f⁺⁺ⁿ)(x) = (g⁺⁺ⁿ)(x)` verified. `⁼` itself
  // is not mapped at all: in an exponent it can only be one of those.
  it.each([
    ['x⁼', 'x⁼'],
    ['x⁼²', 'x⁼^2'],
    ['x¹⁼⁼', 'x^1⁼⁼'],
    ['x⁺⁺ⁿ', 'x⁺⁺ⁿ'],
    ['x⁻⁻¹', 'x⁻⁻^1'],
    ['xⁿ⁺⁻¹', 'xⁿ⁺⁻^1'],
    // Whatever follows: the product and letter rules are for terms only.
    ['2ⁿ⁺⁻¹(y)', '2ⁿ⁺⁻^1(y)'],
    ['xⁿ⁺⁻¹2', 'xⁿ⁺⁻^12'],
    ['(x+1)⁻⁻¹(x+1)', '(x+1)⁻⁻^1(x+1)'],
    ['x⁻⁻¹y', 'x⁻⁻^1y'],
  ])('reads a run that is no single term glyph by glyph: %s', (input, expected) => {
    expect(unicodeToAscii(input)).toBe(expected);
  });

  // An exponent that ENDS in a sign has no operand to end on. Mapped, `^(+)`
  // is `undef` to Giac, and as a function head `undef(x)` — so
  // `(f⁺)(x) = (f⁻)(x)` verified. Such a run is read glyph by glyph instead.
  it.each([
    ['f⁺', 'f⁺'],
    ['x⁻', 'x⁻'],
    ['0⁺', '0⁺'],
    ['fⁿ⁻', 'fⁿ⁻'],
    ['e⁻ᵗ', 'e⁻ᵗ'],
    ['x²⁻', 'x^2⁻'],
    ['(f⁺)(x)', '(f⁺)(x)'],
  ])('reads a run ending in a sign glyph by glyph: %s', (input, expected) => {
    expect(unicodeToAscii(input)).toBe(expected);
  });

  // Two runs split only by spaces keep their per-glyph text here — the tools
  // refuse them — and an all-digit pair reads exactly as it always did.
  it.each([
    ['x² ³', 'x^2 ^3'],
    ['x⁻¹ ⁿ', 'x⁻^1 ^n'],
  ])('reads two runs split by spaces glyph by glyph: %s', (input, expected) => {
    expect(unicodeToAscii(input)).toBe(expected);
  });

  // The name is read from a window behind the run; near the start of a long
  // text that window must still be the text's start, not its end.
  it('reads an early run between a name and a bracket glyph by glyph, in a long text', () => {
    const tail = ` + ${'a+'.repeat(40)}a`;
    expect(unicodeToAscii(`f⁻¹(x)${tail}`)).toBe(`f⁻^1(x)${tail}`);
  });

  // A letter then a digit is n² as often as n·2 — superscripts cannot nest, so
  // `2ⁿ²` is how 2^(n²) is written in plain text — and the product was a
  // guess that verified `2ⁿ² = 4ⁿ`. Such a run is read glyph by glyph.
  it.each([
    ['2ⁿ²', '2ⁿ^2'],
    ['xⁱ²', 'xⁱ^2'],
    ['xⁿ²⁺¹', 'xⁿ^2⁺^1'],
    // Wherever the pair sits in the run, not only at its start.
    ['x⁻ⁿ²', 'x⁻ⁿ^2'],
    ['x¹⁺ⁿ²', 'x^1⁺ⁿ^2'],
  ])('reads a letter-then-digit run glyph by glyph: %s', (input, expected) => {
    expect(unicodeToAscii(input)).toBe(expected);
  });

  // A NAME CALL after the run is neither a factor nor a word operator: Giac
  // reads `x^(-1) sin(x)` inside a claim as `undef(x)`, and
  // `x⁻¹ sin(x) = x⁻¹ cos(x)` verified. Read glyph by glyph instead.
  it.each([
    ['x⁻¹ sin(x)', 'x⁻^1 sin(x)'],
    ['x⁻¹sin(x)', 'x⁻^1sin(x)'],
    ['xⁿ⁺¹ f(x)', 'xⁿ⁺^1 f(x)'],
    ['x⁻¹ f (x)', 'x⁻^1 f (x)'],
    ['x⁻¹ θ(x)', 'x⁻^1 θ(x)'],
    // A name with a digit is a name.
    ['x⁻¹ f2(x)', 'x⁻^1 f2(x)'],
  ])('reads a run before a name call glyph by glyph: %s', (input, expected) => {
    expect(unicodeToAscii(input)).toBe(expected);
  });

  // A space between a name and the run is still a name before it: without
  // it, `f ⁻¹(x)` got the product and answered `x/f`.
  it.each([
    ['f ⁻¹(x)', 'f ⁻^1(x)'],
    ['f_⁻¹(x)', 'f_⁻^1(x)'],
    ['x ⁻¹(y+1)', 'x ⁻^1(y+1)'],
    ['f\t⁻¹(x)', 'f\t⁻^1(x)'],
  ])('reads a run after a name and a space as before: %s', (input, expected) => {
    expect(unicodeToAscii(input)).toBe(expected);
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
    // A call LATER, past an operator, is not a call after the run.
    ['x⁻¹ + sin(x)', 'x^-1 + sin(x)'],
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
    // Read glyph by glyph too: `x^^1⁺` was XOR.
    ['x^¹⁺', 'x^1⁺'],
    ['x**¹⁺', 'x^1⁺'],
  ])('adds no second caret after ^ or **: %s', (input, expected) => {
    expect(unicodeToAscii(input)).toBe(expected);
  });

  // Deliberately out of scope, pinned so the boundary is a decision rather
  // than an accident: modifier letters (`ˣ`, U+02E3) are an open-ended
  // alphabet outside the Superscripts and Subscripts block, and a subscript names a variable.
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

// Where unicodeToAscii can only read a run glyph by glyph, that reading was
// measured wrong somewhere — as a guess, bracketed, and glyph by glyph alike:
// `2ⁱ²` answered -2 (Giac reads a raw `ⁱ` after a number as i), and
// `limit(x⁻¹ sin(2*x), x, 0)` answered 1 with the call inside the exponent.
// So caller text with such a run is refused, and this names the run.
describe('ambiguousSuperscript', () => {
  it.each([
    ['x⁻¹ sin(x)', '⁻¹'],
    ['x⁻¹sin(x)', '⁻¹'],
    ['x⁻¹ f2(x)', '⁻¹'],
    ['3⁻¹ mod (7)', '⁻¹'],
    ['f⁻¹(x)', '⁻¹'],
    ['f ⁻¹(x)', '⁻¹'],
    ['f_⁻¹(x)', '⁻¹'],
    ['x⁻¹(y+1)', '⁻¹'],
    ['2ⁱ²', 'ⁱ²'],
    ['2ⁿ²', 'ⁿ²'],
    ['x⁻ⁿ²', '⁻ⁿ²'],
    ['x¹⁺ⁿ²', '¹⁺ⁿ²'],
    ['x⁻', '⁻'],
    ['0⁺', '⁺'],
    ['(f⁺)(x)', '⁺'],
    ['x⁺⁺ⁿ', '⁺⁺ⁿ'],
    ['x⁻⁻¹', '⁻⁻¹'],
    // The first such run, past any that read cleanly — and before any later one.
    ['10⁸⁰ + x⁻¹ sin(x)', '⁻¹'],
    ['x⁻ + 2ⁱ²', '⁻'],
    // A name of any length, before the run or after it.
    [`x⁻¹ ${'a'.repeat(200)}(x)`, '⁻¹'],
    [`f${'1'.repeat(200)}⁻¹(x)`, '⁻¹'],
    [`${'b'.repeat(200)}⁻¹(x)`, '⁻¹'],
    // `_` starts a name as a letter does.
    ['_1⁻¹(x)', '⁻¹'],
    // Digits between two runs print into the first run's exponent — `x²12`
    // is `x^212` — so they are not a number the next run can take as a base.
    ['x²12⁻¹(z)', '⁻¹'],
    // …and a space before the next run does not separate them from it:
    // `x^212 ^(-1)*(z)` answered z·x^(1/212), and verified.
    ['x²12 ⁻¹(z)', '⁻¹'],
    // Two runs split only by spaces have no single reading: the second prints
    // into the first's exponent. `x⁻¹ ⁿ` answered 1/x and `x² ⁻¹(z)` z·√x, and
    // both verified.
    ['x⁻¹ ⁿ', '⁻¹'],
    ['xⁿ ⁱ(y)', 'ⁿ'],
    ['x² ⁻¹(z)', '²'],
    ['x² ³', '²'],
    // Any whitespace, and any amount of it.
    ['x⁻¹  ⁿ', '⁻¹'],
    ['x⁻¹\tⁿ', '⁻¹'],
    ['f  ⁻¹(x)', '⁻¹'],
    ['x²12  ⁻¹(z)', '⁻¹'],
  ])('names the run in %s', (input, run) => {
    expect(ambiguousSuperscript(input)).toBe(run);
  });

  it.each([
    ['10⁸⁰'],
    ['x²'],
    ['x²y'],
    ['x^²'],
    ['x⁻¹'],
    ['xⁿ⁺¹'],
    ['x²ⁿ'],
    ['xⁿⁱ'],
    ['2⁻¹(y+1)'],
    ['12⁻¹(z)'],
    // Runs split by anything but spaces are two readings, each its own.
    ['x² + y³'],
    ['x⁻¹ + yⁿ'],
    // `π` is a name that ends at the run after it, raw or read as `pi`, so the
    // run before it takes it as a factor and `²` stays a bare power.
    ['xⁿπ²(y)'],
    ['x⁻¹π²(2)'],
    ['x⁻¹2'],
    ['x⁻¹y'],
    ['3⁻¹ mod 7'],
    ['x⁻¹ + sin(x)'],
    ['10⁻³..1'],
    ['x⁻¹π'],
    ['sqrt(2)*x^2 + 3'],
  ])('finds nothing to refuse in %s', (input) => {
    expect(ambiguousSuperscript(input)).toBeUndefined();
  });

  // The glyphs replaced before runs are read cannot move a verdict: `π` is a
  // letter either way, and `×` is never a name.
  it('reads π as a name and × as an operator', () => {
    expect(ambiguousSuperscript('x⁻¹ π(x)')).toBe('⁻¹');
    expect(ambiguousSuperscript('x⁻¹×sin(x)')).toBeUndefined();
  });
});

describe('superscriptRefusal', () => {
  it('names the run and says how to write it', () => {
    const refusal = superscriptRefusal('x⁻¹ sin(x)');
    expect(refusal).toContain('`⁻¹`');
    expect(refusal).toContain('x^(-1)*sin(x)');
  });

  it('points a lone sign at the direction argument of a limit', () => {
    expect(superscriptRefusal('limit(x*ln(x), x, 0⁺)')).toContain('limit(f, x, a, +)');
    expect(superscriptRefusal('x⁻¹ sin(x)')).not.toContain('limit(f, x, a, +)');
  });

  it('refuses nothing that reads cleanly', () => {
    expect(superscriptRefusal('simplify(10⁸⁰) + x⁻¹')).toBeUndefined();
  });

  // The name scan stops at the next run, so it is linear: reading a name
  // across every later run made 8 KB of `aⁿ` take a third of a second. Timed
  // with a margin wide enough for a loaded machine, not tight enough to race.
  it('stays linear on the longest input a caller can send', () => {
    const inputs = [
      'aⁿ'.repeat(4096),
      'θⁿ'.repeat(4096),
      'abⁿ'.repeat(2730),
      'x⁻¹('.repeat(2048),
      'ⁿ('.repeat(4096),
      'a²ⁿ'.repeat(2730),
    ];
    const started = performance.now();
    for (const input of inputs) {
      unicodeToAscii(input);
      ambiguousSuperscript(input);
    }
    expect(performance.now() - started).toBeLessThan(250);
  });
});

// The refusal and the normaliser read one grammar: whatever the refusal lets
// through, unicodeToAscii reads without falling back on a glyph. They parted
// once — a name pattern whose exclusion guarded only its first character let
// `π²(` through raw and read `pi²(` glyph by glyph — and `x⁻¹π²(2) = …` got a
// verdict it should not have. Seeded, so a failure reproduces.
describe('superscriptRefusal and unicodeToAscii agree', () => {
  it('leaves no superscript in any text it does not refuse', () => {
    // Few symbols and short texts, so the junctions — a name, a run, a bracket,
    // `π` — meet often enough to be drawn. Park–Miller, whose products stay
    // exact in a double.
    const alphabet = ['x', 'a', 'b', '2', 'π', '×', ' ', '(', '+', '⁻', '¹', '²', 'ⁿ', 'ⁱ', '⁺'];
    let seed = 20260929;
    const next = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    const glyph = /[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻ⁱⁿ]/u;
    const leaks: string[] = [];
    for (let n = 0; n < 50000 && leaks.length < 5; n++) {
      let text = '';
      const length = 2 + Math.floor(next() * 6);
      for (let i = 0; i < length; i++) text += alphabet[Math.floor(next() * alphabet.length)];
      if (superscriptRefusal(text) === undefined && glyph.test(unicodeToAscii(text))) {
        leaks.push(text);
      }
    }
    expect(leaks).toEqual([]);
  });
});

describe('caretExponentRefusal', () => {
  // An exponent made of nothing but operators has no reading Giac can be
  // trusted with: `x^(==)` answers `x` (the exponent dropped), `x^(!=)`
  // answers `1`, `x^(+,)` answers powmod(x,undef,undef). `**` is Giac's own
  // spelling of `^` and is scanned the same way.
  it.each([
    ['x^(==)', '^(==)'],
    ['x^ (==)', '^ (==)'],
    ['x ^ (==)', '^ (==)'],
    ['2** (==)', '** (==)'],
    ['x^[==]', '^[==]'],
    ['x^(=\u200b=)', '^('],
    ['x^(!=)', '^(!=)'],
    ['x^(=)', '^(=)'],
    ['x^(+)', '^(+)'],
    ['x^(-)', '^(-)'],
    ['x^(*)', '^(*)'],
    ['x^(<=)', '^(<=)'],
    ['x^()', '^()'],
    ['x^==', '^=='],
    ['x^-', '^-'],
    ['x^(+,)', '^(+,)'],
    ['2^(==)+1', '^(==)'],
    ['x^(==)*y', '^(==)'],
    ['2**==', '**=='],
    // The tail after a legitimate run still gets its own scan: skipping
    // wholesale past an operand-bearing run would let `a^b^==` through.
    ['a^b^==', '^=='],
    // A C-style comment is transparent to Giac — it discards /*…*/
    // wholesale — so the operand characters inside one are not real and
    // the effective exponent is still soup.
    ['x^ /*c*/ (==)', '(==)'],
    ['x^(/*c*/ ==)', '^(/*c*/ ==)'],
    ['x^/**/(==)', '(==)'],
    ['x^= /*c*/ =', '^='],
  ])('refuses the operand-free exponent in %s', (input, slice) => {
    const refusal = caretExponentRefusal(input);
    expect(refusal).toBeDefined();
    expect(refusal).toContain(slice);
  });

  it.each([
    'x^2',
    'x^(-1)',
    'x^- 1',
    'x ^ - 1',
    'x^- /*c*/ 1',
    'x^[1,2]',
    'x^(n+1)',
    'e^(x)',
    'x^(-x)',
    '2^10',
    'x^-1',
    'x^.5',
    '2**3',
    'a^b_c',
    'x^((n+1))',
    'sqrt(x^2+1)^(-1)',
  ])('reads every legitimate exponent: %s', (input) => {
    expect(caretExponentRefusal(input)).toBeUndefined();
  });
});
