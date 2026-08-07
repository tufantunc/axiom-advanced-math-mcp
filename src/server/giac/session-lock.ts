import { AsyncLocalStorage } from 'node:async_hooks';
import { giacEngine } from './index.js';

/**
 * Minimal FIFO async mutex — a promise chain, no dependency.
 *
 * `acquire()` resolves once every earlier acquirer has released, and returns
 * that holder's release function. Waiters are served in call order: each one
 * links itself onto the tail before awaiting, so the queue cannot be
 * reordered or starved.
 */
export function createMutex() {
  let tail: Promise<void> = Promise.resolve();

  return {
    async acquire(): Promise<() => void> {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const previous = tail;
      // Link before awaiting, so the next acquire() queues behind THIS holder
      // even if it calls acquire() in the same tick.
      tail = previous.then(() => held);
      await previous;
      let released = false;
      return () => {
        // Idempotent: a double release must not hand the lock to two holders.
        if (released) return;
        released = true;
        release();
      };
    },
  };
}

const casSession = createMutex();

/**
 * True for the duration of a handler that already holds the CAS session lock.
 * Follows the async call tree, so a nested tool handler (should one ever be
 * added) sees it and passes straight through instead of deadlocking on a lock
 * its own caller is holding.
 */
const insideSession = new AsyncLocalStorage<true>();

/**
 * Runs one MCP tool call as an exclusive CAS session: reset the engine, then
 * run the handler, with no other tool call interleaving in between.
 *
 * `reset()` alone (fix wave 1) only isolates *sequential* calls. A single
 * `compute` makes several `evaluate()` calls — the computation, its `latex`,
 * its verification pass — so two overlapping tool calls interleave their
 * evaluations against the one shared worker, and one call's `sto`/`assume`
 * lands between another's reset and its own evaluation. Over the stateless,
 * multi-client HTTP transport that overlap is the normal case: measured, a
 * concurrent `sto(5,c1)` + `simplify(c1+1)` returned `6`.
 *
 * Serializing whole tool calls costs no real throughput. The Giac worker is a
 * single forked child running a synchronous WASM engine, so concurrent
 * evaluations already queue on it; the lock only moves the queueing to the
 * correct granularity — whole tool calls instead of individual `evaluate()`s.
 *
 * The lock is released on every path, including a throwing handler and a Giac
 * call that times out.
 */
export function withGiacSession<A, R>(handler: (args: A) => Promise<R>): (args: A) => Promise<R> {
  return async (args: A): Promise<R> => {
    if (insideSession.getStore()) return handler(args);

    const release = await casSession.acquire();
    try {
      await giacEngine.reset();
      return await insideSession.run(true, () => handler(args));
    } finally {
      release();
    }
  };
}
