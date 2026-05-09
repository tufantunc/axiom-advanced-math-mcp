import { z } from 'zod';
import { giacEngine } from '../giac/index.js';

export const numberPropertiesSchema = z.object({
  number: z
    .number()
    .int()
    .describe('The integer to analyze (e.g., 28, 100, 997)'),
});

/**
 * Parse Giac ifactor output like "2^2*7" into prime factor pairs [[2,2],[7,1]].
 */
function parseIfactor(ifactorResult: string): [number, number][] {
  const cleaned = ifactorResult.trim().replace(/[()]/g, '');
  if (!cleaned || cleaned === '1') return [];

  const factors: [number, number][] = [];
  const parts = cleaned.split('*');

  for (const part of parts) {
    if (part.includes('^')) {
      const [base, exp] = part.split('^');
      factors.push([parseInt(base.trim()), parseInt(exp.trim())]);
    } else {
      const n = parseInt(part.trim());
      if (!isNaN(n) && n > 1) factors.push([n, 1]);
    }
  }

  return factors;
}

/**
 * Compute divisor count from prime factorization: product of (e_i + 1).
 */
function divisorCount(factors: [number, number][]): number {
  if (factors.length === 0) return 1; // for n=1
  return factors.reduce((acc, [, exp]) => acc * (exp + 1), 1);
}

/**
 * Compute divisor sum from prime factorization: product of (p^(e+1) - 1) / (p - 1).
 */
function divisorSum(factors: [number, number][]): number {
  if (factors.length === 0) return 1; // for n=1
  return factors.reduce((acc, [p, e]) => {
    if (p === 1) return acc;
    return acc * (Math.pow(p, e + 1) - 1) / (p - 1);
  }, 1);
}

/**
 * List all divisors from prime factorization (sorted).
 */
function listDivisors(factors: [number, number][]): number[] {
  let divisors = [1];
  for (const [p, e] of factors) {
    const newDivisors: number[] = [];
    for (const d of divisors) {
      let pe = 1;
      for (let i = 0; i <= e; i++) {
        newDivisors.push(d * pe);
        pe *= p;
      }
    }
    divisors = newDivisors;
  }
  return divisors.sort((a, b) => a - b);
}

function isPerfectSquare(n: number): boolean {
  if (n < 0) return false;
  const s = Math.round(Math.sqrt(n));
  return s * s === n;
}

function isPerfectCube(n: number): boolean {
  const c = Math.round(Math.cbrt(n));
  return c * c * c === n;
}

function isTriangular(n: number): boolean {
  // n is triangular if 8n+1 is a perfect square
  return n >= 0 && isPerfectSquare(8 * n + 1);
}

function triangularIndex(n: number): number {
  // T_k = k(k+1)/2 → k = (-1 + sqrt(1+8n)) / 2
  return Math.round((-1 + Math.sqrt(1 + 8 * n)) / 2);
}

function isFibonacci(n: number): boolean {
  // n is Fibonacci if 5n²+4 or 5n²-4 is a perfect square
  return isPerfectSquare(5 * n * n + 4) || isPerfectSquare(5 * n * n - 4);
}

export async function numberPropertiesHandler(
  args: Record<string, unknown>,
) {
  const n = args.number as number;

  try {
    const lines: string[] = [`Number: ${n}`];
    const absN = Math.abs(n);

    // Prime check via Giac
    let isPrime = false;
    try {
      const primeResult = await giacEngine.evaluate(`isprime(${absN})`);
      isPrime = primeResult.trim() === '1' || primeResult.trim().toLowerCase() === 'true';
    } catch {
      // fallback: simple trial division for small numbers
      if (absN > 1) {
        isPrime = true;
        for (let i = 2; i * i <= absN; i++) {
          if (absN % i === 0) { isPrime = false; break; }
        }
      }
    }
    lines.push(`Prime: ${isPrime ? 'Yes' : 'No'}`);

    // Prime factorization via Giac
    let factors: [number, number][] = [];
    if (absN > 1) {
      try {
        const ifactorResult = await giacEngine.evaluate(`ifactor(${absN})`);
        factors = parseIfactor(ifactorResult);
        const factorStr = factors.map(([p, e]) => e > 1 ? `${p}^${e}` : `${p}`).join(' × ');
        lines.push(`Prime factorization: ${factorStr}`);
      } catch {
        lines.push(`Prime factorization: (could not compute)`);
      }
    } else {
      lines.push(`Prime factorization: ${absN}`);
    }

    // Divisors
    if (absN >= 1) {
      const divs = factors.length > 0 ? listDivisors(factors) : [1];
      const count = divisorCount(factors.length > 0 ? factors : []);
      const sum = divisorSum(factors.length > 0 ? factors : []);
      lines.push(`Divisor count: ${count}`);
      if (count <= 30) {
        lines.push(`Divisors: ${divs.join(', ')}`);
      }
      lines.push(`Divisor sum: ${sum}`);

      // Perfect number
      if (absN > 1) {
        const properSum = sum - absN;
        lines.push(`Perfect number: ${properSum === absN ? 'Yes' : 'No'}`);
      }
    }

    // Euler's totient via Giac
    if (absN > 0) {
      try {
        const eulerResult = await giacEngine.evaluate(`euler(${absN})`);
        lines.push(`Euler totient φ(${absN}): ${eulerResult.trim()}`);
      } catch {
        // skip
      }
    }

    // Number type properties
    lines.push(`Perfect square: ${isPerfectSquare(absN) ? `Yes (${Math.round(Math.sqrt(absN))}²)` : 'No'}`);
    lines.push(`Perfect cube: ${isPerfectCube(absN) ? `Yes (${Math.round(Math.cbrt(absN))}³)` : 'No'}`);
    lines.push(`Triangular: ${isTriangular(absN) ? `Yes (T${triangularIndex(absN)})` : 'No'}`);
    lines.push(`Fibonacci: ${isFibonacci(absN) ? 'Yes' : 'No'}`);

    return {
      content: [{ type: 'text' as const, text: lines.join('\n') }],
      isError: false,
    };
  } catch (error) {
    return {
      content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}
