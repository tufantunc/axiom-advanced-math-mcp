import { AdvancedSolveService, type AdvancedSolveOptions } from './advanced-solve-service.js';
import { formatToolResponse, formatErrorResponse } from './response-formatter.js';

export async function advancedSolveHandler(args: Record<string, unknown>) {
  try {
    const service = new AdvancedSolveService();
    const result = await service.evaluate({
      expression: args.expression as string,
      format: args.format as AdvancedSolveOptions['format'],
      steps: args.steps as boolean | undefined,
      simplify: args.simplify as boolean | undefined,
    });

    const notes: string[] = [];
    if (result.latex) notes.push(`LaTeX: ${result.latex}`);
    if (result.variables && result.variables.length > 0)
      notes.push(`Variables: ${result.variables.join(', ')}`);
    if (result.domain) notes.push(`Domain: ${result.domain}`);
    if (result.steps && result.steps.length > 0) notes.push('Steps:', ...result.steps);

    return formatToolResponse({
      result: String(result.result),
      notes: notes.length > 0 ? notes : undefined,
    });
  } catch (error) {
    return formatErrorResponse(error instanceof Error ? error.message : String(error));
  }
}
