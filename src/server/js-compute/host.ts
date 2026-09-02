import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JsComputeError } from './errors.js';
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
 * forked child but not in a worker thread, and the same
 * recycle-versus-redispatch split.
 */
export interface JsComputeHostOptions {
  timeoutMs?: number;
  heapMb?: number;
  /** Overridable so the overflow path is reachable in a test. */
  maxQueueDepth?: number;
}

interface Pending {
  task: string;
  args: Record<string, unknown>;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
  /** null while the child is still starting — cold start is not queue wait. */
  timer: NodeJS.Timeout | null;
  /** `queued` until the worker acks a start; `running` once it is executing. */
  phase: 'queued' | 'running';
  redispatches: number;
}

/**
 * A call that has already outlived two workers is treated as the problem rather
 * than dragged across a third. Mirrors giac/worker-host.ts.
 */
const MAX_REDISPATCHES = 2;

/**
 * Ceiling on calls waiting for the single serial child. Bounds the pending map
 * rather than letting a burst queue without limit; overflow is refused
 * immediately and truthfully instead of waiting and then being reported as an
 * oversized computation.
 */
const MAX_QUEUE_DEPTH = 64;

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
 * Exceeding it kills the child and fails the computation that caused it.
 */
function defaultHeapMb(): number {
  const configured = Number(process.env.AXIOM_JS_COMPUTE_HEAP_MB);
  return Number.isFinite(configured) && configured > 0 ? configured : 512;
}

export function createJsComputeHost(opts: JsComputeHostOptions = {}) {
  const timeoutMs = opts.timeoutMs ?? defaultTimeoutMs();
  const heapMb = opts.heapMb ?? defaultHeapMb();
  const maxQueueDepth = opts.maxQueueDepth ?? MAX_QUEUE_DEPTH;
  let child: ChildProcess | null = null;
  let childReady: () => boolean = () => false;
  let nextId = 1;
  const pending = new Map<number, Pending>();

  // Same-extension resolution as giac/worker-host.ts: under tsx/vitest this
  // module is .ts and the worker must be forked with the tsx loader; in dist it
  // is .js and forks plain.
  const here = fileURLToPath(import.meta.url);
  const isTs = here.endsWith('.ts');
  const workerPath = path.join(path.dirname(here), isTs ? 'worker.ts' : 'worker.js');
  const loaderArgs = isTs ? ['--import', 'tsx'] : [];

  /**
   * Faults are the only abuse signal this path has: the child's stderr is
   * discarded, and a poisoned or hammered worker is otherwise silent. The
   * concrete budgets go here rather than to the caller.
   */
  function logFault(what: string, detail: string): void {
    console.error(
      `[js-compute] ${what}: ${detail} (timeout ${timeoutMs}ms, heap ${heapMb}MB, ${pending.size} pending)`
    );
  }

  function settle(id: number, p: Pending, error: Error): void {
    pending.delete(id);
    if (p.timer) clearTimeout(p.timer);
    p.reject(error);
  }

  /**
   * Arms a queued call's admission clock.
   *
   * Always armed, never left null: the child and its IPC channel are both
   * unref'd, so this ref'd timer is the only thing keeping the event loop alive
   * while a call is outstanding. Leaving it unset until the child reported ready
   * made every call hang.
   *
   * While the child is still starting the timer re-arms instead of failing the
   * call: a fork plus the tsx loader costs ~400ms, and charging that to the
   * admission budget refused every first call on a short timeout with "the
   * worker is busy" — wrong, and unactionable.
   */
  function armAdmission(id: number): void {
    const p = pending.get(id);
    if (p?.phase !== 'queued') return;
    if (p.timer) clearTimeout(p.timer);
    p.timer = setTimeout(() => {
      const cur = pending.get(id);
      if (cur?.phase !== 'queued') return;
      if (!childReady() || runningEntry() === undefined) {
        // The worker's own setup, not another caller's computation, so extend
        // rather than blame this one. Two kinds of setup reach here:
        //
        //   - the fork plus the tsx loader, before `ready`; and
        //   - resolving the task in the child, which for the first mathjs task
        //     runs an import that worker.ts prices at ~170ms. That one was
        //     missed: `ready` had arrived, nothing else was running, and the
        //     admission timer fired anyway — so `2+2`, alone on an idle worker,
        //     was refused with "busy with other computations". There were none.
        //
        // `runningEntry() === undefined` is a sufficient test for "nobody else
        // holds the worker", not an exact one: a peer that already has the
        // message in the child but has not acked yet is still `queued` in the
        // host's view. That case is the one this exemption exists for, so the
        // looseness runs in the safe direction — it extends where it might have
        // blamed, never the reverse.
        //
        // Unbounded, like the cold-start extension it joins. The ceiling is
        // MAX_REDISPATCHES, not the exit handler: a child that dies re-queues
        // this call (recycleAndRedispatch fails only the RUNNING entry, and
        // there is none here), and the third death fails it with
        // `worker_failed`. Only dispose() fails everything pending. A child that
        // stays alive past `ready` and never acks is the one case with no
        // ceiling — it now waits forever and holds the event loop open with it,
        // where before it was refused as busy. No caller input reaches that
        // state: an unknown task returns a result error, a throwing resolveTask
        // is caught in worker.ts and returned as a result, and a child blocked
        // in a synchronous task has an entry in `running` so this exemption does
        // not apply. It takes a replaced worker binary to produce.
        cur.timer = null;
        armAdmission(id);
        return;
      }
      // Reachable, and it refuses the wrong caller. An earlier version of this
      // comment argued the opposite; the ordering is the reverse of what it
      // claimed. A running call's execution timer is armed at its `start` ACK,
      // which is LATER than the enqueue of anything issued in the same tick, so
      // the queued call's admission fires FIRST — not second:
      //
      //   warm, then in one tick, timeoutMs 400:
      //     A = run('stirling_first', { n: 20000, k: 48 })   // ~2.9s
      //     B = run('mathjs_evaluate', { expression: '2+2' })
      //   B @609ms busy: the compute worker was busy with other computations
      //   A @610ms timeout: the computation exceeded its time budget
      //
      // So a trivial call is blamed and told to retry one millisecond before the
      // actual offender is killed, and because B is settled here its entry is
      // gone by the time recycleAndRedispatch runs — which is exactly the
      // collateral that function's own docblock says the design prevents. Any
      // two calls issued within one ack latency of each other hit it.
      //
      // NOT introduced by the extension above: this reproduces identically on
      // main, verified. Left as-is because fixing it is a behaviour change
      // beyond the refusal-message defect this commit exists to fix. The fix
      // would be to start a queued call's admission clock no earlier than the
      // peer's execution clock, by re-arming queued timers when a peer
      // transitions to `running`.
      //
      // Overload shedding does NOT depend on this branch: that is maxQueueDepth
      // in run(), which rejects synchronously and says "is busy". The timer is
      // load-bearing regardless — it is the event-loop ref that keeps the
      // process alive while a call is outstanding.
      settle(
        id,
        cur,
        new JsComputeError(
          'the compute worker was busy with other computations; please retry',
          'busy'
        )
      );
    }, timeoutMs);
  }

  function detach(): ChildProcess | null {
    const c = child;
    child = null;
    return c;
  }

  /** The single task the child is executing, if any. The worker is serial. */
  function runningEntry(): [number, Pending] | undefined {
    for (const entry of pending) {
      if (entry[1].phase === 'running') return entry;
    }
    return undefined;
  }

  /**
   * Unrecoverable path (dispose): nothing pending can be salvaged.
   */
  function failAllPending(error: Error): void {
    for (const [id, p] of Array.from(pending)) settle(id, p, error);
  }

  /**
   * A fault blames the RUNNING call and re-sends the rest.
   *
   * The previous shape failed everything pending with the offender's error, so
   * one caller's `1:20000000` told a concurrent `2+2` that it had exhausted a
   * 512MB heap. Only the running task can have caused a timeout or a heap
   * abort; queued tasks had not started. `plot` is not behind the CAS session
   * mutex, so that collateral was reachable by ordinary traffic.
   */
  function recycleAndRedispatch(error: Error): void {
    const dying = detach();
    dying?.kill('SIGKILL');

    const culprit = runningEntry();
    if (culprit) settle(culprit[0], culprit[1], error);

    const survivors: [number, Pending][] = [];
    for (const [id, p] of Array.from(pending)) {
      if (p.redispatches >= MAX_REDISPATCHES) {
        settle(
          id,
          p,
          new JsComputeError(
            'the compute worker was restarted repeatedly; the call was abandoned',
            'worker_failed'
          )
        );
        continue;
      }
      p.redispatches++;
      p.phase = 'queued';
      survivors.push([id, p]);
    }
    if (survivors.length === 0) return;

    const fresh = ensureChild();
    for (const [id, p] of survivors) {
      // Skip anything settled by another path in the meantime.
      if (pending.get(id) !== p) continue;
      armAdmission(id);
      try {
        fresh.send({ id, task: p.task, args: p.args });
      } catch (e) {
        settle(id, p, e instanceof Error ? e : new Error(String(e)));
      }
    }
  }

  function ensureChild(): ChildProcess {
    if (child) return child;
    const c = fork(workerPath, [], {
      execArgv: [...loaderArgs, `--max-old-space-size=${heapMb}`],
      // stderr discarded deliberately: a heap-limit death prints a ~40-line V8
      // stack dump that says nothing a caller or operator can act on. logFault
      // above is what replaces it.
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    child = c;
    let ready = false;
    childReady = () => ready;

    // Neither the child nor its IPC channel may hold the parent's event loop
    // open: the CLI does its work and then exits, and an unref'd channel is what
    // lets it. Without this the five plot CLI integration tests each hung for
    // 25s (the cli() helper's SIGKILL timeout). Mirrors giac/worker-host.ts,
    // which unrefs both for the same reason; the child self-exits on
    // 'disconnect' when the parent goes away. Each in-flight call holds a live
    // timer, which is what keeps the loop alive while work is outstanding.
    c.unref();
    c.channel?.unref();

    c.on(
      'message',
      (msg: { type: string; id: number; value?: string; error?: string; code?: string }) => {
        if (msg.type === 'ready') {
          ready = true;
          // Anything enqueued during the cold start restarts its clock now, so
          // the fork is not charged against the admission budget.
          for (const [id, p] of Array.from(pending)) {
            if (p.phase === 'queued') armAdmission(id);
          }
          return;
        }

        const p = pending.get(msg.id);
        if (!p) return;

        // The worker acks the start of each task. The per-call clock runs from
        // there, not from enqueue: the child is serial, so charging queue wait
        // against a call's compute budget refused calls whose own work was
        // small — 12 concurrent plots and the tenth was told its arguments were
        // too large for a budget it had spent entirely waiting.
        if (msg.type === 'start') {
          if (p.phase !== 'queued') return;
          if (p.timer) clearTimeout(p.timer);
          p.phase = 'running';
          p.timer = setTimeout(() => onExecutionTimeout(msg.id), timeoutMs);
          return;
        }

        if (msg.type !== 'result') return;
        pending.delete(msg.id);
        if (p.timer) clearTimeout(p.timer);
        if (msg.error !== undefined) {
          // A task that threw means the worker is healthy and the expression was
          // not: `evaluation_failed`, not `worker_failed`. Only the worker's own
          // faults get that code, so a caller can tell whose problem it is.
          p.reject(
            new JsComputeError(
              msg.error,
              msg.code === 'result_too_large' ? 'result_too_large' : 'evaluation_failed'
            )
          );
        } else if (msg.value === undefined) {
          // Protocol mismatch rather than a caller error: resolving '' here made
          // both consumers fail inside a bare JSON.parse with no hint of origin.
          p.reject(
            new JsComputeError(
              `the compute worker returned no value for task ${p.task}`,
              'worker_failed'
            )
          );
        } else {
          p.resolve(msg.value);
        }
      }
    );

    const handleFault = (error: Error): void => {
      // A fault matters only while this child is the current one: by the time a
      // kill's own 'exit' arrives, `child` is already null or a replacement.
      if (child !== c) return;
      recycleAndRedispatch(error);
    };

    c.on('exit', (code, signal) => {
      const oom = signal === 'SIGABRT' || code === 134;
      logFault(
        'worker exited',
        oom ? 'heap limit' : `code ${String(code)}, signal ${String(signal)}`
      );
      handleFault(
        oom
          ? new JsComputeError('the computation exceeded its memory budget', 'out_of_memory')
          : new JsComputeError('the compute worker stopped unexpectedly', 'worker_failed')
      );
    });

    c.on('error', (e) => {
      logFault('worker error', e.message);
      handleFault(new JsComputeError(`the compute worker failed: ${e.message}`, 'worker_failed'));
    });

    return c;
  }

  function onExecutionTimeout(id: number): void {
    const p = pending.get(id);
    if (!p) return;
    logFault('computation timed out', `task ${p.task}`);
    // Kills the child: a synchronous loop cannot be interrupted. Only this call
    // is blamed; anything queued behind it is re-sent.
    recycleAndRedispatch(new JsComputeError('the computation exceeded its time budget', 'timeout'));
  }

  return {
    /**
     * Runs one task in the child, bounded by the timeout and the heap cap.
     */
    run(task: TaskName | MathJsTaskName, args: Record<string, unknown>): Promise<string> {
      if (pending.size >= maxQueueDepth) {
        return Promise.reject(
          new JsComputeError(
            'the compute worker is busy with other computations; please retry',
            'busy'
          )
        );
      }
      const c = ensureChild();
      const id = nextId++;
      return new Promise<string>((resolve, reject) => {
        pending.set(id, {
          task,
          args,
          resolve,
          reject,
          timer: null,
          phase: 'queued',
          redispatches: 0,
        });
        // Queue wait gets its own budget and its own, truthful message. Armed
        // immediately — it is also the loop-keeping ref — and reset when the
        // child reports ready so the cold start is not charged to it.
        armAdmission(id);
        try {
          c.send({ id, task, args });
        } catch (e) {
          const p = pending.get(id);
          if (p) settle(id, p, e instanceof Error ? e : new Error(String(e)));
        }
      });
    },

    /** Stops the worker. Tests and shutdown paths call this. */
    async dispose(): Promise<void> {
      const dying = detach();
      failAllPending(new JsComputeError('the compute worker was shut down', 'worker_failed'));
      dying?.kill();
      await Promise.resolve();
    },
  };
}
