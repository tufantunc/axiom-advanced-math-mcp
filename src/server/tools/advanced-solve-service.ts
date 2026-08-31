import { giacEngine } from '../giac/index.js';
import { toLatex } from './giac-eval.js';

export interface AdvancedSolveOptions {
  expression: string;
  format?: 'text' | 'latex' | 'json';
  steps?: boolean;
  simplify?: boolean;
}

export interface AdvancedSolveResult {
  result: string;
  latex?: string;
  steps?: string[];
  variables?: string[];
  domain?: string;
}

export class AdvancedSolveService {
  async evaluate(options: AdvancedSolveOptions): Promise<AdvancedSolveResult> {
    const { expression, format, steps, simplify } = options;

    try {
      let giacExpression = expression;

      if (simplify !== false) {
        giacExpression = `simplify(${expression})`;
      }

      const result = await giacEngine.evaluate(giacExpression);

      const output: AdvancedSolveResult = {
        result,
      };

      // LaTeX output, through the shared renderer. Open-coded here it was a
      // fourth copy of a pipeline `toLatex`'s docblock claims was consolidated:
      // it skipped the `undef`/echoed-`latex` rejection and the quote stripping,
      // and — the reason it matters — it had neither of the size bounds, so a
      // deep or oversized result handed straight to `latex(...)` traps the engine
      // and takes the shared worker down with whatever else is in flight.
      if (format === 'latex' || format === 'json') {
        const latex = await toLatex(result);
        if (latex !== undefined) output.latex = latex;
      }

      // Steps: show original expression and simplified result
      if (steps) {
        output.steps = [];
        output.steps.push(`Input: ${expression}`);
        if (simplify !== false && giacExpression !== expression) {
          const rawResult = await giacEngine.evaluate(expression);
          output.steps.push(`Raw result: ${rawResult}`);
          output.steps.push(`Simplified: ${result}`);
        } else {
          output.steps.push(`Result: ${result}`);
        }
      }

      // Extract variables using lname()
      try {
        const vars = await giacEngine.evaluate(`lname(${expression})`);
        if (vars && vars !== '[]' && vars !== 'undef') {
          // Parse Giac list output: [x,y,z] -> ['x', 'y', 'z']
          const cleaned = vars.replace(/[[\]]/g, '').trim();
          if (cleaned) {
            output.variables = cleaned.split(',').map((v) => v.trim());
          }
        }
      } catch {
        // Variable extraction is best-effort
      }

      return output;
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Giac evaluation error: ${error.message}`);
      }
      throw new Error(`Giac evaluation error: ${String(error)}`);
    }
  }
}
