import { QuickCalcService, type QuickCalcOptions } from './quick-calc-service.js';
import { preprocessExpression } from './quick-calc-preprocessor.js';
import { tryExactResult } from './exact-arithmetic.js';
import { formatToolResponse, formatErrorResponse } from './response-formatter.js';

export async function quickCalcHandler(args: Record<string, unknown>) {
  try {
    const rawExpr = args.expression as string;

    const { expression } = preprocessExpression(rawExpr);

    const service = new QuickCalcService();
    const opts: QuickCalcOptions = {
      expression,
      units: args.units as QuickCalcOptions['units'],
      precision: args.precision as number | undefined,
      format: args.format as QuickCalcOptions['format'],
    };
    const result = service.evaluate(opts);

    const numericResult =
      typeof result.result === 'number' ? result.result : parseFloat(String(result.result));

    if (!isNaN(numericResult)) {
      const exact = await tryExactResult(rawExpr, numericResult);
      if (exact) {
        return formatToolResponse({
          result: exact.exact,
          decimal: String(numericResult),
          latex: exact.latex,
          notes: result.units ? [`Units: ${result.units}`] : undefined,
        });
      }
    }

    return formatToolResponse({
      result: String(result.result),
      latex: result.latex,
      notes: result.units ? [`Units: ${result.units}`] : undefined,
    });
  } catch (error) {
    return formatErrorResponse(error instanceof Error ? error.message : String(error));
  }
}
