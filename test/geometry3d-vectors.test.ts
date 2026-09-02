import { describe, it, expect } from 'vitest';
import { vectorHandler } from '../src/server/tools/geometry3d/vectors.js';

const text = (r: { content: { text: string }[] }) => r.content.map((c) => c.text).join('\n');
const flat = (r: { content: { text: string }[] }) => text(r).replace(/\s/g, '');

describe('geometry3d vectors', () => {
  it('distance3d([0,0,0],[2,3,6]) = 7', async () => {
    const r = await vectorHandler({ operation: 'distance3d', lists: [[0, 0, 0], [2, 3, 6]] });
    expect(r.isError).toBe(false);
    expect(text(r)).toContain('7');
  });

  it('dot([1,2,3],[4,5,6]) = 32', async () => {
    const r = await vectorHandler({ operation: 'dot', lists: [[1, 2, 3], [4, 5, 6]] });
    expect(r.isError).toBe(false);
    expect(text(r)).toContain('32');
  });

  it('cross([1,0,0],[0,1,0]) = [0,0,1]', async () => {
    const r = await vectorHandler({ operation: 'cross', lists: [[1, 0, 0], [0, 1, 0]] });
    expect(r.isError).toBe(false);
    expect(flat(r)).toContain('[0,0,1]');
  });

  it('vector_norm([2,3,6]) = 7', async () => {
    const r = await vectorHandler({ operation: 'vector_norm', lists: [[2, 3, 6]] });
    expect(r.isError).toBe(false);
    expect(text(r)).toContain('7');
  });

  it('angle_vectors([1,0,0],[0,1,0]) = 90', async () => {
    const r = await vectorHandler({ operation: 'angle_vectors', lists: [[1, 0, 0], [0, 1, 0]] });
    expect(r.isError).toBe(false);
    expect(text(r)).toContain('90');
  });

  it('midpoint3d([0,0,0],[2,4,6]) = [1,2,3]', async () => {
    const r = await vectorHandler({ operation: 'midpoint3d', lists: [[0, 0, 0], [2, 4, 6]] });
    expect(r.isError).toBe(false);
    expect(flat(r)).toContain('[1,2,3]');
  });

  it('errors on zero vector for angle_vectors', async () => {
    const r = await vectorHandler({ operation: 'angle_vectors', lists: [[0, 0, 0], [0, 1, 0]] });
    expect(r.isError).toBe(true);
  });

  it('errors when a point does not have 3 coordinates', async () => {
    const r = await vectorHandler({ operation: 'distance3d', lists: [[0, 0], [1, 1, 1]] });
    expect(r.isError).toBe(true);
  });

  // The vnorm hypot conversion is invisible at typical magnitudes — these
  // overflow-scale pins are what actually guard it. The sqrt(vdot(v,v)) form
  // answers Infinity for both (verified during review of the conversion).
  it('distance3d stays finite at 1e200 components', async () => {
    const r = await vectorHandler({ operation: 'distance3d', lists: [[0, 0, 0], [1e200, 0, 0]] });
    expect(r.isError).toBe(false);
    expect(text(r)).toMatch(/Result: 1e\+200/);
    expect(text(r)).not.toContain('Infinity');
  });

  it('vector_norm stays finite at 1e200 components', async () => {
    const r = await vectorHandler({
      operation: 'vector_norm',
      lists: [[1e200, 1e200, 1e200]],
    });
    expect(r.isError).toBe(false);
    expect(text(r)).toMatch(/Result: 1\.7320\d*e\+200/);
    expect(text(r)).not.toContain('Infinity');
  });
});
