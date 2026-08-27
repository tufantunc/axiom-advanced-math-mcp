import { formatToolResponse, formatErrorResponse } from './response-formatter.js';
import { tryExactResult } from './exact-arithmetic.js';
import { QuickCalcService } from './quick-calc-service.js';

export async function exactValueHandler(args: Record<string, unknown>) {
  try {
    const op = args.operation as string;
    const value = args.value as string;

    switch (op) {
      case 'to_exact': {
        const n = parseFloat(value);
        if (isNaN(n)) return formatErrorResponse(`"${value}" is not a valid number`);
        const exact = await tryExactResult(value, n);
        if (exact) {
          return formatToolResponse({
            result: exact.exact,
            decimal: String(n),
            latex: exact.latex,
          });
        }
        return formatToolResponse({
          result: value,
          notes: ['No simpler exact form found — the value may be irrational or transcendental'],
        });
      }

      case 'to_decimal': {
        const precision = (args.precision as number) ?? 10;
        const service = new QuickCalcService();
        const result = await service.evaluate({ expression: value, precision });
        const numeric =
          typeof result.result === 'number' ? result.result : parseFloat(String(result.result));
        return formatToolResponse({
          result: isNaN(numeric) ? String(result.result) : String(numeric),
          notes: [`Expression: ${value}`],
        });
      }

      case 'simplify_fraction': {
        const fracMatch = value.match(/^(-?\d+)\s*\/\s*(-?\d+)$/);
        if (!fracMatch)
          return formatErrorResponse(`"${value}" is not a valid fraction (expected "a/b")`);
        let num = parseInt(fracMatch[1]);
        let den = parseInt(fracMatch[2]);
        if (den === 0) return formatErrorResponse('Denominator cannot be zero');
        const sign = num < 0 !== den < 0 ? -1 : 1;
        num = Math.abs(num);
        den = Math.abs(den);
        const g = gcd(num, den);
        num = sign * (num / g);
        den = den / g;
        if (den === 1) {
          return formatToolResponse({
            result: String(num),
            notes: [`Simplified: ${fracMatch[1]}/${fracMatch[2]} = ${num}`],
          });
        }
        return formatToolResponse({
          result: `${num}/${den}`,
          latex: `${num < 0 ? '-' : ''}\\frac{${Math.abs(num)}}{${den}}`,
          notes: [`GCD = ${g}`, `Simplified: ${fracMatch[1]}/${fracMatch[2]} = ${num}/${den}`],
        });
      }

      default:
        return formatErrorResponse(`Unknown operation: ${op}`);
    }
  } catch (error) {
    return formatErrorResponse(error instanceof Error ? error.message : String(error));
  }
}

function gcd(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) {
    [a, b] = [b, a % b];
  }
  return a;
}
