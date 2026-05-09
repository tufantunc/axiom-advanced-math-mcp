import { z } from 'zod';
import { giacEngine } from '../giac/index.js';
import { formatToolResponse, formatErrorResponse } from './response-formatter.js';
import { validateExpression } from './symbolic/validator.js';
import { evaluationCache } from './symbolic/cache.js';

export const calculusSchema = z.object({
  operation: z
    .enum(['differentiate', 'integrate', 'limit', 'taylor', 'solve_ode'])
    .describe(
      'Calculus operation:\n' +
        '  differentiate — derivative (any order, partial)\n' +
        '  integrate — definite or indefinite integral\n' +
        '  limit — two-sided or one-sided limit\n' +
        '  taylor — Taylor/Maclaurin series\n' +
        '  solve_ode — ordinary differential equation'
    ),
  expression: z
    .string()
    .optional()
    .describe('Expression (for differentiate, integrate, limit, taylor). e.g., "x^2", "sin(x)"'),
  equation: z
    .string()
    .optional()
    .describe('ODE equation (for solve_ode). e.g., "y\'=2*x", "y\'\'+y=0"'),
  variable: z.string().optional().describe('Variable (e.g., "x", "t"). Default: "x"'),
  order: z
    .number()
    .optional()
    .describe(
      'Derivative order (differentiate) or series terms (taylor). Default: 1 for diff, 5 for taylor'
    ),
  lower_bound: z
    .string()
    .optional()
    .describe('Lower bound for definite integral (e.g., "0", "-inf")'),
  upper_bound: z
    .string()
    .optional()
    .describe('Upper bound for definite integral (e.g., "1", "inf")'),
  point: z
    .string()
    .optional()
    .describe('Limit point or taylor expansion point (e.g., "0", "inf"). Default: "0" for taylor'),
  direction: z
    .enum(['+', '-'])
    .optional()
    .describe('One-sided limit direction: "+" (right) or "-" (left)'),
  function_name: z.string().optional().describe('Unknown function name for ODE (default: "y")'),
  initial_conditions: z
    .string()
    .optional()
    .describe('Initial conditions for ODE (e.g., "y(0)=1" or "y(0)=1,y\'(0)=0")'),
});

function buildGiacExpression(operation: string, args: Record<string, unknown>): string {
  switch (operation) {
    case 'differentiate': {
      const expr = args.expression as string;
      const v = args.variable as string;
      const ord = args.order as number | undefined;
      if (ord && ord > 1) return `diff(${expr},${v},${ord})`;
      return `diff(${expr},${v})`;
    }
    case 'integrate': {
      const expr = args.expression as string;
      const v = args.variable as string;
      const lo = args.lower_bound as string | undefined;
      const hi = args.upper_bound as string | undefined;
      if (lo !== undefined && hi !== undefined) return `int(${expr},${v},${lo},${hi})`;
      return `int(${expr},${v})`;
    }
    case 'limit': {
      const expr = args.expression as string;
      const v = args.variable as string;
      const pt = args.point as string;
      const dir = args.direction as string | undefined;
      if (dir) return `limit(${expr},${v},${pt},${dir === '+' ? '1' : '-1'})`;
      return `limit(${expr},${v},${pt})`;
    }
    case 'taylor': {
      const expr = args.expression as string;
      const v = args.variable as string;
      const pt = (args.point as string) ?? '0';
      const n = (args.order as number) ?? 5;
      return `taylor(${expr},${v}=${pt},${n})`;
    }
    case 'solve_ode': {
      const eq = args.equation as string;
      const v = (args.variable as string) ?? 'x';
      const fn = (args.function_name as string) ?? 'y';
      const ic = args.initial_conditions as string | undefined;
      if (ic) return `desolve([${eq},${ic}],${v},${fn})`;
      return `desolve(${eq},${v},${fn})`;
    }
    default:
      throw new Error(`Unknown calculus operation: ${operation}`);
  }
}

function validateParams(operation: string, args: Record<string, unknown>): string | null {
  switch (operation) {
    case 'differentiate':
      if (!args.expression) return "'expression' is required for differentiate";
      if (!args.variable) return "'variable' is required for differentiate";
      return null;
    case 'integrate':
      if (!args.expression) return "'expression' is required for integrate";
      if (!args.variable) return "'variable' is required for integrate";
      return null;
    case 'limit':
      if (!args.expression) return "'expression' is required for limit";
      if (!args.variable) return "'variable' is required for limit";
      if (!args.point) return "'point' is required for limit";
      return null;
    case 'taylor':
      if (!args.expression) return "'expression' is required for taylor";
      if (!args.variable) return "'variable' is required for taylor";
      return null;
    case 'solve_ode':
      if (!args.equation) return "'equation' is required for solve_ode";
      return null;
    default:
      return `Unknown operation: ${operation}`;
  }
}

export async function calculusHandler(args: Record<string, unknown>) {
  try {
    const operation = args.operation as string;

    const paramError = validateParams(operation, args);
    if (paramError) return formatErrorResponse(paramError);

    const exprToValidate =
      operation === 'solve_ode' ? (args.equation as string) : (args.expression as string);
    const validationError = validateExpression(exprToValidate);
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
