import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * Replaces the 100 kb cap `express.json()` used to provide before the Hono
 * migration. `c.req.json()` has no size limit of its own, and
 * `@hono/node-server` buffers the whole request body before handing it to
 * Hono — so without an explicit cap, an unauthenticated `POST /mcp` is a
 * memory-exhaustion vector for anyone who can reach the port.
 *
 * 1 MB is generous for MCP payloads (the largest realistic case is a
 * regression dataset embedded in a `tools/call` argument) while still
 * bounding how much an unauthenticated caller can force this process to
 * buffer per request.
 */
const MAX_MCP_BODY_BYTES = 1024 * 1024;

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

  /**
   * Builds a fresh MCP server instance for a single request.
   *
   * Injected rather than imported: calling `createServer()` here directly
   * would pull `node:child_process` into this module via
   * index.ts -> tools/{compute,verify}/index.ts -> giac/index.ts ->
   * wrapper.ts -> worker-host.ts, and this module must stay free of Node
   * APIs so it can run unchanged on Workers/Deno/Bun.
   * Enforced by test/http-portability.test.ts.
   */
  createServer: () => McpServer;
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

  app.post(
    '/mcp',
    bodyLimit({
      maxSize: MAX_MCP_BODY_BYTES,
      onError: (c) =>
        c.json(
          {
            jsonrpc: '2.0',
            id: null,
            error: {
              code: -32000,
              message: `Request body exceeds the ${MAX_MCP_BODY_BYTES} byte limit`,
            },
          },
          413
        ),
    }),
    async (c) => {
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
      const server = options.createServer();
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
    }
  );

  // Every method other than POST gets a 405 here, with an Allow header and a
  // reason specific to why it doesn't apply: GET because this stateless
  // server never offers an SSE stream to poll, DELETE because there are no
  // sessions to terminate, anything else because the method just isn't
  // supported on this path. Registered with app.all() *after* the POST route
  // above so it can never shadow it: Hono chains handlers that match a
  // request in registration order, and the POST handler is terminal (it
  // never calls next()), so POST requests are answered before this ever
  // runs.
  app.all('/mcp', (c) => {
    const reason =
      c.req.method === 'GET'
        ? 'no SSE stream is offered by this stateless server'
        : c.req.method === 'DELETE'
          ? 'there are no sessions to terminate'
          : 'the method is not supported';
    c.header('Allow', 'POST');
    return c.json(
      { jsonrpc: '2.0', id: null, error: { code: -32000, message: `Method not allowed: ${reason}` } },
      405
    );
  });

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
