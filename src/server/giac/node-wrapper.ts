import type { GiacEngine } from './interface.js';

let giacInstance: any = null;

export class NodeGiacEngine implements GiacEngine {
  private _ready: boolean = false;

  async initialize(): Promise<void> {
    try {
      giacInstance = await import('giac');
      this._ready = true;
      console.log('✅ Giac native module loaded successfully');
    } catch (error) {
      throw new Error(
        `Failed to load giac native module. Error: ${error instanceof Error ? error.message : String(error)}\n\n` +
        `To install giac native module:\n` +
        `  - Linux: sudo apt install libgmp-dev libmpfr-dev\n` +
        `  - Mac: sudo port install gmp mpfr\n` +
        `  - Then run: npm install giac`
      );
    }
  }

  evaluate(expression: string): Promise<string> {
    if (!this._ready || !giacInstance) {
      throw new Error('Giac engine not initialized. Call initialize() first.');
    }

    try {
      return giacInstance.evaluate(expression);
    } catch (error) {
      throw new Error(
        `Giac evaluation error: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  isReady(): boolean {
    return this._ready;
  }
}

export const giacEngine = new NodeGiacEngine();
