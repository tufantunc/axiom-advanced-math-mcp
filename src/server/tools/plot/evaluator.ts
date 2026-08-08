import { create, all } from 'mathjs';

const math = create(all, {});
// This instance only ever evaluates caller-supplied plot expressions and
// needs no custom imports or units, so lock down `import`/`createUnit` per
// mathjs's security guidance for instances that evaluate untrusted input:
// https://mathjs.org/docs/expressions/security.html
math.import(
  {
    import: function () {
      throw new Error('Function import is disabled');
    },
    createUnit: function () {
      throw new Error('Function createUnit is disabled');
    },
  },
  { override: true }
);

/** Samples taken across the x range when a caller does not say otherwise. */
export const DEFAULT_PLOT_POINTS = 200;

export interface PlotPoint {
  x: number;
  y: number;
}

export interface PlotSegment {
  points: PlotPoint[];
}

export interface EvaluationResult {
  segments: PlotSegment[];
  yMin: number;
  yMax: number;
}

/**
 * Evaluate a mathematical expression over a range, splitting at
 * discontinuities (NaN, Infinity, very large jumps).
 */
export function evaluateFunction(
  expression: string,
  variable: string,
  xMin: number,
  xMax: number,
  numPoints: number = DEFAULT_PLOT_POINTS
): EvaluationResult {
  const compiled = math.compile(expression);
  const step = (xMax - xMin) / (numPoints - 1);

  const allPoints: (PlotPoint | null)[] = [];
  let yMin = Infinity;
  let yMax = -Infinity;

  for (let i = 0; i < numPoints; i++) {
    const x = xMin + i * step;
    try {
      const scope: Record<string, number> = { [variable]: x };
      const y = compiled.evaluate(scope);

      if (typeof y === 'number' && isFinite(y)) {
        allPoints.push({ x, y });
        if (y < yMin) yMin = y;
        if (y > yMax) yMax = y;
      } else {
        allPoints.push(null); // discontinuity marker
      }
    } catch {
      allPoints.push(null);
    }
  }

  // Add padding to y range
  if (yMin === Infinity) {
    yMin = -10;
    yMax = 10;
  }
  const yRange = yMax - yMin;
  if (yRange === 0) {
    yMin -= 1;
    yMax += 1;
  } else {
    yMin -= yRange * 0.05;
    yMax += yRange * 0.05;
  }

  // Split into continuous segments (break at null/large jumps)
  const segments: PlotSegment[] = [];
  let current: PlotPoint[] = [];

  for (let i = 0; i < allPoints.length; i++) {
    const pt = allPoints[i];
    if (pt === null) {
      if (current.length > 1) segments.push({ points: current });
      current = [];
      continue;
    }

    // Check for large jumps (likely asymptote)
    if (current.length > 0) {
      const prev = current[current.length - 1];
      const jump = Math.abs(pt.y - prev.y);
      const threshold = (yMax - yMin) * 2;
      if (jump > threshold) {
        if (current.length > 1) segments.push({ points: current });
        current = [];
      }
    }

    current.push(pt);
  }
  if (current.length > 1) segments.push({ points: current });

  return { segments, yMin, yMax };
}
