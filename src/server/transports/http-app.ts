import { Hono } from 'hono';

export interface HttpAppOptions {
  /**
   * Reports whether the compute backend is ready to serve.
   *
   * Injected rather than imported: reaching for `giacEngine.isReady()` here
   * would pull `node:child_process` into this module via
   * giac/index.ts -> wrapper.ts -> worker-host.ts, and this module must stay
   * free of Node APIs so it can run unchanged on Workers/Deno/Bun.
   * Enforced by test/http-portability.test.ts.
   */
  healthProbe: () => boolean;
}

/**
 * Builds the MCP HTTP application.
 *
 * Web Standards only — no Node APIs, no port, no signal handling, no
 * environment access. The Node entrypoint (src/http.ts) supplies everything
 * host-specific.
 */
export function createHttpApp(options: HttpAppOptions): Hono {
  const app = new Hono();

  app.get('/health', (c) => {
    const ready = options.healthProbe();
    return c.json(
      { status: ready ? 'ok' : 'degraded', giac: ready, transport: 'stateless' },
      ready ? 200 : 503
    );
  });

  return app;
}
