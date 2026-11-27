/**
 * Pure string helpers for Giac-shaped text — CAS output on its way to the model
 * or the structured envelope, and (for the depth-aware splitter) problem text on
 * its way in — plus the excerpt a refusal quotes caller text through and the
 * escape for names built into a pattern. No I/O, no Giac calls — easy to
 * unit-test.
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

/** `s` without one pair of parentheses that encloses all of it, and without spaces. */
function unwrapParens(s: string): string {
  const t = s.replaceAll(/\s+/g, '');
  if (!t.startsWith('(') || !t.endsWith(')')) return t;
  let depth = 0;
  for (let i = 0; i < t.length - 1; i++) {
    if (t[i] === '(') depth++;
    else if (t[i] === ')') depth--;
    if (depth === 0) return t; // the first `(` closes before the end: `(a)*(b)`
  }
  return t.slice(1, -1);
}

/** A name character, as unicode-normalize reads one: a letter, a digit or `_`. */
function isNameChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}_]/u.test(ch);
}

/**
 * The longest base or argument a series remainder is read with. A remainder's
 * base is `x`, `x-1`, `1/x`, `x-pi/2`; anything longer is not one, and the
 * bound is what keeps every scan below proportional to the output's length.
 */
const MAX_REMAINDER_BASE = 256;

/** Index of the `)` closing the `(` at `open`, within MAX_REMAINDER_BASE, or -1. */
function closingParen(s: string, open: number): number {
  let depth = 0;
  const end = Math.min(s.length, open + MAX_REMAINDER_BASE + 2);
  for (let i = open; i < end; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')' && --depth === 0) return i;
  }
  return -1;
}

/**
 * The operand that ends at `end` (inclusive), read backwards within
 * MAX_REMAINDER_BASE: a parenthesised group, or a run of name characters.
 * undefined for anything else, and for a function's argument list (`cos(x)`),
 * which is not an operand on its own.
 */
function operandEndingAt(s: string, end: number): string | undefined {
  const floor = Math.max(0, end - MAX_REMAINDER_BASE - 1);
  if (s[end] === ')') {
    let depth = 0;
    for (let i = end; i >= floor; i--) {
      if (s[i] === ')') depth++;
      else if (s[i] === '(' && --depth === 0) {
        return isNameChar(s[i - 1]) ? undefined : s.slice(i, end + 1);
      }
    }
    return undefined;
  }
  let i = end;
  while (i >= floor && isNameChar(s[i])) i--;
  return i === end ? undefined : s.slice(i + 1, end + 1);
}

/** Index of the last non-space character at or before `i`. */
function skipSpacesBack(s: string, i: number): number {
  let j = i;
  while (j >= 0 && /\s/.test(s[j])) j--;
  return j;
}

/**
 * The order of each series remainder in a Giac answer: for every
 * `order_size(B)` it prints, the k of the `B^k*` in front of it — the
 * remainder is O(B^k). 0 when nothing in front of it is a power of B.
 *
 * Giac marks the place a series expansion broke down with the same token it
 * uses for an ordinary remainder, so the token alone proves nothing: a
 * successful expansion to order n ends `+x^(n+1)*order_size(x)`, and one that
 * met an essential singularity is `order_size(x)` — O(1), no information at
 * all — or stops early, `1+x*order_size(x)` for `1+x*exp(1/x)` to order 3.
 * The exponent is what tells them apart, and stripOrderTerm, which cuts the
 * remainder off, threw it away: `taylor(exp(1/x), x, 0, 3)` answered
 * `order_size(x)` and `taylor(1+x*exp(1/x), x, 0, 3)` answered `1`.
 *
 * Linear in the output's length, because it runs on every engine answer on
 * the main thread, outside the worker's timeout: each occurrence is read from
 * the few characters around it, never by rescanning what precedes it. A first
 * version matched `[\p{L}\p{N}_]+$` against the whole prefix once per
 * occurrence, and `simplify(seq(x^4*order_size(x),k,1,10000))` — 42
 * characters of input — held the event loop for 6.5 seconds.
 */
export function seriesRemainderOrders(expr: string): number[] {
  const orders: number[] = [];
  const marker = 'order_size(';
  for (let at = expr.indexOf(marker); at !== -1; at = expr.indexOf(marker, at + 1)) {
    if (isNameChar(expr[at - 1])) continue; // `my_order_size(`
    const open = at + marker.length - 1;
    const close = closingParen(expr, open);
    const base = close === -1 ? undefined : unwrapParens(expr.slice(open + 1, close));
    let order = 0;
    let j = skipSpacesBack(expr, at - 1);
    if (base !== undefined && expr[j] === '*') {
      j = skipSpacesBack(expr, j - 1);
      let digitsStart = j;
      while (digitsStart >= 0 && j - digitsStart < 12 && /\d/.test(expr[digitsStart])) {
        digitsStart--;
      }
      const caret = skipSpacesBack(expr, digitsStart);
      const powered = digitsStart < j && expr[caret] === '^';
      const operandEnd = powered ? skipSpacesBack(expr, caret - 1) : j;
      const operand = operandEndingAt(expr, operandEnd);
      if (operand !== undefined && unwrapParens(operand) === base) {
        order = powered ? Number(expr.slice(digitsStart + 1, j + 1)) : 1;
      }
    }
    orders.push(order);
  }
  return orders;
}

/** The longest exponent read as an integer: `^-12`, `^(3)`. */
const MAX_INTEGER_EXPONENT = 24;

/**
 * The first piece of a printed series that is not a power of `variable` with
 * coefficients free of it, or undefined when there is none: an application
 * whose argument names the variable (`sin(1/x)`, `ln(x)`, `exp(n*ln(x))`), a
 * square root of it (`√x`), or a power of it that is not an integer
 * (`x^(1/3)`, `x^n`, `x^x`). The remainder, `order_size(...)`, is skipped.
 * A parenthesis left unclosed answers the rest of the text, so what cannot
 * be read is never taken for a series.
 *
 * Read from the printed text rather than handed back to the engine: a series
 * answer runs to half a million characters (`taylor(exp(x*y)*sin(x+y), x, 0,
 * 100)`), and Giac's parser traps on far less. Linear in the text's length,
 * because it runs on the main thread outside the worker's timeout: one pass
 * pairs the parentheses, one counts where the variable occurs, and each name
 * and exponent is read once.
 */
export function nonSeriesTerm(printed: string, variable: string): string | undefined {
  const s = printed;
  const match = new Int32Array(s.length).fill(-1);
  const open: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') open.push(i);
    else if (s[i] === ')') {
      const o = open.pop();
      if (o === undefined) return s;
      match[o] = i;
      match[i] = o;
    }
  }
  if (open.length > 0) return s.slice(open[0]);
  // occurrences[i]: how many times the variable is named in s[0, i).
  const occurrences = new Int32Array(s.length + 1);
  for (let i = 0; i < s.length;) {
    let j = i;
    while (j < s.length && isNameChar(s[j])) j++;
    if (j === i) {
      occurrences[i + 1] = occurrences[i];
      i++;
      continue;
    }
    const named = s.slice(i, j) === variable ? 1 : 0;
    for (let k = i; k < j; k++) occurrences[k + 1] = occurrences[i] + (k === j - 1 ? named : 0);
    i = j;
  }
  const names = (from: number, to: number) => occurrences[to] - occurrences[from] > 0;
  /** The end (exclusive) of the operand starting at `at`: a group or a run of name characters. */
  const operandEnd = (at: number): number => {
    if (s[at] === '(') return match[at] + 1;
    let j = at;
    while (j < s.length && (isNameChar(s[j]) || s[j] === '.')) j++;
    return j;
  };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(' && isNameChar(s[i - 1])) {
      let start = i - 1;
      while (start > 0 && isNameChar(s[start - 1])) start--;
      const close = match[i];
      if (s.slice(start, i) === 'order_size') {
        i = close;
      } else if (names(i, close)) {
        return s.slice(start, close + 1);
      }
    } else if (ch === '√') {
      const end = operandEnd(i + 1);
      if (names(i + 1, end)) return s.slice(i, end);
    } else if (ch === '^') {
      const from = i + 1;
      const end = operandEnd(s[from] === '-' ? from + 1 : from);
      const exponent = s.slice(from, Math.min(end, from + MAX_INTEGER_EXPONENT + 1));
      if (end - from <= MAX_INTEGER_EXPONENT && /^(?:-?\d+|\(-?\d+\))$/.test(exponent)) continue;
      let start = i - 1;
      if (s[start] === ')') {
        start = match[start];
        while (start > 0 && isNameChar(s[start - 1])) start--;
      } else {
        while (start > 0 && isNameChar(s[start - 1])) start--;
      }
      if (names(start, end)) return s.slice(start, end);
    }
  }
  return undefined;
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
/**
 * A Giac real as printed: a numeric literal, or `+infinity`/`-infinity` (and
 * unsigned `infinity`, read as +Infinity); NaN for anything else. giacNumber
 * with the infinities Giac prints for a bound or a limit.
 */
export function printedReal(printed: string): number {
  const t = printed.trim();
  if (t === '+infinity' || t === 'infinity') return Infinity;
  if (t === '-infinity') return -Infinity;
  return giacNumber(t) ?? Number.NaN;
}

/**
 * The members of a list as Giac prints one, `[a,b]` or `list[a,b]`, or
 * undefined when `printed` is not a list (or is missing).
 */
export function printedList(printed: string | undefined): string[] | undefined {
  let t = printed?.trim();
  if (t?.startsWith('list[')) t = t.slice(4);
  if (!t?.startsWith('[') || !t.endsWith(']')) return undefined;
  const inner = t.slice(1, -1).trim();
  return inner === '' ? [] : splitTopLevel(inner, ',').map((m) => m.trim());
}

const COMPLEX_TERM = new RegExp(String.raw`^(.*?)([+-]?(?:${GIAC_NUMBER}\*?)?)i$`);

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
  let im: number;
  if (coefficient === '' || coefficient === '+') im = 1;
  else if (coefficient === '-') im = -1;
  else im = Number(coefficient);
  const re = realPart === '' ? 0 : Number(realPart);
  if (!Number.isFinite(re) || !Number.isFinite(im)) {
    throw new TypeError(`unparseable complex term: ${term}`);
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
    throw new Error(`expected a Giac list, got: ${excerpt(trimmed, 60)}`);
  }
  const inner = trimmed.slice(1, -1).trim();
  if (inner === '') return [];
  return splitTopLevel(inner, ',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map(parseComplexTerm);
}

/**
 * Deepest parenthesis nesting in a printed result, call or grouping alike.
 *
 * Lives here rather than beside MAX_ENGINE_DEPTH, the bound it is usually
 * compared against: the bound is an engine measurement, this is pure text. Being
 * here is what lets ode-system-shape.ts state its no-engine invariant as a fact
 * about the module graph instead of an exception in a comment.
 *
 * Parentheses only. Counting `[` and `{` as well seemed the cautious reading —
 * how deep the tree goes, whichever delimiter spelt it — but it refuses LaTeX
 * that renders perfectly well: a list nested 200 deep is 401 characters and
 * `latex()` answers it with the worker untouched, where a 140-deep run of
 * `sqrt(1+...)` kills it. The hazard is nested function application; grouping
 * parentheses are counted too, which only makes this more conservative.
 */
export function nestingDepth(text: string): number {
  let depth = 0;
  let deepest = 0;
  for (const ch of text) {
    if (ch === '(') deepest = Math.max(deepest, ++depth);
    else if (ch === ')') depth -= 1;
  }
  return deepest;
}

/**
 * Caller text quoted back in a refusal, cut to a readable length.
 *
 * Marked, because an unmarked cut names a DIFFERENT input from the one refused:
 * `10^1000*10^1000*10^1000*10^1000` came back as `(10^1000*10^1000*10^1)`, which
 * denotes 2,002 digits and passes the bound, so a caller shortening its input to
 * what the message named would be refused again. Every refusal that quotes caller
 * text goes through here. The exponent branch in ode-condition-bounds.ts once did
 * not, and returned up to 8 KB of caller digits as the tool's answer on the
 * right-hand-side channel, which has no length bound in front of it.
 *
 * `max` is 20 for the magnitude refusals and 60 where a whole argument or
 * condition is quoted.
 */
export function excerpt(text: string, max = 20): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/**
 * A caller-supplied name escaped for embedding in a RegExp source.
 *
 * Shared because it had been written out inline at each site that built a
 * pattern from a function or variable name, four copies in all.
 */
export function escapeForRegExp(name: string): string {
  return name.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}
