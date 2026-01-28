import { z } from 'zod';

export const advancedSolveToolSchema = z.object({
  expression: z
    .string()
    .describe('Giac expression (e.g., "int(x^2, x)" or "diff(sin(x), x)")'),
  format: z
    .enum(['text', 'latex', 'json'] as const)
    .optional()
    .describe('Output format (default: latex)'),
  steps: z
    .boolean()
    .optional()
    .describe('Show computation steps if available (default: false)'),
  simplify: z
    .boolean()
    .optional()
    .describe('Simplify the result (default: true)')
});
