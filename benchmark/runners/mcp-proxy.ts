import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { NeutralTool } from '../providers/types.js';

export interface MCPProxy {
  tools: NeutralTool[];
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
  close(): Promise<void>;
}

/**
 * Create an MCP proxy that connects to the MCP server and exposes
 * its tools as NeutralTool[] (provider-agnostic format).
 */
export async function createMCPProxy(serverCmd: string[]): Promise<MCPProxy> {
  const [command, ...args] = serverCmd;

  // Pass the runner's full env to the spawned MCP server. Without this, the
  // SDK's getDefaultEnvironment() strips custom flags like AXIOM_OUTPUT_V2,
  // and the server runs with v1 defaults regardless of --features=output-v2.
  const transport = new StdioClientTransport({
    command,
    args,
    env: Object.fromEntries(
      Object.entries(process.env).filter(([, v]) => v !== undefined)
    ) as Record<string, string>,
  });
  const client = new Client({ name: 'benchmark', version: '1.0.0' });
  await client.connect(transport);

  const { tools: mcpTools } = await client.listTools();

  const tools: NeutralTool[] = mcpTools.map(t => ({
    name: t.name,
    description: t.description ?? '',
    inputSchema: t.inputSchema as NeutralTool['inputSchema'],
  }));

  return {
    tools,
    async callTool(name: string, toolArgs: Record<string, unknown>): Promise<string> {
      const result = await client.callTool({ name, arguments: toolArgs });
      const content = result.content as { type: string; text?: string }[];
      return content
        .filter(c => c.type === 'text' && c.text)
        .map(c => c.text!)
        .join('\n');
    },
    async close(): Promise<void> {
      await client.close();
    },
  };
}
