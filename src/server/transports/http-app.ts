import { Hono, type Context } from 'hono';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createServer } from '../index.js';

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

  app.post('/mcp', async (c) => {
    // Parse here rather than letting the transport do it, so malformed JSON
    // gets a deterministic JSON-RPC parse error instead of a framework 400.
    let parsed: unknown;
    try {
      parsed = await c.req.json();
    } catch {
      return c.json(
        { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
        400
      );
    }

    // Stateless: a throwaway server + transport per request. This costs
    // ~0.25 ms, against 4-19 ms for a Giac evaluation. The expensive part —
    // the Giac worker process — is a module-level singleton and is untouched.
    //
    // enableJsonResponse is required, not cosmetic: without it the transport
    // answers with an SSE stream, and the close() below truncates the body to
    // "". With it, every response is a complete JSON body and closing once
    // handleRequest resolves is safe by construction.
    const server = createServer();
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);

    try {
      return await transport.handleRequest(c.req.raw, { parsedBody: parsed });
    } finally {
      await transport.close();
      await server.close();
    }
  });

  // The MCP spec requires 405 from servers that offer no SSE stream at this
  // endpoint. Session termination is likewise meaningless without sessions.
  const methodNotAllowed = (c: Context) =>
    c.json(
      {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32000, message: 'Method not allowed: this server is stateless' },
      },
      405
    );

  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);

  app.notFound((c) =>
    c.json(
      { jsonrpc: '2.0', id: null, error: { code: -32601, message: 'Not found' } },
      404
    )
  );

  app.onError((err, c) => {
    // Full detail to stderr; never into the response body. This is an
    // open-source server — leaking internals buys nothing.
    console.error('[http] unhandled error:', err);
    return c.json(
      { jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error' } },
      500
    );
  });

  return app;
}
