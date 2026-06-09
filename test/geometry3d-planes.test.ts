import { describe, it, expect } from 'vitest';
import { planeHandler } from '../src/server/tools/geometry3d/planes.js';

const text = (r: { content: { text: string }[] }) => r.content.map((c) => c.text).join('\n');
const flat = (r: { content: { text: string }[] }) => text(r).replace(/\s/g, '');

describe('geometry3d planes', () => {
  it('plane_from_points(xy-plane) = [0,0,1,0]', async () => {
    const r = await planeHandler({ operation: 'plane_from_points', lists: [[0, 0, 0], [1, 0, 0], [0, 1, 0]] });
    expect(r.isError).toBe(false);
    expect(flat(r)).toContain('[0,0,1,0]');
  });

  it('point_plane_distance([0,0,5],[0,0,1,0]) = 5', async () => {
    const r = await planeHandler({ operation: 'point_plane_distance', lists: [[0, 0, 5], [0, 0, 1, 0]] });
    expect(r.isError).toBe(false);
    expect(text(r)).toContain('5');
  });

  it('line_plane_intersection(z-axis from z=-1, plane z=0) = [0,0,0]', async () => {
    const r = await planeHandler({ operation: 'line_plane_intersection', lists: [[0, 0, -1], [0, 0, 1], [0, 0, 1, 0]] });
    expect(r.isError).toBe(false);
    expect(flat(r)).toContain('[0,0,0]');
  });

  it('plane_plane_angle([0,0,1,0],[0,1,0,0]) = 90', async () => {
    const r = await planeHandler({ operation: 'plane_plane_angle', lists: [[0, 0, 1, 0], [0, 1, 0, 0]] });
    expect(r.isError).toBe(false);
    expect(text(r)).toContain('90');
  });

  it('line_line_distance (skew axes) = 1', async () => {
    const r = await planeHandler({ operation: 'line_line_distance', lists: [[0, 0, 0], [1, 0, 0], [0, 0, 1], [0, 1, 0]] });
    expect(r.isError).toBe(false);
    expect(text(r)).toContain('1');
  });

  it('line_line_distance parallel lines (x-axis vs y=1 line) = 1', async () => {
    const r = await planeHandler({ operation: 'line_line_distance', lists: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 0, 0]] });
    expect(r.isError).toBe(false);
    expect(text(r)).toContain('1');
  });

  it('errors on collinear points for plane_from_points', async () => {
    const r = await planeHandler({ operation: 'plane_from_points', lists: [[0, 0, 0], [1, 0, 0], [2, 0, 0]] });
    expect(r.isError).toBe(true);
  });

  it('errors when line is parallel to plane', async () => {
    const r = await planeHandler({ operation: 'line_plane_intersection', lists: [[0, 0, 5], [1, 0, 0], [0, 0, 1, 0]] });
    expect(r.isError).toBe(true);
  });
});
