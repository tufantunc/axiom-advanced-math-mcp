/**
 * Parsing primitives for a problem string's argument list.
 *
 * These are the "how do I read an argument" half of routing; `extractors.ts`
 * keeps the "which handler owns this verb" half.
 *
 * One coercion policy lives here — JSON if the text is JSON, else a finite
 * number, else the raw string — and every caller goes through it, so a fix to
 * named-argument handling lands in one place. No Giac calls, no I/O.
 */

/** The text between a call's outermost parentheses, or the whole string. */
export function extractFnArgs(problem: string): string {
  const idx = problem.indexOf('(');
  if (idx === -1) return problem;
  let depth = 0;
  let end = -1;
  for (let i = idx; i < problem.length; i++) {
    if (problem[i] === '(') depth++;
    else if (problem[i] === ')') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  return end === -1 ? problem.slice(idx + 1) : problem.slice(idx + 1, end);
}

/**
 * Split a call's argument text on top-level commas.
 *
 * `splitOnSemicolons` also treats `;` as a separator, for the positions where
 * both spell "next item" — `solve_system(x+y=3; x-y=1)` names two equations,
 * and reading it as one made Giac answer `{}`.
 */
export function splitArgs(inner: string, splitOnSemicolons = false): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of inner) {
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    if ((ch === ',' || (splitOnSemicolons && ch === ';')) && depth === 0) {
      parts.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

/** One argument's value: JSON where it parses, else a finite number, else the text. */
function coerceValue(raw: string): unknown {
  const text = raw.trim();
  try {
    const parsed: unknown = JSON.parse(text);
    // The JSON branch skipped the finiteness check the Number branch applies,
    // and `JSON.parse('1e999')` is Infinity — so `t_test(mu0=1e999, ...)`
    // reported "H₀: μ = Infinity" and a maximally confident rejection. Keep the
    // text so a caller sees what they typed rather than a degenerate number.
    if (typeof parsed === 'number' && !Number.isFinite(parsed)) return text;
    return parsed;
  } catch {
    const num = Number(text);
    return Number.isFinite(num) ? num : text;
  }
}

export interface CallArgs {
  named: Record<string, unknown>;
  positional: unknown[];
}

/**
 * Splits an argument list into `name=value` pairs and bare positional values,
 * coercing every value the same way.
 *
 * The single primitive behind every `name=value` form the router accepts. A
 * `==` is left alone so a comparison is not mistaken for an assignment.
 */
export function parseCallArgs(inner: string): CallArgs {
  const named: Record<string, unknown> = {};
  const positional: unknown[] = [];
  for (const part of splitArgs(inner)) {
    const match = /^\s*([A-Za-z_]\w*)\s*=(?!=)\s*([\s\S]+)$/.exec(part);
    if (match) named[match[1]] = coerceValue(match[2]);
    else positional.push(coerceValue(part));
  }
  return { named, positional };
}

/** The named entries whose keys the caller allows and whose values are finite numbers. */
export function pickNumbers(
  named: Record<string, unknown>,
  allowed: string[]
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of allowed) {
    const value = named[key];
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

/** Elements of a bracketed list, as raw text. */
export function parseBracketList(s: string): string[] {
  return splitArgs(s.trim().replace(/^\[/, '').replace(/\]$/, ''));
}

/**
 * A list of finite numbers, or null if any element is not one.
 *
 * Null rather than a partly-NaN array: `.map(Number)` kept the declared
 * `number[]` type and a non-zero length while every element was NaN, so callers
 * guarding on `.length` passed garbage through to the CAS.
 */
export function parseNumberList(s: string): number[] | null {
  const parts = parseBracketList(s);
  if (parts.length === 0) return null;
  // `Number('')` is 0, and a doubled comma yields an empty part — so `[1,,3]`
  // parsed as [1, 0, 3] and passed the finiteness check below, answering
  // `dot([1,,3],[1,2,3])` = 10 for a vector the caller never wrote.
  if (parts.some((part) => part.trim() === '')) return null;
  const nums = parts.map(Number);
  return nums.every((n) => Number.isFinite(n)) ? nums : null;
}

/** `[[1,2],[2,4]]` as (x, y) pairs, or null if it is not that shape. */
export function parsePointPairs(arg: unknown): [number, number][] | null {
  const value: unknown = typeof arg === 'string' ? tryJson(arg) : arg;
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (pair) =>
        Array.isArray(pair) &&
        pair.length === 2 &&
        pair.every((n) => typeof n === 'number' && Number.isFinite(n))
    )
  ) {
    return value as [number, number][];
  }
  return null;
}

/**
 * A list of (x, y) points from a call's argument text, accepting both the
 * "one bracketed list" and the "one argument per point" spellings.
 *
 * The two differ only in nesting depth, and wrapping the argument text in
 * brackets to parse it turned the first into a one-element array holding the
 * whole polygon. geometryHandler read that as a single vertex and reported
 * "area_polygon requires at least 3 vertices" for a call that supplied four.
 */
export function parsePointList(inner: string): [number, number][] | null {
  const asSeparateArgs = parsePointPairs(`[${inner}]`);
  if (asSeparateArgs) return asSeparateArgs;
  const parts = splitArgs(inner);
  return parts.length === 1 ? parsePointPairs(parts[0]) : null;
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text.trim()) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Drops a leading `name =` label from an expression argument.
 *
 * `gradient(f = x*y, [x,y])` names its argument; the expression to operate on
 * is `x*y`. Handlers that receive the label pass it to Giac whole and produce
 * confident nonsense (`grad(f = x*y)` -> `[0,0]=[y,x]`). Only fires on a bare
 * identifier followed by `=`, so real equations and comparisons are untouched.
 */
export function expressionArg(arg: string | undefined): string {
  return (arg || '').replace(/^\s*[A-Za-z_]\w*\s*=\s*(?!=)/, '');
}

/**
 * Drops bracket pairs that wrap the whole problem, so a parenthesised equation
 * still reads as an equation: `(x^2-4=0)` and the Giac-idiomatic `[x^2-4=0]`
 * have no depth-0 `=` until the wrapper comes off.
 *
 * Only strips a pair whose partner is the final character, so `gradient(f =
 * x*y, [x,y])` (opener preceded by a verb) and `(a=1)*(b=2)` are untouched.
 * `{}` is left alone: it is a Giac set, not grouping.
 */
export function stripEnclosingBrackets(problem: string): string {
  let s = problem.trim();
  while (s.length > 1 && (s[0] === '(' || s[0] === '[')) {
    let depth = 0;
    let partner = -1;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') {
        depth--;
        if (depth === 0) {
          partner = i;
          break;
        }
      }
    }
    if (partner !== s.length - 1) break;
    s = s.slice(1, -1).trim();
  }
  return s;
}
