import { WasmGiacEngine } from './wasm-wrapper.js';
import type { GiacEngine } from './interface.js';

const engine = new WasmGiacEngine();
let initPromise: Promise<void> | null = null;

function ensureInit(): Promise<void> {
  if (!initPromise) {
    initPromise = engine.initialize();
  }
  return initPromise;
}

export const giacEngine: GiacEngine = {
  initialize: ensureInit,
  async evaluate(expression: string): Promise<string> {
    await ensureInit();
    return engine.evaluate(expression);
  },
  isReady(): boolean {
    return engine.isReady();
  },
};
