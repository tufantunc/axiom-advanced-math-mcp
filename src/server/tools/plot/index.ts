import { z } from 'zod';
import { MAX_EXPRESSION_LENGTH } from '../limits.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { plotToSvg } from './render.js';

const plotFunctionSchema = {
  expression: z
    .string()
    .max(MAX_EXPRESSION_LENGTH, `expression must be at most ${MAX_EXPRESSION_LENGTH} characters`)
    .describe('Mathematical expression to plot (e.g., "sin(x)", "x^2 - 3*x + 1")'),
  variable: z.string().optional().describe('Variable name (default: "x")'),
  x_min: z.number().optional().describe('Minimum x value (default: -10)'),
  x_max: z.number().optional().describe('Maximum x value (default: 10)'),
  y_min: z.number().optional().describe('Minimum y value (auto-detected if omitted)'),
  y_max: z.number().optional().describe('Maximum y value (auto-detected if omitted)'),
  width: z.number().optional().describe('Image width in pixels (default: 600)'),
  height: z.number().optional().describe('Image height in pixels (default: 400)'),
  title: z.string().optional().describe('Chart title (optional)'),
};

export function registerPlotTools(server: McpServer): void {
  server.registerTool(
    'plot',
    {
      description:
        'Plot a single-variable function as a graph. Returns a base64-encoded SVG image with axes, grid, ' +
        'labels and asymptote detection, plus a text caption.\n\n' +
        'Examples:\n' +
        '- plot sin(x) from -2*pi to 2*pi\n' +
        '- plot x^2 - 3*x + 1 from -5 to 5\n' +
        '- plot exp(-x^2) (Gaussian curve)\n' +
        '- plot 1/x (poles are split into separate segments rather than joined)\n\n' +
        'Samples the function numerically, so it draws the shape of an expression — it does not solve or ' +
        'simplify it. Use `compute` for the mathematics and `plot` to show it. Points where the function ' +
        'is undefined are dropped rather than interpolated.',
      inputSchema: plotFunctionSchema,
    },
    async (args) => {
      try {
        const result = await plotToSvg({
          expression: args.expression as string,
          variable: args.variable as string | undefined,
          xMin: args.x_min as number | undefined,
          xMax: args.x_max as number | undefined,
          yMin: args.y_min as number | undefined,
          yMax: args.y_max as number | undefined,
          width: args.width as number | undefined,
          height: args.height as number | undefined,
          title: args.title as string | undefined,
        });

        const svgBase64 = Buffer.from(result.svg, 'utf-8').toString('base64');

        return {
          content: [
            { type: 'image' as const, data: svgBase64, mimeType: 'image/svg+xml' },
            {
              type: 'text' as const,
              text: `Plot of f(${result.variable}) = ${result.expression} over [${result.xMin}, ${result.xMax}]`,
            },
          ],
          isError: false,
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
