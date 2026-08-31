import { formatToolResponse, formatErrorResponse } from './response-formatter.js';
import { runJsCompute, type TaskName, type TaskArgs } from '../js-compute/index.js';

/**
 * Combinatorics over arbitrary-precision integers.
 *
 * The arithmetic lives in `js-compute/tasks.ts` and runs in a forked child with
 * a wall-clock timeout and a heap cap. It used to run here, on the main thread,
 * where neither axis could be bounded: a synchronous BigInt loop cannot be
 * interrupted and exhausting the heap aborts the server. Four review rounds
 * tried per-operation input ceilings — `factorial` alone, then the Stirling
 * table's cell count, then n²·k, then k — and every one of them was on the wrong
 * axis for at least one operation, rejecting cheap inputs while still admitting
 * one that killed the process. One bound outside the process replaces all of
 * them, and `stirling_first(20000,48)` — which aborted the server under one
 * ceiling and was refused by the next — now simply answers.
 *
 * What stays here is what the worker cannot decide: which operation was asked
 * for, and whether its arguments are the right SHAPE (an integer count, a group
 * list that sums to n). Cost is not this file's concern any more.
 */
const OPERATION_TASK: Record<string, TaskName> = {
  combinations: 'combinations',
  permutations: 'permutations',
  multinomial: 'multinomial',
  stirling_first: 'stirling_first',
  stirling_second: 'stirling_second',
  bell_number: 'bell_number',
  catalan_number: 'catalan_number',
  derangements: 'derangements',
  partition_count: 'partition_count',
};

/** Operations that additionally need `k`. */
const NEEDS_K = new Set(['combinations', 'permutations', 'stirling_first', 'stirling_second']);

function error(msg: string) {
  return formatErrorResponse(msg);
}

/**
 * Argument shape, not argument size.
 *
 * NaN is rejected here because every downstream comparison is false for it — the
 * extractor forwards an unparsable argument as NaN so it can be reported, and
 * without this `combinations(a,b)` answered C(NaN,NaN) = 1.
 */
function checkShape(operation: string, n: number, k: number | undefined): string | null {
  if (!Number.isInteger(n) || n < 0) {
    return `n must be a non-negative integer, got ${String(n)}`;
  }
  if (NEEDS_K.has(operation)) {
    if (k === undefined) return `k is required for ${operation}`;
    if (!Number.isInteger(k) || k < 0) {
      return `k must be a non-negative integer, got ${String(k)}`;
    }
    if (k > n) return `k (${k}) cannot exceed n (${n})`;
  }
  return null;
}

export async function combinatoricsHandler(args: Record<string, unknown>) {
  const operation = args.operation as string;
  const n = args.n as number;
  const k = args.k as number | undefined;
  const groups = args.groups as number[] | undefined;

  const task = OPERATION_TASK[operation];
  if (!task) return error(`Unknown operation: ${operation}`);

  const shapeError = checkShape(operation, n, k);
  if (shapeError) return error(shapeError);

  // Shapes the combinatorics tasks accept. The task itself is chosen at
  // runtime from `operation`, so the call below casts: a literal-keyed generic
  // cannot check a dynamic key. `checkShape` is what validates the pairing.
  let taskArgs: { n: number; k?: number; groups?: number[] } = { n, k };
  if (operation === 'multinomial') {
    const grps = groups ?? (k !== undefined ? [k, n - k] : undefined);
    if (!grps) return error('groups array is required for multinomial');
    if (!grps.every((g) => Number.isInteger(g) && g >= 0)) {
      return error(`groups must be non-negative integers, got [${grps.join(', ')}]`);
    }
    const sum = grps.reduce((a, b) => a + b, 0);
    if (sum !== n) return error(`sum of groups (${sum}) must equal n (${n})`);
    taskArgs = { n, groups: grps };
  }

  let rawResult: string;
  try {
    rawResult = await runJsCompute(task, taskArgs as TaskArgs[TaskName]);
  } catch (err) {
    // A timeout or the heap cap lands here. The message names the budget rather
    // than the input, because there is no single input dimension to name — that
    // is the whole reason the bound moved out of this file.
    return error(err instanceof Error ? err.message : String(err));
  }

  return formatToolResponse({
    result: rawResult,
    notes: [
      describe(operation, n, k, groups),
      `Formula: ${formulaFor(operation, n, k, groups)}`,
      `(exact integer, ${rawResult.length} digits)`,
    ],
  });
}

function describe(
  operation: string,
  n: number,
  k: number | undefined,
  groups: number[] | undefined
): string {
  switch (operation) {
    case 'combinations':
      return `Combinations C(${n}, ${String(k)}): choosing ${String(k)} items from ${n} (order doesn't matter)`;
    case 'permutations':
      return `Permutations P(${n}, ${String(k)}): arranging ${String(k)} items from ${n} (order matters)`;
    case 'multinomial':
      return `Multinomial coefficient: ways to divide ${n} items into groups of [${(groups ?? []).join(', ')}]`;
    case 'stirling_first':
      return `Stirling number of the first kind |s(${n},${String(k)})|: permutations of ${n} elements with exactly ${String(k)} cycles`;
    case 'stirling_second':
      return `Stirling number of the second kind S(${n},${String(k)}): ways to partition ${n} elements into ${String(k)} non-empty subsets`;
    case 'bell_number':
      return `Bell number B(${n}): total number of partitions of a set of ${n} elements`;
    case 'catalan_number':
      return `Catalan number C(${n}): counts balanced parentheses, BST shapes, triangulations, etc.`;
    case 'derangements':
      return `Derangements D(${n}): permutations of ${n} elements with no fixed points`;
    default:
      return `Partition count p(${n}): number of ways to write ${n} as an unordered sum of positive integers`;
  }
}

function formulaFor(
  operation: string,
  n: number,
  k: number | undefined,
  groups: number[] | undefined
): string {
  switch (operation) {
    case 'combinations':
      return `C(${n},${String(k)}) = ${n}! / (${String(k)}! · ${n - (k ?? 0)}!)`;
    case 'permutations':
      return `P(${n},${String(k)}) = ${n}! / ${n - (k ?? 0)}!`;
    case 'multinomial':
      return `${n}! / (${(groups ?? []).join('! · ')}!)`;
    case 'stirling_first':
      return `|s(n,k)| via recurrence: |s(n,k)| = (n-1)·|s(n-1,k)| + |s(n-1,k-1)|`;
    case 'stirling_second':
      return `S(n,k) = (1/k!) · Σ_{j=0}^{k} (-1)^(k-j) · C(k,j) · j^n`;
    case 'bell_number':
      return `B(n) = Σ_{k=0}^{n} S(n,k)  (sum of Stirling numbers of second kind)`;
    case 'catalan_number':
      return `C(n) = C(2n,n) / (n+1) = (2n)! / ((n+1)! · n!)`;
    case 'derangements':
      return `D(n) = (n-1)·(D(n-1) + D(n-2)),  D(0)=1, D(1)=0`;
    default:
      return `DP: p[i] += p[i-k] for each k=1..n`;
  }
}

/** The operations this handler dispatches. Read by the coverage test. */
export const COMBINATORICS_OPERATIONS = Object.keys(OPERATION_TASK);
