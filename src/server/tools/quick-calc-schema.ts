import { z } from 'zod';
import { detectNaturalLanguage } from './quick-calc-service.js';

export const quickCalcToolSchema = z.object({
  expression: z
    .string()
    .min(1)
    .refine((val) => !detectNaturalLanguage(val), {
      message: "Expression appears to contain natural language. Use mathematical notation only (e.g., '3*x + 2').",
    })
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
