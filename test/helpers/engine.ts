import { vi } from 'vitest';
import { giacEngine } from '../../src/server/giac/index.js';

/**
 * The real engine, except that a command matching `pattern` answers `printed`
 * — or throws it, when it is an Error. Restore with vi.restoreAllMocks().
 */
export function stubEngine(pattern: RegExp, printed: string | Error): void {
  const evaluate = giacEngine.evaluate.bind(giacEngine);
  vi.spyOn(giacEngine, 'evaluate').mockImplementation(async (expr: string) => {
    if (!pattern.test(expr)) return evaluate(expr);
    if (printed instanceof Error) throw printed;
    return printed;
  });
}

/**
 * Every engine call that failed while `run` ran. A trap recycles the worker
 * and the next call succeeds on a fresh one, so the answer alone cannot tell
 * a clean refusal from one that took the shared worker down first.
 * Restore with vi.restoreAllMocks().
 */
export async function engineFailures(run: () => Promise<void>): Promise<string[]> {
  const evaluate = giacEngine.evaluate.bind(giacEngine);
  const failures: string[] = [];
  vi.spyOn(giacEngine, 'evaluate').mockImplementation(async (expr: string) => {
    try {
      return await evaluate(expr);
    } catch (error) {
      failures.push(String(error));
      throw error;
    }
  });
  await run();
  return failures;
}
