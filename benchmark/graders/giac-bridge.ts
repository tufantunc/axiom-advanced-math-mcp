export interface GiacEngineLike {
  evaluate(expression: string): Promise<string>;
}

export interface GiacBridge {
  evaluate(expr: string): Promise<string | null>;
}

export interface GiacBridgeOptions {
  engine: GiacEngineLike;
  timeoutMs?: number;
}

/**
 * Wraps a Giac-like engine with an in-memory cache and a per-call timeout.
 * Returns `null` on timeout or engine error so callers can degrade gracefully.
 */
export function createGiacBridge(opts: GiacBridgeOptions): GiacBridge {
  const cache = new Map<string, string>();
  const timeoutMs = opts.timeoutMs ?? 2000;

  return {
    async evaluate(expr: string): Promise<string | null> {
      const key = expr.trim();
      const cached = cache.get(key);
      if (cached !== undefined) return cached;

      try {
        const result = await Promise.race([
          opts.engine.evaluate(key),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
        ]);
        if (result === null) return null;
        cache.set(key, result);
        return result;
      } catch {
        return null;
      }
    },
  };
}

/**
 * Default bridge backed by the project's Giac WASM engine.
 * Lazy — does not initialize Giac unless `evaluate` is actually called.
 */
let defaultBridge: GiacBridge | null = null;
export async function getDefaultGiacBridge(): Promise<GiacBridge> {
  if (defaultBridge) return defaultBridge;
  const { giacEngine } = await import('../../src/server/giac/wrapper.js');
  await giacEngine.initialize();
  defaultBridge = createGiacBridge({ engine: giacEngine, timeoutMs: 2000 });
  return defaultBridge;
}
