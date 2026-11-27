import { GIAC_NUMBER } from './output-cleanup.js';

/**
 * The lexer every ODE text bound reads with, and the factorial arithmetic they
 * share: the leaf both ode-condition-bounds.ts (SIZE) and ode-cost-bounds.ts
 * (COST) import, so neither has to export its internals to the other.
 *
 * Text-only, like both of them, and guarded the same way in
 * ode-system-shape-boundary.test.ts: no `async`, no engine symbol, and no
 * import path to `src/server/giac`.
 */

export type MagnitudeToken = {
  kind: 'number' | 'name' | 'op' | 'separator';
  text: string;
  at: number;
};

const MAGNITUDE_NUMBER = new RegExp(`^${GIAC_NUMBER}`);

/**
 * The characters tokenizeMagnitude reads as operators; every other character
 * that is not part of a number or a name is a separator. Exported so a check
 * that admits "the operators" admits exactly these.
 */
export const MAGNITUDE_OPERATORS = '+-*/^!()[],';

/**
 * Giac's hexadecimal and binary integer literals. GIAC_NUMBER has neither, so
 * `0xFF` read as the number `0` and a free name `xFF` — height zero — and
 * `y''+(0x` + 340 `F`s + `+2)*y=0`, a 410-digit coefficient, was admitted and
 * held the worker its full 10s. Matched first and kept as one number token,
 * even past a double: `Number()` then gives Infinity, which every reader
 * charges as a number too large to count.
 */
const RADIX_NUMBER = /^0(?:[xX][0-9a-fA-F]+|[bB][01]+)/;

/**
 * The condition's characters, as tokens. Never fails.
 *
 * A character this does not model becomes a SEPARATOR rather than aborting the
 * read, and that is load-bearing: aborting made one unmodelled character a
 * master key. `1000!^12%7` was admitted and evaluated — 152ms, having built the
 * 30,812-digit intermediate — because `%` ended the tokenizer and the whole
 * segment went unmeasured. As a separator it ends one run and starts another,
 * and the run before it is still charged.
 *
 * The numeric pattern is GIAC_NUMBER, the spelling this repo already exports,
 * rather than a second one written here. The local copy dropped the trailing
 * decimal form, so `100.!^200` read as unmodelled where `100!^200` was refused —
 * one character apart, opposite verdicts.
 */
export function tokenizeMagnitude(text: string): MagnitudeToken[] {
  const tokens: MagnitudeToken[] = [];
  let at = 0;
  while (at < text.length) {
    const rest = text.slice(at);
    if (/^\s/.test(rest)) {
      at += 1;
      continue;
    }
    const radix = RADIX_NUMBER.exec(rest)?.[0];
    if (radix !== undefined) {
      tokens.push({ kind: 'number', text: radix, at });
      at += radix.length;
      continue;
    }
    const number = MAGNITUDE_NUMBER.exec(rest)?.[0];
    if (number !== undefined && Number.isFinite(Number(number))) {
      tokens.push({ kind: 'number', text: number, at });
      at += number.length;
      continue;
    }
    const name = /^[A-Za-z_]\w*/.exec(rest)?.[0];
    if (name !== undefined) {
      tokens.push({ kind: 'name', text: name, at });
      at += name.length;
      continue;
    }
    const character = rest[0] ?? '';
    tokens.push({
      kind: MAGNITUDE_OPERATORS.includes(character) ? 'op' : 'separator',
      text: character,
      at,
    });
    at += 1;
  }
  return tokens;
}

/**
 * How many decimal digits n! has.
 *
 * Stirling with the 1/(12n) correction rather than a loop over k, because the
 * argument is caller text: `1000000000!` would walk a billion iterations to
 * reach a verdict this can state in closed form. Checked against the exact sum
 * of log10(k) at the sizes that decide anything — 1000! gives 2,568 both ways.
 *
 * Approximate is sound HERE specifically because it feeds a bound with a factor
 * of nine of headroom; the error is far below one digit for n ≥ 2, and this is
 * never used to report a value back to a caller as exact.
 *
 * stats-utils.ts exports `lgamma`, and `factorialLog10(n)` is `lgamma(n+1)/LN10`.
 * Stirling is kept anyway, deliberately: the closed form above is the argument
 * for why a billion-iteration argument costs nothing to bound, and importing it
 * would widen the text-only import closure ode-system-shape-boundary.test.ts
 * walks. Recorded so the next reader does not re-derive the comparison.
 */
export function factorialLog10(n: number): number {
  if (n < 2) return 0;
  const ln = n * Math.log(n) - n + 0.5 * Math.log(2 * Math.PI * n) + 1 / (12 * n);
  return ln / Math.LN10;
}

/**
 * The tokens with a derivative's primes folded into the name before them, so
 * `y''` is one name rather than a name and two separators. One pass, shared by
 * every reader that needs to know what a prime applies to.
 */
export function foldPrimes(tokens: MagnitudeToken[]): MagnitudeToken[] {
  const folded: MagnitudeToken[] = [];
  for (const token of tokens) {
    const last = folded[folded.length - 1];
    if (token.text === "'" && last?.kind === 'name') {
      folded[folded.length - 1] = { ...last, text: `${last.text}'` };
    } else folded.push(token);
  }
  return folded;
}
