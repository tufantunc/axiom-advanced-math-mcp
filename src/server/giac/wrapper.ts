import { createWorkerHost } from './worker-host.js';
import type { GiacEngine } from './interface.js';

// Singleton host: one worker (one WASM engine) per process, recycled on
// timeout/crash by the host. Public GiacEngine interface is unchanged.
const host = createWorkerHost();

export const giacEngine: GiacEngine = {
  initialize: () => host.warmup(),
  async evaluate(expression: string): Promise<string> {
    await host.warmup();
    return host.evaluate(expression);
  },
  /**
   * Wipes Giac's global session state via `restart` (~1 ms measured).
   *
   * Goes through `host.evaluate` rather than a side channel so it inherits
   * the same timeout / pending-map bookkeeping as any other evaluation.
   *
   * No-op when no worker is up: a worker that was never spawned (or was
   * recycled) starts from a pristine engine on its next call anyway, so
   * forcing a spawn here would cost a WASM init to accomplish nothing.
   */
  async reset(): Promise<void> {
    if (!host.isReady()) return;
    await host.evaluate('restart');
  },
  isReady(): boolean {
    return host.isReady();
  },
};
