/**
 * Every character of Unicode's Superscripts block (U+2070–U+207F), plus the three
 * Latin-1 digits `¹²³`, as the ASCII it stands for.
 *
 * The whole block, because the measured alternative was worse at every glyph
 * left out: an unmapped superscript reaches Giac as part of an identifier and
 * comes back as a confident answer — `simplify(x⁻¹)` answered the free symbol
 * `x⁻`, `simplify(xⁿ⁺¹)` answered `xⁿ⁺`, and `simplify(2ⁱ)` answered `2*i`. `⁼`
 * has no meaning in an exponent and is mapped anyway, so `x⁼` becomes `x^(=)`,
 * which compute REJECTS rather than reading it as the symbol `x⁼`. Verify does
 * not: it gives `x^(=) = 1` a verdict, exactly as it does the same claim typed
 * in ASCII — a defect of verify's identity path that this spelling reaches but
 * did not create.
 *
 * Out of scope, deliberately: modifier letters outside this block (`ˣ` U+02E3,
 * `ᵃ` U+1D43 and the rest), an open-ended alphabet with no block boundary to
 * stop at — `eˣ` still reaches Giac as an identifier and still answers `eˣ`; and
 * subscripts, since `x₁` reads as a variable named `x₁`, which is a meaning
 * rather than an accident.
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
  '⁼': '=',
  '⁽': '(',
  '⁾': ')',
  ⁱ: 'i',
  ⁿ: 'n',
};

/** A maximal run of superscripts, built from the table so the two cannot drift. */
const SUPERSCRIPT_RUN = new RegExp(`[${Object.keys(SUPERSCRIPT).join('')}]+`, 'gu');

/**
 * An exponent that needs no brackets after `^`: a signed integer or one letter.
 * Shared with the benchmark grader's `^{…}` rule, so a standalone `x⁻¹` and
 * `x^{-1}` reach one canonical form — each site adds its own policy around it,
 * this is only the part the two must agree on. They still differ when an
 * operand follows (`x⁻¹y` writes the product, `x^{-1}y` does not); see
 * test/normalizer.test.ts.
 */
export function isAtomicExponent(token: string): boolean {
  return /^(-?\d+|[A-Za-z])$/.test(token);
}

/**
 * The ASCII for one superscript run found at `at` in `text`: ONE exponent, since
 * replaced a glyph at a time `10⁸⁰` became `10^8^0`, which Giac reads
 * right-associatively as 10^(8^0) — so `simplify(10⁸⁰)` answered 10, as a
 * success, and `2²³` answered 256.
 *
 * A superscript's END is visible, and `^`'s is not, so anything that is not all
 * digits and has an operand after it — past any spaces — gets the product
 * written out. Measured, each alternative read the operand into the exponent
 * and answered as a success: bare `x^-1y` answered `1/x^y`; bracketed
 * `x^(-1)(y+1)` answered `x^(-y-1)`, because Giac applies a bracket group to
 * the exponent before it; and `x^-1 y` answered `1/x^y`, a space being
 * juxtaposition. `x^(-1)*(y+1)` answers `(y+1)/x`.
 *
 * Otherwise:
 *   - All digits: bare, always, so `x²` stays `x^2` byte for byte — including
 *     before an operand, where it has the hazard above (`x²y` answers
 *     `(x^y)^2`). Left so deliberately: it predates this function, and the fix
 *     changes one-digit output.
 *   - Atomic (isAtomicExponent): bare, the grader's own form.
 *   - Anything else: bracketed, because `^` binds tighter than `+` and `xⁿ⁺¹`
 *     as `x^n+1` is a different expression.
 *
 * Letters are multiplied explicitly — joined with nothing, `xⁿⁱ` became the free
 * symbol `x^ni` and was answered as a success, a digit beside a letter makes a
 * name just as well (`n2`), and a letter before a bracket makes a call (`n(i+1)`
 * answered `x^(n(1+i))`). And a run straight after `^` or `**` IS that
 * caret's exponent: adding another made `x^^2`, which Giac reads as XOR, so
 * `simplify(x^²)` answered `bitxor(x,2)`.
 *
 * Not handled: a postfix `^` or `!` after the run binds into the exponent —
 * `x⁻¹^2` answers `1/x`, `x²^3` answers `x^8` — and no output of this function
 * alone can fix that, since the power it should apply to begins at a base this
 * function does not see. Nor function powers: `sin²(x)` and `sin⁻¹(x)` answer
 * a lambda, in every spelling including ASCII.
 */
function superscriptExponent(run: string, at: number, text: string): string {
  const exponent = Array.from(run, (glyph) => SUPERSCRIPT[glyph])
    .join('')
    .replaceAll(/(?<=[a-z)])(?=[a-z\d(])|(?<=\d)(?=[a-z(])/g, '*');
  const caret = text[at - 1] === '^' || text.slice(at - 2, at) === '**' ? '' : '^';
  if (/^\d+$/.test(exponent)) return caret + exponent;
  // Any letter, not ASCII only — `θ` is an identifier to Giac — and `√`, since
  // this runs before the rules that turn it into `sqrt(`. But not Giac's word
  // operators, which are letters and not operands: a `*` before `mod` made
  // `simplify(3⁻¹ mod 7)` answer `undef % 7`.
  if (/^\s*(?!(?:mod|and|or|xor)\b)[\p{L}\p{N}_.(√]/u.test(text.slice(at + run.length))) {
    return `${caret}(${exponent})*`;
  }
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
