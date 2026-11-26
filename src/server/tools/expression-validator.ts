export interface ValidationError {
  message: string;
  position?: number;
}

/**
 * One pass over the expression for one kind of delimiter: a closer before
 * its opener reports the position; leftover openers report a count. Wordings
 * are parameterized so parentheses and brackets keep their exact messages.
 */
function unbalancedDelimiters(
  expression: string,
  open: string,
  close: string,
  singular: string,
  plural: string
): ValidationError | null {
  let depth = 0;
  for (let i = 0; i < expression.length; i++) {
    if (expression[i] === open) depth++;
    else if (expression[i] === close) depth--;
    if (depth < 0) {
      return { message: `Unmatched closing ${singular} at position ${i}`, position: i };
    }
  }
  if (depth > 0) {
    return { message: `${depth} unclosed ${depth > 1 ? plural : singular}` };
  }
  return null;
}

/**
 * Pre-flight validation for mathematical expressions before sending to Giac.
 * Catches common syntax errors early with user-friendly messages.
 */
export function validateExpression(expression: string): ValidationError | null {
  if (!expression || expression.trim().length === 0) {
    return { message: 'Expression is empty' };
  }

  // Check balanced parentheses
  const parens = unbalancedDelimiters(expression, '(', ')', 'parenthesis', 'parentheses');
  if (parens) return parens;

  // Check balanced brackets
  return unbalancedDelimiters(expression, '[', ']', 'bracket', 'brackets');
}

/**
 * A binary operator with an empty slot on its right: the input's end, a closing
 * bracket or an argument separator follows it.
 */
const MISSING_RIGHT = /([=<>+\-*/^])\s*(?:$|[)\],])/;
/**
 * The same on the left. `+` and `-` are left out because they are also signs:
 * `-x=4` is an equation.
 */
const MISSING_LEFT = /(?:^|[([,])\s*([=<>*/^])/;
/** Giac's store operators. `x*=4` stores into x; it states nothing. */
const ASSIGNMENT = /:=|[+\-*/]=(?!=)/;

/** Bare `=` signs at nesting depth 0 — not part of `<=`, `>=`, `!=` or `==`. */
function topLevelEqualsCount(expression: string): number {
  let depth = 0;
  let count = 0;
  for (let i = 0; i < expression.length; i++) {
    const c = expression[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === '=' && depth === 0) {
      const part = '<>!='.includes(expression[i - 1] ?? ' ') || expression[i + 1] === '=';
      if (!part) count++;
    }
  }
  return count;
}

/**
 * Pre-flight validation for an equation handed to `solve`, on top of
 * {@link validateExpression}.
 *
 * Giac does not reject a truncated equation, it answers it: `solve(x^2=,x)` is
 * `[]`, which reached the caller as "no solutions" with exit status 0. The same
 * holds for a dangling operator (`x^2+` → `[]`), a second `=` (`x^2=4=` →
 * `√(undef_+4)`), `==` (Giac's boolean test — `solve(x^2==4,x)` is `[x]`) and
 * the store operators (`x*=4` → a GIAC_ERROR rendered as the result). None of
 * those is an answer, so each is refused here, before the engine sees it.
 *
 * An operator only counts as dangling when the slot beside it is empty: the
 * input's start or end, a bracket, or a comma. So `x^-1`, `-x=4` and
 * `int(t,t=0..x)=2` (whose inner `=` is a range, at depth 1) all pass.
 */
export function validateEquation(equation: string): ValidationError | null {
  const base = validateExpression(equation);
  if (base) return base;

  const assignment = ASSIGNMENT.exec(equation);
  if (assignment) {
    return {
      message: `Malformed equation: '${assignment[0]}' is an assignment, not an equation — write it with a single '='`,
      position: assignment.index,
    };
  }
  const comparison = equation.indexOf('==');
  if (comparison >= 0) {
    return {
      message:
        "Malformed equation: '==' is a comparison, not an equation — write it with a single '='",
      position: comparison,
    };
  }
  const right = MISSING_RIGHT.exec(equation);
  if (right) {
    return {
      message: `Malformed equation: '${right[1]}' has nothing after it — the equation is incomplete`,
      position: right.index,
    };
  }
  const left = MISSING_LEFT.exec(equation);
  if (left) {
    return {
      message: `Malformed equation: '${left[1]}' has nothing before it — the equation is incomplete`,
      position: left.index + left[0].length - 1,
    };
  }
  if (topLevelEqualsCount(equation) > 1) {
    return {
      message:
        "Malformed equation: more than one '=' — solve takes a single equation; use solve_system for several",
    };
  }
  return null;
}
