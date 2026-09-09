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
