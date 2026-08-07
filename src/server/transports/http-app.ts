import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * Replaces the 100 kb cap `express.json()` used to provide before the Hono
 * migration. `c.req.json()` has no size limit of its own and buffers the
 * entire body into memory while parsing it — so without an explicit cap, an
 * unauthenticated `POST /mcp` is a memory-exhaustion vector for anyone who
 * can reach the port.
 *
 * 1 MB is generous for MCP payloads (the largest realistic case is a
 * regression dataset embedded in a `tools/call` argument) while still
 * bounding how much an unauthenticated caller can force this process to
 * buffer per request.
 */
export const MAX_MCP_BODY_BYTES = 1024 * 1024;

/**
 * Builds the standard JSON-RPC error envelope used for every error response
 * this app returns outside of a parsed JSON-RPC message (host/origin
 * rejection, body-limit, parse error, method-not-allowed, not-found, and
 * unhandled errors). `id` is always `null` here because none of these
 * failures ever get far enough to know the request's real id — either the
 * body was never parsed, or the failure happened before the transport had a
 * chance to look at it.
 */
function jsonRpcError(code: number, message: string) {
  return { jsonrpc: '2.0' as const, id: null, error: { code, message } };
}

/**
 * Loopback-only default for `allowedHosts`. Kept as bracketed `[::1]` to
 * match how the spec (and operators) write an IPv6 literal in a Host
 * header; `extractHostname` strips the brackets when normalizing it into
 * the comparison set below.
 */
const DEFAULT_ALLOWED_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/**
 * Pulls just the hostname out of a `Host` header value, discarding the
 * port, and normalizes it for allowlist comparison.
 *
 * Naively splitting on the first `:` would mangle a bracketed IPv6 literal
 * like `[::1]:3000` (or truncate bare `::1` to an empty string), so
 * bracketed hosts are unwrapped explicitly before falling back to a plain
 * `host:port` split.
 *
 * Lowercased because hostnames are case-insensitive (`Host: LOCALHOST` and
 * `Host: localhost` must be the same request) but `Set` membership is not —
 * comparing raw header bytes against a raw config string would fail-closed
 * on any case mismatch, on either side, for no security benefit. A trailing
 * FQDN dot (`localhost.`) is stripped for the same reason: it's a different
 * string but the same host.
 */
function extractHostname(hostHeader: string): string {
  const withoutPort = hostHeader.startsWith('[')
    ? (() => {
        const closeBracket = hostHeader.indexOf(']');
        return closeBracket === -1 ? hostHeader : hostHeader.slice(1, closeBracket);
      })()
    : (() => {
        const colonIndex = hostHeader.indexOf(':');
        return colonIndex === -1 ? hostHeader : hostHeader.slice(0, colonIndex);
      })();
  const lower = withoutPort.toLowerCase();
  return lower.endsWith('.') ? lower.slice(0, -1) : lower;
}

export interface HttpAppOptions {
  /**
   * Reports whether the compute backend is ready to serve.
   *
   * May be async, and is expected to be *active* rather than a flag read:
   * the Node entrypoint's probe drives the engine's warmup so a worker that
   * was recycled by a routine CAS timeout respawns here instead of leaving
   * /health latched at 503 until unrelated traffic happens to revive it.
   *
   * Injected rather than imported: reaching for `giacEngine.isReady()` here
   * would pull `node:child_process` into this module via
   * giac/index.ts -> wrapper.ts -> worker-host.ts, and this module must stay
   * free of Node APIs so it can run unchanged on Workers/Deno/Bun.
   * Enforced by test/http-portability.test.ts.
   */
  healthProbe: () => boolean | Promise<boolean>;

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

  /**
   * Hostnames permitted in the `Host` header on `POST /mcp`, compared
   * ignoring port. Defaults to the loopback set (`localhost`, `127.0.0.1`,
   * `[::1]`) when omitted. When provided, the list REPLACES the default
   * rather than extending it -- an operator who names hosts explicitly is
   * saying exactly what should be reachable, not "loopback plus this".
   *
   * This defends against DNS rebinding: a malicious page can make a
   * victim's browser resolve an attacker-controlled domain to 127.0.0.1
   * and then issue a same-origin request that reaches this server despite
   * it never being intentionally exposed. It is NOT authentication -- it
   * only constrains which domain names may reach this endpoint.
   *
   * Injected rather than read from `process.env.MCP_ALLOWED_HOSTS` here:
   * touching `process` would pull Node-specific behavior into a module
   * that must stay portable to Workers/Deno/Bun. `src/http.ts` reads the
   * environment and passes the parsed result down.
   * Enforced by test/http-portability.test.ts.
   */
  allowedHosts?: string[];
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

  // Normalized once at app-build time; extractHostname strips the
  // brackets off a bracketed IPv6 entry so it compares equal to whatever
  // extractHostname produces from an incoming Host header.
  const allowedHosts = new Set(
    (options.allowedHosts ?? DEFAULT_ALLOWED_HOSTS).map(extractHostname)
  );

  app.get('/health', async (c) => {
    const ready = await options.healthProbe();
    return c.json(
      { status: ready ? 'ok' : 'degraded', giac: ready, transport: 'stateless' },
      ready ? 200 : 503
    );
  });

  app.post(
    '/mcp',
    // DNS-rebinding protection (see the `allowedHosts` doc comment above).
    // Scoped to /mcp only, not /health: /mcp executes CAS computations --
    // the actual threat surface -- while /health is inert and is
    // legitimately probed by monitoring systems from outside the
    // allowlist, so gating it too would break harmless health checks for
    // no security benefit.
    async (c, next) => {
      const hostHeader = c.req.header('host');
      // A missing or empty Host header is rejected outright (fail closed)
      // rather than treated as "no restriction applies".
      const hostname = hostHeader ? extractHostname(hostHeader) : '';
      if (!hostHeader || !allowedHosts.has(hostname)) {
        return c.json(
          jsonRpcError(
            -32000,
            `Host not allowed: ${hostHeader ?? '(missing)'}. Set MCP_ALLOWED_HOSTS to permit this host.`
          ),
          403
        );
      }
      await next();
    },
    // Origin validation, alongside the Host check above. Not currently
    // exploitable on its own -- the SDK's 415 on non-JSON content types and
    // the 405 a CORS preflight falls through to (with no
    // Access-Control-Allow-Origin) already stop a browser from mounting
    // this attack -- but that protection lives in a dependency's strictness,
    // not in a check this app owns. An absent Origin is allowed outright:
    // that's the normal shape of a non-browser client (curl, another
    // server, an MCP client library) and must keep working.
    async (c, next) => {
      const origin = c.req.header('origin');
      if (origin) {
        let originHost = '';
        try {
          originHost = extractHostname(new URL(origin).host);
        } catch {
          // Unparseable Origin header -- fail closed rather than guess.
        }
        if (!allowedHosts.has(originHost)) {
          return c.json(
            jsonRpcError(
              -32000,
              `Origin not allowed: ${origin}. Set MCP_ALLOWED_HOSTS to permit this host.`
            ),
            403
          );
        }
      }
      await next();
    },
    bodyLimit({
      maxSize: MAX_MCP_BODY_BYTES,
      onError: (c) =>
        c.json(
          jsonRpcError(-32000, `Request body exceeds the ${MAX_MCP_BODY_BYTES} byte limit`),
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
        return c.json(jsonRpcError(-32700, 'Parse error'), 400);
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
    return c.json(jsonRpcError(-32000, `Method not allowed: ${reason}`), 405);
  });

  // -32601 ("method not found") is a JSON-RPC-spec code meaning the RPC
  // *method* named in a parsed message doesn't exist. A 404 here fires
  // before any JSON-RPC message is even parsed -- it's an unknown HTTP
  // *path* -- so it reuses the implementation-defined -32000 already used
  // for the other rejections above instead of overloading a spec code that
  // means something more specific.
  app.notFound((c) => c.json(jsonRpcError(-32000, 'Not found'), 404));

  app.onError((err, c) => {
    // Full detail to stderr; never into the response body. This is an
    // open-source server — leaking internals buys nothing.
    console.error('[http] unhandled error:', err);
    return c.json(jsonRpcError(-32603, 'Internal error'), 500);
  });

  return app;
}
