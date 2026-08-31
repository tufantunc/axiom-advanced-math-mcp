import { create, all, MathJsInstance } from 'mathjs';

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
  units?: 'none' | 'auto' | 'si' | 'us';
  precision?: number;
  format?: 'text' | 'latex' | 'json';
}

export interface QuickCalcResult {
  result: number | string;
  latex?: string;
  units?: string;
  steps?: string[];
}

export class QuickCalcService {
  private readonly math: MathJsInstance;

  constructor() {
    this.math = create(all, {});
    // mathjs has no ln(); models write it constantly. Alias to natural log.
    this.math.import({ ln: (x: number) => Math.log(x) });
    // Expressions handed to evaluate() below come straight from the model /
    // caller, i.e. untrusted input. `import` and `createUnit` are reachable
    // from the expression parser (e.g. `import({foo:...})` inside a string)
    // and can be used to redefine trusted built-ins or fabricate fake units,
    // so mathjs's own security guidance is to disable them on any instance
    // that evaluates third-party expressions:
    // https://mathjs.org/docs/expressions/security.html
    this.math.import(
      {
        import: function () {
          throw new Error('Function import is disabled');
        },
        createUnit: function () {
          throw new Error('Function createUnit is disabled');
        },
      },
      { override: true }
    );
  }

  evaluate(options: QuickCalcOptions): QuickCalcResult {
    const { expression, precision, format } = options;

    if (detectNaturalLanguage(expression)) {
      throw new Error(
        "Expression appears to contain natural language. quick_calc only accepts mathematical expressions (e.g., '3*x + 2', 'sin(pi/4)'). For symbolic reasoning use solve_equation or advanced_solve."
      );
    }

    try {
      const result = this.math.evaluate(expression, {
        precision: precision || 10,
      });

      const output: QuickCalcResult = {
        result: typeof result === 'number' ? result : result.toString(),
      };

      if (format === 'latex' || format === 'json') {
        output.latex = this.math.parse(expression).toTex();
      }

      return output;
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Math evaluation error: ${error.message}`);
      }
      throw new Error(`Math evaluation error: ${String(error)}`);
    }
  }
}
