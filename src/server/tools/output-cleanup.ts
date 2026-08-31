/**
 * Pure string helpers for Giac-shaped text — CAS output on its way to the model
 * or the structured envelope, and (for the depth-aware splitter) problem text on
 * its way in. No I/O, no Giac calls — easy to unit-test.
 */

/**
 * Split `s` at top-level (depth-0) occurrences of `sep`, respecting (), [], {}.
 * @param sep a single-character separator.
 */
/**
 * Whether a Giac-printed scalar is zero, however the engine spelt it.
 *
 * Three spellings, all of which have shipped a defect here. `0` is the exact
 * form. `0.0` and `-0.0` are the float forms, and comparing to the string '0'
 * refused every system with a decimal coefficient as "not linear". At 15 or more
 * significant digits Giac prints a negative float zero as the malformed token
 * `0.-0000000000000000`, which `Number` reads as NaN — that one refused pi, e and
 * sqrt(2) at double precision, and later cost `y(0)=0.3333333333333333` its
 * verification mark, because the predicate had been written out a second time
 * instead of shared.
 */
export function isPrintedZero(entry: string): boolean {
  const t = entry.trim();
  if (t.length === 0) return false;
  return Number(t) === 0 || (/^[+-]?[0.+-]*$/.test(t) && /0/.test(t));
}

export function splitTopLevel(s: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (depth === 0 && ch === sep) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  return parts;
}

/** Strip a single matched pair of surrounding double-quotes (Giac latex() artifact). */
export function stripQuotes(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * Drop LaTeX display-mode wrappers so the emitted LaTeX renders the same
 * inline as it does in a block: `\dfrac` -> `\frac`, and `\displaystyle` /
 * `\textstyle` removed.
 *
 * Whether Giac emits these depends on its build and settings — the bundled one
 * returns `\frac` for simple fractions — so this is a normalizer that may be a
 * no-op on any given result. It is unit-tested on literals rather than through
 * a CAS call for exactly that reason.
 */
export function stripDisplayMode(latex: string): string {
  return latex
    .replaceAll(/\\dfrac\b/g, String.raw`\frac`)
    .replaceAll(/\\displaystyle\s*/g, '')
    .replaceAll(/\\textstyle\s*/g, '');
}

/**
 * Remove the trailing big-O remainder term (e.g. `+x^5*order_size(x)`) that
 * Giac appends to series/taylor results. The remainder is always the last
 * additive term, so we cut from the last depth-0 +/- operator before the
 * `order_size` token to the end of the string.
 */
export function stripOrderTerm(expr: string): string {
  const idx = expr.indexOf('order_size');
  if (idx === -1) return expr;
  let depth = 0;
  let cut = -1;
  for (let i = 0; i < idx; i++) {
    const ch = expr[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    // Assumes exact (fraction) terms — Giac series output is exact, never floating/scientific notation. A '-' in a hypothetical '1e-5' literal is therefore out of scope.
    else if (depth === 0 && (ch === '+' || ch === '-') && i > 0) cut = i;
  }
  if (cut === -1) return expr;
  const stripped = expr.slice(0, cut).trim();
  return stripped || expr;
}

/**
 * Normalize Giac's `solve` list output into clean set/tuple notation.
 *   list[-2,2]    -> {-2, 2}
 *   list[3]       -> 3
 *   list[[2,1]]   -> (2, 1)
 *   list[i,-i]    -> {i, -i}
 *   []            -> {}
 * Any unparseable input is returned unchanged (never throws).
 */
export function listToSet(raw: string): string {
  const trimmed = raw.trim();
  let inner = trimmed.startsWith('list') ? trimmed.slice(4).trim() : trimmed;
  if (!inner.startsWith('[') || !inner.endsWith(']')) return raw;
  inner = inner.slice(1, -1).trim();
  if (inner === '') return '{}';

  const members = splitTopLevel(inner, ',')
    .map((m) => m.trim())
    .filter((m) => m.length > 0);
  if (members.length === 0) return '{}';

  // System solutions: each member is itself a [a,b,...] tuple.
  const tuples = members.map((m) => {
    if (m.startsWith('[') && m.endsWith(']')) {
      const elems = splitTopLevel(m.slice(1, -1), ',').map((e) => e.trim());
      return `(${elems.join(', ')})`;
    }
    return null;
  });
  if (tuples.every((t) => t !== null)) {
    return tuples.length === 1 ? (tuples[0] as string) : `{${tuples.join(', ')}}`;
  }

  // Mixed tuple/scalar lists (non-existent in real solve output) are joined as
  // a set without unwrapping the tuple member — best-effort only.
  // Scalars.
  if (members.length === 1) return members[0];
  return `{${members.join(', ')}}`;
}

/** A Giac numeric literal, with optional decimal point and exponent. */
export const GIAC_NUMBER = String.raw`(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?`;

/** The whole reply must be one numeric literal — nothing before or after it. */
const GIAC_NUMBER_ONLY = new RegExp(`^[+-]?${GIAC_NUMBER}$`);

/**
 * Reads a Giac reply as a number, or null when the reply is not a numeric
 * literal at all. A literal beyond double range parses to ±Infinity.
 *
 * This is the boundary invariant, not a detail of any one caller: when Giac
 * declines to evaluate something it returns a SYMBOLIC form, and `parseFloat`
 * reads that form's leading term as if it were the answer.
 *
 *   chisquare_cdf(1, NaN)          -> "1-UTPC(1,NaN)"   parseFloat -> 1
 *   student_cdf(2, NaN)            -> "1-UTPT(2,NaN)"   parseFloat -> 1
 *   evalf(subst(1-cos(y),x=2))     -> "1.0-cos(y)"      parseFloat -> 1
 *
 * Every one of those is a confident wrong answer: a p-value of 0, or f(2) = 1
 * for an expression that does not depend on x. Requiring the WHOLE reply to be
 * a numeric literal is what separates "0.393153" from "1-UTPC(1,NaN)".
 */
export function giacNumber(raw: string): number | null {
  const text = raw.trim();
  if (!GIAC_NUMBER_ONLY.test(text)) return null;
  const value = Number(text);
  // ±Infinity is a VALUE, not a failure to parse. Giac's float range is wider
  // than a double's and it renders those as ordinary literals — `exp(800)` comes
  // back as "0.272637457211e348". Rejecting them told the caller "Cannot
  // evaluate exp(x) at x=800" while quoting the value the CAS had just returned.
  // A caller that needs a finite number checks Number.isFinite itself; this
  // function answers only "is the reply a number".
  return Number.isNaN(value) ? null : value;
}
const COMPLEX_TERM = new RegExp(`^(.*?)([+-]?(?:${GIAC_NUMBER}\\*?)?)i$`);

/**
 * Parses one Giac complex literal into its real and imaginary parts.
 *
 * Handles `10.0`, `-2.0+2.0*i`, `2.0*i`, `2.0-i`, `-i` and exponent forms like
 * `6.12323399574e-17-i`. Giac writes a unit coefficient as a bare `i`, so the
 * sign has to be captured separately from the digits — a pattern that requires
 * a digit can never see the `-` in `2.0-i`, and reconstructing the real part
 * from what is left over then loses both halves.
 *
 * Throws on anything it does not recognise. That matters more than it looks:
 * `giacEngine.evaluate` RESOLVES with `GIAC_ERROR: ...` rather than rejecting,
 * and that string contains an `i` (in "Invalid"). Defaulting an unparseable
 * term to zero turns a CAS error into a confident fabricated number.
 */
export function parseComplexTerm(term: string): { re: number; im: number } {
  const t = term.replaceAll(/\s+/g, '');
  if (t === '') throw new Error('empty complex term');

  if (!t.includes('i')) {
    const re = Number(t);
    if (!Number.isFinite(re)) throw new Error(`unparseable term: ${term}`);
    return { re, im: 0 };
  }

  const match = COMPLEX_TERM.exec(t);
  if (!match) throw new Error(`unparseable complex term: ${term}`);

  const [, realPart, imaginaryPart] = match;
  const coefficient = imaginaryPart.replace(/\*$/, '');
  const im =
    coefficient === '' || coefficient === '+' ? 1 : coefficient === '-' ? -1 : Number(coefficient);
  const re = realPart === '' ? 0 : Number(realPart);
  if (!Number.isFinite(re) || !Number.isFinite(im)) {
    throw new Error(`unparseable complex term: ${term}`);
  }
  return { re, im };
}

/**
 * Parses a Giac list of complex numbers, one entry per element.
 *
 * Each element is a complex literal, not a bare number. Reading the list with
 * `parseFloat` per comma-separated part and pairing the results as (re, im)
 * truncated every `a+b*i` at the `+` and halved the bin count.
 */
export function parseComplexList(raw: string): { re: number; im: number }[] {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
    throw new Error(`expected a Giac list, got: ${trimmed.slice(0, 60)}`);
  }
  const inner = trimmed.slice(1, -1).trim();
  if (inner === '') return [];
  return splitTopLevel(inner, ',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map(parseComplexTerm);
}
