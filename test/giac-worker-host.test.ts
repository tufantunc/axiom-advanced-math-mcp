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

describe('giac worker host — a fatal trap fails only the call that caused it', () => {
  it('the trap call gets its own error; the next call reaches the fresh worker', async () => {
    const h = createWorkerHost({ timeoutMs: 30000 });
    try {
      await h.warmup();

      // Measured: a huge-exponent initial condition traps the WASM engine
      // fatally, so worker.ts answers THIS call with the trap text and only
      // then exits on purpose.
      await expect(h.evaluate("desolve([y'=y,y(0)=(2^1000)^1000],x,y)")).rejects.toThrow(
        /Giac WASM evaluation error/
      );

      // This call is dispatched in the gap between the trap answer and the
      // 'exit' event — a promise continuation always beats the event loop —
      // so on the old exit path it sat in `pending` when failAllPending ran.
      // Pre-fix it was rejected with "Giac worker exited (code 1)", a reason
      // that was not this caller's; it is now re-sent to the fresh worker.
      await expect(h.evaluate("desolve([y'=y,y(0)=1],x,y)")).resolves.toBe('exp(x)');
    } finally {
      await h.dispose();
    }
  }, 60000);
});
