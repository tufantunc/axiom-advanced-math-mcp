import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PlotResult } from './render.js';
import { PLOT_APP_HTML } from './app-html.js';

/**
 * MCP Apps (extension `io.modelcontextprotocol/ui`, spec 2026-01-26) wiring
 * for `plot`.
 *
 * A host that implements the extension sees `_meta.ui.resourceUri` on the
 * tool, reads that `ui://` resource and renders it in a sandboxed iframe next
 * to the tool result; the view then draws from `structuredContent` and can
 * ask the host to call `plot` again for a new range. A host that does not
 * implement it ignores both fields and shows the image block exactly as
 * before, so this is purely additive — and the CLI, which never goes through
 * MCP, is untouched.
 *
 * Done by hand rather than with `@modelcontextprotocol/ext-apps/server`: its
 * two helpers only set these same keys, and the 2.x line of that package
 * requires the v2 SDK.
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

/** What the view reads from a `plot` result's `structuredContent`. */
export interface PlotStructuredContent {
  [key: string]: unknown;
  expression: string;
  variable: string;
  x_range: [number, number];
  y_range: [number, number];
  segments: number;
  samples: number;
  points: number;
  /** One flat `[x0, y0, x1, y1, …]` array per segment, at full precision. */
  polylines: number[][];
}

/**
 * The plot's data for the view.
 *
 * Field names follow the CLI's `plot --json` metadata so the two surfaces
 * describe a plot the same way. The samples are not rounded: rounding x to a
 * fixed number of significant digits collapses every sample of a narrow range
 * far from zero (say [1e6, 1e6+1]) onto one value, and the spec keeps
 * `structuredContent` out of the model's context, so the size costs no tokens.
 */
export function toPlotStructuredContent(result: PlotResult): PlotStructuredContent {
  return {
    expression: result.expression,
    variable: result.variable,
    x_range: [result.xMin, result.xMax],
    y_range: [result.yMin, result.yMax],
    segments: result.segments,
    samples: result.samples,
    points: result.points,
    polylines: result.curve.map((segment) => segment.points.flatMap((p) => [p.x, p.y])),
  };
}

/** Registers the view as a resource so hosts can `resources/read` it. */
export function registerPlotApp(server: McpServer): void {
  server.registerResource(
    'plot-view',
    PLOT_APP_URI,
    {
      title: 'Interactive plot',
      description:
        'Interactive view for the plot tool: hover readout of the computed samples, and zoom, ' +
        'pan or a typed x range that re-runs plot on the server.',
      mimeType: MCP_APP_MIME_TYPE,
    },
    async () => ({
      contents: [
        {
          uri: PLOT_APP_URI,
          mimeType: MCP_APP_MIME_TYPE,
          text: PLOT_APP_HTML,
          // No `csp`: the view loads nothing from the network, and an absent
          // csp is the spec's most restrictive default.
          _meta: { ui: { prefersBorder: true } },
        },
      ],
    })
  );
}
