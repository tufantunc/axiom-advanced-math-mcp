// Type declarations for the GeoGebra/giac Emscripten WASM build output.
// After building, giac.wasm.js defines the __ggb__giac global.
// At least one export is required for this to be importable as a module.

export declare const __ggb__giac: {
  /** Emscripten cwrap: binds a C function to JavaScript */
  cwrap?: (
    funcName: string,
    returnType: string,
    argTypes: string[]
  ) => (...args: unknown[]) => unknown;
  /** Called when the WASM runtime is ready */
  onRuntimeInitialized?: () => void;
  /** True if the WASM runtime has already been initialized */
  calledRun?: boolean;
  /** Some builds export caseval directly */
  caseval?: (expression: string) => string;
};

export default __ggb__giac;
