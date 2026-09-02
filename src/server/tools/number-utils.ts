import { giacEngine } from '../giac/index.js';

export async function analyzeNumberCore(n: number): Promise<string[]> {
  const absN = Math.abs(n);
  const lines: string[] = [`Number: ${n}`];

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
  lines.push(`Prime: ${isPrime ? 'Yes' : 'No'}`);

  let factors: [number, number][] = [];
  if (absN > 1) {
    try {
      const ifactorResult = await giacEngine.evaluate(`ifactor(${absN})`);
      factors = parseIfactor(ifactorResult);
      const factorStr = factors.map(([p, e]) => (e > 1 ? `${p}^${e}` : `${p}`)).join(' × ');
      lines.push(`Prime factorization: ${factorStr}`);
    } catch {
      lines.push('Prime factorization: (could not compute)');
    }
  } else {
    lines.push(`Prime factorization: ${absN}`);
  }

  if (absN >= 1) {
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
  }

  if (absN > 0) {
    try {
      const eulerResult = await giacEngine.evaluate(`euler(${absN})`);
      lines.push(`Euler totient φ(${absN}): ${eulerResult.trim()}`);
    } catch {}
  }

  const squareNote = isPerfectSquare(absN) ? `Yes (${Math.round(Math.sqrt(absN))}²)` : 'No';
  lines.push(`Perfect square: ${squareNote}`);
  const cubeNote = isPerfectCube(absN) ? `Yes (${Math.round(Math.cbrt(absN))}³)` : 'No';
  lines.push(`Perfect cube: ${cubeNote}`);
  const triangularNote = isTriangular(absN) ? `Yes (T${triangularIndex(absN)})` : 'No';
  lines.push(`Triangular: ${triangularNote}`);
  lines.push(`Fibonacci: ${isFibonacci(absN) ? 'Yes' : 'No'}`);

  return lines;
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
