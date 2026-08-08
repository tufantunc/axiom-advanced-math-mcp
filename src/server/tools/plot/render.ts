import { evaluateFunction, DEFAULT_PLOT_POINTS } from './evaluator.js';
import { renderSvg } from './svg-renderer.js';

export interface PlotArgs {
  expression: string;
  variable?: string;
  xMin?: number;
  xMax?: number;
  yMin?: number;
  yMax?: number;
  width?: number;
  height?: number;
  title?: string;
}

export interface PlotResult {
  svg: string;
  expression: string;
  variable: string;
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  segments: number;
  /** x values sampled across the range. */
  samples: number;
  /** Of those samples, how many produced a finite y and were drawn. */
  points: number;
}

/**
 * Renders a function plot to SVG text plus the metadata describing it.
 *
 * Deliberately returns raw SVG rather than the base64 image block the MCP tool
 * sends: the CLI writes the SVG to a file or to stdout, and there is no inline
 * image in that path. Both callers share this function so the two surfaces
 * cannot drift apart on defaults or range handling.
 */
export function plotToSvg(args: PlotArgs): PlotResult {
  const variable = args.variable || 'x';
  const xMin = args.xMin ?? -10;
  const xMax = args.xMax ?? 10;
  const width = args.width ?? 600;
  const height = args.height ?? 400;

  if (xMin >= xMax) {
    throw new Error('x_min must be less than x_max');
  }

  const evalResult = evaluateFunction(args.expression, variable, xMin, xMax, DEFAULT_PLOT_POINTS);
  const yMin = args.yMin ?? evalResult.yMin;
  const yMax = args.yMax ?? evalResult.yMax;

  const svg = renderSvg({
    width,
    height,
    xMin,
    xMax,
    yMin,
    yMax,
    title: args.title || `f(${variable}) = ${args.expression}`,
    segments: evalResult.segments,
  });

  return {
    svg,
    expression: args.expression,
    variable,
    xMin,
    xMax,
    yMin,
    yMax,
    segments: evalResult.segments.length,
    samples: DEFAULT_PLOT_POINTS,
    // Counted, not assumed: a function with poles or a restricted domain draws
    // fewer points than it samples, and reporting the sample count as `points`
    // would describe a denser curve than was actually rendered.
    points: evalResult.segments.reduce((n, s) => n + s.points.length, 0),
  };
}
