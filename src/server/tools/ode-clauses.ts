import { stripEnclosingBrackets } from './compute/arg-parsing.js';
import { splitTopLevel } from './output-cleanup.js';

/*
 * The clauses of an ODE as written, and the join spellings that separate them.
 *
 * Text only, and engine-free like ode-system-shape.ts, so both sides of the
 * single-ODE path read one grammar: readSingleOde splits the caller's text
 * into members with odeClauses, and verifyOdeSolution (self-verify.ts) cuts
 * the equation off its conditions (beforeTopLevelConjunction, "the cut"),
 * refuses what is not one equation (isOneBareEquation, "the backstop") and
 * reads the conditions back with odeClauses ("the splitter"). Two splitters
 * that disagreed about what `&&` or `∧` is would let the reader accept a member
 * the verifier then reads differently. Moved here from self-verify.ts, whose
 * history the comments below keep.
 */

/**
 * The LENGTH of the join beginning at `i`, or undefined if none does.
 *
 * A length rather than a boolean because three callers need it: the cut and the
 * backstop only ask whether a join is there, but the clause splitter has to step
 * OVER it, and a splitter with its own idea of how long `and` is would be a
 * fourth spelling prediction in code that has already paid for three.
 *
 * The word form needs a boundary before it, or `and` matches inside `command`. An
 * operator does not, and requiring one is what made this miss the spelling `&&`
 * and `∧` are normally written in: `y'=y&&y(x)=5` was never cut, the conjunction
 * stayed in the equation, and 26 of 26 measured results shipped a non-solution at
 * isError:false. One space was the whole difference, and every `&&` test row had
 * one.
 *
 * Shared by the cut, the backstop and the splitter so they cannot disagree about
 * what a join LOOKS like. They still disagree about what to DO with one, which is
 * the point.
 *
 * The history is worth keeping because each version was a spelling prediction and
 * each was wrong: splitTopLevel takes a single CHARACTER and silently split on
 * nothing when handed 'and', leaving the condition in the equation and accusing
 * `y'=y and y(0)=1` of not satisfying itself; then a space was demanded before the
 * token, so `y'=y and(y(0)=1)` was accused the same way; then the boundary was
 * demanded of the operators too. What ended it is not this function — it is
 * isOneBareEquation, which asks nothing about spelling.
 */
function joinAt(text: string, i: number, operators: RegExp, word: RegExp): number | undefined {
  const asOperator = operators.exec(text.slice(i));
  if (asOperator) return asOperator[0].length;
  if (/\w/.test(text[i - 1] ?? ' ')) return undefined;
  return word.exec(text.slice(i))?.[0].length;
}

function startsAt(text: string, i: number, operators: RegExp, word: RegExp): boolean {
  return joinAt(text, i, operators, word) !== undefined;
}

/**
 * A conjunction, which is Giac's IVP spelling: the first term is the equation.
 *
 * So are `&&` and `∧` (U+2227), and case does not matter for the word form —
 * probed against the engine rather than assumed: `and`, `AND`, `&&`, `&&&` and `∧`
 * all answer exp(x), while `And`, `et`, `xor`, `∩`, `⋀` and `&` do not. Knowing
 * only `and` was the second version of this bug: the join stayed in the equation,
 * so a correct answer was refused AND a non-solution was certified, depending on
 * whether the leftover boolean survived normalisation or collapsed to a truth
 * value. `∧` was the third, and it slipped past a round that had just widened this
 * to `&&`.
 *
 * `or` is deliberately NOT here. It is a disjunction, so the first term is not
 * "the equation" — refuting an answer to the second branch would be wrong — and
 * Giac refuses `or` inside desolve anyway. It is declined below instead of cut.
 *
 * `&&+` rather than `&&`, and the difference is the WIDTH rather than the where.
 * The cut and the backstop only ask whether a join starts at a position, so `&&`
 * was enough for them and `&&&` behaved identically. odeClauses steps OVER the
 * match, so a two-character reading of `&&&` left a stray `&` at the head of the
 * next clause, which matched no condition and cost a correct answer its mark — on
 * a spelling this docblock has recorded the engine accepting since the round that
 * added `∧`.
 */
const CONJUNCTION_OPERATOR = /^(?:&&+|\u2227)/;
const CONJUNCTION_WORD = /^and(?!\w)/i;
const JOIN_OPERATOR = /^(?:&&|\|\||\u2227|\u2228)/;
const JOIN_WORD = /^(?:and|or)(?!\w)/i;

const conjunctionAt = (text: string, i: number): number | undefined =>
  joinAt(text, i, CONJUNCTION_OPERATOR, CONJUNCTION_WORD);
const startsConjunction = (text: string, i: number): boolean =>
  startsAt(text, i, CONJUNCTION_OPERATOR, CONJUNCTION_WORD);
const startsJoin = (text: string, i: number): boolean =>
  startsAt(text, i, JOIN_OPERATOR, JOIN_WORD);

export function beforeTopLevelConjunction(text: string): string {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (depth === 0 && startsConjunction(text, i)) {
      return text.slice(0, i);
    }
  }
  return text;
}

/**
 * Whether the text is one bare equation, and therefore safe to substitute into.
 *
 * INDEPENDENT of the cut above, deliberately. The previous version of this check
 * was `beforeTopLevelJoin(text) !== text` — the cut's own predicate with a `!==`
 * — so it recognised exactly the spellings the cut already recognised and was
 * inert against the failure its comment claimed to cover. `&&` and `AND` walked
 * straight through both.
 *
 * Exactly one top-level `=` is the invariant that does not depend on knowing any
 * join spelling: toZeroForm splits at the first `=`, so a second one means the
 * rest is not part of the equation and whatever is left of it lands in the
 * right-hand side. That alone refuses `y'=y && y(0)=1` without knowing what `&&`
 * is. The keyword scan is kept as well, for a join that carries no second `=`.
 *
 * The `=` count has now earned itself. It looked redundant — remove it and no test
 * failed, because the later guards declined those inputs anyway — and it was kept
 * on the argument that a NEW join spelling could not walk past it. `∧` then turned
 * up as exactly that spelling: the cut did not know it, and this count is what made
 * the verifier decline instead of reaching a verdict on a boolean. It cost a
 * shipped non-solution, because declining is not refusing, but not a wrong verdict.
 */
export function isOneBareEquation(text: string): boolean {
  if (splitTopLevel(text, '=').length !== 2) return false;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (depth === 0 && startsJoin(text, i)) return false;
  }
  return true;
}

/**
 * Every clause of an IVP as written, flattened: the equation, then the conditions.
 *
 * Both spellings, and nested inside one another. A conjunction is Giac's own IVP
 * spelling and the one the extractor's fold uses — `(y'=y) and (y(0)=1)` — while a
 * member list carries its conditions as further members, `[y'=y, y(0)=1]`. A
 * caller who writes conditions into the equation AND passes more of them as
 * arguments gets one nested in the other, `(y'=y and y(0)=1) and (y(1)=2)`, whose
 * top-level split alone stops at `(y'=y and y(0)=1)`. So every part is stripped of
 * its brackets and split again.
 *
 * The recursion terminates because a part is re-split only when a separator was
 * actually found, which makes every recursive argument a strict substring of the
 * text above it.
 *
 * `or` is deliberately NOT a separator, for the same reason it is not a
 * conjunction above: its terms are alternatives, not a list of things that all
 * hold. So `y(0)=1 or y(0)=2` survives whole into ONE clause rather than being
 * split into two claims — and that is all this function guarantees. It does not
 * fail self-verify.ts readCondition's shape: point `0`, value `1 or y(0)=2`. What declines it is
 * readCondition's rule against a boolean value, and that rule rather than this
 * paragraph is what covers the parenthesised spelling `y(0)=(1 or 2)`.
 */
export function odeClauses(text: string): string[] {
  const t = stripEnclosingBrackets(text.trim()).trim();
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < t.length) {
    const ch = t[i];
    if (ch === '(' || ch === '[' || ch === '{') {
      depth++;
      i++;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      i++;
    } else if (depth === 0) {
      const width = ch === ',' ? 1 : conjunctionAt(t, i);
      if (width !== undefined) {
        parts.push(t.slice(start, i));
        start = i + width;
        i = start;
      } else {
        i++;
      }
    } else {
      i++;
    }
  }
  if (parts.length === 0) return [t];
  parts.push(t.slice(start));
  return parts.flatMap((part) => odeClauses(part));
}
