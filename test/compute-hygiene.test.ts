import { describe, it, expect, vi } from 'vitest';
import { applyHygiene } from '../src/server/tools/compute/hygiene.js';
import type { ComputeEnvelope } from '../src/server/tools/compute/types.js';

const baseEnvelope = (display: string, latex?: string): ComputeEnvelope => ({
  success: true,
  result_type: 'symbolic',
  display,
  latex,
  data: {},
  method: 'test',
});

describe('applyHygiene — Unicode normalize', () => {
  it('replaces Unicode in display', async () => {
    const env = baseEnvelope('√(1-x^2)');
    const fakeEngine = { evaluate: vi.fn() };
    const out = await applyHygiene(env, fakeEngine);
    expect(out.display).toBe('sqrt(1-x^2)');
    // No simplify call expected: result is already clean after Unicode swap.
    expect(fakeEngine.evaluate).not.toHaveBeenCalled();
  });

  it('replaces Unicode in latex too when present', async () => {
    const env = baseEnvelope('√(2)', '\\sqrt{2}');
    const fakeEngine = { evaluate: vi.fn() };
    const out = await applyHygiene(env, fakeEngine);
    expect(out.display).toBe('sqrt(2)');
    expect(out.latex).toBe('\\sqrt{2}'); // already ASCII
  });
});

describe('applyHygiene — silent-failure warning', () => {
  it('appends warning note to envelope when result is empty', async () => {
    const env = baseEnvelope('Result: []');
    const fakeEngine = { evaluate: vi.fn() };
    const out = await applyHygiene(env, fakeEngine);
    expect(out.warnings).toBeDefined();
    expect(out.warnings![0]).toMatch(/empty result/);
  });

  it('appends warning when GIAC_ERROR present', async () => {
    const env = baseEnvelope('GIAC_ERROR: bad arg');
    const fakeEngine = { evaluate: vi.fn() };
    const out = await applyHygiene(env, fakeEngine);
    expect(out.warnings![0]).toMatch(/Giac error/);
  });

  it('no warning on healthy result', async () => {
    const env = baseEnvelope('3*x^2');
    const fakeEngine = { evaluate: vi.fn() };
    const out = await applyHygiene(env, fakeEngine);
    expect(out.warnings).toBeUndefined();
  });
});

describe('applyHygiene — optional simplify', () => {
  it('calls simplify when trigger fires and uses shorter result', async () => {
    const env = baseEnvelope('-1/2*2*x*(sqrt(1-x^2))^-1');
    const fakeEngine = {
      evaluate: vi.fn().mockResolvedValue('-x/sqrt(1-x^2)'),
    };
    const out = await applyHygiene(env, fakeEngine);
    expect(fakeEngine.evaluate).toHaveBeenCalledWith(
      'simplify(-1/2*2*x*(sqrt(1-x^2))^-1)'
    );
    expect(out.display).toBe('-x/sqrt(1-x^2)');
  });

  it('keeps original when simplified is longer', async () => {
    const env = baseEnvelope('(x+1)^-1');
    const fakeEngine = {
      evaluate: vi.fn().mockResolvedValue('1/(x+1) + extra_stuff_longer'),
    };
    const out = await applyHygiene(env, fakeEngine);
    expect(out.display).toBe('(x+1)^-1');
  });

  it('keeps original when simplify throws', async () => {
    const env = baseEnvelope('(x+1)^-1');
    const fakeEngine = {
      evaluate: vi.fn().mockRejectedValue(new Error('Giac timeout')),
    };
    const out = await applyHygiene(env, fakeEngine);
    expect(out.display).toBe('(x+1)^-1');
  });
});
