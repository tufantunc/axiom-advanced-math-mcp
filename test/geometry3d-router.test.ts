import { describe, it, expect } from 'vitest';
import { route } from '../src/server/tools/compute/router.js';
import { computeHandler } from '../src/server/tools/compute/index.js';

describe('Router — geometry3d', () => {
  it('routes distance3d() to geometry3d', () => {
    const r = route('distance3d([0,0,0], [1,2,2])');
    expect(r.handler).toBe('geometry3d');
    expect(r.args.operation).toBe('distance3d');
    expect(r.args.lists).toEqual([[0, 0, 0], [1, 2, 2]]);
  });

  it('routes cross() to geometry3d', () => {
    const r = route('cross([1,0,0], [0,1,0])');
    expect(r.handler).toBe('geometry3d');
    expect(r.args.operation).toBe('cross');
  });

  it('routes vector_norm() to geometry3d', () => {
    const r = route('vector_norm([2,3,6])');
    expect(r.handler).toBe('geometry3d');
    expect(r.args.operation).toBe('vector_norm');
  });

  it('routes plane_from_points() to geometry3d', () => {
    const r = route('plane_from_points([0,0,0],[1,0,0],[0,1,0])');
    expect(r.handler).toBe('geometry3d');
    expect(r.args.operation).toBe('plane_from_points');
  });

  it('routes line_plane_intersection() with mixed vector + plane args', () => {
    const r = route('line_plane_intersection([0,0,-1],[0,0,1],[0,0,1,0])');
    expect(r.handler).toBe('geometry3d');
    expect(r.args.operation).toBe('line_plane_intersection');
    expect(r.args.lists).toEqual([[0, 0, -1], [0, 0, 1], [0, 0, 1, 0]]);
  });

  it('routes volume_sphere() with a scalar radius', () => {
    const r = route('volume_sphere(2)');
    expect(r.handler).toBe('geometry3d');
    expect(r.args.operation).toBe('volume_sphere');
    expect(r.args.scalar).toBe(2);
  });

  it('routes volume_tetrahedron() to geometry3d', () => {
    const r = route('volume_tetrahedron([0,0,0],[1,0,0],[0,1,0],[0,0,1])');
    expect(r.handler).toBe('geometry3d');
    expect(r.args.operation).toBe('volume_tetrahedron');
  });

  // --- Regression: existing routes must NOT break ---
  it('still routes 2D distance() to geometry', () => {
    const r = route('distance([0,0], [3,4])');
    expect(r.handler).toBe('geometry');
  });

  it('still routes 2D midpoint() to geometry', () => {
    const r = route('midpoint([0,0], [2,2])');
    expect(r.handler).toBe('geometry');
  });

  it('still routes matrix norm() to matrix', () => {
    const r = route('norm([[1,2],[3,4]])');
    expect(r.handler).toBe('matrix');
  });
});

describe('compute gateway — geometry3d end-to-end', () => {
  it('cross product through compute()', async () => {
    const r = await computeHandler({ problem: 'cross([1,0,0], [0,1,0])' });
    expect(r.isError).toBe(false);
    const flat = r.content.map((c: { text: string }) => c.text).join('\n').replace(/\s/g, '');
    expect(flat).toContain('[0,0,1]');
  });

  it('volume_tetrahedron through compute()', async () => {
    const r = await computeHandler({ problem: 'volume_tetrahedron([0,0,0],[1,0,0],[0,1,0],[0,0,1])' });
    expect(r.isError).toBe(false);
    expect(r.content.map((c: { text: string }) => c.text).join('\n')).toContain('0.1666');
  });
});
