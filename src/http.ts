import { serve } from '@hono/node-server';
import { createHttpApp } from './server/transports/http-app.js';
import { giacEngine } from './server/giac/index.js';
import { createGiacHealthProbe } from './server/giac/health-probe.js';
import { createServer } from './server/index.js';

const rawPort = process.env.MCP_PORT || '3000';
const port = Number.parseInt(rawPort, 10);
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

// Active (it respawns a recycled worker) but bounded (a health endpoint must
// answer promptly, and a cold `initialize()` can run to the worker host's 30 s
// init timeout). See createGiacHealthProbe.
const probeGiac = createGiacHealthProbe(giacEngine);

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
    // server.close() waits for in-flight connections to finish, with no
    // deadline of its own -- a single wedged connection (or a Giac call that
    // never returns) would extend shutdown indefinitely. `.unref()` keeps
    // this timer from itself holding the process open once close() succeeds
    // first, and the timer is cleared in that case so a clean shutdown never
    // waits out the full 10 s.
    const forceExitTimer = setTimeout(() => {
      console.error('[http] graceful shutdown timed out after 10s; forcing exit');
      process.exit(1);
    }, 10_000);
    forceExitTimer.unref();

    server.close(() => {
      clearTimeout(forceExitTimer);
      process.exit(0);
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
