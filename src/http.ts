import { serve } from '@hono/node-server';
import { createHttpApp } from './server/transports/http-app.js';
import { giacEngine } from './server/giac/index.js';
import { createServer } from './server/index.js';

const port = parseInt(process.env.MCP_PORT || '3000', 10);
const host = process.env.MCP_HOST || '127.0.0.1';

const app = createHttpApp({
  healthProbe: () => giacEngine.isReady(),
  createServer,
});

async function start(): Promise<void> {
  await giacEngine.initialize();

  if (host === '0.0.0.0') {
    console.error(
      '[http] WARNING: bound to 0.0.0.0 with no authentication. ' +
        'Anyone who can reach this port can run computations on this server. ' +
        'Put it behind a reverse proxy or restrict MCP_HOST.'
    );
  }

  const server = serve({ fetch: app.fetch, port, hostname: host }, (info) => {
    console.log(`Axiom Math MCP Server (HTTP) listening on http://${host}:${info.port}/mcp`);
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
