import { describe, it, expect } from 'vitest';
import { plotToSvg } from '../src/server/tools/plot/render.js';
import { evaluateFunction } from '../src/server/tools/plot/evaluator.js';

describe('plotToSvg', () => {
  it('returns SVG text and the metadata describing it', () => {
    const r = plotToSvg({ expression: 'sin(x)', xMin: -10, xMax: 10 });
    expect(r.svg.startsWith('<svg')).toBe(true);
    expect(r.expression).toBe('sin(x)');
    expect(r.variable).toBe('x');
    expect(r.xMin).toBe(-10);
    expect(r.xMax).toBe(10);
    expect(r.segments).toBe(1);
    // sin is finite everywhere, so every sample is drawn.
    expect(r.samples).toBe(200);
    expect(r.points).toBe(200);
  });

  it('counts the points actually drawn, not the samples requested', () => {
    // sqrt is undefined on half of [-10, 10]: the sample count is fixed, but
    // roughly half the samples produce no number and are not drawn. The
    // metadata must report what was drawn rather than the constant.
    const r = plotToSvg({ expression: 'sqrt(x)', xMin: -10, xMax: 10 });
    expect(r.samples).toBe(200);
    expect(r.points).toBeLessThan(r.samples);
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

  it('escapes XML-special characters in the title', () => {
    // The title is caller-controlled and rendered into markup — unescaped it
    // would inject raw SVG/HTML into whatever consumes the plot.
    const r = plotToSvg({ expression: 'x', xMin: -10, xMax: 10, title: 'a&b<c>"d"' });
    expect(r.svg).toContain('&amp;b&lt;c&gt;&quot;d&quot;');
    expect(r.svg).not.toContain('a&b');
  });

  it('splits the polyline at a pole instead of connecting it', () => {
    // 5 samples over [-1, 1] hit x = 0 exactly, where 1/x overflows: the
    // evaluator must emit the two finite runs as separate segments.
    const r = evaluateFunction('1/x', 'x', -1, 1, 5);
    expect(r.segments).toHaveLength(2);
    expect(r.segments[0].points.map((p) => p.x)).toEqual([-1, -0.5]);
    expect(r.segments[1].points.map((p) => p.x)).toEqual([0.5, 1]);
  });
});
