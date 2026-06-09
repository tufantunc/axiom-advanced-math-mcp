// test/multivariable-optimization.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
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
