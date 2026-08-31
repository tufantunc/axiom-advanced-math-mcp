import { describe, it, expect } from 'vitest';
import { geometryHandler } from '../src/server/tools/geometry.js';

function allText(r: { content: { text: string }[] }): string {
  return r.content.map((c) => c.text).join('\n');
}

// Goldens verified against the handler before the Math.hypot conversion; the
// values must not move by more than the renderer's 10th decimal when they do.
describe('geometry — 2D distances and magnitudes', () => {
  it('distance of a 3-4-5 pair is exactly 5', async () => {
    const r = await geometryHandler({ operation: 'distance', points: [[0, 0], [3, 4]] });
    expect(r.isError).toBe(false);
    expect(allText(r)).toContain('Result: 5');
    expect(allText(r)).toContain('The answer is 5');
  });

  it('distance renders √2 to the renderer precision', async () => {
    const r = await geometryHandler({ operation: 'distance', points: [[0, 0], [1, 1]] });
    expect(allText(r)).toContain('Result: 1.4142135624');
  });

  it('perimeter of the unit square is 4', async () => {
    const r = await geometryHandler({
      operation: 'perimeter_polygon',
      points: [[0, 0], [1, 0], [1, 1], [0, 1]],
    });
    expect(allText(r)).toContain('Result: 4');
  });

  it('perimeter of a 3-4-5 triangle is 12', async () => {
    const r = await geometryHandler({
      operation: 'perimeter_polygon',
      points: [[0, 0], [3, 0], [3, 4]],
    });
    expect(allText(r)).toContain('Result: 12');
  });

  it('point-to-line distance is |3+4|/5 = 1.4', async () => {
    const r = await geometryHandler({
      operation: 'point_line_distance',
      points: [[1, 1]],
      line1: [3, 4, 0],
    });
    expect(allText(r)).toContain('Result: 1.4');
  });

  it('angle between identical lines is 0°, perpendicular lines 90°', async () => {
    const same = await geometryHandler({
      operation: 'angle_between_lines',
      line1: [1, 0, 0],
      line2: [1, 0, 5],
    });
    expect(allText(same)).toContain('Result: 0°');
    const perp = await geometryHandler({
      operation: 'angle_between_lines',
      line1: [0, 1, 0],
      line2: [1, 0, 0],
    });
    expect(allText(perp)).toContain('Result: 90°');
  });

  it('distance stays finite at 1e154 coordinates (hypot is overflow-safe)', async () => {
    // The sqrt(x²+y²) form answered Infinity here; Math.hypot computes the
    // correct 1.4142135623730953e+154. Shape-matched: formatNumber's 10th
    // decimal rounding may move the last digits of the mantissa.
    const r = await geometryHandler({
      operation: 'distance',
      points: [[0, 0], [1e154, 1e154]],
    });
    expect(allText(r)).toMatch(/Result: 1\.41421\d*e\+154/);
  });
});
