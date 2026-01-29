import type { GiacEngine } from './interface.js';
import { NodeGiacEngine } from './node-wrapper.js';

type GiacEngineType = 'native' | 'wasm' | 'auto';

export function createGiacEngine(type: GiacEngineType = 'auto'): GiacEngine {
  if (type === 'native') {
    return new NodeGiacEngine();
  }

  if (type === 'wasm') {
    throw new Error('WASM engine not yet implemented. Use GIAC_ENGINE=native or build from source: npm run build:giac:wasm');
  }

  console.warn('WASM engine not available, falling back to native module');
  return new NodeGiacEngine();
}

export const giacEngine = createGiacEngine(process.env.GIAC_ENGINE as GiacEngineType || 'auto');
