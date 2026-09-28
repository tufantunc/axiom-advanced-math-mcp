/**
 * Every character of Unicode's Superscripts block (U+2070–U+207F), plus the three
 * Latin-1 digits `¹²³`, as the ASCII it stands for.
 *
 * The whole block, because the measured alternative was worse at every glyph
 * left out: an unmapped superscript reaches Giac as part of an identifier and
 * comes back as a confident answer — `simplify(x⁻¹)` answered the free symbol
 * `x⁻`, `simplify(xⁿ⁺¹)` answered `xⁿ⁺`, and `simplify(2ⁱ)` answered `2*i`. `⁼`
 * has no meaning in an exponent and is mapped anyway, so `x⁼` becomes `x^(=)`
 * and is REJECTED rather than read as the symbol `x⁼`.
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
      // A RUN of superscripts is one exponent. Replaced one glyph at a time, `10⁸⁰`
      // became `10^8^0`, which Giac reads right-associatively as 10^(8^0) — so
      // `simplify(10⁸⁰)` answered 10, as a success, and `2²³` answered 256. An
      // all-digit run needs no brackets and keeps `x²` as `x^2`; anything else is
      // bracketed, because `^` binds tighter than `+` and `xⁿ⁺¹` as `x^n+1` is a
      // different expression.
      .replaceAll(SUPERSCRIPT_RUN, (run) => {
        const exponent = Array.from(run, (glyph) => SUPERSCRIPT[glyph]).join('');
        return /^\d+$/.test(exponent) ? `^${exponent}` : `^(${exponent})`;
      })
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
