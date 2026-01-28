import { z } from 'zod';

export const quickCalcToolSchema = z.object({
  expression: z
    .string()
    .describe('Mathematical expression to evaluate (e.g., "2 * sin(30deg) + 5")'),
  units: z
    .enum(['none', 'auto', 'si', 'us'] as const)
    .optional()
    .describe('Unit system for conversions'),
  precision: z
    .number()
    .min(1)
    .max(50)
    .optional()
    .describe('Number of decimal places (default: 10)'),
  format: z
    .enum(['text', 'latex', 'json'] as const)
    .optional()
    .describe('Output format (default: text)')
});
