import { z } from 'zod';
import { giacEngine } from '../giac/index.js';
import { formatToolResponse, formatErrorResponse } from './response-formatter.js';
import { validateExpression } from './symbolic/validator.js';
import { evaluationCache } from './symbolic/cache.js';

export const algebraSchema = z.object({
  operation: z
    .enum(['factor', 'simplify', 'expand', 'partial_fractions'])
    .describe(
      'Algebraic operation:\n' +
        '  factor — factor into irreducible factors\n' +
        '  simplify — simplify to simplest form\n' +
        '  expand — expand products and powers\n' +
        '  partial_fractions — partial fraction decomposition'
    ),
  expression: z
    .string()
    .describe('Expression (e.g., "x^2-4", "(x^2-1)/(x-1)", "sin(x)^2+cos(x)^2")'),
  variable: z
    .string()
    .optional()
    .describe('Variable for partial_fractions (e.g., "x"). Required for partial_fractions.'),
  complex: z
    .boolean()
    .optional()
    .describe('Factor over complex numbers (default: false). For factor only.'),
});

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
      return formatErrorResponse(`Could not compute ${operation}`);
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
