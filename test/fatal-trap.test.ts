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
    // These three constrain nothing, and are kept only to record why. A Giac
    // diagnostic is a RETURN value, and `Giac evaluation timed out` is built in
    // the parent process — none of the three can reach this predicate at all, so
    // asserting `false` on them is free.
    ['GIAC_ERROR: Bad Argument Value'],
    ['undef'],
    ['Giac evaluation timed out'],
  ])('does not treat the unreachable %s as fatal', (message) => {
    expect(isFatalWasmTrap(message)).toBe(false);
  });

  it.each([
    // These do the work: the shape the predicate actually receives is
    // `Giac WASM evaluation error: <Name>: <text>`, and each row is chosen so
    // that the clause nearest to matching it is what must NOT.
    //
    // The first is the dangerous one. V8 throws `RangeError: Invalid string
    // length` when a returned string passes the maximum length — and this module
    // deliberately handles replies of 677,259 characters. Widening the
    // stack-exhaustion clause to `/RangeError/` would recycle the shared worker
    // on a large but perfectly recoverable reply, rejecting every concurrent
    // caller, and nothing here would have failed.
    ['Giac WASM evaluation error: RangeError: Invalid string length'],
    ['Giac WASM evaluation error: Error: caught exception in caseval'],
    ['Giac WASM engine not initialized. Call initialize() first.'],
  ])('does not treat the reachable %s as fatal', (message) => {
    expect(isFatalWasmTrap(message)).toBe(false);
  });
});
