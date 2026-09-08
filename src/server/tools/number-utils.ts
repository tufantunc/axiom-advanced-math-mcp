import { giacEngine } from '../giac/index.js';

async function primalityLines(absN: number): Promise<string[]> {
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
  return [`Prime: ${isPrime ? 'Yes' : 'No'}`];
}

async function factorize(absN: number): Promise<{ lines: string[]; factors: [number, number][] }> {
  // Negated, not inverted: `absN > 1` and `absN <= 1` disagree on NaN, which
  // fails both comparisons. NaN is reachable from the compute extractors
  // (Number.parseInt with no NaN check), and the inverted form sent it down
  // the engine path where it fabricated "Divisor count: 1" lines and leaked a
  // raw GIAC_ERROR as the totient value. NaN's garbage output is a separate,
  // pre-existing extractor defect — this refactor must not extend it.
  if (!(absN > 1)) {
    return { lines: [`Prime factorization: ${absN}`], factors: [] };
  }
  try {
    const ifactorResult = await giacEngine.evaluate(`ifactor(${absN})`);
    const factors = parseIfactor(ifactorResult);
    const factorStr = factors.map(([p, e]) => (e > 1 ? `${p}^${e}` : `${p}`)).join(' × ');
    return { lines: [`Prime factorization: ${factorStr}`], factors };
  } catch {
    return { lines: ['Prime factorization: (could not compute)'], factors: [] };
  }
}

function divisorLines(absN: number, factors: [number, number][]): string[] {
  // Negated for the same NaN reason as factorize.
  if (!(absN >= 1)) return [];
  const lines: string[] = [];
  const divs = factors.length > 0 ? listDivisors(factors) : [1];
  const count = divisorCount(factors.length > 0 ? factors : []);
  const sum = divisorSum(factors.length > 0 ? factors : []);
  lines.push(`Divisor count: ${count}`);
  if (count <= 30) {
    lines.push(`Divisors: ${divs.join(', ')}`);
  }
  lines.push(`Divisor sum: ${sum}`);
  if (absN > 1) {
    const properSum = sum - absN;
    lines.push(`Perfect number: ${properSum === absN ? 'Yes' : 'No'}`);
  }
  return lines;
}

async function eulerTotientLine(absN: number): Promise<string[]> {
  // Negated for the same NaN reason as factorize.
  if (!(absN > 0)) return [];
  try {
    const eulerResult = await giacEngine.evaluate(`euler(${absN})`);
    return [`Euler totient φ(${absN}): ${eulerResult.trim()}`];
  } catch {
    return [];
  }
}

function shapeNotes(absN: number): string[] {
  const squareNote = isPerfectSquare(absN) ? `Yes (${Math.round(Math.sqrt(absN))}²)` : 'No';
  const cubeNote = isPerfectCube(absN) ? `Yes (${Math.round(Math.cbrt(absN))}³)` : 'No';
  const triangularNote = isTriangular(absN) ? `Yes (T${triangularIndex(absN)})` : 'No';
  return [
    `Perfect square: ${squareNote}`,
    `Perfect cube: ${cubeNote}`,
    `Triangular: ${triangularNote}`,
    `Fibonacci: ${isFibonacci(absN) ? 'Yes' : 'No'}`,
  ];
}

export async function analyzeNumberCore(n: number): Promise<string[]> {
  const absN = Math.abs(n);
  const primeLines = await primalityLines(absN);
  const { lines: factorLines, factors } = await factorize(absN);
  return [
    `Number: ${n}`,
    ...primeLines,
    ...factorLines,
    ...divisorLines(absN, factors),
    ...(await eulerTotientLine(absN)),
    ...shapeNotes(absN),
  ];
}

export function parseIfactor(ifactorResult: string): [number, number][] {
  const cleaned = ifactorResult.trim().replaceAll(/[()]/g, '');
  if (!cleaned || cleaned === '1') return [];
  const factors: [number, number][] = [];
  const parts = cleaned.split('*');
  for (const part of parts) {
    if (part.includes('^')) {
      const [base, exp] = part.split('^');
      factors.push([Number.parseInt(base.trim()), Number.parseInt(exp.trim())]);
    } else {
      const n = Number.parseInt(part.trim());
      if (!Number.isNaN(n) && n > 1) factors.push([n, 1]);
    }
  }
  return factors;
}

export function listDivisors(factors: [number, number][]): number[] {
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

export function divisorCount(factors: [number, number][]): number {
  if (factors.length === 0) return 1;
  return factors.reduce((acc, [, exp]) => acc * (exp + 1), 1);
}

export function divisorSum(factors: [number, number][]): number {
  if (factors.length === 0) return 1;
  return factors.reduce((acc, [p, e]) => {
    if (p === 1) return acc;
    return (acc * (Math.pow(p, e + 1) - 1)) / (p - 1);
  }, 1);
}

export function isPerfectSquare(n: number): boolean {
  if (n < 0) return false;
  const s = Math.round(Math.sqrt(n));
  return s * s === n;
}

export function isPerfectCube(n: number): boolean {
  const c = Math.round(Math.cbrt(n));
  return c * c * c === n;
}

export function isTriangular(n: number): boolean {
  return n >= 0 && isPerfectSquare(8 * n + 1);
}

export function triangularIndex(n: number): number {
  return Math.round((-1 + Math.sqrt(1 + 8 * n)) / 2);
}

export function isFibonacci(n: number): boolean {
  return isPerfectSquare(5 * n * n + 4) || isPerfectSquare(5 * n * n - 4);
}
