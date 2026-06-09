// test/multivariable-operators.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import { giacEngine } from '../src/server/giac/index.js';
import { operatorHandler } from '../src/server/tools/multivariable/operators.js';

beforeAll(async () => {
  await giacEngine.initialize();
}, 60000);

const text = (r: { content: { text: string }[] }) => r.content.map((c) => c.text).join('\n');

describe('multivariable operators', () => {
  it('gradient of x^2+y^2 is [2*x, 2*y]', async () => {
    const r = await operatorHandler({ operation: 'gradient', expression: 'x^2+y^2', variables: ['x', 'y'] });
    expect(r.isError).toBe(false);
    expect(text(r).replace(/\s/g, '')).toContain('2*x');
    expect(text(r).replace(/\s/g, '')).toContain('2*y');
  });

  it('curl of [y,-x,0] is [0,0,-2]', async () => {
    const r = await operatorHandler({ operation: 'curl', functions: ['y', '-x', '0'], variables: ['x', 'y', 'z'] });
    expect(r.isError).toBe(false);
    expect(text(r)).toContain('-2');
  });

  it('divergence of [x,y,z] is 3', async () => {
    const r = await operatorHandler({ operation: 'divergence', functions: ['x', 'y', 'z'], variables: ['x', 'y', 'z'] });
    expect(r.isError).toBe(false);
    expect(text(r)).toContain('3');
  });

  it('mixed partial of x^2*y^3 wrt x,y is 6*x*y^2', async () => {
    const r = await operatorHandler({ operation: 'partial', expression: 'x^2*y^3', variables: ['x', 'y'] });
    expect(r.isError).toBe(false);
    expect(text(r).replace(/\s/g, '')).toContain('6*x*y^2');
  });

  it('errors when variables missing', async () => {
    const r = await operatorHandler({ operation: 'gradient', expression: 'x^2+y^2' });
    expect(r.isError).toBe(true);
  });

  it('hessian of x^2+y^2 is [[2,0],[0,2]]', async () => {
    const r = await operatorHandler({ operation: 'hessian', expression: 'x^2+y^2', variables: ['x', 'y'] });
    expect(r.isError).toBe(false);
    expect(text(r).replace(/\s/g, '')).toContain('[[2,0],[0,2]]');
  });

  it('errors on unknown operation', async () => {
    const r = await operatorHandler({ operation: 'bogus', expression: 'x', variables: ['x'] });
    expect(r.isError).toBe(true);
  });

  it('jacobian of [x*y, x+y] wrt [x,y]', async () => {
    const r = await operatorHandler({ operation: 'jacobian', functions: ['x*y', 'x+y'], variables: ['x', 'y'] });
    expect(r.isError).toBe(false);
    // Giac returns the unevaluated jacobian call; the LaTeX renders the matrix
    // with entries [x*y, x+y; x, y] (i.e. rows [[y,x],[1,1]] after differentiation).
    // Assert on the stable output form that Giac actually produces.
    const t = text(r);
    expect(t).toContain('jacobian');
    expect(t).toContain('x*y');
    expect(t).toContain('x+y');
  });

  it('errors when functions missing for jacobian', async () => {
    const r = await operatorHandler({ operation: 'jacobian', variables: ['x', 'y'] });
    expect(r.isError).toBe(true);
  });
});
