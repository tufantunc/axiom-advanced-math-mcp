import { describe, it, expect } from 'vitest';
import { route } from '../src/server/tools/compute/router.js';

describe('Router — multivariable', () => {
  it('routes gradient() to multivariable', () => {
    const r = route('gradient(x^2+y^2, [x, y])');
    expect(r.handler).toBe('multivariable');
    expect(r.args.operation).toBe('gradient');
    expect(r.args.expression).toBe('x^2+y^2');
    expect(r.args.variables).toEqual(['x', 'y']);
  });

  it('routes curl() to multivariable with functions', () => {
    const r = route('curl([y, -x, 0], [x, y, z])');
    expect(r.handler).toBe('multivariable');
    expect(r.args.operation).toBe('curl');
    expect(r.args.functions).toEqual(['y', '-x', '0']);
    expect(r.args.variables).toEqual(['x', 'y', 'z']);
  });

  it('routes partial() to multivariable', () => {
    const r = route('partial(x^2*y^3, x, y)');
    expect(r.handler).toBe('multivariable');
    expect(r.args.operation).toBe('partial');
    expect(r.args.variables).toEqual(['x', 'y']);
  });

  it('routes iint() to multivariable multiple_integral', () => {
    const r = route('iint(x*y, x, 0, 1, y, 0, 2)');
    expect(r.handler).toBe('multivariable');
    expect(r.args.operation).toBe('multiple_integral');
    expect(r.args.bounds).toEqual([
      { variable: 'x', lower: '0', upper: '1' },
      { variable: 'y', lower: '0', upper: '2' },
    ]);
  });

  it('routes nested int(int(...)) to multivariable as raw', () => {
    const r = route('int(int(x*y,x,0,1),y,0,2)');
    expect(r.handler).toBe('multivariable');
    expect(r.args.operation).toBe('multiple_integral');
    expect(r.args.raw).toBe('int(int(x*y,x,0,1),y,0,2)');
  });

  it('routes critical_points() to multivariable', () => {
    const r = route('critical_points(x^2+y^2, [x, y])');
    expect(r.handler).toBe('multivariable');
    expect(r.args.operation).toBe('critical_points');
  });

  it('routes lagrange() to multivariable', () => {
    const r = route('lagrange(x*y, x+y, 1, [x, y])');
    expect(r.handler).toBe('multivariable');
    expect(r.args.operation).toBe('lagrange');
    expect(r.args.constraint).toBe('x+y');
    expect(r.args.value).toBe('1');
  });

  it('routes tangent_plane() to multivariable', () => {
    const r = route('tangent_plane(x^2+y^2, [x, y], [1, 1])');
    expect(r.handler).toBe('multivariable');
    expect(r.args.operation).toBe('tangent_plane');
    expect(r.args.point).toEqual(['1', '1']);
  });

  it('routes directional_derivative() to multivariable', () => {
    const r = route('directional_derivative(x^2+y^2, [x, y], [1, 1], [1, 0])');
    expect(r.handler).toBe('multivariable');
    expect(r.args.operation).toBe('directional_derivative');
    expect(r.args.direction).toEqual(['1', '0']);
  });

  // --- Regression: existing routes must NOT break ---
  it('still routes single int() to calculus', () => {
    const r = route('int(x^2, x, 0, 1)');
    expect(r.handler).toBe('calculus');
    expect(r.args.operation).toBe('integrate');
  });

  it('still routes diff() to calculus with numeric order', () => {
    const r = route('diff(x^5, x, 3)');
    expect(r.handler).toBe('calculus');
    expect(r.args.operation).toBe('differentiate');
    expect(r.args.order).toBe(3);
  });
});
