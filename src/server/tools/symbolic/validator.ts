export interface ValidationError {
  message: string;
  position?: number;
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
  let depth = 0;
  for (let i = 0; i < expression.length; i++) {
    if (expression[i] === '(') depth++;
    else if (expression[i] === ')') depth--;
    if (depth < 0) {
      return { message: `Unmatched closing parenthesis at position ${i}`, position: i };
    }
  }
  if (depth > 0) {
    return { message: `${depth} unclosed parenthesis${depth > 1 ? 'es' : ''}` };
  }

  // Check balanced brackets
  depth = 0;
  for (let i = 0; i < expression.length; i++) {
    if (expression[i] === '[') depth++;
    else if (expression[i] === ']') depth--;
    if (depth < 0) {
      return { message: `Unmatched closing bracket at position ${i}`, position: i };
    }
  }
  if (depth > 0) {
    return { message: `${depth} unclosed bracket${depth > 1 ? 's' : ''}` };
  }

  return null;
}
