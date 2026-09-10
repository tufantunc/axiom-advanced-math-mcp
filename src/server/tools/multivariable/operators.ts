import { evalWithLatex } from '../giac-eval.js';
import { formatErrorResponse } from '../response-formatter.js';
import { validateExpression } from '../expression-validator.js';

const VECTOR_OPS = new Set(['divergence', 'curl', 'jacobian']);

// Refusals are thrown, not returned: the handler's catch formats the same
// string through formatErrorResponse, which is the file's established
// convention for a command that cannot be built.
function buildVectorCommand(
  operation: string,
  args: Record<string, unknown>,
  variables: string[]
): string {
  const functions = (args.functions as string[]) ?? [];
  if (functions.length === 0) {
    throw new Error(`'functions' (a non-empty list) is required for ${operation}`);
  }
  const vec = `[${functions.join(',')}]`;
  const varList = `[${variables.join(',')}]`;
  const validation = validateExpression(functions.join(','));
  if (validation) throw new Error(validation.message);
  if (operation === 'jacobian') {
    // Giac's built-in jacobian() returns unevaluated in this WASM build.
    // Build the Jacobian matrix explicitly from diff(): each row i is the
    // gradient of functions[i] with respect to each variable.
    const rows = functions.map((fn) => {
      const derivatives = variables.map((v) => `diff(${fn},${v})`).join(',');
      return `[${derivatives}]`;
    });
    return `[${rows.join(',')}]`;
  }
  return `${operation}(${vec},${varList})`;
}

function buildScalarCommand(
  operation: string,
  args: Record<string, unknown>,
  variables: string[]
): string {
  const expression = args.expression as string;
  if (!expression) throw new Error(`'expression' is required for ${operation}`);
  const varList = `[${variables.join(',')}]`;
  const validation = validateExpression(expression);
  if (validation) throw new Error(validation.message);
  if (operation === 'gradient') return `grad(${expression},${varList})`;
  if (operation === 'hessian') return `hessian(${expression},${varList})`;
  // Giac diff(f, x, y) performs successive differentiation, so passing multiple variables
  // computes mixed/higher-order partials, e.g. diff(f,x,y) = ∂²f/∂x∂y.
  if (operation === 'partial') return `diff(${expression},${variables.join(',')})`;
  throw new Error(`Unknown operator: ${operation}`);
}

export async function operatorHandler(args: Record<string, unknown>) {
  try {
    const operation = args.operation as string;
    const variables = (args.variables as string[]) ?? [];
    if (variables.length === 0) {
      return formatErrorResponse(`'variables' (a non-empty list) is required for ${operation}`);
    }

    const giacExpr = VECTOR_OPS.has(operation)
      ? buildVectorCommand(operation, args, variables)
      : buildScalarCommand(operation, args, variables);

    return evalWithLatex({ giacExpr, operation });
  } catch (error) {
    return formatErrorResponse(error instanceof Error ? error.message : String(error));
  }
}
