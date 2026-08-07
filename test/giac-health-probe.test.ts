import { describe, it, expect } from 'vitest';
import {
  createGiacHealthProbe,
  HEALTH_PROBE_TIMEOUT_MS,
} from '../src/server/giac/health-probe.js';

const silent = () => {};

describe('createGiacHealthProbe', () => {
  it('reports healthy when the engine warms up and is ready', async () => {
    const probe = createGiacHealthProbe(
      { initialize: async () => {}, isReady: () => true },
      50,
      silent
    );
    expect(await probe()).toBe(true);
  });

  it('reports unhealthy when the engine warms up but is not ready', async () => {
    const probe = createGiacHealthProbe(
      { initialize: async () => {}, isReady: () => false },
      50,
      silent
    );
    expect(await probe()).toBe(false);
  });

  it('reports unhealthy instead of hanging when the warmup never settles', async () => {
    // The real failure mode: with the worker down, initialize() can run to the
    // worker host's 30 s init timeout. /health must answer long before that.
    const probe = createGiacHealthProbe(
      { initialize: () => new Promise<void>(() => {}), isReady: () => true },
      30,
      silent
    );
    const started = Date.now();
    expect(await probe()).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('reports unhealthy when the warmup rejects, without throwing', async () => {
    const probe = createGiacHealthProbe(
      {
        initialize: () => Promise.reject(new Error('fork failed')),
        isReady: () => true,
      },
      50,
      silent
    );
    await expect(probe()).resolves.toBe(false);
  });

  it('re-probes on every call, so a recovered engine flips back to healthy', async () => {
    let up = false;
    const probe = createGiacHealthProbe(
      { initialize: async () => {}, isReady: () => up },
      50,
      silent
    );
    expect(await probe()).toBe(false);
    up = true;
    expect(await probe()).toBe(true);
  });

  it('defaults to a short bound, not the worker host 30 s init timeout', () => {
    expect(HEALTH_PROBE_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
  });
});
