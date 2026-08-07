import { serve } from '@hono/node-server';
import { createHttpApp } from './server/transports/http-app.js';
import { giacEngine } from './server/giac/index.js';
import { createServer } from './server/index.js';

const rawPort = process.env.MCP_PORT || '3000';
const port = parseInt(rawPort, 10);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  // parseInt('garbage', 10) is NaN, and serve() silently binds an ephemeral
  // port when given NaN — the log line below would then claim a port the
  // process isn't actually listening on. Fail fast instead.
  console.error(`[http] invalid MCP_PORT: ${JSON.stringify(rawPort)} (must be an integer 0-65535)`);
  process.exit(1);
}
const host = process.env.MCP_HOST || '127.0.0.1';

// Comma-separated Host-header allowlist for DNS-rebinding protection (see
// createHttpApp's `allowedHosts` doc comment for the threat model). Reading
// process.env belongs here, not in http-app.ts, which must stay free of
// Node APIs. An unset or blank variable is passed through as an empty
// array so createHttpApp falls back to its loopback-only default rather
// than replacing it with an empty allowlist.
const allowedHosts = (process.env.MCP_ALLOWED_HOSTS || '')
  .split(',')
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0);

/**
 * Active health probe.
 *
 * `isReady()` alone latches: it goes false on any worker recycle (a routine
 * CAS timeout is enough) and only goes true again when the next `evaluate()`
 * lazily respawns the worker. /health never evaluates, so a fully working
 * server would report 503 indefinitely — and docker-compose's healthcheck
 * (30 s interval, 3 retries) would mark the container unhealthy ~90 s after
 * any timeout. Driving `initialize()` here makes the probe do the respawn
 * itself, so /health reports what the engine can actually do right now.
 */
async function probeGiac(): Promise<boolean> {
  try {
    await giacEngine.initialize();
    return giacEngine.isReady();
  } catch (err) {
    console.error('[http] health probe: giac warmup failed:', err);
    return false;
  }
}

const app = createHttpApp({
  healthProbe: probeGiac,
  createServer,
  ...(allowedHosts.length > 0 ? { allowedHosts } : {}),
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
