import { evalWithLatex } from '../giac-eval.js';
import { formatErrorResponse } from '../response-formatter.js';
import { validateExpression } from '../expression-validator.js';

const VECTOR_OPS = new Set(['divergence', 'curl', 'jacobian']);

export async function operatorHandler(args: Record<string, unknown>) {
  try {
    const operation = args.operation as string;
    const variables = (args.variables as string[]) ?? [];
    if (variables.length === 0) {
      return formatErrorResponse(`'variables' (a non-empty list) is required for ${operation}`);
    }
    const varList = `[${variables.join(',')}]`;

    let giacExpr: string;
    if (VECTOR_OPS.has(operation)) {
      const functions = (args.functions as string[]) ?? [];
      if (functions.length === 0) {
        return formatErrorResponse(`'functions' (a non-empty list) is required for ${operation}`);
      }
      const vec = `[${functions.join(',')}]`;
      const validation = validateExpression(functions.join(','));
      if (validation) return formatErrorResponse(validation.message);
      if (operation === 'jacobian') {
        // Giac's built-in jacobian() returns unevaluated in this WASM build.
        // Build the Jacobian matrix explicitly from diff(): each row i is the
        // gradient of functions[i] with respect to each variable.
        const rows = functions.map(
          (fn) => `[${variables.map((v) => `diff(${fn},${v})`).join(',')}]`
        );
        giacExpr = `[${rows.join(',')}]`;
      } else {
        giacExpr = `${operation}(${vec},${varList})`;
      }
    } else {
      const expression = args.expression as string;
      if (!expression) return formatErrorResponse(`'expression' is required for ${operation}`);
      const validation = validateExpression(expression);
      if (validation) return formatErrorResponse(validation.message);
      if (operation === 'gradient') giacExpr = `grad(${expression},${varList})`;
      else if (operation === 'hessian') giacExpr = `hessian(${expression},${varList})`;
      // Giac diff(f, x, y) performs successive differentiation, so passing multiple variables
      // computes mixed/higher-order partials, e.g. diff(f,x,y) = ∂²f/∂x∂y.
      else if (operation === 'partial') giacExpr = `diff(${expression},${variables.join(',')})`;
      else return formatErrorResponse(`Unknown operator: ${operation}`);
    }

    return evalWithLatex({ giacExpr, operation });
  } catch (error) {
    return formatErrorResponse(error instanceof Error ? error.message : String(error));
  }
}
