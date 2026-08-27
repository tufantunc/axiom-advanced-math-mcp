import { giacEngine } from '../giac/index.js';
import { formatToolResponse, formatErrorResponse } from './response-formatter.js';

// --- Pure-JS helpers ---

/**
 * Per-operation input ceilings, in `n`.
 *
 * Most loops in this file are pure-JS BigInt running in the server process, so
 * the Giac worker timeout cannot interrupt one and a long one blocks every
 * other request. Each ceiling is a round number whose cost, measured on the
 * author's machine through the real handler, stays near 100–200ms.
 *
 * `combinations` and `permutations` are the exception: they hand the work to
 * the Giac worker, where AXIOM_EVAL_TIMEOUT_MS bounds it. They need a ceiling
 * for a different reason — `combinations(200000,100000)` traps the WASM engine
 * in 32ms, and the recycle that follows fails every other in-flight call, so
 * repeating it drove a concurrent client to a 98% error rate.
 *
 * The Stirling helpers are bounded separately below: their cost depends on k as
 * well as n, and a ceiling in n alone cannot express that.
 */
const MAX_FACTORIAL_N = 20000; // 33ms; reached via multinomial and stirling2

const MAX_N: Record<string, number> = {
  bell_number: 1500, // 107ms
  catalan_number: 20000, // 80ms
  combinations: 50_000, // Giac-bound; ceiling is to avoid trapping the engine
  derangements: 30000, // 157ms
  multinomial: MAX_FACTORIAL_N,
  partition_count: 5000, // 125ms
  permutations: 50_000, // Giac-bound, as combinations
  stirling_first: 20000, // plus the n²·k bound below
  stirling_second: 20000, // plus the k bound below
};

/**
 * Bounds the Stirling recurrences by the work they do, not by their cell count.
 *
 * Cost is n·k BigInt operations on operands of O(n·log n) digits, so it scales
 * as n²k. Measured on the reference machine, ~155ms per 10⁹:
 *
 *   n=1000  k=500 -> 5.0e8,   49ms      n=15000 k=30 -> 6.8e9, 1051ms
 *   n=5000  k=50  -> 1.3e9,  173ms      n=19999 k=49 -> 2.0e10, 3155ms
 *
 * A cell-count ceiling was the wrong axis entirely: `stirling_first(20000,48)`
 * is 980049 cells — inside a 10⁶ cap — and aborted the process.
 */
const MAX_STIRLING_WORK = 1_500_000_000;

const KNOWN_OPERATIONS = new Set([
  'combinations',
  'permutations',
  'multinomial',
  'stirling_first',
  'stirling_second',
  'bell_number',
  'catalan_number',
  'derangements',
  'partition_count',
]);

/** Terms in stirling_second's sum; 500 measured 205ms at n = 20000. */
const MAX_STIRLING_TERMS = 500;

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
  if (operation === 'stirling_first') {
    const work = n * n * Math.min(k ?? 0, n);
    if (work > MAX_STIRLING_WORK) {
      return `stirling_first is limited to n²·k <= ${MAX_STIRLING_WORK} (got ${work}) — it runs on the main thread`;
    }
  }
  // stirling_second builds no table: its cost is the k+1 `j**n` exponentiations,
  // so n²·k is the wrong shape — it rejected `stirling_second(20000,60)` at 19ms
  // while accepting shapes three orders of magnitude dearer.
  if (operation === 'stirling_second' && (k ?? 0) > MAX_STIRLING_TERMS) {
    return `stirling_second is limited to k <= ${MAX_STIRLING_TERMS} (got ${String(k)})`;
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

  // Two rolling rows, not an (n+1)×(k+1) table. Each cell holds a BigInt whose
  // width grows with n — |s(n,1)| = (n-1)!, 77338 digits at n = 20000 — so the
  // table's cost is cells × digits(n!), and a cell-count ceiling was blind to
  // the axis that actually exhausted the heap: `stirling_first(20000,48)` is
  // 980049 cells, under the old 10^6 cap, and aborted the process at ~4 GB.
  // Rolling rows hold k+1 cells regardless of n (measured 189 MB at n = 20000).
  let prev = new Array<bigint>(k + 1).fill(0n);
  prev[0] = 1n;
  for (let i = 1; i <= n; i++) {
    const cur = new Array<bigint>(k + 1).fill(0n);
    const upper = Math.min(i, k);
    for (let j = 1; j <= upper; j++) {
      cur[j] = BigInt(i - 1) * prev[j] + prev[j - 1];
    }
    prev = cur;
  }
  return prev[k];
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

  // Operation first: every case below needs `n`, so validating it for a verb
  // that does not exist reported "n must be a non-negative integer, got
  // undefined" for an ordinary spelling mistake and never reached the
  // `Unknown operation` arm at all.
  if (!KNOWN_OPERATIONS.has(operation)) {
    return error(`Unknown operation: ${operation}`);
  }
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

    // The exact integer, always. Eliding the middle put `…` inside a field the
    // envelope types as a scalar and that the CLI's -q mode prints for scripting,
    // so `derangements(1000)` returned a non-numeric string with the true value
    // recoverable from nothing in the response. Response size is bounded by the
    // input ceilings above instead.
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
