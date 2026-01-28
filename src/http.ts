import { createHttpTransport } from './server/transports/http.js';

const port = parseInt(process.env.MCP_PORT || '3000', 10);
const host = process.env.MCP_HOST || '127.0.0.1';

console.log(`Starting Axiom Math MCP HTTP server on ${host}:${port}`);

createHttpTransport(port);

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

function gracefulShutdown() {
  console.log('Shutting down gracefully...');
  process.exit(0);
}
