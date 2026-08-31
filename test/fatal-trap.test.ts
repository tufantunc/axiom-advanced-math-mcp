import { describe, it, expect } from 'vitest';
import { isFatalWasmTrap } from '../src/server/giac/fatal-trap.js';

describe('isFatalWasmTrap', () => {
  it.each([
    ['Giac WASM evaluation error: RuntimeError: memory access out of bounds'],
    ['RuntimeError: unreachable'],
    ['table index is out of bounds'],
    // Two shapes that are just as unrecoverable and were not matched, so the
    // worker stayed up serving a corrupted engine instead of being recycled.
    ['Giac WASM evaluation error: RangeError: Maximum call stack size exceeded'],
    ['Giac WASM evaluation error: [object WebAssembly.Exception]'],
  ])('treats %s as fatal', (message) => {
    expect(isFatalWasmTrap(message)).toBe(true);
  });

  it.each([
    // An ordinary diagnostic is a RETURN value here, not an exception, so a user
    // typo must never recycle the engine.
    ['GIAC_ERROR: Bad Argument Value'],
    ['undef'],
    ['Giac evaluation timed out'],
  ])('does not treat %s as fatal', (message) => {
    expect(isFatalWasmTrap(message)).toBe(false);
  });
});
