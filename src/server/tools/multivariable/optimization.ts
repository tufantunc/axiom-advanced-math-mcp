import { giacEngine } from '../../giac/index.js';
import { formatToolResponse, formatErrorResponse } from '../response-formatter.js';
import { validateExpression } from '../symbolic/validator.js';

/** Build a Giac substitution list "[x=1,y=2]" from variables + point values. */
function substList(variables: string[], point: string[]): string {
  return `[${variables.map((v, i) => `${v}=${point[i]}`).join(',')}]`;
}

/** Evaluate a Giac expression, throwing on undef/empty. */
async function giac(expr: string): Promise<string> {
  const out = await giacEngine.evaluate(expr);
  if (!out || out === 'undef') throw new Error(`Giac could not evaluate: ${expr}`);
  return out;
}

export async function optimizationHandler(args: Record<string, unknown>) {
  try {
    const operation = args.operation as string;
    const expression = args.expression as string;
    const variables = (args.variables as string[]) ?? [];

    if (!expression) return formatErrorResponse(`'expression' is required for ${operation}`);
    if (variables.length === 0) return formatErrorResponse(`'variables' is required for ${operation}`);
    const validation = validateExpression(expression);
    if (validation) return formatErrorResponse(validation.message);

    if (operation === 'tangent_plane') {
      const point = (args.point as string[]) ?? [];
      if (point.length !== variables.length) {
        return formatErrorResponse("'point' length must match 'variables' length");
      }
      const sub = substList(variables, point);
      const f0 = await giac(`subst(${expression},${sub})`);
      const terms: string[] = [f0];
      for (let i = 0; i < variables.length; i++) {
        const slope = await giac(`subst(diff(${expression},${variables[i]}),${sub})`);
        terms.push(`(${slope})*(${variables[i]}-(${point[i]}))`);
      }
      const plane = await giac(`simplify(${terms.join('+')})`);
      return formatToolResponse({
        result: `z = ${plane}`,
        notes: [`Expansion point: (${point.join(', ')})`, `f at point = ${f0}`],
      });
    }

    if (operation === 'directional_derivative') {
      const point = (args.point as string[]) ?? [];
      const direction = (args.direction as string[]) ?? [];
      if (point.length !== variables.length) {
        return formatErrorResponse("'point' length must match 'variables' length");
      }
      if (direction.length !== variables.length) {
        return formatErrorResponse("'direction' length must match 'variables' length");
      }
      const sub = substList(variables, point);
      const norm = await giac(`sqrt(${direction.map((d) => `(${d})^2`).join('+')})`);
      const parts: string[] = [];
      for (let i = 0; i < variables.length; i++) {
        const gi = await giac(`subst(diff(${expression},${variables[i]}),${sub})`);
        parts.push(`(${gi})*(${direction[i]})`);
      }
      const dv = await giac(`simplify((${parts.join('+')})/(${norm}))`);
      return formatToolResponse({
        result: dv,
        notes: [`Point: (${point.join(', ')})`, `Direction: [${direction.join(', ')}]`, `‖direction‖ = ${norm}`],
      });
    }

    return formatErrorResponse(`Unknown optimization operation: ${operation}`);
  } catch (error) {
    return formatErrorResponse(error instanceof Error ? error.message : String(error));
  }
}
