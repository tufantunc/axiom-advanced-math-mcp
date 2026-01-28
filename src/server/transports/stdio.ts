import type { Tool } from '@modelcontextprotocol/sdk/index.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/transports/stdio.js';
import { quickCalcTool, quickCalcHandler } from './tools/quick-calc.js';
import { advancedSolveTool, advancedSolveHandler } from './tools/advanced-solve.js';

export async function startStdioServer(): Promise<void> {
  const transport = new StdioServerTransport();
  const server = new Server(
    {
      name: 'axiom-advanced-math-mcp',
      version: '0.1.0',
      instructions: `Axiom MCP Server provides advanced mathematical computation capabilities to LLMs.

Available tools:
1. quick_calc - Fast numerical calculations using math.js
2. advanced_solve - Symbolic computation using Giac/Xcas
  `
    }
  );

  server.setRequestHandler(quickCalcTool, quickCalcHandler);
  server.setRequestHandler(advancedSolveTool, advancedSolveHandler);

  await server.connect(transport);

  console.log('Axiom Math MCP Server running on stdio transport');
}

export async function startHttpServer(port: number = 3000): Promise<void> {
  console.log(`Starting Axiom Math MCP HTTP server on port ${port}`);
  console.log('HTTP transport not yet implemented - use stdio transport for now');
}
