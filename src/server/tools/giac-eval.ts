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

  // Transformed results are cached under a separate key so a transformed call
  // and a raw call for the same giacExpr never return each other's result.
  // Assumes at most one transform variant per giacExpr (production uses only
  // listToSet, applied solely to solve expressions).
  const cacheKey = resultTransform ? `${giacExpr} transformed` : giacExpr;
  const cached = evaluationCache.get(cacheKey);
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

  // Strip the series big-O remainder BEFORE computing latex — the cleaned
  // polynomial re-parses in Giac and yields clean latex.
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

  // Apply the caller transform AFTER latex — e.g. solve's list→set yields set
  // notation ({-2, 2}) that Giac's latex() cannot re-parse, so latex must be
  // derived from the raw (pre-transform) result.
  if (resultTransform) result = resultTransform(result);

  evaluationCache.set(cacheKey, { result, latex });

  return formatToolResponse({
    result,
    latex,
    giacCommand: giacExpr,
  });
}
