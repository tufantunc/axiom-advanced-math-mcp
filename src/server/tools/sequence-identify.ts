import { z } from 'zod';
import { giacEngine } from '../giac/index.js';

export const sequenceIdentifySchema = z.object({
  terms: z
    .array(z.number())
    .min(3)
    .max(20)
    .describe('Array of numbers forming a sequence (at least 3 terms, e.g., [1, 4, 9, 16, 25])'),
});

interface SequenceResult {
  pattern: string;
  formula: string;
  nextTerms: number[];
}

/**
 * Check if all first differences are equal (arithmetic sequence).
 */
function checkArithmetic(terms: number[]): SequenceResult | null {
  const diffs: number[] = [];
  for (let i = 1; i < terms.length; i++) diffs.push(terms[i] - terms[i - 1]);
  if (diffs.every(d => d === diffs[0])) {
    const a = terms[0];
    const d = diffs[0];
    const next: number[] = [];
    for (let i = 1; i <= 3; i++) next.push(a + (terms.length - 1 + i) * d);
    return {
      pattern: `Arithmetic sequence (a=${a}, d=${d})`,
      formula: d === 0 ? `a(n) = ${a}` : `a(n) = ${a} + (n-1)×${d}`,
      nextTerms: next,
    };
  }
  return null;
}

/**
 * Check if all ratios are equal (geometric sequence).
 */
function checkGeometric(terms: number[]): SequenceResult | null {
  if (terms.some(t => t === 0)) return null;
  const ratios: number[] = [];
  for (let i = 1; i < terms.length; i++) ratios.push(terms[i] / terms[i - 1]);
  const eps = 1e-9;
  if (ratios.every(r => Math.abs(r - ratios[0]) < eps)) {
    const a = terms[0];
    const r = ratios[0];
    const next: number[] = [];
    let last = terms[terms.length - 1];
    for (let i = 0; i < 3; i++) {
      last *= r;
      next.push(Math.round(last * 1e9) / 1e9);
    }
    return {
      pattern: `Geometric sequence (a=${a}, r=${r})`,
      formula: `a(n) = ${a} × ${r}^(n-1)`,
      nextTerms: next,
    };
  }
  return null;
}

/**
 * Check if second differences are constant (quadratic sequence).
 */
function checkQuadratic(terms: number[]): SequenceResult | null {
  if (terms.length < 3) return null;
  const d1 = [];
  for (let i = 1; i < terms.length; i++) d1.push(terms[i] - terms[i - 1]);
  const d2: number[] = [];
  for (let i = 1; i < d1.length; i++) d2.push(d1[i] - d1[i - 1]);

  const eps = 1e-9;
  if (d2.length > 0 && d2.every(d => Math.abs(d - d2[0]) < eps)) {
    // a(n) = An² + Bn + C, solve from first 3 terms (n=1,2,3)
    const c2 = d2[0] / 2; // coefficient of n²
    const c1 = d1[0] - 3 * c2 + c2; // coefficient of n: d1[0] = a(2)-a(1) = c2(4-1) + c1(2-1) = 3c2 + c1
    // Actually: a(n) = c2*n² + c1*n + c0
    // a(1) = c2 + c1 + c0 = terms[0]
    // d1[0] = a(2) - a(1) = 3c2 + c1
    // d2[0] = 2c2
    const A = d2[0] / 2;
    const B = d1[0] - 3 * A;
    const C = terms[0] - A - B;

    const next: number[] = [];
    for (let i = 1; i <= 3; i++) {
      const n = terms.length + i;
      next.push(A * n * n + B * n + C);
    }

    // Format formula
    const parts: string[] = [];
    if (A !== 0) parts.push(A === 1 ? 'n²' : A === -1 ? '-n²' : `${A}n²`);
    if (B !== 0) parts.push(B > 0 && parts.length > 0 ? `+${B}n` : `${B}n`);
    if (C !== 0) parts.push(C > 0 && parts.length > 0 ? `+${C}` : `${C}`);

    return {
      pattern: 'Quadratic sequence',
      formula: `a(n) = ${parts.join(' ') || '0'}`,
      nextTerms: next,
    };
  }
  return null;
}

/**
 * Check known named sequences by matching against generated values.
 */
function checkKnownSequences(terms: number[]): SequenceResult | null {
  const n = terms.length;

  // Perfect squares: 1, 4, 9, 16, 25, ...
  const squares = Array.from({ length: n + 3 }, (_, i) => (i + 1) * (i + 1));
  if (matchesSubsequence(terms, squares)) {
    return {
      pattern: 'Perfect squares',
      formula: 'a(n) = n²',
      nextTerms: squares.slice(n, n + 3),
    };
  }

  // Perfect cubes: 1, 8, 27, 64, ...
  const cubes = Array.from({ length: n + 3 }, (_, i) => (i + 1) ** 3);
  if (matchesSubsequence(terms, cubes)) {
    return {
      pattern: 'Perfect cubes',
      formula: 'a(n) = n³',
      nextTerms: cubes.slice(n, n + 3),
    };
  }

  // Triangular numbers: 1, 3, 6, 10, 15, ...
  const tri = Array.from({ length: n + 3 }, (_, i) => ((i + 1) * (i + 2)) / 2);
  if (matchesSubsequence(terms, tri)) {
    return {
      pattern: 'Triangular numbers',
      formula: 'a(n) = n(n+1)/2',
      nextTerms: tri.slice(n, n + 3),
    };
  }

  // Powers of 2: 1, 2, 4, 8, 16, ...
  const pow2 = Array.from({ length: n + 3 }, (_, i) => 2 ** i);
  if (matchesSubsequence(terms, pow2)) {
    return {
      pattern: 'Powers of 2',
      formula: 'a(n) = 2^(n-1)',
      nextTerms: pow2.slice(n, n + 3),
    };
  }

  // Factorials: 1, 1, 2, 6, 24, 120, ...
  const facts: number[] = [1];
  for (let i = 1; i < n + 3; i++) facts.push(facts[i - 1] * i);
  if (matchesSubsequence(terms, facts)) {
    return {
      pattern: 'Factorials',
      formula: 'a(n) = n!',
      nextTerms: facts.slice(n, n + 3),
    };
  }
  // Also check 1-indexed factorials: 1, 2, 6, 24, 120, ...
  const facts1 = facts.slice(1);
  if (matchesSubsequence(terms, facts1)) {
    return {
      pattern: 'Factorials (1-indexed)',
      formula: 'a(n) = n!',
      nextTerms: facts1.slice(n, n + 3),
    };
  }

  // Fibonacci: 1, 1, 2, 3, 5, 8, 13, ...
  const fib: number[] = [1, 1];
  for (let i = 2; i < n + 3; i++) fib.push(fib[i - 1] + fib[i - 2]);
  if (matchesSubsequence(terms, fib)) {
    return {
      pattern: 'Fibonacci numbers',
      formula: 'a(n) = a(n-1) + a(n-2)',
      nextTerms: fib.slice(n, n + 3),
    };
  }
  // Also check 0-started Fibonacci: 0, 1, 1, 2, 3, 5, ...
  const fib0 = [0, ...fib];
  if (matchesSubsequence(terms, fib0)) {
    return {
      pattern: 'Fibonacci numbers (0-indexed)',
      formula: 'a(n) = a(n-1) + a(n-2), a(0)=0, a(1)=1',
      nextTerms: fib0.slice(n, n + 3),
    };
  }

  // Primes: 2, 3, 5, 7, 11, 13, ...
  const primes = generatePrimes(n + 3);
  if (matchesSubsequence(terms, primes)) {
    return {
      pattern: 'Prime numbers',
      formula: 'a(n) = nth prime',
      nextTerms: primes.slice(n, n + 3),
    };
  }

  return null;
}

function matchesSubsequence(terms: number[], seq: number[]): boolean {
  if (terms.length > seq.length) return false;
  const eps = 1e-9;
  return terms.every((t, i) => Math.abs(t - seq[i]) < eps);
}

function generatePrimes(count: number): number[] {
  const primes: number[] = [];
  let candidate = 2;
  while (primes.length < count) {
    let isPrime = true;
    for (const p of primes) {
      if (p * p > candidate) break;
      if (candidate % p === 0) { isPrime = false; break; }
    }
    if (isPrime) primes.push(candidate);
    candidate++;
  }
  return primes;
}

export async function sequenceIdentifyHandler(
  args: Record<string, unknown>,
) {
  const terms = args.terms as number[];

  try {
    const lines: string[] = [`Sequence: ${terms.join(', ')}`];

    // Check constant
    if (terms.every(t => t === terms[0])) {
      lines.push(`Pattern: Constant sequence`);
      lines.push(`Formula: a(n) = ${terms[0]}`);
      lines.push(`Next 3 terms: ${terms[0]}, ${terms[0]}, ${terms[0]}`);
      return { content: [{ type: 'text' as const, text: lines.join('\n') }], isError: false };
    }

    // Try each recognizer
    const recognizers = [
      () => checkArithmetic(terms),
      () => checkGeometric(terms),
      () => checkKnownSequences(terms),
      () => checkQuadratic(terms),
    ];

    for (const recognize of recognizers) {
      const result = recognize();
      if (result) {
        lines.push(`Pattern: ${result.pattern}`);
        lines.push(`Formula: ${result.formula}`);
        lines.push(`Next 3 terms: ${result.nextTerms.join(', ')}`);
        return { content: [{ type: 'text' as const, text: lines.join('\n') }], isError: false };
      }
    }

    // Fallback: Giac polynomial interpolation
    try {
      const xValues = terms.map((_, i) => i + 1).join(',');
      const yValues = terms.join(',');
      const giacExpr = `interp([${xValues}],[${yValues}],x)`;
      const polyResult = await giacEngine.evaluate(giacExpr);

      if (polyResult && polyResult !== 'undef') {
        lines.push(`Pattern: Polynomial interpolation`);
        lines.push(`Formula: a(n) = ${polyResult}`);

        // Compute next 3 terms using Giac
        const next: string[] = [];
        for (let i = 1; i <= 3; i++) {
          try {
            const val = await giacEngine.evaluate(
              `subst(${polyResult},x=${terms.length + i})`,
            );
            next.push(val.trim());
          } catch {
            next.push('?');
          }
        }
        lines.push(`Next 3 terms: ${next.join(', ')}`);
        return { content: [{ type: 'text' as const, text: lines.join('\n') }], isError: false };
      }
    } catch {
      // Giac interpolation failed
    }

    // No pattern found
    lines.push('Pattern: Could not identify a pattern');
    lines.push('Suggestion: Try providing more terms or check if the sequence is correct.');
    return { content: [{ type: 'text' as const, text: lines.join('\n') }], isError: false };

  } catch (error) {
    return {
      content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}
