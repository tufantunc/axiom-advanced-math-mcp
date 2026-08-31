import { formatErrorResponse } from './response-formatter.js';
import { validateExpression } from './expression-validator.js';
import { evalWithLatex } from './giac-eval.js';
import { verifyFactor } from './self-verify.js';

function buildGiacExpression(operation: string, args: Record<string, unknown>): string {
  const expr = args.expression as string;
  switch (operation) {
    case 'factor':
      return (args.complex as boolean) ? `cfactor(${expr})` : `factor(${expr})`;
    case 'simplify':
      return `simplify(${expr})`;
    case 'expand':
      return `expand(${expr})`;
    case 'partial_fractions': {
      const v = args.variable as string;
      return `partfrac(${expr},${v})`;
    }
    default:
      throw new Error(`Unknown algebra operation: ${operation}`);
  }
}

export async function algebraHandler(args: Record<string, unknown>) {
  try {
    const operation = args.operation as string;

    if (!args.expression) {
      return formatErrorResponse("'expression' is required");
    }
    if (operation === 'partial_fractions' && !args.variable) {
      return formatErrorResponse("'variable' is required for partial_fractions");
    }

    const validationError = validateExpression(args.expression as string);
    if (validationError) return formatErrorResponse(validationError.message);

    const giacExpr = buildGiacExpression(operation, args);
    const verify =
      operation === 'factor'
        ? (result: string) => verifyFactor(args.expression as string, result)
        : undefined;
    return evalWithLatex({ giacExpr, operation, verify });
  } catch (error) {
    return formatErrorResponse(error instanceof Error ? error.message : String(error));
  }
}
