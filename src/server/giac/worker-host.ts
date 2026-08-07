import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export interface WorkerHostOptions {
  timeoutMs?: number;
}

interface Pending {
  /** Kept so the call can be re-sent to a fresh worker after a recycle. */
  expr: string;
  resolve: (s: string) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  /** How many times this call has already been moved to a fresh worker. */
  redispatches: number;
}

const DEFAULT_TIMEOUT_MS = Number(process.env.AXIOM_EVAL_TIMEOUT_MS ?? 10_000);
const INIT_TIMEOUT_MS = 30_000;

/**
 * How many times a single call may be re-sent to a freshly spawned worker
 * before the host gives up on it. Without a cap, two mutually-wedging calls
 * could bounce each other between workers indefinitely.
 */
const MAX_REDISPATCHES = 2;

/**
 * Main-process bridge to the Giac worker (a forked child process). Enforces a
 * hard per-call timeout; on timeout (or worker crash) it kills the worker and
 * respawns a fresh one (fresh WASM engine). The server process never dies with
 * a wedged evaluation.
 *
 * Two recycle paths, deliberately different:
 *   - per-call timeout  -> only the offending call fails; the other in-flight
 *     calls are re-sent to the fresh worker (`recycleAndRedispatch`).
 *   - worker crash/exit -> nothing is recoverable, so everything pending fails
 *     (`recycle`).
 *
 * Uses child_process.fork (not worker_threads) because tsx's loader rewrites
 * nested `.js`->`.ts` imports correctly in a forked child but not in a worker
 * thread spawned with `--import tsx` (verified empirically).
 *
 * Note: a recycle resets Giac global state (e.g. `sto` assignments) — accepted,
 * documented in the design spec; recycling happens only on timeout/crash.
 */
export function createWorkerHost(opts: WorkerHostOptions = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let child: ChildProcess | null = null;
  let readyPromise: Promise<void> | null = null;
  let ready = false; // true only between the worker's 'ready' handshake and the next recycle/dispose
  let nextId = 1;
  const pending = new Map<number, Pending>();

  // Resolve the sibling worker entry with the SAME extension as this module:
  // under tsx/vitest this file is .ts -> fork worker.ts with the tsx loader;
  // in the compiled dist it is .js -> fork worker.js plain.
  const here = fileURLToPath(import.meta.url);
  const isTs = here.endsWith('.ts');
  const workerPath = path.join(path.dirname(here), isTs ? 'worker.ts' : 'worker.js');
  const execArgv = isTs ? ['--import', 'tsx'] : [];

  function failAllPending(err: Error): void {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    pending.clear();
  }

  /** Detaches the current worker (so nothing else can send to it) and returns it. */
  function detachWorker(): ChildProcess | null {
    const c = child;
    child = null;
    readyPromise = null;
    ready = false;
    return c;
  }

  /**
   * Unrecoverable path (worker crash/exit, init failure, dispose): nothing
   * in flight can be salvaged, so every pending call is rejected.
   */
  function recycle(err: Error): void {
    const c = detachWorker();
    failAllPending(err);
    if (c) c.kill('SIGKILL');
  }

  /**
   * Per-call timeout path: exactly ONE call is at fault, so only that call is
   * failed (by its own timer, before this runs). The wedged worker still has
   * to die — it is stuck in a synchronous caseval and will never answer
   * anything again — but the other in-flight calls are innocent, so they are
   * re-sent to the freshly spawned worker instead of being rejected.
   *
   * Survivors keep their original timers: each was enqueued against its own
   * deadline and the re-dispatch does not buy it more time.
   */
  function recycleAndRedispatch(): void {
    const c = detachWorker();
    if (c) c.kill('SIGKILL');
    if (pending.size === 0) return;

    const survivors: [number, Pending][] = [];
    for (const [id, p] of pending) {
      if (p.redispatches >= MAX_REDISPATCHES) {
        // This call has already outlived two workers; treat it as the
        // problem rather than dragging it across a third.
        pending.delete(id);
        clearTimeout(p.timer);
        p.reject(new Error('Giac worker recycled repeatedly; call abandoned'));
        continue;
      }
      p.redispatches++;
      survivors.push([id, p]);
    }
    if (survivors.length === 0) return;

    const failSurvivors = (err: Error): void => {
      for (const [id, p] of survivors) {
        // Skip anything that resolved, timed out, or was failed by another
        // path in the meantime — its entry is already gone from the map.
        if (pending.get(id) !== p) continue;
        pending.delete(id);
        clearTimeout(p.timer);
        p.reject(err);
      }
    };

    ensureWorker().then(
      () => {
        const fresh = child;
        if (!fresh) {
          failSurvivors(new Error('Giac worker unavailable'));
          return;
        }
        for (const [id, p] of survivors) {
          if (pending.get(id) !== p) continue;
          try {
            fresh.send({ id, expr: p.expr });
          } catch (e) {
            pending.delete(id);
            clearTimeout(p.timer);
            p.reject(e instanceof Error ? e : new Error(String(e)));
          }
        }
      },
      (e: unknown) => {
        // ensureWorker's own failure paths already call recycle(), which
        // fails everything pending; this only covers anything it missed and
        // keeps the promise from rejecting unhandled.
        failSurvivors(e instanceof Error ? e : new Error(String(e)));
      }
    );
  }

  function ensureWorker(): Promise<void> {
    if (child && readyPromise) return readyPromise;
    const c = fork(workerPath, [], {
      execArgv,
      // Ignore the child's stdin/stdout (stdout would corrupt the MCP stdio
      // protocol); keep stderr for diagnostics; ipc for messages.
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    // Don't let the live child (or its IPC channel) keep the parent process
    // alive: when the parent finishes, it can exit, the channel disconnects,
    // and the child self-exits on 'disconnect'. Prevents test-runner hangs.
    c.unref();
    c.channel?.unref();
    child = c;
    readyPromise = new Promise<void>((resolve, reject) => {
      const initTimer = setTimeout(() => {
        const err = new Error('Giac worker init timed out');
        recycle(err);
        reject(err);
      }, INIT_TIMEOUT_MS);

      c.on('message', (msg: { type?: string; id?: number; result?: string; error?: string }) => {
        if (msg.type === 'ready') {
          clearTimeout(initTimer);
          ready = true;
          resolve();
          return;
        }
        if (msg.type === 'init-error') {
          clearTimeout(initTimer);
          const err = new Error(`Giac worker init failed: ${msg.error}`);
          recycle(err);
          reject(err);
          return;
        }
        if (msg.type === 'result' && msg.id !== undefined) {
          const p = pending.get(msg.id);
          if (!p) return; // already timed out
          pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.error !== undefined) p.reject(new Error(msg.error));
          else p.resolve(msg.result ?? '');
        }
      });
      c.on('error', (e) => {
        clearTimeout(initTimer);
        const err = e instanceof Error ? e : new Error(String(e));
        recycle(err);
        reject(err);
      });
      c.on('exit', (code) => {
        if (child === c) recycle(new Error(`Giac worker exited (code ${code})`));
      });
    });
    return readyPromise;
  }

  return {
    async evaluate(expr: string): Promise<string> {
      await ensureWorker();
      const id = nextId++;
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          // Only this call is at fault: fail it, kill the worker it wedged,
          // and move every other in-flight call to the fresh one.
          reject(new Error('Giac evaluation timed out'));
          recycleAndRedispatch();
        }, timeoutMs);
        pending.set(id, { expr, resolve, reject, timer, redispatches: 0 });
        // Re-read `child` here: a sibling call's timeout could have recycled
        // between the await above and now. Guard so this call can't send on a
        // killed child and then hang until its own timeout.
        const c = child;
        if (!c) {
          clearTimeout(timer);
          pending.delete(id);
          reject(new Error('Giac worker unavailable'));
          return;
        }
        try {
          c.send({ id, expr });
        } catch (e) {
          clearTimeout(timer);
          pending.delete(id);
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      });
    },
    async warmup(): Promise<void> {
      await ensureWorker();
    },
    isReady(): boolean {
      return ready; // only true after the worker's init handshake, until recycle/dispose
    },
    async dispose(): Promise<void> {
      const c = child;
      child = null;
      readyPromise = null;
      ready = false;
      failAllPending(new Error('worker host disposed'));
      if (c) c.kill('SIGKILL');
    },
  };
}

export type WorkerHost = ReturnType<typeof createWorkerHost>;
