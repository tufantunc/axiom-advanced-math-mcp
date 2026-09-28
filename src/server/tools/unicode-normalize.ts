/**
 * The superscript half of Unicode's Superscripts and Subscripts block
 * (U+2070–U+207F) less `⁼ ⁽ ⁾`, plus the three Latin-1 digits `¹²³`, as the
 * ASCII each stands for.
 *
 * Nearly the whole half, because the measured alternative was worse at each
 * glyph left out: an unmapped superscript reaches Giac as part of an
 * identifier and comes back as a confident answer — `simplify(x⁻¹)` answered
 * the free symbol `x⁻`, `simplify(xⁿ⁺¹)` answered `xⁿ⁺`, and `simplify(2ⁱ)`
 * answered `2*i`.
 *
 * Out of scope, deliberately:
 *   - `⁼`, which in an exponent can only spell one of Giac's operators — `⁼⁼`
 *     is `==`, a leading `⁼` is `=nop` — and did: mapped, `x⁼² = x²` and
 *     `2⁼¹¹ = 2048` verified.
 *   - `⁽ ⁾`, three notations rather than one — grouping (`2⁽³⁾`), derivative
 *     order (`y⁽³⁾` is y'''), iterate (`f⁽²⁾`) — and every reading measured
 *     answered some input wrongly as a verified success: as grouping,
 *     `desolve(y⁽³⁾=0, y)` answered `[0]`; as a derivative,
 *     `simplify((a+b)⁽²⁾)` answered 0; left as typed, `integrate(x⁽ⁿ⁾, x)`
 *     answered `x⁽ⁿ⁾*x`. Unmapped, they end a run and reach Giac as glyphs,
 *     which answers each of those with an error or with the glyph showing
 *     (`[(y⁽^⁾)^4]`), never a clean-looking wrong result.
 *   - Modifier letters outside the block (`ˣ` U+02E3, `ᵃ` U+1D43 and the
 *     rest), an open-ended alphabet with no boundary to stop at — `eˣ` still
 *     reaches Giac as an identifier and still answers `eˣ`.
 *   - Subscripts, since `x₁` reads as a variable named `x₁`, which is a
 *     meaning rather than an accident.
 */
const SUPERSCRIPT: Readonly<Record<string, string>> = {
  '⁰': '0',
  '¹': '1',
  '²': '2',
  '³': '3',
  '⁴': '4',
  '⁵': '5',
  '⁶': '6',
  '⁷': '7',
  '⁸': '8',
  '⁹': '9',
  '⁺': '+',
  '⁻': '-',
  ⁱ: 'i',
  ⁿ: 'n',
};

/** A maximal run of superscripts, built from the table so the two cannot drift. */
const SUPERSCRIPT_RUN = new RegExp(`[${Object.keys(SUPERSCRIPT).join('')}]+`, 'gu');

/**
 * How many code units before a run are searched for the name it follows. A
 * bound only so the search is constant per run; a name whose trailing digits
 * alone are longer than this reads as a number instead.
 */
const NAME_WINDOW = 64;

/**
 * An exponent that needs no brackets after `^`: a signed integer or one letter.
 * Shared with the benchmark grader's `^{…}` rule, so a standalone `x⁻¹` and
 * `x^{-1}` reach one canonical form — each site adds its own policy around it,
 * this is only the part the two must agree on. They still differ when an
 * operand follows (`x⁻¹y` brackets its exponent, `x^{-1}y` does not); see
 * test/normalizer.test.ts.
 */
export function isAtomicExponent(token: string): boolean {
  return /^(-?\d+|[A-Za-z])$/.test(token);
}

/**
 * The reading for a run this cannot read with confidence: each digit glyph as
 * its own `^d`, every other glyph as typed — what every glyph got before runs
 * were read at all. Not the raw run, since Giac lexes a raw `¹` as `undef` and
 * drops the name it follows, and not a guess. After a caret the first `^` is
 * the caret's own: `x^¹⁺` as `x^^1⁺` is XOR.
 */
function perGlyphPowers(run: string, caret: string): string {
  const powers = Array.from(run, (glyph) =>
    /\d/.test(SUPERSCRIPT[glyph]) ? `^${SUPERSCRIPT[glyph]}` : glyph
  ).join('');
  return caret === '' ? powers.replace(/^\^/, '') : powers;
}

/**
 * The ASCII for one superscript run found at `at` in `text`: ONE exponent.
 * Replaced a glyph at a time, `10⁸⁰` was `10^8^0`, which Giac reads
 * right-associatively as 10^(8^0) — so `simplify(10⁸⁰)` answered 10, as a
 * success, and `2²³` answered 256.
 *
 * Decided in this order:
 *
 *   1. After `^` or `**` the run IS that caret's exponent and gets no caret of
 *      its own: `x^^2` is XOR, and `simplify(x^²)` answered `bitxor(x,2)`. The
 *      one change to one-digit output, deliberately.
 *   2. All digits: bare, whatever follows, so `x²` stays `x^2` byte for byte.
 *      That keeps a known hazard: `x²y` answers `(x^y)^2`.
 *   3. Not one term — a sign, then operands joined by single signs — or a
 *      letter then a digit: per glyph (perGlyphPowers). Any other join spells
 *      something else to Giac: ending in a sign, `^(+)` is `undef`, and
 *      `(f⁺)(x) = (f⁻)(x)` verified; doubled, `⁺⁺ⁿ` is the increment `++n`.
 *      And `ⁿ²` is n² as often as n·2, since superscripts cannot nest; the
 *      product verified `2ⁿ² = 4ⁿ`.
 *   4. Then by what follows, past any spaces, since a superscript's END is
 *      visible and `^`'s is not. Unwritten, each boundary read the operand
 *      into the exponent and answered as a success: bare `x^-1y` answered
 *      `1/x^y`; `x^(-1)(y+1)` answered `x^(-y-1)`, Giac applying the bracket
 *      to the exponent; `x^-1 y` answered `1/x^y`.
 *        - A bracket after a NAME, before the run or its spaces: per glyph.
 *          `x⁻¹(y+1)` and `f⁻¹(x)` are one shape, and the product answered
 *          `f⁻¹(x)` as `x/f`. A name ends in a letter and digits — `12a`
 *          included, which Giac reads as 12*a.
 *        - A NAME CALL: per glyph. Bracketed, `x^(-1) sin(x)` is `undef(x)`
 *          inside a claim, and `x⁻¹ sin(x) = x⁻¹ cos(x)` verified. A word
 *          operator before a bracket (`3⁻¹ mod (7)`) reads this way too.
 *        - A digit, a bracket, a decimal point or `√`: the product, since none
 *          can begin a word. `2^(-1)*(y+1)` answers `(y+1)/2`. `.` counts only
 *          before a digit: `..` is Giac's range, and a `*` before it made
 *          `10⁻³..1` answer `0 .. 1/1000`.
 *        - A letter: brackets and NO product, since a word may be a factor or
 *          a word operator, and a `*` before an operator answered as a success
 *          (`3⁻¹ mod 7` gave `undef % 7`). Giac then refuses the factor —
 *          `x^(-1)y`, `x^(-1) θ` — and reads `3^(-1) mod 7`, `2^(-1) in […]`
 *          and `x^(-1) union y` correctly. So `x⁻¹y` is an error, not `y/x`.
 *   5. Otherwise an atomic exponent (isAtomicExponent) is bare, the grader's
 *      own form, and anything else bracketed: `^` binds tighter than `+`.
 *
 * Inside a term, letters are multiplied explicitly — joined with nothing, `xⁿⁱ`
 * was the free symbol `x^ni`, answered as a success — as is a digit before a
 * letter (`x²ⁿ` is x^(2*n)).
 *
 * Not handled: a postfix `^` or `!` after the run binds into the exponent —
 * `x⁻¹^2` answers `1/x`, `x²^3` answers `x^8` — which no output of this
 * function alone can fix, since the power it should apply to begins at a base
 * it does not see. Nor function powers: `sin²(x)` answers a lambda, in every
 * spelling including ASCII. Nor one-sided limit notation: `0⁺` is read per
 * glyph, as `0*⁺`.
 */
function superscriptExponent(run: string, at: number, text: string): string {
  const glyphs = Array.from(run, (glyph) => SUPERSCRIPT[glyph]).join('');
  const caret = text[at - 1] === '^' || text.slice(at - 2, at) === '**' ? '' : '^';
  if (/^\d+$/.test(glyphs)) return caret + glyphs;
  if (!/^[-+]?[a-z\d]+(?:[-+][a-z\d]+)*$/.test(glyphs) || /[a-z]\d/.test(glyphs)) {
    return perGlyphPowers(run, caret);
  }
  const exponent = glyphs.replaceAll(/(?<=[a-z\d])(?=[a-z])/g, '*');
  const rest = text.slice(at + run.length);
  const before = text.slice(Math.max(0, at - NAME_WINDOW), at);
  // Any letter, not ASCII only: `θ` is an identifier to Giac, and so is `𝑦`,
  // which `u` reads as one character rather than two halves of a surrogate.
  const nameBefore = /[\p{L}_][\p{L}\p{N}_]*\s*$/u.test(before);
  if (nameBefore && /^\s*\(/u.test(rest)) return perGlyphPowers(run, caret);
  if (/^\s*[\p{L}_][\p{L}\p{N}_]*\s*\(/u.test(rest)) return perGlyphPowers(run, caret);
  if (/^\s*(?:[\p{N}(√]|\.\p{N})/u.test(rest)) return `${caret}(${exponent})*`;
  if (/^\s*[\p{L}_]/u.test(rest)) return `${caret}(${exponent})`;
  return caret + (isAtomicExponent(exponent) ? exponent : `(${exponent})`);
}

/**
 * Replace Unicode math characters with their ASCII / Giac-plain equivalents.
 * Pure function — used by both runtime tool output (compute hygiene) and the
 * benchmark grader normalizer, so both have a consistent canonical form.
 */
export function unicodeToAscii(s: string): string {
  return (
    s
      // Every other glyph FIRST, so `√`'s argument is already ASCII when the
      // rules below look at it. Ordered the other way, `√π` reached the bare-token
      // rule as a non-ASCII character, fell through to the plain replacement and
      // became the free symbol `sqrtpi` — so `simplify(√π*√π)` answered
      // `sqrtpi^2`, the same defect the `√` rules were written to fix, for the one
      // operand written as a glyph rather than as ASCII.
      .replaceAll('π', 'pi')
      .replaceAll('×', '*')
      .replaceAll('·', '*')
      .replaceAll('÷', '/')
      // A RUN of superscripts is one exponent — see superscriptExponent. After
      // `π`, so `x⁻¹π` sees the operand `pi` and brackets its exponent; before
      // `**`, so a run after `**` is still recognisable as that caret's.
      .replaceAll(SUPERSCRIPT_RUN, superscriptExponent)
      // `sqrt(X)`, not `sqrt`: a bare replacement turned `√2` into the free symbol
      // `sqrt2`, so `simplify(√2*√2)` answered `sqrt2^2` instead of 2 and
      // `integrate(√2*x, x)` answered `sqrt2*x^2/2`. Parenthesised argument first,
      // then a bare token; a `√` followed by neither is left as the word, which
      // Giac then reads as a free identifier rather than reporting — the reason
      // the two rules above it have to cover every argument that can occur.
      .replaceAll(/√\s*\(([^()]*)\)/g, 'sqrt($1)')
      .replaceAll(/√\s*([A-Za-z_]\w*|\d+(?:\.\d+)?)/g, 'sqrt($1)')
      .replaceAll('√', 'sqrt')
      // `**` is Giac's own spelling of `^` — measured, `10**20` answers
      // 100000000000000000000 — and every guard that scans for `^` was blind to
      // it. Last in the chain so the rules above keep their measured order (`×`
      // becomes `*` first, and `2×*2` normalises the same either way), and HERE
      // rather than in a caller so the one seam that canonicalises caller text
      // stays the one seam: the evaluation cache keys on this function's output,
      // and `y**2` and `y^2` were two keys for one expression.
      .replaceAll('**', '^')
  );
}
