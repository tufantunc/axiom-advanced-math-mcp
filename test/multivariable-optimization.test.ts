// test/multivariable-optimization.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import { giacEngine } from '../src/server/giac/index.js';
import { optimizationHandler } from '../src/server/tools/multivariable/optimization.js';

beforeAll(async () => {
  await giacEngine.initialize();
}, 60000);

const text = (r: { content: { text: string }[] }) => r.content.map((c) => c.text).join('\n');

describe('multivariable optimization — tangent_plane & directional_derivative', () => {
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
    expect(text(r)).toContain('2');
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
});
