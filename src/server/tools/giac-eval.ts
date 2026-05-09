import { giacEngine } from '../giac/index.js';
import { formatToolResponse, formatErrorResponse } from './response-formatter.js';
import { evaluationCache } from './symbolic/cache.js';

export interface EvalOptions {
  giacExpr: string;
  operation: string;
  errorMessage?: string;
}

export async function evalWithLatex(options: EvalOptions) {
  const { giacExpr, operation, errorMessage } = options;

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
    return formatErrorResponse(errorMessage ?? `Could not compute ${operation}`);
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
}
