import { formatErrorResponse } from './response-formatter.js';
import { validateExpression } from './expression-validator.js';
import { evalWithLatex } from './giac-eval.js';
import { verifyIntegrate } from './self-verify.js';

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
    const isIndefiniteIntegral =
      operation === 'integrate' && args.lower_bound === undefined && args.upper_bound === undefined;
    const verify = isIndefiniteIntegral
      ? (result: string) =>
          verifyIntegrate(args.expression as string, args.variable as string, result)
      : undefined;
    return evalWithLatex({ giacExpr, operation, verify });
  } catch (error) {
    return formatErrorResponse(error instanceof Error ? error.message : String(error));
  }
}
