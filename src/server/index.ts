import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { quickCalcTool, quickCalcHandler } from './tools/quick-calc.js';
import { advancedSolveTool, advancedSolveHandler } from './tools/advanced-solve.js';

const server = new Server(
  {
    name: 'axiom-advanced-math-mcp',
    version: '0.1.0'
  }
);

server.setRequestHandler(quickCalcTool, quickCalcHandler);
server.setRequestHandler(advancedSolveTool, advancedSolveHandler);

export default server;
