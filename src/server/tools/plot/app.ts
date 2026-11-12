import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { plotSummary, type PlotResult } from './render.js';
import { plotViewHtml } from './view.js';

/**
 * MCP Apps (extension `io.modelcontextprotocol/ui`, spec 2026-01-26) wiring
 * for `plot`.
 *
 * A host that implements the extension sees `_meta.ui.resourceUri` on the
 * tool, reads that `ui://` resource and renders it in a sandboxed iframe next
 * to the tool result; the view then draws from `structuredContent` and can
 * ask the host to call `plot` again for a new range. A host that does not
 * implement it ignores `_meta` and shows the image block. The CLI never goes
 * through MCP and is untouched.
 *
 * Done by hand rather than with `@modelcontextprotocol/ext-apps/server`. Its
 * two server helpers only set these same keys, and its view-side `App` class
 * would have to be bundled into the page, which has no browser build step.
 * (Its 2.x line also requires the v2 SDK; 1.x still supports SDK 1.x, so this
 * is a choice, not a constraint.)
 */

export const PLOT_APP_URI = 'ui://axiom-math/plot.html';

/** The spec makes this exact value a MUST for the resource's `mimeType`. */
export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app';

/**
 * The tool-level `_meta`. `ui.resourceUri` is the spec's form; the flat
 * `ui/resourceUri` key is its deprecated predecessor, still set because hosts
 * built against early drafts read only that one. The official helper sets
 * both for the same reason.
 */
export const PLOT_TOOL_META = {
  ui: { resourceUri: PLOT_APP_URI },
  'ui/resourceUri': PLOT_APP_URI,
};

/**
 * One run of drawn samples, as sample indices on the sampler's grid: sample
 * `start + k` is at `x_range[0] + (start + k) * step`, with
 * `step = (x_range[1] - x_range[0]) / (samples - 1)`, and has value `y[k]`.
 */
export interface PlotCurve {
  start: number;
  y: number[];
}

/**
 * What the view reads from a `plot` result's `structuredContent`.
 *
 * A `type`, not an `interface`: a type alias is assignable to the SDK's
 * `Record<string, unknown>` without an index signature, and an index signature
 * would let a misspelled field compile.
 */
export type PlotStructuredContent = ReturnType<typeof plotSummary> & { curves: PlotCurve[] };

/**
 * The plot's data for the view.
 *
 * `structuredContent` goes to every client, not only MCP Apps hosts, and a
 * client without the extension may hand it to the model. So it is kept small
 * without losing precision. x is not sent at all: the samples sit on a fixed
 * grid, and the view rebuilds each x with the sampler's own arithmetic. That
 * halves the payload. Rounding would not have been safe: at 12 significant
 * digits every x of a narrow range far from zero, such as [1e6, 1e6+1],
 * collapses onto one value.
 *
 * Throws if a sample is not exactly on that grid, which would mean the
 * sampler changed and the view would draw it at the wrong x.
 *
 * No `outputSchema` is declared for this: a schema advertises the structure as
 * the tool's result to every client, which works against keeping the samples
 * out of the model's context.
 */
export function toPlotStructuredContent(result: PlotResult): PlotStructuredContent {
  const { xMin, xMax, samples } = result;
  const step = (xMax - xMin) / (samples - 1);
  const curves = result.curve.map((segment): PlotCurve => {
    const start = Math.round((segment.points[0].x - xMin) / step);
    segment.points.forEach((p, k) => {
      if (p.x !== xMin + (start + k) * step) {
        throw new Error(
          `plot: sample x=${p.x} is not on the ${samples}-point grid over [${xMin}, ${xMax}]`
        );
      }
    });
    return { start, y: segment.points.map((p) => p.y) };
  });
  return { ...plotSummary(result), curves };
}

/** Registers the view as a resource so hosts can `resources/read` it. */
export function registerPlotApp(server: McpServer): void {
  server.registerResource(
    'plot-view',
    PLOT_APP_URI,
    {
      title: 'Interactive plot',
      description:
        'Interactive view for the plot tool: a readout of the computed samples by pointer or ' +
        'keyboard, and zoom, pan or a typed x range that re-runs plot on the server.',
      mimeType: MCP_APP_MIME_TYPE,
    },
    async () => ({
      contents: [
        {
          uri: PLOT_APP_URI,
          mimeType: MCP_APP_MIME_TYPE,
          text: plotViewHtml(),
          // No `csp`: the view loads nothing from the network, and an absent
          // csp is the spec's most restrictive default.
          _meta: { ui: { prefersBorder: true } },
        },
      ],
    })
  );
}
