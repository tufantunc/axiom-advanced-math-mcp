import { giacEngine } from '../giac/index.js';
import { formatToolResponse, formatErrorResponse } from './response-formatter.js';
import { evaluationCache, isCacheable } from '../giac/cache.js';
import { stripQuotes, stripDisplayMode, stripOrderTerm } from './output-cleanup.js';
import type { VerificationResult } from './self-verify.js';
import { unicodeToAscii } from './unicode-normalize.js';

export interface EvalOptions {
  giacExpr: string;
  operation: string;
  errorMessage?: string;
  /** Optional caller-supplied cleanup applied to the raw result (e.g. solve's list→set). */
  resultTransform?: (raw: string) => string;
  /**
   * Optional round-trip verification run on the (final) result. Never throws.
   * Returns undefined to skip (no Verified line). The first result for a given
   * giacExpr is cached and reused — callers must use a consistent verify
   * strategy per expression.
   */
  verify?: (result: string) => Promise<VerificationResult | undefined>;
  /** Optional note about which method produced the result (e.g. escalation). */
  methodNote?: string;
}

/**
 * Best-effort LaTeX rendering of a Giac result; undefined when Giac cannot
 * render it.
 *
 * The whole pipeline lives here, not just the string cleanup: `latex(X)`, the
 * falsy/`undef`/echoed-`latex` rejection, quote stripping, display-mode
 * stripping, and swallowing the throw. It was open-coded in three places and
 * one copy had drifted — it omitted `stripQuotes`, so that path emitted LaTeX
 * wrapped in literal double quotes.
 */
export async function toLatex(result: string): Promise<string | undefined> {
  try {
    const raw = await giacEngine.evaluate(`latex(${result})`);
    if (!raw || raw === 'undef' || raw.startsWith('latex')) return undefined;
    return stripDisplayMode(stripQuotes(raw));
  } catch {
    return undefined;
  }
}

export async function evalWithLatex(options: EvalOptions) {
  const { operation, errorMessage, resultTransform, verify, methodNote } = options;
  // Normalize unicode math glyphs in the input before anything else (cacheKey,
  // evaluation, latex) so e.g. factor(x²-4) is not parsed as factor(xmicro-4).
  const giacExpr = unicodeToAscii(options.giacExpr);

  // Transformed results are cached under a separate key so a transformed call
  // and a raw call for the same giacExpr never return each other's result.
  // Assumes at most one transform variant per giacExpr (production uses only
  // listToSet, applied solely to solve expressions).
  const cacheKey = resultTransform ? `${giacExpr} transformed` : giacExpr;

  // An expression that mutates CAS state bypasses the cache in both
  // directions: its result is only valid under that mutation, and the key
  // does not capture the mutation the *reader* would need to have made.
  const cacheable = isCacheable(giacExpr);

  let result: string;
  let latex: string | undefined;
  let verification: VerificationResult | undefined;

  const cached = cacheable ? evaluationCache.get(cacheKey) : undefined;
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

    latex = await toLatex(raw);

    // Apply the caller transform AFTER latex — e.g. solve's list→set yields set
    // notation ({-2, 2}) that Giac's latex() cannot re-parse, so latex must be
    // derived from the raw (pre-transform) result.
    result = resultTransform ? resultTransform(raw) : raw;

    if (verify) verification = await verify(result);

    if (cacheable) evaluationCache.set(cacheKey, { result, latex, verification });
  }

  return formatToolResponse({
    result,
    latex,
    giacCommand: giacExpr,
    verification,
    methodNote,
  });
}
