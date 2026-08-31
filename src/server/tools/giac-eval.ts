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
  /** Extra lines placed before the summary, e.g. which component is which function. */
  notes?: string[];
  /** Optional note about which method produced the result (e.g. escalation). */
  methodNote?: string;
}

/** Deepest nesting handed back to `latex(...)`; see the note in toLatex. */
export const MAX_ENGINE_DEPTH = 100;
const MAX_LATEX_DEPTH = MAX_ENGINE_DEPTH;

/**
 * Deepest parenthesis nesting in a printed result, call or grouping alike.
 *
 * Parentheses only. Counting `[` and `{` as well seemed the cautious reading —
 * how deep the tree goes, whichever delimiter spelt it — but it refuses LaTeX
 * that renders perfectly well: a list nested 200 deep is 401 characters and
 * `latex()` answers it with the worker untouched, where a 140-deep run of
 * `sqrt(1+...)` kills it. The hazard is nested function application; grouping
 * parentheses are counted too, which only makes this more conservative.
 */
export function nestingDepth(text: string): number {
  let depth = 0;
  let deepest = 0;
  for (const ch of text) {
    if (ch === '(') deepest = Math.max(deepest, ++depth);
    else if (ch === ')') depth -= 1;
  }
  return deepest;
}

/** Largest result handed back to `latex(...)`; see the note in toLatex. */
const MAX_LATEX_INPUT = 6_000;

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
  // The result goes back INTO the engine, so its size is an input size, and this
  // is the one bound here that every operation passes through rather than just
  // the ODE path that motivated it.
  //
  // Measured on two shapes, because they trap at very different sizes: a digit
  // string (`latex(<n digits>+x)`) renders at 9,002 characters and fatally traps
  // at 10,002, while an expanded polynomial renders at 9,855 and traps somewhere
  // under 100,585. A trap recycles the worker and fails whatever else was
  // pending, and the `catch` below turns it into a quiet `undefined` — so the
  // caller who triggered it still sees a successful-looking answer while a
  // stranger's call dies. A 55-character ODE system with an initial condition at
  // 10^10000 produced an 80,000-character result and did exactly that.
  //
  // 6,000 sits below the smallest measured trap ON THE LENGTH AXIS. It was 4,000
  // first, chosen against the digit measurement alone, and that silently cost
  // LaTeX for ordinary work this path also serves — `expand((x+1)^140)` is 5,041
  // characters and main rendered it. Above this a reader gets the plain result
  // and no LaTeX, which is a real if small loss, and the alternative is a dead
  // worker.
  //
  // Length is not the only axis, and treating it as one made this worse before it
  // made it better: `latex()` also traps on NESTING DEPTH, at about a fifth of the
  // length cap. A depth-132 argument renders at 1,057 characters and a depth-140
  // one traps at 1,121, so raising the length cap opened a band that a
  // 5,605-character depth-140 result walks straight through — declined at 4,000
  // with the worker alive, sent at 6,000 with the worker dead. Deeper still and
  // Giac's own parser refuses gracefully ("Too many embeddings"), so the fatal
  // band is narrow and a conservative depth bound costs nothing: 100 rendered
  // cleanly in every probe.
  if (result.length > MAX_LATEX_INPUT || nestingDepth(result) > MAX_LATEX_DEPTH) {
    return undefined;
  }
  try {
    const raw = await giacEngine.evaluate(`latex(${result})`);
    if (!raw || raw === 'undef' || raw.startsWith('latex')) return undefined;
    return stripDisplayMode(stripQuotes(raw));
  } catch {
    return undefined;
  }
}

export async function evalWithLatex(options: EvalOptions) {
  const { operation, errorMessage, resultTransform, verify, methodNote, notes } = options;
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
    ...(notes ? { notes } : {}),
  });
}
