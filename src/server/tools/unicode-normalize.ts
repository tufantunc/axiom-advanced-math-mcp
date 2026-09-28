/**
 * Unicode's Superscripts block (U+2070–U+207F) less its brackets, plus the three
 * Latin-1 digits `¹²³`, as the ASCII each stands for.
 *
 * Nearly the whole block, because the measured alternative was worse at each
 * glyph left out: an unmapped superscript reaches Giac as part of an identifier and
 * comes back as a confident answer — `simplify(x⁻¹)` answered the free symbol
 * `x⁻`, `simplify(xⁿ⁺¹)` answered `xⁿ⁺`, and `simplify(2ⁱ)` answered `2*i`. `⁼`
 * has no meaning in an exponent and is mapped anyway, so `x⁼` becomes `x^(=)`,
 * which compute REJECTS rather than reading it as the symbol `x⁼`. Verify does
 * not: it gives `x^(=) = 1` a verdict, exactly as it does the same claim typed
 * in ASCII — a defect of verify's identity path that this spelling reaches but
 * did not create.
 *
 * Out of scope, deliberately: `⁽ ⁾`, which are three notations rather than one
 * — grouping (`2⁽³⁾`), derivative order (`y⁽³⁾` is y'''), iterate (`f⁽²⁾`) —
 * and every reading measured here answered some input wrongly as a verified
 * success: as grouping, `desolve(y⁽³⁾=0, y)` answered `[0]`; as a derivative,
 * `simplify((a+b)⁽²⁾)` answered 0 and `desolve(y⁽¹⁾³=x, y)` `[x^(1/3)]`; left
 * as typed, `integrate(x⁽ⁿ⁾, x)` answered `x⁽ⁿ⁾*x`. Unmapped, they end a run
 * and reach Giac as they did on main, and measured, each of those inputs then
 * answers as main does: an error, or an answer that shows the glyph
 * (`[(y⁽^⁾)^4]`) rather than a clean-looking wrong one. Also modifier letters
 * outside this block (`ˣ` U+02E3, `ᵃ` U+1D43 and the rest), an open-ended
 * alphabet with no block boundary to stop at — `eˣ` still reaches Giac as an identifier and still answers `eˣ`; and
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
 * Main's reading of a run, for the shapes where no reading of this function's
 * can be stood behind: each digit glyph as its own `^d`, every other glyph as
 * typed. Not the raw run — Giac lexes a raw `¹` as `undef`, which drops the
 * name it follows — and not a guess.
 */
function asOnMain(run: string): string {
  return Array.from(run, (glyph) =>
    /\d/.test(SUPERSCRIPT[glyph]) ? `^${SUPERSCRIPT[glyph]}` : glyph
  ).join('');
}

/**
 * The ASCII for one superscript run found at `at` in `text`: ONE exponent, since
 * replaced a glyph at a time `10⁸⁰` became `10^8^0`, which Giac reads
 * right-associatively as 10^(8^0) — so `simplify(10⁸⁰)` answered 10, as a
 * success, and `2²³` answered 256.
 *
 * A superscript's END is visible, and `^`'s is not, so when anything that is
 * not all digits has an operand after it — past any spaces — the boundary has
 * to be written down. Measured, each unwritten form read the operand into the
 * exponent and answered as a success: bare `x^-1y` answered `1/x^y`; bracketed
 * `x^(-1)(y+1)` answered `x^(-y-1)`, because Giac applies a bracket group to
 * the exponent before it; and `x^-1 y` answered `1/x^y`, a space being
 * juxtaposition. How it is written depends on what follows:
 *   - A digit, a bracket, a decimal point or `√` gets the product:
 *     `2^(-1)*(y+1)` answers `(y+1)/2`. None of them can begin a word. The
 *     exception is a bracket after a NAME, where the run gets main's
 *     reading (asOnMain).
 *   - An exponent ending in a sign gets main's reading too — which leaves
 *     one-sided limit notation (`0⁺`) as main read it, `0*⁺`.
 *   - A letter gets brackets and NO product, since a word may be an operand or
 *     one of Giac's word operators, and a `*` before an operator answered as a
 *     success — `3⁻¹ mod 7` gave `undef % 7`, `2⁻¹ in [1/2,1]` gave 0, and a
 *     list of operators to skip was incomplete twice. Left bracketed, Giac
 *     decides: measured, it refuses `x^(-1)y`, `x^(-1) y`, `x^(-1)θ` and
 *     `x^(-1)sin(x)`, and reads `3^(-1) mod 7`, `3^(-1)mod 7`, `2^(-1) in […]`
 *     and `x^(-1) union y` correctly. So `x⁻¹y` is an error, not `y/x`: the
 *     price of never writing a `*` before a word.
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
 * name just as well (`n2`). And a run straight after `^` or `**` IS that
 * caret's exponent: adding another made `x^^2`, which Giac reads as XOR, so
 * `simplify(x^²)` answered `bitxor(x,2)`. This is the ONE change
 * to one-digit output, made deliberately and against the rule above: `x^²`
 * and `x**²` were `x^^2` on main.
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
    .replaceAll(/(?<=[a-z])(?=[a-z\d])|(?<=\d)(?=[a-z])/g, '*');
  const caret = text[at - 1] === '^' || text.slice(at - 2, at) === '**' ? '' : '^';
  if (/^\d+$/.test(exponent)) return caret + exponent;
  // Ending in a sign, it has no operand to end on. Mapped, `^(+)` is `undef`
  // to Giac and `(f^(+))(x)` is `undef(x)`, so `(f⁺)(x) = (f⁻)(x)` verified.
  if (/[-+]$/.test(exponent)) return asOnMain(run);
  const rest = text.slice(at + run.length);
  // `.` only as a decimal point: before another `.` it is Giac's range
  // operator, and a `*` there made `10⁻³..1` answer `0 .. 1/1000`. `√` too,
  // since this runs before the rules that turn it into `sqrt(`.
  if (/^\s*(?:[\p{N}(√]|\.\p{N})/u.test(rest)) {
    // Between a NAME and a bracket, a power times a factor and an inverse
    // function are one shape — `x⁻¹(y+1)`, `f⁻¹(x)` — and the product answered
    // `f⁻¹(x)` as `x/f`, clean-looking where main showed the glyph. So the run
    // gets main's reading there, one digit glyph at a time and the rest as
    // typed — not the raw run, whose `¹` Giac lexes as `undef`, dropping the
    // name: `x⁻¹(y) = z⁻¹(y)` became `undef(y) = undef(y)` and verified. A name is whatever ends in a letter and digits —
    // `12a` included, which Giac reads as 12*a, a power of the name `a`. 64
    // code units back is further than any name.
    const before = text.slice(Math.max(0, at - 64), at);
    if (/^\s*\(/u.test(rest) && /[\p{L}_][\p{L}\p{N}_]*$/u.test(before)) {
      return asOnMain(run);
    }
    return `${caret}(${exponent})*`;
  }
  // Any letter, not ASCII only — `θ` is an identifier to Giac, and so is `𝑦`,
  // which `u` reads as one character rather than two halves of a surrogate.
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
