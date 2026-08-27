import { runJsComputeJson } from '../../js-compute/index.js';
import type { PlotPoint, PlotSegment, SampledFunction } from '../../js-compute/index.js';

/**
 * Function sampling for the plot tool, bounded outside the server process.
 *
 * The mathjs instance and the sampling loop live in
 * `js-compute/mathjs-tasks.ts`, under the same wall-clock timeout and heap cap
 * as the arithmetic path. They ran here, synchronously: the sample count is
 * fixed at 200 but the CALLER writes the expression, and `sum(1:200000)*x` took
 * 9.5s of blocked event loop across those 200 points. `plot` is not behind the
 * CAS session mutex, so that stalled every other client directly rather than
 * queueing.
 */

/** Samples taken across the x range when a caller does not say otherwise. */
export const DEFAULT_PLOT_POINTS = 200;

// Re-exported from the module that produces them: the two sides of the IPC
// boundary previously declared identical shapes with no type relationship, so a
// renamed field compiled clean on both.
export type { PlotPoint, PlotSegment };
export type EvaluationResult = SampledFunction;

/**
 * Evaluate a mathematical expression over a range, splitting at
 * discontinuities (non-finite samples) and at poles.
 *
 * Throws when nothing evaluated: an expression that failed at every point used
 * to come back as a successful plot of empty axes, so `plot notafunction(x)`
 * returned ok with a picture of nothing.
 */
export async function evaluateFunction(
  expression: string,
  variable: string,
  xMin: number,
  xMax: number,
  numPoints: number = DEFAULT_PLOT_POINTS
): Promise<EvaluationResult> {
  const result = await runJsComputeJson('mathjs_sample', {
    expression,
    variable,
    xMin,
    xMax,
    numPoints,
  });
  if (result.sampled === 0) {
    throw new Error(
      result.firstError !== undefined
        ? `the expression could not be evaluated: ${result.firstError}`
        : `the expression produced no finite values over [${xMin}, ${xMax}]`
    );
  }
  return result;
}
