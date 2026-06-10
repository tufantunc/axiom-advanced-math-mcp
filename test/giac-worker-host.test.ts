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
