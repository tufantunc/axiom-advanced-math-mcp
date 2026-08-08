import { describe, it, expect } from 'vitest';
import { plotToSvg } from '../src/server/tools/plot/render.js';

describe('plotToSvg', () => {
  it('returns SVG text and the metadata describing it', () => {
    const r = plotToSvg({ expression: 'sin(x)', xMin: -10, xMax: 10 });
    expect(r.svg.startsWith('<svg')).toBe(true);
    expect(r.expression).toBe('sin(x)');
    expect(r.variable).toBe('x');
    expect(r.xMin).toBe(-10);
    expect(r.xMax).toBe(10);
    expect(r.segments).toBeGreaterThan(0);
    expect(r.points).toBeGreaterThan(0);
  });

  it('honours an explicit variable and y range', () => {
    const r = plotToSvg({ expression: 't^2', variable: 't', yMin: 0, yMax: 4 });
    expect(r.variable).toBe('t');
    expect(r.yMin).toBe(0);
    expect(r.yMax).toBe(4);
  });

  it('throws when the x range is inverted', () => {
    expect(() => plotToSvg({ expression: 'sin(x)', xMin: 5, xMax: 5 })).toThrow(
      /x_min must be less than x_max/
    );
  });
});
