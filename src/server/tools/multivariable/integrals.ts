// src/server/tools/multivariable/integrals.ts
import { evalWithLatex } from '../giac-eval.js';
import { formatErrorResponse } from '../response-formatter.js';
import { validateExpression } from '../symbolic/validator.js';

interface Bound {
  variable: string;
  lower: string;
  upper: string;
}

export async function integralHandler(args: Record<string, unknown>) {
  try {
    // Raw native form: pass straight through (already valid Giac).
    const raw = args.raw as string | undefined;
    if (raw) {
      const validation = validateExpression(raw);
      if (validation) return formatErrorResponse(validation.message);
      return evalWithLatex({ giacExpr: raw, operation: 'multiple_integral' });
    }

    const expression = args.expression as string;
    if (!expression) return formatErrorResponse("'expression' is required for multiple_integral");
    const bounds = (args.bounds as Bound[]) ?? [];
    if (bounds.length < 2) {
      return formatErrorResponse(
        "multiple_integral requires at least 2 integration bounds (use 'int' for a single integral)",
      );
    }
    const validation = validateExpression(expression);
    if (validation) return formatErrorResponse(validation.message);

    // Build nested int(): the first bound is the innermost integral.
    let giacExpr = expression;
    for (const b of bounds) {
      if (!b.variable || !b.lower || !b.upper) {
        return formatErrorResponse('each bound needs variable, lower, and upper');
      }
      giacExpr = `int(${giacExpr},${b.variable},${b.lower},${b.upper})`;
    }

    return evalWithLatex({ giacExpr, operation: 'multiple_integral' });
  } catch (error) {
    return formatErrorResponse(error instanceof Error ? error.message : String(error));
  }
}
