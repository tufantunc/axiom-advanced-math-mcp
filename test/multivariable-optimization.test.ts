// test/multivariable-optimization.test.ts
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { giacEngine } from '../src/server/giac/index.js';
import { optimizationHandler } from '../src/server/tools/multivariable/optimization.js';

beforeAll(async () => {
  await giacEngine.initialize();
}, 60000);

const text = (r: { content: { text: string }[] }) => r.content.map((c) => c.text).join('\n');

describe('multivariable optimization', () => {
  it('tangent plane of x^2+y^2 at (1,1)', async () => {
    // z = 2 + 2(x-1) + 2(y-1) = 2x + 2y - 2
    const r = await optimizationHandler({
      operation: 'tangent_plane',
      expression: 'x^2+y^2',
      variables: ['x', 'y'],
      point: ['1', '1'],
    });
    expect(r.isError).toBe(false);
    const flat = text(r).replace(/\s/g, '');
    expect(flat).toContain('2*x');
    expect(flat).toContain('2*y');
  });

  it('directional derivative of x^2+y^2 at (1,1) along (1,0) is 2', async () => {
    // grad = [2,2] at (1,1); unit dir (1,0); Dv = 2
    const r = await optimizationHandler({
      operation: 'directional_derivative',
      expression: 'x^2+y^2',
      variables: ['x', 'y'],
      point: ['1', '1'],
      direction: ['1', '0'],
    });
    expect(r.isError).toBe(false);
    expect(text(r)).toMatch(/Result:\s*2\b/);
    // Notes are user-visible contract (stdout doctrine): the point, the
    // direction and the computed norm belong in the response — a dropped
    // note survived the entire suite by mutation.
    expect(text(r)).toContain('Point: (1, 1)');
    expect(text(r)).toContain('Direction: [1, 0]');
    expect(text(r)).toContain('‖direction‖ = 1');
  });

  it('errors on zero direction vector', async () => {
    const r = await optimizationHandler({
      operation: 'directional_derivative',
      expression: 'x^2+y^2',
      variables: ['x', 'y'],
      point: ['1', '1'],
      direction: ['0', '0'],
    });
    expect(r.isError).toBe(true);
  });

  it.each(['tangent_plane', 'directional_derivative', 'critical_points', 'lagrange'])(
    'resolves an engine throw from %s into an error response, never a rejection',
    async (op) => {
      // The dispatch must be `return await` — a bare `return promise`
      // escapes the handler's catch, and callers see a rejection instead
      // of the error envelope (found by review on the Giac-undef path).
      // Every dispatch is pinned: a future "cleanup" dropping one await
      // must fail here, not in production. The engine is forced to reject
      // so all four paths throw deterministically.
      const spy = vi.spyOn(giacEngine, 'evaluate').mockRejectedValue(new Error('engine down'));
      try {
        const r = await optimizationHandler({
          operation: op,
          expression: 'x^2+y^2',
          variables: ['x', 'y'],
          ...(op === 'tangent_plane' || op === 'directional_derivative' ? { point: ['1', '1'] } : {}),
          ...(op === 'directional_derivative' ? { direction: ['1', '0'] } : {}),
          ...(op === 'lagrange' ? { constraint: 'x+y' } : {}),
        });
        expect(r.isError).toBe(true);
        expect(r.content[0].text).toContain('engine down');
      } finally {
        spy.mockRestore();
      }
    }
  );

  it('errors when point length != variables length', async () => {
    const r = await optimizationHandler({
      operation: 'tangent_plane',
      expression: 'x^2+y^2',
      variables: ['x', 'y'],
      point: ['1'],
    });
    expect(r.isError).toBe(true);
  });

  it('critical point of x^2+y^2 is a local minimum at (0,0)', async () => {
    const r = await optimizationHandler({
      operation: 'critical_points',
      expression: 'x^2+y^2',
      variables: ['x', 'y'],
    });
    expect(r.isError).toBe(false);
    const t = text(r).toLowerCase();
    expect(t).toContain('minimum');
  });

  it('critical point of x^2-y^2 is a saddle at (0,0)', async () => {
    const r = await optimizationHandler({
      operation: 'critical_points',
      expression: 'x^2-y^2',
      variables: ['x', 'y'],
    });
    expect(r.isError).toBe(false);
    expect(text(r).toLowerCase()).toContain('saddle');
  });

  it('critical point of -(x^2+y^2) is a local maximum at (0,0)', async () => {
    const r = await optimizationHandler({
      operation: 'critical_points',
      expression: '-(x^2+y^2)',
      variables: ['x', 'y'],
    });
    expect(r.isError).toBe(false);
    const t = text(r).toLowerCase();
    expect(t).toContain('maximum');
  });

  it('fractional discriminant: critical point of x^2/3+y^2 is a local minimum (evalf fix)', async () => {
    const r = await optimizationHandler({
      operation: 'critical_points',
      expression: 'x^2/3+y^2',
      variables: ['x', 'y'],
    });
    expect(r.isError).toBe(false);
    expect(text(r).toLowerCase()).toContain('minimum');
  });

  it('errors for 1-variable critical_points', async () => {
    const r = await optimizationHandler({
      operation: 'critical_points',
      expression: 'x^2',
      variables: ['x'],
    });
    expect(r.isError).toBe(true);
  });

  it('lagrange: max xy s.t. x+y=1 yields (1/2, 1/2)', async () => {
    const r = await optimizationHandler({
      operation: 'lagrange',
      expression: 'x*y',
      constraint: 'x+y',
      value: '1',
      variables: ['x', 'y'],
    });
    expect(r.isError).toBe(false);
    const flat = text(r).replace(/\s/g, '');
    expect(flat).toContain('1/2');
  });

  it('lagrange: min x^2+y^2+z^2 s.t. x+y+z=3 yields (1,1,1)', async () => {
    const r = await optimizationHandler({
      operation: 'lagrange',
      expression: 'x^2+y^2+z^2',
      constraint: 'x+y+z',
      value: '3',
      variables: ['x', 'y', 'z'],
    });
    expect(r.isError).toBe(false);
    expect(text(r).replace(/\s/g, '')).toContain('(1,1,1)');
  });

  it('critical_points of x^3-3*x+y^2 finds (1,0) min and (-1,0) saddle', async () => {
    const r = await optimizationHandler({
      operation: 'critical_points',
      expression: 'x^3-3*x+y^2',
      variables: ['x', 'y'],
    });
    expect(r.isError).toBe(false);
    const t = text(r).toLowerCase();
    expect(t).toContain('minimum');
    expect(t).toContain('saddle');
  });

  it('lagrange errors when constraint missing', async () => {
    const r = await optimizationHandler({
      operation: 'lagrange',
      expression: 'x*y',
      value: '1',
      variables: ['x', 'y'],
    });
    expect(r.isError).toBe(true);
  });
});
