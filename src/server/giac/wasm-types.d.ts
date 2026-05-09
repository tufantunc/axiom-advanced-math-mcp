/**
 * Minimal WebAssembly type declarations for Node.js environments.
 * TypeScript only includes WebAssembly types in "dom" or "webworker" libs,
 * but Node.js supports WebAssembly natively since v8+.
 */

/* eslint-disable @typescript-eslint/no-namespace */
declare namespace WebAssembly {
  interface Module {}

  interface Instance {
    readonly exports: Record<string, unknown>;
  }

  interface WebAssemblyInstantiatedSource {
    instance: Instance;
    module: Module;
  }

  type ImportValue = Function | Global | Memory | Table | number;
  type Imports = Record<string, Record<string, ImportValue>>;

  interface Global {
    value: number;
    valueOf(): number;
  }

  interface Memory {
    readonly buffer: ArrayBuffer;
    grow(delta: number): number;
  }

  interface Table {
    readonly length: number;
    get(index: number): Function | null;
    grow(delta: number): number;
    set(index: number, value: Function | null): void;
  }

  function instantiate(
    bufferSource: ArrayBuffer | Uint8Array,
    importObject?: Imports,
  ): Promise<WebAssemblyInstantiatedSource>;

  function compile(bufferSource: ArrayBuffer | Uint8Array): Promise<Module>;
}
