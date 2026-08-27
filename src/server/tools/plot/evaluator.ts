import { runJsCompute } from '../../js-compute/index.js';

/**
 * Function sampling for the plot tool, bounded outside the server process.
 *
 * The mathjs instance and the sampling loop now live in
 * `js-compute/mathjs-tasks.ts`, under the same wall-clock timeout, heap cap and
 * response-size limit as the arithmetic path. They ran here, synchronously: the
 * sample count is fixed at 200 but the CALLER writes the expression, and
 * `sum(1:2000000)*x` — sixteen characters — took 10.9s of blocked event loop
 * across those 200 points. `plot` is not behind the CAS session mutex, so that
 * stalled every other client directly rather than queueing.
 */

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
export async function evaluateFunction(
  expression: string,
  variable: string,
  xMin: number,
  xMax: number,
  numPoints: number = DEFAULT_PLOT_POINTS
): Promise<EvaluationResult> {
  const raw = await runJsCompute('mathjs_sample', {
    expression,
    variable,
    xMin,
    xMax,
    numPoints,
  });
  return JSON.parse(raw) as EvaluationResult;
}
