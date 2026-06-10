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
  isReady(): boolean {
    return host.isReady();
  },
};
