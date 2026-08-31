import { formatErrorResponse } from './response-formatter.js';
import { validateExpression } from './expression-validator.js';
import { evalWithLatex } from './giac-eval.js';

const OPS: Record<string, string> = {
  determinant: 'det',
  inverse: 'inv',
  eigenvalues: 'eigenvals',
  eigenvectors: 'eigenvects',
  rref: 'rref',
  rank: 'rank',
  transpose: 'tran',
  nullspace: 'ker',
  qr: 'qr',
  lu: 'lu',
  cholesky: 'cholesky',
  svd: 'svd',
  norm_frobenius: 'norm',
  norm_1: 'l1norm',
  norm_inf: 'linfnorm',
  condition_number: 'cond',
};

export async function matrixHandler(args: Record<string, unknown>) {
  try {
    const operation = args.operation as string;
    const matrix = args.matrix as string;

    if (!matrix) return formatErrorResponse("'matrix' is required");
    if (!operation) return formatErrorResponse("'operation' is required");

    const validationError = validateExpression(matrix);
    if (validationError) return formatErrorResponse(validationError.message);

    const fn = OPS[operation] ?? 'det';
    const giacExpr = `${fn}(${matrix})`;
    return evalWithLatex({
      giacExpr,
      operation,
      errorMessage: `Could not compute ${operation}. Check matrix format.`,
    });
  } catch (error) {
    return formatErrorResponse(error instanceof Error ? error.message : String(error));
  }
}
