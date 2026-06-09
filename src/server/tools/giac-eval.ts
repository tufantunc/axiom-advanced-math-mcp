import { giacEngine } from '../giac/index.js';
import { formatToolResponse, formatErrorResponse } from './response-formatter.js';
import { evaluationCache } from './symbolic/cache.js';
import { stripQuotes, stripOrderTerm } from './output-cleanup.js';

export interface EvalOptions {
  giacExpr: string;
  operation: string;
  errorMessage?: string;
  /** Optional caller-supplied cleanup applied to the raw result (e.g. solve's list→set). */
  resultTransform?: (raw: string) => string;
}

export async function evalWithLatex(options: EvalOptions) {
  const { giacExpr, operation, errorMessage, resultTransform } = options;

  const cached = evaluationCache.get(giacExpr);
  if (cached) {
    return formatToolResponse({
      result: cached.result,
      latex: cached.latex,
      giacCommand: giacExpr,
    });
  }

  let result = await giacEngine.evaluate(giacExpr);
  if (!result || result === 'undef') {
    return formatErrorResponse(errorMessage ?? `Could not compute ${operation}`);
  }

  // Cleanup, in order: caller transform (solve list→set) → generic order_size strip.
  if (resultTransform) result = resultTransform(result);
  result = stripOrderTerm(result);

  let latex: string | undefined;
  try {
    const rawLatex = await giacEngine.evaluate(`latex(${result})`);
    if (rawLatex && rawLatex !== 'undef' && !rawLatex.startsWith('latex')) {
      latex = stripQuotes(rawLatex)
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
}
