import { giacEngine } from '../giac/index.js';
import { formatToolResponse, formatErrorResponse } from './response-formatter.js';

// --- Pure-JS helpers ---

function factorial(n: number): bigint {
  if (n < 0) throw new Error('factorial of negative number');
  let r = 1n;
  for (let i = 2; i <= n; i++) r *= BigInt(i);
  return r;
}

function comb(n: number, k: number): bigint {
  if (k < 0 || k > n) return 0n;
  if (k === 0 || k === n) return 1n;
  k = Math.min(k, n - k);
  let r = 1n;
  for (let i = 0; i < k; i++) {
    r = (r * BigInt(n - i)) / BigInt(i + 1);
  }
  return r;
}

/** Stirling numbers of the second kind S(n, k): ways to partition n items into k non-empty subsets */
function stirling2(n: number, k: number): bigint {
  if (k === 0) return n === 0 ? 1n : 0n;
  if (k > n) return 0n;
  // Explicit formula: S(n,k) = (1/k!) * sum_{j=0}^{k} (-1)^(k-j) * C(k,j) * j^n
  let sum = 0n;
  for (let j = 0; j <= k; j++) {
    const sign = (k - j) % 2 === 0 ? 1n : -1n;
    sum += sign * comb(k, j) * BigInt(j) ** BigInt(n);
  }
  return sum / factorial(k);
}

/** Stirling numbers of the first kind |s(n,k)|: unsigned, counts permutations of n with k cycles */
function stirling1Unsigned(n: number, k: number): bigint {
  if (n === 0 && k === 0) return 1n;
  if (n === 0 || k === 0) return 0n;
  if (k > n) return 0n;
  // Recurrence: |s(n,k)| = (n-1)*|s(n-1,k)| + |s(n-1,k-1)|
  // Build table bottom-up
  const table: bigint[][] = Array.from({ length: n + 1 }, () => new Array(k + 1).fill(0n));
  table[0][0] = 1n;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= k; j++) {
      table[i][j] = BigInt(i - 1) * table[i - 1][j] + (j > 0 ? table[i - 1][j - 1] : 0n);
    }
  }
  return table[n][k];
}

/** Bell number B(n): total number of partitions of a set of n elements */
function bellNumber(n: number): bigint {
  // Bell triangle
  const row: bigint[] = [1n];
  for (let i = 1; i <= n; i++) {
    const next: bigint[] = [row[row.length - 1]];
    for (let j = 0; j < row.length; j++) {
      next.push(next[j] + row[j]);
    }
    row.length = 0;
    row.push(...next);
  }
  return row[0];
}

/** Catalan number C(n) = C(2n,n) / (n+1) */
function catalanNumber(n: number): bigint {
  return comb(2 * n, n) / BigInt(n + 1);
}

/** Derangements D(n): permutations with no fixed points */
function derangements(n: number): bigint {
  if (n === 0) return 1n;
  if (n === 1) return 0n;
  // D(n) = (n-1)*(D(n-1) + D(n-2))
  let prev2 = 1n; // D(0)
  let prev1 = 0n; // D(1)
  for (let i = 2; i <= n; i++) {
    const curr = BigInt(i - 1) * (prev1 + prev2);
    prev2 = prev1;
    prev1 = curr;
  }
  return prev1;
}

export async function combinatoricsHandler(args: Record<string, unknown>) {
  const operation = args.operation as string;
  const n = args.n as number;
  const k = args.k as number | undefined;
  const groups = args.groups as number[] | undefined;

  try {
    let result: bigint;
    let description: string;
    let formula: string;

    switch (operation) {
      case 'combinations': {
        if (k === undefined) return error('k is required for combinations');
        if (k > n) return error(`k (${k}) cannot exceed n (${n})`);
        // Use Giac for large inputs for extra confidence; JS for verification
        const raw = await giacEngine.evaluate(`comb(${n},${k})`);
        const giacVal = BigInt(raw.trim().replace(/[^0-9-]/g, ''));
        result = giacVal;
        description = `Combinations C(${n}, ${k}): choosing ${k} items from ${n} (order doesn't matter)`;
        formula = `C(${n},${k}) = ${n}! / (${k}! · ${n - k}!)`;
        break;
      }

      case 'permutations': {
        if (k === undefined) return error('k is required for permutations');
        if (k > n) return error(`k (${k}) cannot exceed n (${n})`);
        const raw = await giacEngine.evaluate(`perm(${n},${k})`);
        result = BigInt(raw.trim().replace(/[^0-9-]/g, ''));
        description = `Permutations P(${n}, ${k}): arranging ${k} items from ${n} (order matters)`;
        formula = `P(${n},${k}) = ${n}! / ${n - k}!`;
        break;
      }

      case 'multinomial': {
        const grps = groups ?? (k !== undefined ? [k, n - k] : undefined);
        if (!grps) return error('groups array is required for multinomial');
        const sum = grps.reduce((a, b) => a + b, 0);
        if (sum !== n) return error(`sum of groups (${sum}) must equal n (${n})`);
        const num = factorial(n);
        const den = grps.reduce((acc, g) => acc * factorial(g), 1n);
        result = num / den;
        description = `Multinomial coefficient: ways to divide ${n} items into groups of [${grps.join(', ')}]`;
        formula = `${n}! / (${grps.join('! · ')}!)`;
        break;
      }

      case 'stirling_first': {
        if (k === undefined) return error('k is required for stirling_first');
        result = stirling1Unsigned(n, k);
        description = `Stirling number of the first kind |s(${n},${k})|: permutations of ${n} elements with exactly ${k} cycles`;
        formula = `|s(n,k)| via recurrence: |s(n,k)| = (n-1)·|s(n-1,k)| + |s(n-1,k-1)|`;
        break;
      }

      case 'stirling_second': {
        if (k === undefined) return error('k is required for stirling_second');
        result = stirling2(n, k);
        description = `Stirling number of the second kind S(${n},${k}): ways to partition ${n} elements into ${k} non-empty subsets`;
        formula = `S(n,k) = (1/k!) · Σ_{j=0}^{k} (-1)^(k-j) · C(k,j) · j^n`;
        break;
      }

      case 'bell_number': {
        result = bellNumber(n);
        description = `Bell number B(${n}): total number of partitions of a set of ${n} elements`;
        formula = `B(n) = Σ_{k=0}^{n} S(n,k)  (sum of Stirling numbers of second kind)`;
        break;
      }

      case 'catalan_number': {
        result = catalanNumber(n);
        description = `Catalan number C(${n}): counts balanced parentheses, BST shapes, triangulations, etc.`;
        formula = `C(n) = C(2n,n) / (n+1) = (2n)! / ((n+1)! · n!)`;
        break;
      }

      case 'derangements': {
        result = derangements(n);
        description = `Derangements D(${n}): permutations of ${n} elements with no fixed points`;
        formula = `D(n) = (n-1)·(D(n-1) + D(n-2)),  D(0)=1, D(1)=0`;
        break;
      }

      case 'partition_count': {
        // Pure JS DP for integer partitions p(n): unordered sums of positive integers
        const p = new Array(n + 1).fill(0n);
        p[0] = 1n;
        for (let k = 1; k <= n; k++) {
          for (let i = k; i <= n; i++) {
            p[i] = p[i] + p[i - k];
          }
        }
        result = p[n];
        description = `Partition count p(${n}): number of ways to write ${n} as an unordered sum of positive integers`;
        formula = `DP: p[i] += p[i-k] for each k=1..n`;
        break;
      }

      default:
        return error(`Unknown operation: ${operation}`);
    }

    const rawResult = result.toString();

    return formatToolResponse({
      result: rawResult,
      notes: [description, `Formula: ${formula}`, `(exact integer, ${rawResult.length} digits)`],
    });
  } catch (err) {
    return formatErrorResponse(err instanceof Error ? err.message : String(err));
  }
}

function error(msg: string) {
  return formatErrorResponse(msg);
}
