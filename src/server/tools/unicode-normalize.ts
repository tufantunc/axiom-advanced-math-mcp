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

/** The mapped glyphs, as one character class body, so no list can drift from the table. */
const SUPERSCRIPT_GLYPHS = Object.keys(SUPERSCRIPT).join('');

/** A maximal run of superscripts. */
const SUPERSCRIPT_RUN = new RegExp(`[${SUPERSCRIPT_GLYPHS}]+`, 'gu');

/**
 * One character of a name: a letter, a digit or `_`, but no superscript, though
 * `ⁿ ⁱ` are letters and `¹ ²` digits to Unicode — so a name ends at the next
 * run. Any letter, not ASCII only: `θ` is an identifier to Giac. Wrapped in
 * `(?:…)` so a quantifier repeats the exclusion with the class: unwrapped,
 * `NAME_CHAR*` excluded superscripts from the first character alone, `pi²(`
 * read as a name where the raw `π²(` did not, and the refusal and the
 * normaliser parted.
 */
const NAME_CHAR = String.raw`(?:(?![${SUPERSCRIPT_GLYPHS}])[\p{L}\p{N}_])`;
/**
 * What a name starts with, and needs somewhere: a letter or `_`. Digits alone
 * are a number. Wrapped as NAME_CHAR is.
 */
const NAME_START = String.raw`(?:(?![${SUPERSCRIPT_GLYPHS}])[\p{L}_])`;
const NAME_CHAR_ONE = new RegExp(`^${NAME_CHAR}$`, 'u');
const NAME_START_ONE = new RegExp(`^${NAME_START}$`, 'u');
const NAME_CALL_AFTER = new RegExp(`^\\s*${NAME_START}${NAME_CHAR}*\\s*\\(`, 'u');
const NAME_AFTER = new RegExp(`^\\s*${NAME_START}`, 'u');
/** Another run after nothing but spaces. */
const RUN_AFTER_SPACES = new RegExp(`^\\s+[${SUPERSCRIPT_GLYPHS}]`, 'u');

/** How far back from `at` the spaces before a run reach. */
function spacesBefore(at: number, text: string): number {
  let i = at;
  while (i > 0 && /\s/.test(text[i - 1])) i--;
  return i;
}

/**
 * Whether the text before `at` ends in a name, past any spaces: a run of name
 * characters with a letter or `_` among them — `12a` included, which Giac
 * reads as 12*a. Scanned backwards, since a `$`-anchored pattern would retry
 * from every earlier position; the scan stops at the previous run, which is
 * what keeps it linear. A letter outside the BMP is read whole by the
 * surrogate check, as one character.
 */
function endsInName(at: number, text: string): boolean {
  let i = spacesBefore(at, text);
  let letter = false;
  while (i > 0) {
    const low = text.charCodeAt(i - 1);
    const width = low >= 0xdc00 && low <= 0xdfff && i >= 2 ? 2 : 1;
    const glyph = text.slice(i - width, i);
    if (!NAME_CHAR_ONE.test(glyph)) break;
    letter ||= NAME_START_ONE.test(glyph);
    i -= width;
  }
  return letter;
}

/**
 * Whether the text before `at` is digits straight after another run, past any
 * spaces. They are no base of their own: after an all-digit run they print
 * into its exponent (`x²12` is `x^212`), and after any other run they are
 * counted the same way, conservatively, rather than tracking how that run
 * was read.
 */
function digitsAfterRun(at: number, text: string): boolean {
  const end = spacesBefore(at, text);
  let i = end;
  while (i > 0 && /\d/.test(text[i - 1])) i--;
  return i < end && i > 0 && text[i - 1] in SUPERSCRIPT;
}

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

/** Whether the run at `at` follows `^` or `**` and so is that caret's exponent. */
function followsCaret(at: number, text: string): boolean {
  return text[at - 1] === '^' || text.slice(at - 2, at) === '**';
}

/**
 * The reading unicodeToAscii falls back on where readRun has none: each digit
 * glyph as its own `^d`, every other glyph as typed. Not the raw run, since
 * Giac lexes a raw `¹` as `undef` and drops the name it follows. For output and
 * grader text only; see ambiguousSuperscript for why caller text is refused
 * instead. After a caret the first `^` is the caret's own: `x^^1⁺` is XOR.
 */
function perGlyphPowers(run: string, afterCaret: boolean): string {
  const powers = Array.from(run, (glyph) =>
    /\d/.test(SUPERSCRIPT[glyph]) ? `^${SUPERSCRIPT[glyph]}` : glyph
  ).join('');
  return afterCaret ? powers.replace(/^\^/, '') : powers;
}

/**
 * The ASCII for one superscript run found at `at` in `text` — ONE exponent —
 * or undefined where no reading can be stood behind. Replaced a glyph at a
 * time, `10⁸⁰` was `10^8^0`, which Giac reads right-associatively as
 * 10^(8^0) — so `simplify(10⁸⁰)` answered 10, as a success, and `2²³`
 * answered 256.
 *
 * Throughout, a run after `^` or `**` IS that caret's exponent and gets no
 * caret of its own: `x^^2` is XOR, and `simplify(x^²)` answered `bitxor(x,2)`.
 * The one change to one-digit output, deliberately. Then, in this order:
 *
 *   0. No reading when another run follows past nothing but spaces: the
 *      second prints into the first's exponent, so `x⁻¹ ⁿ` answered 1/x and
 *      `x² ⁻¹(z)` z·√x, and both verified. Per glyph, an all-digit pair
 *      still reads as it always did (`x² ³` is `x^2 ^3`); only the tools
 *      refuse it.
 *   1. All digits: bare, whatever operand follows, so `x²` stays `x^2` byte
 *      for byte.
 *      That keeps a known hazard: `x²y` answers `(x^y)^2`.
 *   2. No reading, when the run is not one term — a sign, then operands joined
 *      by single signs — or has a letter then a digit. Any other join spells
 *      something else to Giac: ending in a sign, `^(+)` is `undef`, and
 *      `(f⁺)(x) = (f⁻)(x)` verified; doubled, `⁺⁺ⁿ` is the increment `++n`.
 *      And `ⁿ²` is n² as often as n·2, since superscripts cannot nest; the
 *      product verified `2ⁿ² = 4ⁿ`.
 *   3. Then by what follows, past any spaces, since a superscript's END is
 *      visible and `^`'s is not. Unwritten, each boundary read the operand
 *      into the exponent and answered as a success: bare `x^-1y` answered
 *      `1/x^y`; `x^(-1)(y+1)` answered `x^(-y-1)`, Giac applying the bracket
 *      to the exponent; `x^-1 y` answered `1/x^y`.
 *        - A bracket that a NAME calls, the name before the run (`f⁻¹(x)`) or
 *          after it (`x⁻¹ sin(x)`): no reading. Every rendering was measured
 *          wrong somewhere — as a product `f⁻¹(x)` answered `x/f`; bracketed,
 *          `x^(-1) sin(x)` is `undef(x)` inside a claim, and
 *          `x⁻¹ sin(x) = x⁻¹ cos(x)` verified; glyph by glyph,
 *          `limit(x⁻¹ sin(2*x), x, 0)` answered 1. A word operator before a
 *          bracket (`3⁻¹ mod (7)`) counts as a name, and so do digits printed
 *          into an earlier run's exponent (`x²12 ⁻¹(z)`; see digitsAfterRun).
 *        - A digit, a bracket, a decimal point or `√`: the product, since none
 *          can begin a word. `2^(-1)*(y+1)` answers `(y+1)/2`. `.` counts only
 *          before a digit: `..` is Giac's range, and a `*` before it made
 *          `10⁻³..1` answer `0 .. 1/1000`.
 *        - A letter: brackets and NO product, since a word may be a factor or
 *          a word operator, and a `*` before an operator answered as a success
 *          (`3⁻¹ mod 7` gave `undef % 7`). Giac then refuses the factor —
 *          `x^(-1)y`, `x^(-1) θ` — and reads `3^(-1) mod 7`, `2^(-1) in […]`
 *          and `x^(-1) union y` correctly. So `x⁻¹y` is an error, not `y/x`.
 *   4. Otherwise an atomic exponent (isAtomicExponent) is bare, the grader's
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
 * spelling including ASCII.
 */
function readRun(run: string, at: number, text: string, afterCaret: boolean): string | undefined {
  const glyphs = Array.from(run, (glyph) => SUPERSCRIPT[glyph]).join('');
  const caret = afterCaret ? '' : '^';
  const rest = text.slice(at + run.length);
  if (RUN_AFTER_SPACES.test(rest)) return undefined;
  if (/^\d+$/.test(glyphs)) return caret + glyphs;
  if (!/^[-+]?[a-z\d]+(?:[-+][a-z\d]+)*$/.test(glyphs) || /[a-z]\d/.test(glyphs)) {
    return undefined;
  }
  const exponent = glyphs.replaceAll(/(?<=[a-z\d])(?=[a-z])/g, '*');
  const bracket = /^\s*\(/u.test(rest);
  if (bracket ? endsInName(at, text) || digitsAfterRun(at, text) : NAME_CALL_AFTER.test(rest)) {
    return undefined;
  }
  if (/^\s*(?:[\p{N}(√]|\.\p{N})/u.test(rest)) return `${caret}(${exponent})*`;
  if (NAME_AFTER.test(rest)) return `${caret}(${exponent})`;
  return caret + (isAtomicExponent(exponent) ? exponent : `(${exponent})`);
}

/** readRun, falling back on the per-glyph reading: unicodeToAscii is total. */
function superscriptExponent(run: string, at: number, text: string): string {
  const afterCaret = followsCaret(at, text);
  return readRun(run, at, text, afterCaret) ?? perGlyphPowers(run, afterCaret);
}

/**
 * The first superscript run in caller text that has no reading — readRun
 * returned undefined — or undefined when every run reads cleanly.
 *
 * For the tools to REFUSE, rather than evaluate: every rendering of such a run
 * was measured wrong somewhere, the per-glyph fallback included — `2ⁱ^2` is
 * 2·i² = -2, since Giac reads a raw `ⁱ` after a number as i, and
 * `limit(x⁻¹ sin(2*x), x, 0)` answered 1 with the call inside the exponent.
 * unicodeToAscii stays total, because tool output and benchmark answers are
 * text to canonicalise, not requests to refuse.
 *
 * Read on the raw text: the glyphs unicodeToAscii replaces first cannot move
 * a verdict, since `π` is a letter before and after and `× · ÷` are never
 * names.
 */
export function ambiguousSuperscript(text: string): string | undefined {
  for (const match of text.matchAll(SUPERSCRIPT_RUN)) {
    if (readRun(match[0], match.index, text, followsCaret(match.index, text)) === undefined) {
      return match[0];
    }
  }
  return undefined;
}

/**
 * What a tool says when it refuses caller text — undefined when there is
 * nothing to refuse. A lone sign is most often a one-sided limit point, `0⁺`,
 * which has a spelling of its own; the tool reads `limit(1/x, x, 0, +)` as
 * +infinity.
 */
export function superscriptRefusal(text: string): string | undefined {
  const run = ambiguousSuperscript(text);
  if (run === undefined) return undefined;
  const fix = /^[⁺⁻]$/u.test(run)
    ? 'for a one-sided limit give the direction as an argument, e.g. limit(f, x, a, +)'
    : 'write the exponent with ^ and brackets instead, e.g. x^(-1)*sin(x) or 2^(n^2)';
  return `the superscript \`${run}\` has more than one reading here — ${fix}`;
}

/** Characters that can only be operators: an exponent made of nothing else carries no operand. */
const CARET_SOUP = new Set('=+-*/^<>!,:;.&|~%');

/** Whitespace and the zero-width/format characters: invisible inside an exponent. */
function isInvisible(ch: string): boolean {
  return /\s/u.test(ch) || ch === '\u200b' || ch === '\u2060' || ch === '\ufeff';
}

/**
 * Length of the `/* … *​/` comment starting at `i`, or 0 when `i` is not
 * one. Giac discards comments wholesale, so their contents are invisible to
 * the mathematics — an operand character inside one is not real, and
 * `x^ /*c*​/ (==)` is the soup `x^(==)` underneath.
 */
function commentLength(text: string, i: number): number {
  if (text[i] !== '/' || text[i + 1] !== '*') return 0;
  const close = text.indexOf('*/', i + 2);
  return close === -1 ? 0 : close + 2 - i;
}

/** A character that can carry meaning inside an exponent (operand material). */
function isOperandChar(ch: string): boolean {
  return !CARET_SOUP.has(ch) && !'()[]{}'.includes(ch) && !isInvisible(ch);
}

/** How one caret's exponent read: the refused slice, or where to resume scanning. */
interface ExponentVerdict {
  /** The slice to refuse, or undefined when the exponent reads. */
  refusal?: string;
  /**
   * The index scanning resumes from. For a passing bare run this is the
   * char AFTER its last operand — every caret before that operand sees the
   * same operand, so none is re-scanned, while a soup tail after it
   * (`a^b^==`) still gets its own scan. This is what keeps the scan linear.
   */
  resumeAt: number;
}

/**
 * The first caret exponent in caller text that carries no operand — nothing
 * but operator characters — or undefined when every exponent reads.
 *
 * The ASCII sibling of the superscript refusal above. Giac does not error on
 * these exponents, it guesses, and every guess is wrong somewhere: `x^(==)`
 * reads as `x` (the exponent silently dropped), `x^(!=)` as `1`, `2^(==)+1`
 * as `3`, `x^(==)*y` as `x*y`, while `x^(+)`, `x^()`, `x^-` collapse toward
 * undef. No answer that comes back can be trusted, so the tools refuse
 * rather than evaluate. `**` is Giac's own spelling of `^` and is scanned
 * the same way. Operators AROUND an operand (`x^(-1)`, `x^- 1`, `x^(n+1)`,
 * `x^.5`) read fine and are not refused; whitespace before or inside the
 * exponent is transparent — Giac reads `x^ (==)` exactly like `x^(==)`
 * (measured), and `x^- 1` exactly like `x^-1`.
 */
export function caretExponentRefusal(text: string): string | undefined {
  let i = 0;
  while (i < text.length) {
    const doubleStar = text[i] === '*' && text[i + 1] === '*';
    if (text[i] !== '^' && !doubleStar) {
      i++;
      continue;
    }
    const start = i;
    const after = i + (doubleStar ? 2 : 1);
    let head = after;
    for (;;) {
      while (head < text.length && isInvisible(text[head])) head++;
      const comment = commentLength(text, head);
      if (comment === 0) break;
      head += comment;
    }
    const verdict = exponentVerdict(text, start, head);
    if (verdict.refusal !== undefined) {
      return (
        `the exponent \`${verdict.refusal}\` carries no operand — write it with ` +
        `something to raise, e.g. x^2 or x^(n+1)`
      );
    }
    i = Math.max(verdict.resumeAt, after);
  }
  return undefined;
}

/**
 * How the exponent at `head` (already past whitespace) read. A bracketed
 * exponent — `(`, `[`, `{` are all live group spellings to Giac (`x^[1,2]`
 * answers `[x,x^2]`) — needs its balanced close and an operand inside; the
 * walk bails past 128 nesting levels, deeper than any hand-written
 * exponent, so it cannot be walked quadratic. A bare exponent is the
 * whitespace-transparent token run after the caret and is refused only when
 * the run is non-empty and carries no operand — the run scans THROUGH
 * operators so `x^-1` and `x^.5` keep their digits, and the verdict is
 * settled at the first operand char.
 */
function exponentVerdict(text: string, start: number, head: number): ExponentVerdict {
  const opener = text[head];
  if (opener === '(' || opener === '[' || opener === '{') {
    const closer = opener === '(' ? ')' : opener === '[' ? ']' : '}';
    let depth = 0;
    for (let i = head; i < text.length; i++) {
      if (text[i] === opener) {
        depth++;
      } else if (text[i] === closer) {
        depth--;
        if (depth === 0) {
          for (let j = head + 1; j < i; j++) {
            const comment = commentLength(text, j);
            if (comment > 0) {
              j += comment - 1;
              continue;
            }
            if (isOperandChar(text[j])) return { resumeAt: i + 1 };
          }
          return { refusal: text.slice(start, i + 1), resumeAt: i + 1 };
        }
      }
      if (depth > 128) return { resumeAt: head + 1 };
    }
    return { resumeAt: head + 1 }; // unbalanced: the engine's own error answers
  }
  let end = head;
  let lastOperand = -1;
  while (end < text.length) {
    const comment = commentLength(text, end);
    if (comment > 0) {
      end += comment;
      continue;
    }
    const ch = text[end];
    if (/[A-Za-z0-9_]/.test(ch)) lastOperand = end;
    else if (!CARET_SOUP.has(ch) && !isInvisible(ch)) break;
    end++;
  }
  if (lastOperand !== -1) return { resumeAt: lastOperand + 1 };
  if (end === head) return { resumeAt: head + 1 }; // nothing follows: engine answers
  return { refusal: text.slice(start, end), resumeAt: end };
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
      // Comparison glyphs are Giac-live operators but invisible to every
      // guard that scans for ASCII '=' — unmapped, `2 ≥ x` evaluated WHOLE
      // inside a mangled side and inverted compound verdicts (measured:
      // `x^2-1=0, 2 ≥ x` refuted, `x^2-1=0, 0 ≥ x` certified). Mapped, they
      // route into the ASCII behavior the verify shape guards already rule
      // on; Giac answers `2>=1` exactly as it answers `2 ≥ 1`.
      .replaceAll('≥', '>=')
      .replaceAll('≤', '<=')
      .replaceAll('≠', '!=')
      // Fullwidth ＝ (CJK IMEs) is a different codepoint Giac reads as an
      // identifier — with no ASCII '=' anywhere, `x^2-4＝0` routed into the
      // expression=0 path and the TRUE claim was REFUTED (measured).
      // Canonicalised to the separator every shape guard scans for.
      .replaceAll('＝', '=')
      .replaceAll('﹦', '=')
      // A RUN of superscripts is one exponent — see readRun. Before `**` is
      // rewritten, so a run after `**` is still recognisable as that caret's.
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
