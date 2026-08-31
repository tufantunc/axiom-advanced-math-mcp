import { giacEngine } from '../giac/index.js';
import { toLatex } from './giac-eval.js';

export interface ExactResult {
  exact: string;
  decimal: number;
  latex?: string;
}

export async function tryExactResult(
  originalExpression: string,
  numericResult: number
): Promise<ExactResult | null> {
  if (!Number.isFinite(numericResult)) return null;

  const rounded = Math.round(numericResult);
  if (Math.abs(numericResult - rounded) < 1e-9) {
    return { exact: String(rounded), decimal: numericResult };
  }

  const frac = floatToFraction(numericResult);
  if (frac) {
    const [num, den] = frac;
    const absNum = Math.abs(num);
    const sign = num < 0 ? '-' : '';
    return {
      exact: `${num}/${den}`,
      decimal: numericResult,
      latex: den === 1 ? String(num) : `${sign}\\frac{${absNum}}{${den}}`,
    };
  }

  if (looksLikeGiacExpression(originalExpression)) {
    try {
      let giacExpr = originalExpression;
      if (giacExpr.includes('°')) {
        // `\d+(?:\.\d*)?` rather than `\d+\.?\d*`: the latter can split a run of
        // digits many ways, so a long number with no degree sign after it
        // backtracks through all of them. Same strings, one way to match them.
        giacExpr = giacExpr.replaceAll(/(\d+(?:\.\d*)?)\s*°/g, '($1*pi/180)');
      }
      const giacResult = await giacEngine.evaluate(giacExpr);
      if (
        giacResult &&
        giacResult !== 'undef' &&
        !giacResult.startsWith('Error') &&
        giacResult !== String(numericResult) &&
        giacResult !== numericResult.toFixed(15)
      ) {
        const latex = await toLatex(giacResult);

        return {
          exact: giacResult,
          decimal: numericResult,
          latex,
        };
      }
    } catch {
      /* Giac failed, continue */
    }
  }

  return null;
}

function looksLikeGiacExpression(expr: string): boolean {
  const c = expr.trim();
  if (/\b(combinations|permutations|factorial|unit|to\s+\w+)\b/i.test(c)) return false;
  if (/^\d+\s*(km\/h|inch|cm|lb|kg|m\/s|mile|foot|feet)\b/i.test(c)) return false;
  return true;
}

function floatToFraction(x: number, maxDenom = 10000): [number, number] | null {
  if (x === 0 || !Number.isFinite(x)) return null;

  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);

  let p0 = 0,
    q0 = 1;
  let p1 = 1,
    q1 = 0;
  let n = ax;

  for (let i = 0; i < 30; i++) {
    const a = Math.floor(n);
    const p2 = a * p1 + p0;
    const q2 = a * q1 + q0;

    if (q2 > maxDenom) {
      if (q1 > 0 && q1 <= maxDenom && Math.abs(ax - p1 / q1) < 1e-9) {
        const g = gcd(p1, q1);
        return [(sign * p1) / g, q1 / g];
      }
      return null;
    }

    if (Math.abs(ax - p2 / q2) < 1e-9) {
      const g = gcd(p2, q2);
      return [(sign * p2) / g, q2 / g];
    }

    p0 = p1;
    p1 = p2;
    q0 = q1;
    q1 = q2;

    const frac = n - a;
    if (frac < 1e-15) break;
    n = 1 / frac;
  }

  return null;
}

function gcd(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) {
    [a, b] = [b, a % b];
  }
  return a;
}
