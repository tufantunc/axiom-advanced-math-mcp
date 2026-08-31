import { runJsCompute, type EvaluatedExpression } from '../js-compute/index.js';

// Words that unambiguously indicate natural language (not valid math operators/identifiers)
const NATURAL_LANGUAGE_WORDS =
  /\b(let|then|where|since|assume|given|therefore|thus|hence|find|compute|calculate|what|check|verify|prove|suppose|note|observe|recall|we\s+have|such\s+that)\b/i;

export function detectNaturalLanguage(expression: string): boolean {
  const trimmed = expression.trim();
  // Starts with uppercase prose word followed by space (e.g., "Let S = ...", "Given that ...", "If S = ...")
  if (
    /^(Let|Given|Since|Assume|Suppose|If|Then|Check|Find|Compute|Calculate|Note|Recall|Observe|We)\s/.test(
      trimmed
    )
  )
    return true;
  // Contains unambiguous natural language keywords
  if (NATURAL_LANGUAGE_WORDS.test(trimmed)) return true;
  // Very long string with many spaces is likely a prose sentence, not an expression
  if (trimmed.length > 150 && (trimmed.match(/ /g) || []).length > 5) return true;
  return false;
}

export interface QuickCalcOptions {
  expression: string;
  precision?: number;
  format?: 'text' | 'latex' | 'json';
}

export interface QuickCalcResult {
  result: number | string;
  latex?: string;
  /**
   * The result has an infinite component. Determined in the worker, where the
   * value is still a value — a caller cannot recover this from `result`, which
   * is a rendered string for anything that is not a plain number.
   */
  /** The result as a number when it is one, else null. Never re-derive this. */
  numeric: number | null;
  nonFinite: boolean;
}

/**
 * Arithmetic evaluation, bounded outside the server process.
 *
 * The mathjs instance, its hardening and the evaluation itself live in
 * `js-compute/mathjs-tasks.ts`, which runs in a forked child under a wall-clock
 * timeout, a heap cap and a response-size limit. It ran here, synchronously, on
 * the main thread — where an unbounded expression cannot be interrupted:
 * `1:20000000` is eleven characters and blocked the event loop for 18.5s while
 * building a 266-million-character result.
 *
 * The bounds are on time, memory and response size rather than on any mathjs
 * construct, because the reachable surface is whatever `isPureArithmetic`
 * (compute/router.ts) admits — which is open-ended, and covers syntax nobody has
 * thought of yet.
 *
 * The class holds no state: it is a typed stub over the worker.
 */
export class QuickCalcService {
  async evaluate(options: QuickCalcOptions): Promise<QuickCalcResult> {
    const { expression, precision, format } = options;

    // Stays in-process: a bounded regex over an input the schema already caps.
    if (detectNaturalLanguage(expression)) {
      throw new Error(
        "Expression appears to contain natural language. quick_calc only accepts mathematical expressions (e.g., '3*x + 2', 'sin(pi/4)'). For symbolic reasoning use solve_equation or advanced_solve."
      );
    }

    let raw: string;
    try {
      // `precision` is forwarded only when the caller supplied it: applying the
      // documented default of 10 would reformat every existing caller's result
      // (`0.1+0.2` would answer `0.3`).
      raw = await runJsCompute('mathjs_evaluate', {
        expression,
        ...(precision !== undefined ? { precision } : {}),
        latex: format === 'latex' || format === 'json',
      });
    } catch (error) {
      throw new Error(
        `Math evaluation error: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    const parsed = JSON.parse(raw) as EvaluatedExpression;
    const output: QuickCalcResult = {
      result: parsed.isNumber ? Number(parsed.value) : parsed.value,
      // Carried straight through from the worker, where the value was still a
      // value. Required rather than set-only-when-true so a consumer that forgets
      // to check cannot silently read `undefined` as "finite".
      numeric: parsed.numeric,
      nonFinite: parsed.nonFinite,
    };
    if (parsed.latex !== undefined) output.latex = parsed.latex;
    return output;
  }
}
