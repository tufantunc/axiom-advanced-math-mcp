import { giacEngine } from '../giac/index.js';
import { formatToolResponse, formatErrorResponse } from './response-formatter.js';
import { evaluationCache } from './symbolic/cache.js';
import { stripQuotes, stripOrderTerm } from './output-cleanup.js';
import type { VerificationResult } from './self-verify.js';

export interface EvalOptions {
  giacExpr: string;
  operation: string;
  errorMessage?: string;
  /** Optional caller-supplied cleanup applied to the raw result (e.g. solve's list→set). */
  resultTransform?: (raw: string) => string;
  /** Optional round-trip verification run on the (final) result. Never throws. */
  verify?: (result: string) => Promise<VerificationResult>;
  /** Optional note about which method produced the result (e.g. escalation). */
  methodNote?: string;
}

export async function evalWithLatex(options: EvalOptions) {
  const { giacExpr, operation, errorMessage, resultTransform, verify, methodNote } = options;

  // Transformed results are cached under a separate key so a transformed call
  // and a raw call for the same giacExpr never return each other's result.
  // Assumes at most one transform variant per giacExpr (production uses only
  // listToSet, applied solely to solve expressions).
  const cacheKey = resultTransform ? `${giacExpr} transformed` : giacExpr;

  let result: string;
  let latex: string | undefined;
  let verification: VerificationResult | undefined;

  const cached = evaluationCache.get(cacheKey);
  if (cached) {
    result = cached.result;
    latex = cached.latex;
    verification = cached.verification;
  } else {
    let raw = await giacEngine.evaluate(giacExpr);
    if (!raw || raw === 'undef') {
      return formatErrorResponse(errorMessage ?? `Could not compute ${operation}`);
    }

    // Strip the series big-O remainder BEFORE computing latex — the cleaned
    // polynomial re-parses in Giac and yields clean latex.
    raw = stripOrderTerm(raw);

    try {
      const rawLatex = await giacEngine.evaluate(`latex(${raw})`);
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
    result = resultTransform ? resultTransform(raw) : raw;

    if (verify) verification = await verify(result);

    evaluationCache.set(cacheKey, { result, latex, verification });
  }

  return formatToolResponse({
    result,
    latex,
    giacCommand: giacExpr,
    verification,
    methodNote,
  });
}
