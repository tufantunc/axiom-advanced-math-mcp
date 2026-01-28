import { giacEngine } from '../giac/index.js';
import type { z } from 'zod';

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
        result
      };

      if (format === 'latex' || format === 'json') {
        output.latex = await giacEngine.evaluate(`tex(${result})`);
      }

      return output;
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Giac evaluation error: ${error.message}`);
      }
      throw new Error(`Giac evaluation error: ${String(error)}`);
    }
  }

  parseSteps(giacOutput: string): string[] {
    const steps: string[] = [];
    const lines = giacOutput.split('\n');
    for (const line of lines) {
      if (line.match(/^Step \d+:/)) {
        steps.push(line);
      }
    }
    return steps;
  }

  extractVariables(expression: string): string[] {
    const variables = new Set<string>();
    const matches = expression.match(/[a-zA-Z][a-zA-Z0-9]*/g);
    if (matches) {
      for (const match of matches) {
        const varName = match.replace(/[0-9]*/g, '');
        if (varName.length > 0) {
          variables.add(varName);
        }
      }
    }
    return Array.from(variables);
  }
}
