import { evaluateFunction, DEFAULT_PLOT_POINTS } from './evaluator.js';
import type { PlotSegment } from './evaluator.js';
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
  /** The caption drawn on the image: the caller's title, else `f(x) = <expression>`. */
  title: string;
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  segments: number;
  /** x values sampled across the range. */
  samples: number;
  /** Of those samples, how many produced a finite y and were drawn. */
  points: number;
  /**
   * The drawn samples themselves, one run per segment. The interactive view
   * (`app.ts`) redraws from these rather than re-evaluating the expression in
   * the browser: a second evaluator there could disagree with this one and
   * draw a curve the server never computed.
   */
  curve: PlotSegment[];
}

/**
 * Renders a function plot to SVG text plus the metadata describing it.
 *
 * Deliberately returns raw SVG rather than the base64 image block the MCP tool
 * sends: the CLI writes the SVG to a file or to stdout, and there is no inline
 * image in that path. Both callers share this function so the two surfaces
 * cannot drift apart on defaults or range handling.
 */
export async function plotToSvg(args: PlotArgs): Promise<PlotResult> {
  const variable = args.variable || 'x';
  const xMin = args.xMin ?? -10;
  const xMax = args.xMax ?? 10;
  const width = args.width ?? 600;
  const height = args.height ?? 400;

  if (xMin >= xMax) {
    throw new Error('x_min must be less than x_max');
  }

  const evalResult = await evaluateFunction(
    args.expression,
    variable,
    xMin,
    xMax,
    DEFAULT_PLOT_POINTS
  );
  const yMin = args.yMin ?? evalResult.yMin;
  const yMax = args.yMax ?? evalResult.yMax;
  // Checked after the auto range is filled in: a lone y_min above the sampled
  // maximum is just as inverted as an explicit y_min > y_max. Either one used
  // to come back as an upside-down plot rather than an error.
  if (!(yMin < yMax)) {
    throw new Error(
      `y_min must be less than y_max, but the y range came out as [${yMin}, ${yMax}]`
    );
  }
  const title = args.title || `f(${variable}) = ${args.expression}`;

  const svg = renderSvg({
    width,
    height,
    xMin,
    xMax,
    yMin,
    yMax,
    title,
    segments: evalResult.segments,
  });

  return {
    svg,
    expression: args.expression,
    variable,
    title,
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
    curve: evalResult.segments,
  };
}

/**
 * The description of a plot that every surface reports: the CLI's `plot --json`
 * metadata and the MCP result's `structuredContent` both spread this, so the two
 * cannot drift apart field by field.
 */
export function plotSummary(p: PlotResult) {
  return {
    expression: p.expression,
    variable: p.variable,
    title: p.title,
    x_range: [p.xMin, p.xMax] as [number, number],
    y_range: [p.yMin, p.yMax] as [number, number],
    segments: p.segments,
    samples: p.samples,
    points: p.points,
  };
}
