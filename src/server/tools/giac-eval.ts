import { giacEngine } from '../giac/index.js';
import { formatToolResponse, formatErrorResponse } from './response-formatter.js';
import { evaluationCache, isCacheable } from '../giac/cache.js';
import {
  stripQuotes,
  stripDisplayMode,
  stripOrderTerm,
  nestingDepth,
  seriesRemainderOrders,
} from './output-cleanup.js';
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

/** Deepest nesting handed back to the engine; see the note in toLatex. */
export const MAX_ENGINE_DEPTH = 100;

/**
 * The longest printed engine output handed back to the engine as input.
 *
 * Giac's parser traps on a long input ("RuntimeError: memory access out of
 * bounds"), which recycles the worker every call shares, and where depends on
 * the shape. Measured by bisection through `simplify((E)-(0))`: a digit string
 * parses at 9,314 characters and traps at 9,752, a product of binomials at
 * 12,820 and 13,250, a sum of rational multiples of powers at 27,698 and
 * 28,132. A series or derivative the engine printed runs far past all three —
 * `diff(exp(sin(x)), x, 100)` is 159,096 characters — so anything read back
 * is bounded first, below the smallest of them. Nesting depth is bounded with
 * it (MAX_ENGINE_DEPTH). `latex(...)` is one such read-back, measured on its
 * own in toLatex, and sits under the same bound.
 */
export const MAX_READBACK_LENGTH = 6_000;

/** Whether printed engine output is short and shallow enough to hand back to the engine. */
export function readableBack(printed: string): boolean {
  return printed.length <= MAX_READBACK_LENGTH && nestingDepth(printed) <= MAX_ENGINE_DEPTH;
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
  if (!readableBack(result)) return undefined;
  try {
    const raw = await giacEngine.evaluate(`latex(${result})`);
    if (!raw || raw === 'undef' || raw.startsWith('latex')) return undefined;
    return stripDisplayMode(stripQuotes(raw));
  } catch {
    return undefined;
  }
}

/**
 * The formatted response, plus the two structured values behind it.
 *
 * A caller that must ACT on the verdict — refuse a disproved answer, say —
 * needs the value, not the rendering. Returning only the formatted content made
 * `calculus.ts` scrape its own output for a `Verified: ✗` glyph, which coupled a
 * correctness guard to a display character.
 */
export interface EvaluatedResponse {
  content: { type: 'text'; text: string }[];
  isError: boolean;
  verification?: VerificationResult;
  result: string;
  /**
   * The order of each series remainder the engine printed, read before
   * stripOrderTerm cut it off — present only when it printed one. The cut
   * keeps the answer readable and loses the one fact that says whether the
   * expansion reached the order asked for (see seriesRemainderOrders).
   */
  seriesRemainderOrders?: number[];
}

export async function evalWithLatex(options: EvalOptions): Promise<EvaluatedResponse> {
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
  let remainderOrders: number[] | undefined;

  const cached = cacheable ? evaluationCache.get(cacheKey) : undefined;
  if (cached) {
    result = cached.result;
    latex = cached.latex;
    verification = cached.verification;
    remainderOrders = cached.seriesRemainderOrders;
  } else {
    let raw = await giacEngine.evaluate(giacExpr);
    if (!raw || raw === 'undef') {
      // Carries `result` too, so the error path satisfies the same contract the
      // success path does and a consumer never has to check which it got.
      return {
        ...formatErrorResponse(errorMessage ?? `Could not compute ${operation}`),
        result: '',
      };
    }

    // Strip the series big-O remainder BEFORE computing latex — the cleaned
    // polynomial re-parses in Giac and yields clean latex.
    const orders = seriesRemainderOrders(raw);
    if (orders.length > 0) remainderOrders = orders;
    raw = stripOrderTerm(raw);

    latex = await toLatex(raw);

    // Apply the caller transform AFTER latex — e.g. solve's list→set yields set
    // notation ({-2, 2}) that Giac's latex() cannot re-parse, so latex must be
    // derived from the raw (pre-transform) result.
    result = resultTransform ? resultTransform(raw) : raw;

    if (verify) verification = await verify(result);

    if (cacheable) {
      evaluationCache.set(cacheKey, {
        result,
        latex,
        verification,
        ...(remainderOrders ? { seriesRemainderOrders: remainderOrders } : {}),
      });
    }
  }

  // The structured values ride along beside the formatted content. Without them
  // a caller that needs to ACT on the verdict has to scrape the rendered text —
  // `calculus.ts` was testing for the `Verified: ✗` glyph to decide whether to
  // refuse a disproved answer, which couples a correctness guard to a display
  // character: rename the label or reorder the formatter and the guard silently
  // stops firing, shipping the wrong answer it exists to block, with no test
  // failing because the scrape still returns false.
  return Object.assign(
    formatToolResponse({
      result,
      latex,
      giacCommand: giacExpr,
      verification,
      methodNote,
      ...(notes ? { notes } : {}),
    }),
    { verification, result, ...(remainderOrders ? { seriesRemainderOrders: remainderOrders } : {}) }
  );
}
