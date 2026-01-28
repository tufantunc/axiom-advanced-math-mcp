import type { CallToolResultSchema } from '@modelcontextprotocol/sdk';
import type { Tool } from '@modelcontextprotocol/sdk';
import { quickCalcToolSchema } from './quick-calc-schema.js';
import { QuickCalcService } from './quick-calc-service.js';

export const quickCalcTool: Tool = {
  name: 'quick_calc',
  title: 'Quick Calculator',
  description:
    'Fast numerical calculations using math.js. Supports arithmetic, unit conversions, trigonometry, matrices, and complex numbers.',
  inputSchema: quickCalcToolSchema,
  outputSchema: {
    type: 'object',
    properties: {
      result: {
        type: ['number', 'string'],
        description: 'The calculated result'
      },
      latex: {
        type: 'string',
        description: 'LaTeX formatted output (when format=latex)'
      },
      units: {
        type: 'string',
        description: 'Unit information (when units conversion is performed)'
      },
      steps: {
        type: 'array',
        items: { type: 'string' },
        description: 'Step-by-step calculation steps (if available)'
      }
    }
  } as any,
  annotations: {
    execution: {
      taskSupport: 'optional',
      timeout: 10000
    }
  }
};

export async function quickCalcHandler(
  args: Record<string, unknown>
): CallToolResultSchema {
  const service = new QuickCalcService();
  const result = service.evaluate(args as any);

  const content = [];

  if (typeof result.result === 'number' || typeof result.result === 'string') {
    content.push({
      type: 'text',
      text: result.result.toString()
    });
  }

  if (result.latex) {
    content.push({
      type: 'text',
      text: `LaTeX: ${result.latex}`
    });
  }

  if (result.units) {
    content.push({
      type: 'text',
      text: `Units: ${result.units}`
    });
  }

  if (result.steps && result.steps.length > 0) {
    content.push({
      type: 'text',
      text: 'Steps:'
    });
    content.push(
      ...result.steps.map(step => ({
        type: 'text',
        text: step
      }))
    );
  }

  return {
    content,
    isError: false
  };
}
