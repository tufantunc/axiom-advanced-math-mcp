import type { CallToolResultSchema } from '@modelcontextprotocol/sdk';
import type { Tool } from '@modelcontextprotocol/sdk';
import { advancedSolveToolSchema } from './advanced-solve-schema.js';
import { AdvancedSolveService } from './advanced-solve-service.js';

export const advancedSolveTool: Tool = {
  name: 'advanced_solve',
  title: 'Advanced Symbolic Solver',
  description:
    'Symbolic computation using Giac/Xcas. Supports integration, derivatives, limits, equation solving, factorization, expansion, simplification, and differential equations.',
  inputSchema: advancedSolveToolSchema,
  outputSchema: {
    type: 'object',
    properties: {
      result: {
        type: 'string',
        description: 'The calculated symbolic result'
      },
      latex: {
        type: 'string',
        description: 'LaTeX formatted output (when format=latex)'
      },
      steps: {
        type: 'array',
        items: { type: 'string' },
        description: 'Step-by-step solution steps (if requested)'
      },
      variables: {
        type: 'array',
        items: { type: 'string' },
        description: 'Variables found in the expression'
      },
      domain: {
        type: 'string',
        description: 'Domain of the expression (if applicable)'
      }
    }
  } as any,
  annotations: {
    execution: {
      taskSupport: 'optional',
      timeout: 30000
    }
  }
};

export async function advancedSolveHandler(
  args: Record<string, unknown>
): CallToolResultSchema {
  const service = new AdvancedSolveService();
  const result = await service.evaluate(args as any);

  const content = [];

  content.push({
    type: 'text',
    text: `Result: ${result.result}`
  });

  if (result.latex) {
    content.push({
      type: 'text',
      text: `LaTeX: ${result.latex}`
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

  if (result.variables && result.variables.length > 0) {
    content.push({
      type: 'text',
      text: `Variables: ${result.variables.join(', ')}`
    });
  }

  if (result.domain) {
    content.push({
      type: 'text',
      text: `Domain: ${result.domain}`
    });
  }

  return {
    content,
    isError: false
  };
}
