/**
 * Whether an evaluation error left the WASM instance unusable.
 *
 * A trap is not recoverable: the instance stays trapped and every later
 * `_caseval` throws the same thing, so one bad expression silently kills the CAS
 * for the life of the process while `isReady()` keeps reporting true. The worker
 * exits on a match so the host respawns it.
 *
 * The distinction that matters is the one in the other direction: Giac's own
 * diagnostics are RETURN VALUES (`GIAC_ERROR: ...`, `undef`), not exceptions, so
 * an ordinary syntax error never reaches this predicate. Only a genuine WASM
 * trap does — and a false positive here would recycle the engine on a user typo.
 *
 * Lives in its own module because `worker.ts` initializes the WASM engine and
 * registers IPC handlers at import time, so it cannot be imported by a test.
 */
export function isFatalWasmTrap(message: string): boolean {
  return (
    /memory access out of bounds/i.test(message) ||
    /unreachable/i.test(message) ||
    /table index is out of bounds/i.test(message) ||
    // wasm-wrapper prefixes the error's constructor name, so a trap that
    // identifies itself by type rather than by one of the phrases above is
    // still caught. Matching on Emscripten's exact wording alone would tie
    // detection to a build detail.
    /\bRuntimeError\b/.test(message)
  );
}
