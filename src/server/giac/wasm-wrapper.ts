import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { GiacEngine } from './interface.js';

const _require = createRequire(import.meta.url);
const _dirname = dirname(fileURLToPath(import.meta.url));

let isInitialized = false;
let _caseval: ((expression: string) => string) | null = null;

/**
 * Load the Emscripten-built giac.wasm.js module.
 *
 * The GeoGebra/giac build embeds the WASM binary as a base64 data URI inside
 * the JS file. Node.js fs.readFileSync treats data URIs as file paths,
 * causing ENAMETOOLONG. We work around this by:
 *
 * 1. Reading the JS source and extracting the base64-encoded WASM binary.
 * 2. Running the Emscripten JS via `new Function()` with a pre-configured
 *    `__ggb__giac` object that supplies a custom `instantiateWasm` hook.
 * 3. The hook calls WebAssembly.instantiate with the decoded binary directly,
 *    skipping the broken file-based loading entirely.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadGiacModule(): Promise<any> {
  const wasmJsPath = join(_dirname, 'giac.wasm.js');

  let code: string;
  try {
    code = readFileSync(wasmJsPath, 'utf8');
  } catch {
    throw new Error(
      'Giac WASM file not found.\n\n' + 'To build WASM:\n  npm run build:giac:wasm\n'
    );
  }

  // Extract base64-encoded WASM binary from the embedded data URI
  const marker = 'data:application/wasm;base64,';
  const start = code.indexOf(marker);
  if (start === -1) {
    throw new Error(
      'Could not find embedded WASM binary in giac.wasm.js.\n' +
        'Make sure the file is a real build output: npm run build:giac:wasm'
    );
  }
  const base64Start = start + marker.length;
  const base64End = code.indexOf('"', base64Start);
  const base64Data = code.substring(base64Start, base64End);
  const wasmBinary = Buffer.from(base64Data, 'base64');

  // Pre-configure the Emscripten module object.
  // The code starts with: var __ggb__giac = typeof __ggb__giac != "undefined" ? __ggb__giac : {};
  // When __ggb__giac is a function parameter, typeof returns "object" so it keeps ours.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const giacModule: any = {};

  // Suppress native C stdout/stderr from Giac WASM (e.g. "Warning adding 1 )",
  // "syntax error" messages). Real errors are caught and re-thrown in evaluate().
  giacModule.print = () => {};
  giacModule.printErr = () => {};

  // Custom WASM instantiation — bypasses Emscripten's file-based loading
  giacModule.instantiateWasm = (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    imports: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    successCallback: (instance: any) => void
  ) => {
    WebAssembly.instantiate(wasmBinary, imports)
      .then((result: WebAssembly.WebAssemblyInstantiatedSource) => successCallback(result.instance))
      .catch((err: unknown) => console.error('WASM instantiation failed:', err));
  };

  // Set up onRuntimeInitialized BEFORE executing the module
  const ready = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Giac WASM init timeout (30s)')), 30000);
    giacModule.onRuntimeInitialized = () => {
      clearTimeout(timeout);
      resolve();
    };
  });

  // Execute the Emscripten code with our pre-configured module.
  // new Function wraps the code so __ggb__giac is a parameter — the Emscripten
  // typeof check sees it as defined and keeps our object.
  // We also inject require/module/__dirname for Node.js code paths.
  const wrapper = new Function(
    '__ggb__giac',
    'require',
    'module',
    'exports',
    '__dirname',
    '__filename',
    code
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const moduleExports: any = {};
  wrapper(giacModule, _require, { exports: moduleExports }, moduleExports, _dirname, wasmJsPath);

  await ready;
  return giacModule;
}

export class WasmGiacEngine implements GiacEngine {
  private _ready: boolean = false;

  async initialize(): Promise<void> {
    if (isInitialized) {
      this._ready = true;
      return;
    }

    const giacModule = await loadGiacModule();

    // Bind _caseval via cwrap (GeoGebra build: -s EXPORTED_RUNTIME_METHODS=["cwrap"])
    if (typeof giacModule.cwrap === 'function') {
      _caseval = giacModule.cwrap('caseval', 'string', ['string']);
    } else if (typeof giacModule.caseval === 'function') {
      _caseval = giacModule.caseval.bind(giacModule);
    } else {
      throw new Error(
        'caseval function not found in Giac WASM module.\n' +
          'Build flags: -s EXPORTED_FUNCTIONS=[\'_caseval\'] -s EXPORTED_RUNTIME_METHODS=["cwrap"]'
      );
    }

    isInitialized = true;
    this._ready = true;
  }

  async evaluate(expression: string): Promise<string> {
    if (!this._ready || !_caseval) {
      throw new Error('Giac WASM engine not initialized. Call initialize() first.');
    }
    try {
      return _caseval(expression);
    } catch (error) {
      // Keep the constructor name, not just the message. A WebAssembly trap
      // carries its identity in `name` (`RuntimeError`) while `message` is the
      // bare reason ("memory access out of bounds"), so flattening to `.message`
      // left the worker's trap classifier matching Emscripten's exact wording
      // and nothing else.
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      throw new Error(`Giac WASM evaluation error: ${detail}`);
    }
  }

  /**
   * Clears Giac's global session state (`sto` bindings, `assume`
   * hypotheses). No-op when the engine was never initialized — a fresh
   * engine is already pristine.
   *
   * In the normal (worker-host) topology the host reaches this by sending
   * `restart` down the IPC channel like any other expression; this method is
   * what makes the engine honor the interface when used in-process.
   */
  async reset(): Promise<void> {
    if (!this._ready || !_caseval) return;
    await this.evaluate('restart');
  }

  isReady(): boolean {
    return this._ready;
  }
}
