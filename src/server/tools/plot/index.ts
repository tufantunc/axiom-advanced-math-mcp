import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { evaluateFunction } from './evaluator.js';
import { renderSvg } from './svg-renderer.js';

const plotFunctionSchema = {
  expression: z.string().describe('Mathematical expression to plot (e.g., "sin(x)", "x^2 - 3*x + 1")'),
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
  server.tool(
    'plot',
    'Plot a mathematical function as an SVG graph. Returns an image showing the function curve with axes, grid, and labels.\n\n' +
    'Examples:\n' +
    '- plot sin(x) from -2*pi to 2*pi\n' +
    '- plot x^2 - 3*x + 1 from -5 to 5\n' +
    '- plot exp(-x^2) (Gaussian curve)\n' +
    '- plot 1/x with asymptote detection',
    plotFunctionSchema,
    async (args) => {
      try {
        const variable = (args.variable as string) || 'x';
        const xMin = (args.x_min as number) ?? -10;
        const xMax = (args.x_max as number) ?? 10;
        const width = (args.width as number) ?? 600;
        const height = (args.height as number) ?? 400;
        const title = args.title as string | undefined;

        if (xMin >= xMax) {
          return {
            content: [{ type: 'text' as const, text: 'Error: x_min must be less than x_max' }],
            isError: true,
          };
        }

        const evalResult = evaluateFunction(args.expression as string, variable, xMin, xMax);

        const yMin = (args.y_min as number) ?? evalResult.yMin;
        const yMax = (args.y_max as number) ?? evalResult.yMax;

        const svg = renderSvg({
          width,
          height,
          xMin,
          xMax,
          yMin,
          yMax,
          title: title || `f(${variable}) = ${args.expression}`,
          segments: evalResult.segments,
        });

        const svgBase64 = Buffer.from(svg, 'utf-8').toString('base64');

        const summary = `Plot of f(${variable}) = ${args.expression} over [${xMin}, ${xMax}]`;
        const v2 = process.env.AXIOM_OUTPUT_V2 === '1';

        return {
          content: [
            {
              type: 'image' as const,
              data: svgBase64,
              mimeType: 'image/svg+xml',
            },
            { type: 'text' as const, text: summary },
            ...(v2
              ? [
                  {
                    type: 'text' as const,
                    text: `\\boxed{plot: f(${variable}) = ${args.expression}}`,
                  },
                ]
              : []),
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
    },
  );
}
