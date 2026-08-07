import type { GiacEngine } from './interface.js';

/**
 * How long /health waits for the engine before giving up on it.
 *
 * `initialize()` is not bounded: a worker that is down takes a full WASM init,
 * whose own ceiling is the worker host's 30 s init timeout. A health endpoint
 * must answer promptly, so an init that has not finished in this window is
 * reported unhealthy rather than waited on. Measured warm init is ~112 ms, so
 * 2 s is generous — it only expires when something is genuinely wrong.
 */
export const HEALTH_PROBE_TIMEOUT_MS = 2_000;

const TIMED_OUT = Symbol('probe-timeout');

/**
 * Builds the active /health probe.
 *
 * Active, because `isReady()` alone latches: it goes false on any worker
 * recycle (a routine CAS timeout is enough) and only goes true again when the
 * next `evaluate()` lazily respawns the worker — /health never evaluates, so a
 * fully working server would report 503 forever. Driving `initialize()` makes
 * the probe perform the respawn itself.
 *
 * On timeout the warmup is deliberately left running: it *is* the respawn, and
 * the next probe will observe the engine it produced.
 */
export function createGiacHealthProbe(
  engine: Pick<GiacEngine, 'initialize' | 'isReady'>,
  timeoutMs: number = HEALTH_PROBE_TIMEOUT_MS,
  log: (message: string, detail?: unknown) => void = (m, d) =>
    d === undefined ? console.error(m) : console.error(m, d)
): () => Promise<boolean> {
  return async function probe(): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const bounded = new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
        // Never hold the event loop open just to answer a health probe.
        timer.unref?.();
      });
      const warmed = Promise.resolve()
        .then(() => engine.initialize())
        .then(() => engine.isReady())
        .catch((err: unknown) => {
          log('[http] health probe: giac warmup failed:', err);
          return false;
        });

      const outcome = await Promise.race([warmed, bounded]);
      if (outcome === TIMED_OUT) {
        log(`[http] health probe: giac warmup exceeded ${timeoutMs}ms`);
        return false;
      }
      return outcome;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}
