import { formatErrorResponse } from './response-formatter.js';
import { validateExpression } from './symbolic/validator.js';
import { evalWithLatex } from './giac-eval.js';

export async function solveEquationHandler(args: Record<string, unknown>) {
  try {
    const equation = args.equation as string;
    const variable = args.variable as string;
    const domain = args.domain as string | undefined;

    if (!equation) return formatErrorResponse("'equation' is required");
    if (!variable) return formatErrorResponse("'variable' is required");

    const validationError = validateExpression(equation);
    if (validationError) return formatErrorResponse(validationError.message);

    const fn = domain === 'complex' ? 'csolve' : 'solve';
    const giacExpr = `${fn}(${equation},${variable})`;
    return evalWithLatex({
      giacExpr,
      operation: 'solve',
      errorMessage: 'Could not solve equation',
    });
  } catch (error) {
    return formatErrorResponse(error instanceof Error ? error.message : String(error));
  }
}

export async function solveSystemHandler(args: Record<string, unknown>) {
  try {
    const equations = args.equations as string[];
    const variables = args.variables as string[];

    if (!equations || !Array.isArray(equations) || equations.length === 0) {
      return formatErrorResponse("'equations' must be a non-empty array");
    }
    if (!variables || !Array.isArray(variables) || variables.length === 0) {
      return formatErrorResponse("'variables' must be a non-empty array");
    }

    for (const eq of equations) {
      const validationError = validateExpression(eq);
      if (validationError) return formatErrorResponse(validationError.message);
    }

    const giacExpr = `solve([${equations.join(',')}],[${variables.join(',')}])`;
    return evalWithLatex({
      giacExpr,
      operation: 'solve_system',
      errorMessage: 'Could not solve system',
    });
  } catch (error) {
    return formatErrorResponse(error instanceof Error ? error.message : String(error));
  }
}
