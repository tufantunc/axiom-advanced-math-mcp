import { z } from 'zod';
import { giacEngine } from '../giac/index.js';
import { formatToolResponse, formatErrorResponse } from './response-formatter.js';
import { validateExpression } from './symbolic/validator.js';
import { evaluationCache } from './symbolic/cache.js';

export const matrixSchema = z.object({
  operation: z
    .enum([
      'determinant',
      'inverse',
      'eigenvalues',
      'eigenvectors',
      'rref',
      'rank',
      'transpose',
      'nullspace',
      'qr',
      'lu',
      'cholesky',
      'svd',
      'norm_frobenius',
      'norm_1',
      'norm_inf',
      'condition_number',
    ])
    .describe(
      'Matrix operation. Determinant, inverse, eigenvalues, eigenvectors, RREF, rank, transpose, nullspace, QR/LU/Cholesky/SVD decomposition, norms, condition number.'
    ),
  matrix: z.string().describe('Matrix as nested list (e.g., "[[1,2],[3,4]]")'),
});

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

    const cached = evaluationCache.get(giacExpr);
    if (cached) {
      return formatToolResponse({
        result: cached.result,
        latex: cached.latex,
        giacCommand: giacExpr,
      });
    }

    const result = await giacEngine.evaluate(giacExpr);
    if (!result || result === 'undef') {
      return formatErrorResponse(`Could not compute ${operation}. Check matrix format.`);
    }

    let latex: string | undefined;
    try {
      const rawLatex = await giacEngine.evaluate(`latex(${result})`);
      if (rawLatex && rawLatex !== 'undef' && !rawLatex.startsWith('latex')) {
        latex = rawLatex
          .replace(/\\dfrac\b/g, '\\frac')
          .replace(/\\displaystyle\s*/g, '')
          .replace(/\\textstyle\s*/g, '');
      }
    } catch {
      /* best effort */
    }

    evaluationCache.set(giacExpr, { result, latex });

    return formatToolResponse({
      result,
      latex,
      giacCommand: giacExpr,
    });
  } catch (error) {
    return formatErrorResponse(error instanceof Error ? error.message : String(error));
  }
}
