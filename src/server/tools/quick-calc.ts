import { QuickCalcService, type QuickCalcOptions } from './quick-calc-service.js';
import { preprocessExpression } from './quick-calc-preprocessor.js';
import { tryExactResult } from './exact-arithmetic.js';
import { formatToolResponse, formatErrorResponse, NON_FINITE_NOTE } from './response-formatter.js';

export async function quickCalcHandler(args: Record<string, unknown>) {
  try {
    const rawExpr = args.expression as string;

    const { expression } = preprocessExpression(rawExpr);

    const service = new QuickCalcService();
    const opts: QuickCalcOptions = {
      expression,
      precision: args.precision as number | undefined,
      format: args.format as QuickCalcOptions['format'],
    };
    const result = await service.evaluate(opts);

    // From the worker, not re-derived: parseFloat(String(result)) read the leading
    // term of a rendered value, so "0.5 kg" became 0.5 and the unit was dropped
    // from the answer.
    const numericResult = result.numeric;

    if (numericResult !== null) {
      const exact = await tryExactResult(rawExpr, numericResult);
      if (exact) {
        return formatToolResponse({
          result: exact.exact,
          decimal: String(numericResult),
          latex: exact.latex,
        });
      }
    }

    // An infinite result is reported, but never bare. The flag comes from the
    // worker rather than from `typeof result.result === 'number'`, which is false
    // for every container — `[1, 1/0]` and `1/0 m` carried no caveat at all.
    return formatToolResponse({
      result: String(result.result),
      latex: result.latex,
      ...(result.nonFinite ? { notes: [NON_FINITE_NOTE] } : {}),
    });
  } catch (error) {
    return formatErrorResponse(error instanceof Error ? error.message : String(error));
  }
}
