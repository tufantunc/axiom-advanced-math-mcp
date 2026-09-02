import type { TaskModule } from './task-module.js';

/**
 * The pure-JS arbitrary-precision computations, isolated from the server process.
 *
 * These loops are unbounded in both time and memory as a function of their
 * inputs, and they used to run on the main thread — where the Giac worker's
 * timeout cannot reach them, and where exhausting the heap aborts the whole
 * server. Four review rounds tried to bound them with per-operation ceilings
 * (`factorial` alone, then cell count, then n²·k, then k) and each ceiling was
 * on the wrong axis for at least one operation: the cost is driven by a
 * different variable per operation, and by the WIDTH of the BigInts as much as
 * by the iteration count.
 *
 * So the bound is not per-operation any more. The host runs these in a forked
 * child with a wall-clock timeout and a heap cap, which bounds every task here
 * — and every task added later — by construction. `stirling_first(20000,48)`,
 * which aborted the server under the cell-count ceiling and was rejected under
 * the n²·k one, is simply a 2.9s answer now.
 *
 * Everything in this file must be a pure function of JSON-cloneable input
 * returning a JSON-cloneable result: it runs in a child process with no access
 * to the CAS, the MCP session, or anything else.
 */

/** Results cross a process boundary, so BigInts leave as decimal strings. */
export interface TaskResult {
  value: string;
}

function factorial(n: number): bigint {
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

/**
 * Stirling numbers of the first kind, unsigned: |s(n,k)|.
 *
 * Two rolling rows, not an (n+1)×(k+1) table — the recurrence reads only row
 * i-1, and each cell holds a BigInt whose width grows with n, so the full table
 * cost ~cells × digits(n!) and exhausted the heap at inputs a cell-count
 * ceiling accepted.
 */
function stirlingFirstUnsigned(n: number, k: number): bigint {
  if (n === 0 && k === 0) return 1n;
  if (n === 0 || k === 0 || k > n) return 0n;
  let prev = Array.from({ length: k + 1 }, () => 0n);
  prev[0] = 1n;
  for (let i = 1; i <= n; i++) {
    const cur = Array.from({ length: k + 1 }, () => 0n);
    const upper = Math.min(i, k);
    for (let j = 1; j <= upper; j++) {
      cur[j] = BigInt(i - 1) * prev[j] + prev[j - 1];
    }
    prev = cur;
  }
  return prev[k];
}

/** Stirling numbers of the second kind S(n, k). */
function stirlingSecond(n: number, k: number): bigint {
  if (k === 0) return n === 0 ? 1n : 0n;
  if (k > n) return 0n;
  let sum = 0n;
  for (let j = 0; j <= k; j++) {
    const sign = (k - j) % 2 === 0 ? 1n : -1n;
    sum += sign * comb(k, j) * BigInt(j) ** BigInt(n);
  }
  return sum / factorial(k);
}

/**
 * Bell number B(n): partitions of an n-element set, via the Bell triangle.
 *
 * B(n) is the FIRST element of row n, not the last — the last is B(n+1). Taking
 * the last returned 203 for B(5) = 52.
 */
function bellNumber(n: number): bigint {
  let row: bigint[] = [1n];
  for (let i = 1; i <= n; i++) {
    // The Bell triangle seeds each row with the previous row's last element,
    // which at iteration i is row[i-1] — the row has length i by construction.
    const next: bigint[] = [row[i - 1]];
    for (let j = 0; j < row.length; j++) next.push(next[j] + row[j]);
    row = next;
  }
  return row[0];
}

/** Catalan number C(n) = C(2n,n) / (n+1). */
function catalanNumber(n: number): bigint {
  return comb(2 * n, n) / BigInt(n + 1);
}

/** Derangements D(n) = (n-1)·(D(n-1) + D(n-2)). */
function derangements(n: number): bigint {
  if (n === 0) return 1n;
  let a = 1n;
  let b = 0n;
  for (let i = 2; i <= n; i++) {
    const c = BigInt(i - 1) * (b + a);
    a = b;
    b = c;
  }
  return b;
}

/** Integer partitions p(n), by the standard O(n²) dynamic program. */
function partitionCount(n: number): bigint {
  const p = Array.from({ length: n + 1 }, () => 0n);
  p[0] = 1n;
  for (let k = 1; k <= n; k++) {
    for (let i = k; i <= n; i++) p[i] = p[i] + p[i - k];
  }
  return p[n];
}

/** Multinomial n! / (g1! · g2! · …). */
function multinomial(n: number, groups: number[]): bigint {
  const den = groups.reduce((acc, g) => acc * factorial(g), 1n);
  return factorial(n) / den;
}

/**
 * The Poisson cdf, summed with a running term.
 *
 * `Σ e^-λ λ^i / i!` with a fresh `factorial(i)` per term is O(k²); the running
 * form is O(k) and needs no factorial at all. It also stops once the term
 * underflows, which is where the double saturates anyway.
 */
function poissonCdf(lambda: number, k: number): number {
  let term = Math.exp(-lambda);
  let sum = term;
  for (let i = 1; i <= k; i++) {
    term = (term * lambda) / i;
    if (!Number.isFinite(term)) break;
    sum += term;
    if (term < Number.EPSILON * sum) break;
  }
  return Math.min(sum, 1);
}

/** The binomial cdf, summed with a running term for the same reason. */
function binomialCdf(n: number, p: number, k: number): number {
  const q = 1 - p;
  let term = Math.pow(q, n);
  let sum = term;
  for (let i = 1; i <= Math.min(k, n); i++) {
    term = (term * (n - i + 1) * p) / (i * q);
    if (!Number.isFinite(term)) break;
    sum += term;
  }
  return Math.min(sum, 1);
}

export type TaskName = keyof typeof TASKS;

/** Argument shape per task, so the IPC seam is checked rather than asserted. */
export type TaskArgs = { [K in TaskName]: Parameters<(typeof TASKS)[K]>[0] };

/**
 * Every task the host may run, keyed by name.
 *
 * Adding one needs no ceiling: the host's timeout and heap cap already bound it.
 */
export const TASKS = {
  factorial: (a: { n: number }) => factorial(a.n).toString(),
  combinations: (a: { n: number; k: number }) => comb(a.n, a.k).toString(),
  permutations: (a: { n: number; k: number }) => (factorial(a.n) / factorial(a.n - a.k)).toString(),
  multinomial: (a: { n: number; groups: number[] }) => multinomial(a.n, a.groups).toString(),
  stirling_first: (a: { n: number; k: number }) => stirlingFirstUnsigned(a.n, a.k).toString(),
  stirling_second: (a: { n: number; k: number }) => stirlingSecond(a.n, a.k).toString(),
  bell_number: (a: { n: number }) => bellNumber(a.n).toString(),
  catalan_number: (a: { n: number }) => catalanNumber(a.n).toString(),
  derangements: (a: { n: number }) => derangements(a.n).toString(),
  partition_count: (a: { n: number }) => partitionCount(a.n).toString(),
  poisson_cdf: (a: { lambda: number; k: number }) => String(poissonCdf(a.lambda, a.k)),
  binomial_cdf: (a: { n: number; p: number; k: number }) => String(binomialCdf(a.n, a.p, a.k)),
} as const satisfies TaskModule;
