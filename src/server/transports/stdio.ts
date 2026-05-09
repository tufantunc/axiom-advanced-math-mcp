import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from '../index.js';
import { giacEngine } from '../giac/index.js';

export async function startStdioServer(): Promise<void> {
  await giacEngine.initialize();

  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
