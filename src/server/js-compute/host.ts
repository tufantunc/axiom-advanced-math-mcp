import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { TaskName } from './tasks.js';
import type { MathJsTaskName } from './mathjs-tasks.js';

/**
 * Main-process bridge to the pure-JS compute worker.
 *
 * Why this exists: the arbitrary-precision loops it runs are unbounded in both
 * time and memory as a function of their inputs, and on the main thread neither
 * axis can be bounded after the fact — a synchronous BigInt loop cannot be
 * interrupted, and exhausting the heap aborts the server. Four rounds of
 * per-operation ceilings each landed on the wrong axis for at least one
 * operation. A child process with a wall-clock timeout and a heap cap bounds
 * every task uniformly, including ones added later.
 *
 * Deliberately mirrors giac/worker-host.ts: `fork` rather than `worker_threads`
 * because tsx's loader rewrites nested `.js`->`.ts` imports correctly in a
 * forked child but not in a worker thread, and the same recycle-on-fault shape.
 * The difference is that this worker holds no state, so a recycle costs nothing
 * but the respawn and every pending call can be re-sent.
 */
export interface JsComputeHostOptions {
  timeoutMs?: number;
  heapMb?: number;
}

interface Pending {
  resolve: (value: string) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Wall-clock bound per computation. Shares AXIOM_EVAL_TIMEOUT_MS with the CAS
 * path: both answer the same operator question, "how long may one evaluation
 * hold the server". Validated rather than coerced — `Number('10s')` is NaN, and
 * a NaN timeout means `setTimeout` fires immediately, failing every call.
 */
function defaultTimeoutMs(): number {
  const configured = Number(process.env.AXIOM_EVAL_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 10_000;
}

/**
 * Heap ceiling for the child, in MB. Bounds the memory axis that no
 * per-operation input ceiling managed to express: `stirling_first`'s cost is
 * cells × digits(n!), `permutations`' is the width of n!/(n-k)!, and so on.
 * Exceeding it kills the child with a clean error and leaves the server up.
 */
function defaultHeapMb(): number {
  const configured = Number(process.env.AXIOM_JS_COMPUTE_HEAP_MB);
  return Number.isFinite(configured) && configured > 0 ? configured : 512;
}

export function createJsComputeHost(opts: JsComputeHostOptions = {}) {
  const timeoutMs = opts.timeoutMs ?? defaultTimeoutMs();
  const heapMb = opts.heapMb ?? defaultHeapMb();
  let child: ChildProcess | null = null;
  let nextId = 1;
  const pending = new Map<number, Pending>();

  // Same-extension resolution as giac/worker-host.ts: under tsx/vitest this
  // module is .ts and the worker must be forked with the tsx loader; in dist it
  // is .js and forks plain.
  const here = fileURLToPath(import.meta.url);
  const isTs = here.endsWith('.ts');
  const workerPath = path.join(path.dirname(here), isTs ? 'worker.ts' : 'worker.js');
  const loaderArgs = isTs ? ['--import', 'tsx'] : [];

  function failAllPending(error: Error): void {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    pending.clear();
  }

  function detach(): ChildProcess | null {
    const c = child;
    child = null;
    return c;
  }

  /** Kills the current child and fails everything in flight. */
  function recycle(error: Error): void {
    const dying = detach();
    failAllPending(error);
    dying?.kill('SIGKILL');
  }

  function ensureChild(): ChildProcess {
    if (child) return child;
    const c = fork(workerPath, [], {
      execArgv: [...loaderArgs, `--max-old-space-size=${heapMb}`],
      // stderr discarded deliberately: a heap-limit death prints a ~40-line V8
      // stack dump that says nothing a caller or operator can act on, and the
      // host already turns the exit into "exceeded its NNNmb memory budget".
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    child = c;

    // Neither the child nor its IPC channel may hold the parent's event loop
    // open: the CLI does its work and then exits, and an unref'd channel is what
    // lets it. Without this the four plot CLI integration tests each hung for
    // 25s. Mirrors giac/worker-host.ts, which unrefs both for the same reason;
    // the child self-exits on 'disconnect' when the parent goes away.
    c.unref();
    c.channel?.unref();

    c.on('message', (msg: { type: string; id: number; value?: string; error?: string }) => {
      if (msg.type !== 'result') return;
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error !== undefined) p.reject(new Error(msg.error));
      else p.resolve(msg.value ?? '');
    });

    let detached = false;
    const handleFault = (error: Error): void => {
      // A fault matters only while this child is the current one. Two ways to
      // get here otherwise, and both must be silent: `recycle()` already failed
      // this child's pending work and set `child` to null, so `child !== c` is
      // true again by the time the kill's own 'exit' arrives; and by then the
      // NEXT call may have forked a replacement, whose pending work is not this
      // child's to fail.
      if (detached || child !== c) return;
      detached = true;
      recycle(error);
    };

    c.on('exit', (code, signal) => {
      // The heap cap and SIGKILL both land here. Report the cause rather than
      // the code: "exited (code null)" told an operator nothing, and this is the
      // message a caller sees when their input was simply too large.
      const cause =
        signal === 'SIGABRT' || code === 134
          ? `exceeded its ${heapMb}MB memory budget`
          : `stopped unexpectedly (code ${String(code)}, signal ${String(signal)})`;
      handleFault(new Error(`the computation ${cause}`));
    });

    c.on('error', (e) => handleFault(e));

    return c;
  }

  return {
    /**
     * Runs one task in the child, bounded by the timeout and the heap cap.
     *
     * A timeout kills the child: a synchronous BigInt loop cannot be
     * interrupted, so there is nothing else to do, and the worker holds no state
     * worth preserving.
     */
    run(task: TaskName | MathJsTaskName, args: Record<string, unknown>): Promise<string> {
      const c = ensureChild();
      const id = nextId++;
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          const timedOut = new Error(
            `the computation exceeded its ${timeoutMs}ms budget — try smaller arguments`
          );
          // Kills the child: a synchronous loop cannot be interrupted, and the
          // worker holds no state worth preserving.
          recycle(timedOut);
          reject(timedOut);
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        c.send({ id, task, args });
      });
    },

    /** Stops the worker. Tests and shutdown paths call this. */
    async dispose(): Promise<void> {
      const dying = detach();
      failAllPending(new Error('the compute worker was shut down'));
      dying?.kill();
      await Promise.resolve();
    },
  };
}
