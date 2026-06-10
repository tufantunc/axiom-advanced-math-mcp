import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export interface WorkerHostOptions {
  timeoutMs?: number;
}

interface Pending {
  resolve: (s: string) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_TIMEOUT_MS = Number(process.env.AXIOM_EVAL_TIMEOUT_MS ?? 10_000);
const INIT_TIMEOUT_MS = 30_000;

/**
 * Main-process bridge to the Giac worker (a forked child process). Enforces a
 * hard per-call timeout; on timeout (or worker crash) it kills the worker,
 * fails in-flight calls, and lazily respawns a fresh worker (fresh WASM engine)
 * on the next call. The server process never dies with a wedged evaluation.
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

  function recycle(err: Error): void {
    const c = child;
    child = null;
    readyPromise = null;
    ready = false;
    failAllPending(err);
    if (c) c.kill('SIGKILL');
  }

  function ensureWorker(): Promise<void> {
    if (child && readyPromise) return readyPromise;
    const c = fork(workerPath, [], {
      execArgv,
      // Ignore the child's stdin/stdout (stdout would corrupt the MCP stdio
      // protocol); keep stderr for diagnostics; ipc for messages.
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
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
          const err = new Error('Giac evaluation timed out');
          recycle(err); // kill the wedged worker; next call gets a fresh one
          reject(err);
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
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
