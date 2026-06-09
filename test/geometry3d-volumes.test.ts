import { describe, it, expect } from 'vitest';
import { volumeHandler } from '../src/server/tools/geometry3d/volumes.js';

const text = (r: { content: { text: string }[] }) => r.content.map((c) => c.text).join('\n');

describe('geometry3d volumes', () => {
  it('volume_tetrahedron (unit corner) = 1/6', async () => {
    const r = await volumeHandler({ operation: 'volume_tetrahedron', lists: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]] });
    expect(r.isError).toBe(false);
    expect(text(r)).toContain('0.1666');
  });

  it('volume_parallelepiped (unit cube) = 1', async () => {
    const r = await volumeHandler({ operation: 'volume_parallelepiped', lists: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] });
    expect(r.isError).toBe(false);
    expect(r.content.map((c) => c.text).join('\n')).toMatch(/Result:\s*1\b/);
  });

  it('volume_sphere(r=1) ≈ 4.18879', async () => {
    const r = await volumeHandler({ operation: 'volume_sphere', scalar: 1 });
    expect(r.isError).toBe(false);
    expect(text(r)).toContain('4.18');
  });

  it('volume_sphere errors without a radius', async () => {
    const r = await volumeHandler({ operation: 'volume_sphere' });
    expect(r.isError).toBe(true);
  });

  it('volume_tetrahedron errors when a vertex lacks 3 coords', async () => {
    const r = await volumeHandler({ operation: 'volume_tetrahedron', lists: [[0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]] });
    expect(r.isError).toBe(true);
  });

  it('volume_sphere errors on negative radius', async () => {
    const r = await volumeHandler({ operation: 'volume_sphere', scalar: -1 });
    expect(r.isError).toBe(true);
  });
});
