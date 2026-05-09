import { z } from 'zod';
import { giacEngine } from '../giac/index.js';
import { formatToolResponse, formatErrorResponse } from './response-formatter.js';
import { validateExpression } from './symbolic/validator.js';
import { evaluationCache } from './symbolic/cache.js';

export const solveEquationSchema = z.object({
  equation: z
    .string()
    .describe(
      'Equation to solve. Use "=" for equality (e.g., "x^2-4=0", "sin(x)=1/2"). If no "=" present, solved as equal to 0.'
    ),
  variable: z.string().describe('Variable to solve for (e.g., "x", "y")'),
  domain: z
    .enum(['real', 'complex'])
    .optional()
    .describe('Solution domain: "real" (default) or "complex"'),
});

export const solveSystemSchema = z.object({
  equations: z.array(z.string()).describe('List of equations (e.g., ["x+y=5", "x-y=1"])'),
  variables: z.array(z.string()).describe('Variables to solve for (e.g., ["x", "y"])'),
});

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
      return formatErrorResponse('Could not solve equation');
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
      return formatErrorResponse('Could not solve system');
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
