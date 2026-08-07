import { describe, it, expect, afterAll } from 'vitest';
import { createWorkerHost } from '../src/server/giac/worker-host.js';

describe('giac worker host — watchdog + recycle', () => {
  const host = createWorkerHost({ timeoutMs: 3000 });
  afterAll(async () => {
    await host.dispose();
  });

  it('evaluates normally through the worker', async () => {
    expect(await host.evaluate('diff(x^3, x)')).toBe('3*x^2');
  }, 60000);

  it('times out a wedged evaluation and recovers on the next call', async () => {
    await expect(host.evaluate('__AXIOM_TEST_HANG__')).rejects.toThrow('Giac evaluation timed out');
    // Recycle proof: a fresh worker serves the next call.
    expect(await host.evaluate('1+1')).toBe('2');
  }, 60000);
});

describe('giac worker host — a timeout fails only the call that timed out', () => {
  it('re-dispatches other in-flight calls to the fresh worker instead of failing them', async () => {
    const h = createWorkerHost({ timeoutMs: 6000 });
    try {
      await h.warmup();

      const wedged = h.evaluate('__AXIOM_TEST_HANG__');

      // Enqueue the innocent call well after the wedged one so its own
      // deadline (enqueue + 6 s) sits comfortably past the recycle, which
      // has to fork and initialize a fresh worker before it can be served.
      await new Promise((r) => setTimeout(r, 4000));
      const innocent = h.evaluate('diff(x^3, x)');

      await expect(wedged).rejects.toThrow('Giac evaluation timed out');
      // Pre-fix this rejected too: the timeout called failAllPending(), which
      // rejected every entry in the pending map, not just the offender.
      expect(await innocent).toBe('3*x^2');
    } finally {
      await h.dispose();
    }
  }, 60000);
});
