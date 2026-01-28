import { create } from 'mathjs';
import type { z } from 'zod';

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
  private math: any;

  constructor() {
    this.math = create({
      number: 'BigNumber',
    });
  }

  evaluate(options: QuickCalcOptions): QuickCalcResult {
    const { expression, units, precision, format } = options;

    try {
      const result = this.math.evaluate(expression, {
        precision: precision || 10,
      });

      const output: QuickCalcResult = {
        result: typeof result === 'number' ? result : result.toString(),
      };

      if (format === 'latex' || format === 'json') {
        output.latex = result.toTex();
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
