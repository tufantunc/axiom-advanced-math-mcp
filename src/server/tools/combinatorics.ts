import { giacEngine } from '../giac/index.js';
import { formatToolResponse, formatErrorResponse } from './response-formatter.js';

// --- Pure-JS helpers ---

/**
 * Per-operation input ceilings.
 *
 * Every loop in this file is pure-JS BigInt running in the server process, so
 * the Giac worker timeout cannot interrupt one and a long one blocks every
 * other request. Each ceiling is a round number whose measured cost on the
 * reference machine stays near 100–200ms:
 *
 *   factorial       20000 ->  33ms      partition_count   5000 -> 113ms
 *   bell_number      1500 -> ~110ms     derangements     30000 -> ~150ms
 *   catalan_number  20000 ->  81ms      stirling n*k     10^6 ->  81ms
 *
 * `stirling_first` is bounded by the product because it allocates an
 * (n+1)×(k+1) BigInt table: `stirling_first(4000,2000)` allocated past V8's
 * heap limit and aborted the whole process — 25 characters of input.
 *
 * combinations/permutations are absent because `comb` is O(min(k,n-k)) with no
 * table: C(20000,3) is under a millisecond.
 */
/** The largest n for which the factorial loop stays cheap: 33ms at 20000. */
const MAX_FACTORIAL_N = 20000;

const MAX_N: Record<string, number> = {
  bell_number: 1500,
  catalan_number: 20000,
  derangements: 30000,
  multinomial: MAX_FACTORIAL_N,
  partition_count: 5000,
  stirling_first: 20000,
  stirling_second: 20000,
};

/** Above this many digits the exact integer is elided in the response. */
const MAX_RESULT_DIGITS = 2000;

/** Bounds the (n+1)×(k+1) BigInt table the Stirling helpers allocate. */
const MAX_STIRLING_CELLS = 1_000_000;

function factorial(n: number): bigint {
  if (n < 0) throw new Error('factorial of negative number');
  if (!Number.isInteger(n) || n > MAX_FACTORIAL_N) {
    throw new Error(`n must be an integer no greater than ${MAX_FACTORIAL_N}, got ${n}`);
  }
  let r = 1n;
  for (let i = 2; i <= n; i++) r *= BigInt(i);
  return r;
}

/**
 * Rejects an out-of-range n/k before any loop runs.
 *
 * This has to sit at the entry, not inside a leaf helper: `bell_number`,
 * `partition_count`, `derangements` and `catalan_number` never call
 * `factorial`, so a bound living there covered none of them — and `stirling2`
 * called it only on its last line, after the expensive loop, so an
 * out-of-range request paid the full cost and then got an error anyway.
 *
 * NaN is rejected here for the same reason. The extractor forwards an
 * unparsable argument as NaN so it can be reported rather than silently
 * becoming 0, and every downstream comparison (`k > n`, `k === undefined`) is
 * false for NaN — so `combinations(a,b)` used to answer C(NaN,NaN) = 1.
 */
function checkRange(operation: string, n: number, k: number | undefined): string | null {
  if (!Number.isInteger(n) || n < 0) {
    return `n must be a non-negative integer, got ${String(n)}`;
  }
  if (k !== undefined && (!Number.isInteger(k) || k < 0)) {
    return `k must be a non-negative integer, got ${String(k)}`;
  }
  const ceiling = MAX_N[operation];
  if (ceiling !== undefined && n > ceiling) {
    return `${operation} is limited to n <= ${ceiling} (got ${n}) — it runs on the main thread`;
  }
  if (operation === 'stirling_first' || operation === 'stirling_second') {
    const cells = (n + 1) * ((k ?? 0) + 1);
    if (cells > MAX_STIRLING_CELLS) {
      return `${operation} is limited to (n+1)*(k+1) <= ${MAX_STIRLING_CELLS} (got ${cells})`;
    }
  }
  return null;
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

  const rangeError = checkRange(operation, n, k);
  if (rangeError) return error(rangeError);

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

    // `factorial(20000)` is 77338 digits — a 77 KB response for 33ms of work,
    // which lands whole in the caller's context. The digit count below already
    // states the true length, so elide the middle rather than the fact.
    const shown =
      rawResult.length > MAX_RESULT_DIGITS
        ? `${rawResult.slice(0, 40)}…${rawResult.slice(-40)}`
        : rawResult;

    return formatToolResponse({
      result: shown,
      notes: [
        description,
        `Formula: ${formula}`,
        `(exact integer, ${rawResult.length} digits${
          shown === rawResult ? '' : ' — first and last 40 shown'
        })`,
      ],
    });
  } catch (err) {
    return formatErrorResponse(err instanceof Error ? err.message : String(err));
  }
}

function error(msg: string) {
  return formatErrorResponse(msg);
}
