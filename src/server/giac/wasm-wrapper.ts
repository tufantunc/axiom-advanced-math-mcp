import type { GiacEngine } from './interface.js';
// Module will be populated after running 'npm run build:giac:wasm'
import './giac.wasm.js';

var __ggb__giac: any;

let isInitialized = false;

export class WasmGiacEngine implements GiacEngine {
  private _ready: boolean = false;

  async initialize(): Promise<void> {
    if (isInitialized) {
      this._ready = true;
      return;
    }

    try {
      if (typeof __ggb__giac !== 'undefined' && __ggb__giac.caseval) {
        isInitialized = true;
        this._ready = true;
        console.log('✅ Giac WASM initialized successfully');
        return;
      }

      throw new Error(
        'Giac WASM stub not available.\n\n' +
          'To build Giac WASM from source: npm run build:giac:wasm\n\n' +
          'To use native giac module: npm install giac'
      );
    } catch (error) {
      console.warn(`Failed to load Giac WASM stub: ${error}`);
    }
  }

  evaluate(expression: string): Promise<string> {
    if (!this._ready || !isInitialized) {
      throw new Error('Giac WASM engine not initialized. Call initialize() first.');
    }

    try {
      if (typeof __ggb__giac !== 'undefined' && __ggb__giac.caseval) {
        const result = __ggb__giac.caseval(expression);
        return Promise.resolve(result);
      } else {
        throw new Error('Giac WASM stub does not have caseval function.');
      }
    } catch (error) {
      throw new Error(`Giac WASM evaluation error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  isReady(): boolean {
    return this._ready;
  }
}

export const wasmGiacEngine = new WasmGiacEngine();
