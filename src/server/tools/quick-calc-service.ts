import { runJsCompute } from '../js-compute/index.js';

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
}

/**
 * Arithmetic evaluation, bounded outside the server process.
 *
 * The mathjs instance, its hardening and the evaluation itself now live in
 * `js-compute/mathjs-tasks.ts`, which runs in a forked child under a wall-clock
 * timeout, a heap cap and a response-size limit. It ran here, synchronously, on
 * the main thread — where an unbounded expression cannot be interrupted:
 * `1:20000000` is eleven characters and blocked the event loop for 20s while
 * building a 532MB response.
 *
 * A guard on the construct would not have been enough. `zeros(3000,3000)` costs
 * 3.7s and `ones(2000,2000)*ones(2000,2000)` 21s with no range syntax in sight,
 * so the three bounds are on time, memory and response size — none of them named
 * after a mathjs feature.
 *
 * The class shape is kept because two handlers construct one per call; it holds
 * no state now, and the worker behind it is a lazily-forked process singleton.
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
      raw = await runJsCompute('mathjs_evaluate', {
        expression,
        precision: precision ?? 10,
        latex: format === 'latex' || format === 'json',
      });
    } catch (error) {
      throw new Error(
        `Math evaluation error: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    const parsed = JSON.parse(raw) as { value: string; isNumber: boolean; latex?: string };
    const output: QuickCalcResult = {
      result: parsed.isNumber ? Number(parsed.value) : parsed.value,
    };
    if (parsed.latex !== undefined) output.latex = parsed.latex;
    return output;
  }
}
