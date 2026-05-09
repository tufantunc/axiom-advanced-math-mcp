import { z } from 'zod';
import { giacEngine } from '../giac/index.js';
import { formatToolResponse, formatErrorResponse } from './response-formatter.js';

export const numberTheorySchema = z.object({
  operation: z
    .enum(['prime_factorize', 'analyze', 'sequence_identify'])
    .describe(
      'Number theory operation:\n' +
        '  prime_factorize — prime factorization of an integer\n' +
        '  analyze — comprehensive number analysis (primality, divisors, totient, etc.)\n' +
        '  sequence_identify — identify pattern in number sequence'
    ),
  number: z.number().int().optional().describe('Integer to analyze'),
  sequence: z
    .array(z.number())
    .optional()
    .describe('Number sequence for pattern identification (at least 3 terms)'),
});

async function primeFactorize(n: number) {
  const absN = Math.abs(n);
  if (absN < 2) {
    return formatToolResponse({
      result: String(absN),
      notes: [`${absN} has no prime factors.`],
    });
  }
  try {
    const result = await giacEngine.evaluate(`ifactor(${absN})`);
    return formatToolResponse({
      result: result.trim(),
      notes: [`Prime factorization of ${absN}: ${result.trim()}`],
    });
  } catch (error) {
    return formatErrorResponse(error instanceof Error ? error.message : String(error));
  }
}

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

function divisorCount(factors: [number, number][]): number {
  if (factors.length === 0) return 1;
  return factors.reduce((acc, [, exp]) => acc * (exp + 1), 1);
}

function divisorSum(factors: [number, number][]): number {
  if (factors.length === 0) return 1;
  return factors.reduce((acc, [p, e]) => {
    if (p === 1) return acc;
    return (acc * (Math.pow(p, e + 1) - 1)) / (p - 1);
  }, 1);
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
  return n >= 0 && isPerfectSquare(8 * n + 1);
}

function isFibonacci(n: number): boolean {
  return isPerfectSquare(5 * n * n + 4) || isPerfectSquare(5 * n * n - 4);
}

async function analyzeNumber(n: number) {
  const absN = Math.abs(n);
  const notes: string[] = [`Number: ${n}`];

  let isPrime = false;
  try {
    const primeResult = await giacEngine.evaluate(`isprime(${absN})`);
    isPrime = primeResult.trim() === '1' || primeResult.trim().toLowerCase() === 'true';
  } catch {
    if (absN > 1) {
      isPrime = true;
      for (let i = 2; i * i <= absN; i++) {
        if (absN % i === 0) {
          isPrime = false;
          break;
        }
      }
    }
  }
  notes.push(`Prime: ${isPrime ? 'Yes' : 'No'}`);

  let factors: [number, number][] = [];
  if (absN > 1) {
    try {
      const ifactorResult = await giacEngine.evaluate(`ifactor(${absN})`);
      factors = parseIfactor(ifactorResult);
      const factorStr = factors.map(([p, e]) => (e > 1 ? `${p}^${e}` : `${p}`)).join(' x ');
      notes.push(`Prime factorization: ${factorStr}`);
    } catch {
      notes.push('Prime factorization: (could not compute)');
    }
  } else {
    notes.push(`Prime factorization: ${absN}`);
  }

  if (absN >= 1) {
    const count = divisorCount(factors.length > 0 ? factors : []);
    const sum = divisorSum(factors.length > 0 ? factors : []);
    notes.push(`Divisor count: ${count}`);
    if (count <= 30) {
      const divs = factors.length > 0 ? listDivisors(factors) : [1];
      notes.push(`Divisors: ${divs.join(', ')}`);
    }
    notes.push(`Divisor sum: ${sum}`);
    if (absN > 1) {
      const properSum = sum - absN;
      notes.push(`Perfect number: ${properSum === absN ? 'Yes' : 'No'}`);
    }
  }

  if (absN > 0) {
    try {
      const eulerResult = await giacEngine.evaluate(`euler(${absN})`);
      notes.push(`Euler totient phi(${absN}): ${eulerResult.trim()}`);
    } catch {
      /* skip */
    }
  }

  notes.push(
    `Perfect square: ${isPerfectSquare(absN) ? `Yes (${Math.round(Math.sqrt(absN))}^2)` : 'No'}`
  );
  notes.push(
    `Perfect cube: ${isPerfectCube(absN) ? `Yes (${Math.round(Math.cbrt(absN))}^3)` : 'No'}`
  );
  notes.push(`Triangular: ${isTriangular(absN) ? 'Yes' : 'No'}`);
  notes.push(`Fibonacci: ${isFibonacci(absN) ? 'Yes' : 'No'}`);

  return formatToolResponse({
    result: String(n),
    notes,
  });
}

interface SequenceResult {
  pattern: string;
  formula: string;
  nextTerms: number[];
}

function checkArithmetic(terms: number[]): SequenceResult | null {
  const diffs: number[] = [];
  for (let i = 1; i < terms.length; i++) diffs.push(terms[i] - terms[i - 1]);
  if (diffs.every((d) => d === diffs[0])) {
    const a = terms[0];
    const d = diffs[0];
    const next: number[] = [];
    for (let i = 1; i <= 3; i++) next.push(a + (terms.length - 1 + i) * d);
    return {
      pattern: `Arithmetic sequence (a=${a}, d=${d})`,
      formula: d === 0 ? `a(n) = ${a}` : `a(n) = ${a} + (n-1)*${d}`,
      nextTerms: next,
    };
  }
  return null;
}

function checkGeometric(terms: number[]): SequenceResult | null {
  if (terms.some((t) => t === 0)) return null;
  const ratios: number[] = [];
  for (let i = 1; i < terms.length; i++) ratios.push(terms[i] / terms[i - 1]);
  const eps = 1e-9;
  if (ratios.every((r) => Math.abs(r - ratios[0]) < eps)) {
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
      formula: `a(n) = ${a} * ${r}^(n-1)`,
      nextTerms: next,
    };
  }
  return null;
}

function checkQuadratic(terms: number[]): SequenceResult | null {
  if (terms.length < 3) return null;
  const d1: number[] = [];
  for (let i = 1; i < terms.length; i++) d1.push(terms[i] - terms[i - 1]);
  const d2: number[] = [];
  for (let i = 1; i < d1.length; i++) d2.push(d1[i] - d1[i - 1]);
  const eps = 1e-9;
  if (d2.length > 0 && d2.every((d) => Math.abs(d - d2[0]) < eps)) {
    const A = d2[0] / 2;
    const B = d1[0] - 3 * A;
    const C = terms[0] - A - B;
    const next: number[] = [];
    for (let i = 1; i <= 3; i++) {
      const n = terms.length + i;
      next.push(A * n * n + B * n + C);
    }
    const parts: string[] = [];
    if (A !== 0) parts.push(A === 1 ? 'n^2' : A === -1 ? '-n^2' : `${A}n^2`);
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
      if (candidate % p === 0) {
        isPrime = false;
        break;
      }
    }
    if (isPrime) primes.push(candidate);
    candidate++;
  }
  return primes;
}

function checkKnownSequences(terms: number[]): SequenceResult | null {
  const n = terms.length;

  const squares = Array.from({ length: n + 3 }, (_, i) => (i + 1) * (i + 1));
  if (matchesSubsequence(terms, squares)) {
    return {
      pattern: 'Perfect squares',
      formula: 'a(n) = n^2',
      nextTerms: squares.slice(n, n + 3),
    };
  }

  const cubes = Array.from({ length: n + 3 }, (_, i) => (i + 1) ** 3);
  if (matchesSubsequence(terms, cubes)) {
    return {
      pattern: 'Perfect cubes',
      formula: 'a(n) = n^3',
      nextTerms: cubes.slice(n, n + 3),
    };
  }

  const tri = Array.from({ length: n + 3 }, (_, i) => ((i + 1) * (i + 2)) / 2);
  if (matchesSubsequence(terms, tri)) {
    return {
      pattern: 'Triangular numbers',
      formula: 'a(n) = n(n+1)/2',
      nextTerms: tri.slice(n, n + 3),
    };
  }

  const pow2 = Array.from({ length: n + 3 }, (_, i) => 2 ** i);
  if (matchesSubsequence(terms, pow2)) {
    return {
      pattern: 'Powers of 2',
      formula: 'a(n) = 2^(n-1)',
      nextTerms: pow2.slice(n, n + 3),
    };
  }

  const fib: number[] = [1, 1];
  for (let i = 2; i < n + 3; i++) fib.push(fib[i - 1] + fib[i - 2]);
  if (matchesSubsequence(terms, fib)) {
    return {
      pattern: 'Fibonacci numbers',
      formula: 'a(n) = a(n-1) + a(n-2)',
      nextTerms: fib.slice(n, n + 3),
    };
  }

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

async function sequenceIdentify(terms: number[]) {
  const notes: string[] = [`Sequence: ${terms.join(', ')}`];

  if (terms.every((t) => t === terms[0])) {
    notes.push(`Pattern: Constant sequence`);
    notes.push(`Formula: a(n) = ${terms[0]}`);
    notes.push(`Next 3 terms: ${terms[0]}, ${terms[0]}, ${terms[0]}`);
    return formatToolResponse({ result: String(terms[0]), notes });
  }

  const recognizers = [
    () => checkArithmetic(terms),
    () => checkGeometric(terms),
    () => checkKnownSequences(terms),
    () => checkQuadratic(terms),
  ];

  for (const recognize of recognizers) {
    const seqResult = recognize();
    if (seqResult) {
      notes.push(`Pattern: ${seqResult.pattern}`);
      notes.push(`Formula: ${seqResult.formula}`);
      notes.push(`Next 3 terms: ${seqResult.nextTerms.join(', ')}`);
      return formatToolResponse({
        result: seqResult.formula,
        notes,
      });
    }
  }

  try {
    const xValues = terms.map((_, i) => i + 1).join(',');
    const yValues = terms.join(',');
    const giacExpr = `interp([${xValues}],[${yValues}],x)`;
    const polyResult = await giacEngine.evaluate(giacExpr);
    if (polyResult && polyResult !== 'undef') {
      notes.push(`Pattern: Polynomial interpolation`);
      notes.push(`Formula: a(n) = ${polyResult}`);
      const next: string[] = [];
      for (let i = 1; i <= 3; i++) {
        try {
          const val = await giacEngine.evaluate(`subst(${polyResult},x=${terms.length + i})`);
          next.push(val.trim());
        } catch {
          next.push('?');
        }
      }
      notes.push(`Next 3 terms: ${next.join(', ')}`);
      return formatToolResponse({ result: polyResult, notes });
    }
  } catch {
    /* Giac interpolation failed */
  }

  notes.push('Pattern: Could not identify a pattern');
  return formatErrorResponse('Could not identify sequence pattern. Try providing more terms.');
}

export async function numberTheoryHandler(args: Record<string, unknown>) {
  try {
    const operation = args.operation as string;

    if (operation === 'prime_factorize') {
      const n = args.number as number | undefined;
      if (n === undefined) return formatErrorResponse("'number' is required for prime_factorize");
      return primeFactorize(n);
    }

    if (operation === 'analyze') {
      const n = args.number as number | undefined;
      if (n === undefined) return formatErrorResponse("'number' is required for analyze");
      return analyzeNumber(n);
    }

    if (operation === 'sequence_identify') {
      const seq = args.sequence as number[] | undefined;
      if (!seq || seq.length < 3)
        return formatErrorResponse(
          "'sequence' array with at least 3 terms is required for sequence_identify"
        );
      return sequenceIdentify(seq);
    }

    return formatErrorResponse(`Unknown operation: ${operation}`);
  } catch (error) {
    return formatErrorResponse(error instanceof Error ? error.message : String(error));
  }
}
