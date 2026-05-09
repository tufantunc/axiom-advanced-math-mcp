import express from 'express';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './server/index.js';
import { giacEngine } from './server/giac/index.js';

const app = express();
const port = parseInt(process.env.MCP_PORT || '3000', 10);
const host = process.env.MCP_HOST || '127.0.0.1';

// Session management
const sessions = new Map<string, StreamableHTTPServerTransport>();

app.use(express.json());

// MCP Streamable HTTP endpoint
app.post('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  if (sessionId && sessions.has(sessionId)) {
    const transport = sessions.get(sessionId);
    if (transport) {
      await transport.handleRequest(req, res, req.body);
      return;
    }
  }

  // New session
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });

  const server = createServer();
  await server.connect(transport);

  if (transport.sessionId) {
    sessions.set(transport.sessionId, transport);
  }

  transport.onclose = () => {
    if (transport.sessionId) {
      sessions.delete(transport.sessionId);
    }
  };

  await transport.handleRequest(req, res, req.body);
});

app.get('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !sessions.has(sessionId)) {
    res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'No valid session' } });
    return;
  }
  const transport = sessions.get(sessionId);
  if (!transport) {
    res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'No valid session' } });
    return;
  }
  await transport.handleRequest(req, res);
});

app.delete('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  const transportDelete = sessions.get(sessionId ?? '');
  if (!transportDelete) {
    res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'No valid session' } });
    return;
  }
  await transportDelete.handleRequest(req, res);
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', giac: giacEngine.isReady(), sessions: sessions.size });
});

async function start() {
  await giacEngine.initialize();

  app.listen(port, host, () => {
    console.log(`Axiom Math MCP Server (HTTP) listening on http://${host}:${port}/mcp`);
  });
}

start().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});

async function shutdown() {
  for (const transport of sessions.values()) {
    await transport.close();
  }
  sessions.clear();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
