import { vi } from 'vitest';

/**
 * `console.error` capture, shared because one change shipped two byte-identical
 * copies of it.
 *
 * Two shapes, deliberately: `captureStderr` restores in a synchronous `finally`,
 * while `beginStderrCapture` stays live across an awaited assertion. Forcing
 * either caller onto the other's shape was the reason the copy existed.
 *
 * test/http-contract.test.ts has an unrelated `captureStderr(child)` that reads a
 * child process's stream; it is a different thing and not folded in here.
 */
export function beginStderrCapture(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  return { lines, restore: () => spy.mockRestore() };
}

/** Runs `fn` with stderr captured, restoring the spy even if `fn` throws. */
export function captureStderr<T>(fn: () => T): { value: T; lines: string[] } {
  const capture = beginStderrCapture();
  try {
    return { value: fn(), lines: capture.lines };
  } finally {
    capture.restore();
  }
}
