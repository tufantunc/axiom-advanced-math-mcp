import { formatToolResponse, formatErrorResponse, NON_FINITE_NOTE } from './response-formatter.js';
import { tryExactResult } from './exact-arithmetic.js';
import { QuickCalcService } from './quick-calc-service.js';

export async function exactValueHandler(args: Record<string, unknown>) {
  try {
    const op = args.operation as string;
    const value = args.value as string;

    switch (op) {
      case 'to_exact': {
        const n = Number.parseFloat(value);
        if (Number.isNaN(n)) return formatErrorResponse(`"${value}" is not a valid number`);
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
        // Forwarded only when the caller asked: `precision` now actually formats
        // the result, so defaulting it to 10 would truncate every existing
        // to_decimal answer (1/3 would become 0.3333333333).
        const precision = args.precision as number | undefined;
        const service = new QuickCalcService();
        const result = await service.evaluate({
          expression: value,
          ...(precision !== undefined ? { precision } : {}),
        });
        // From the worker. Re-deriving it with parseFloat(String(...)) dropped
        // units: `to_decimal("1/2 m")` answered "0.5".
        return formatToolResponse({
          // With `precision` the worker's rendering IS the requested answer,
          // shown verbatim; without it the full double, exactly as before.
          result:
            precision !== undefined
              ? result.formatted
              : result.numeric !== null
                ? String(result.numeric)
                : String(result.result),
          // Same evaluator as quick_calc, so the same caveat: `to_decimal(1e308*10)`
          // reported a bare "Infinity" for a quantity whose true value is finite.
          notes: result.nonFinite
            ? [`Expression: ${value}`, NON_FINITE_NOTE]
            : [`Expression: ${value}`],
        });
      }

      case 'simplify_fraction': {
        const fracMatch = /^(-?\d+)\s*\/\s*(-?\d+)$/.exec(value);
        if (!fracMatch)
          return formatErrorResponse(`"${value}" is not a valid fraction (expected "a/b")`);
        let num = Number.parseInt(fracMatch[1]);
        let den = Number.parseInt(fracMatch[2]);
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
