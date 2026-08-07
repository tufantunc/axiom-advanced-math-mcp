import { describe, it, expect } from 'vitest';
import { createHttpApp, MAX_MCP_BODY_BYTES } from '../src/server/transports/http-app.js';
import { createServer } from '../src/server/index.js';
import { VERSION } from '../src/version.js';

/**
 * POST a JSON-RPC message into the app in-process and parse the reply.
 *
 * Sets an explicit `Host: localhost` header: unlike a real HTTP client, an
 * in-memory `Request` never synthesizes one from the URL (confirmed: Node's
 * `new Request('http://localhost/...').headers.get('host')` is `null`), and
 * this app now rejects `POST /mcp` when the host is missing. `localhost` is
 * inside the default allowlist, so this keeps the helper's behavior
 * matching what it always conceptually represented -- a request to
 * `http://localhost`.
 */
async function post(app: ReturnType<typeof createHttpApp>, body: unknown) {
  const res = await app.fetch(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        host: 'localhost',
      },
      body: JSON.stringify(body),
    })
  );
  const contentType = res.headers.get('content-type') ?? '';
  const text = await res.text();
  // Responses from this app are always application/json — pinned by the
  // "answers with a complete JSON body, not a stream" test below — so no
  // SSE-framing branch is needed here.
  const json = JSON.parse(text);
  return { res, contentType, json };
}

const INIT_MSG = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'unit-test', version: '1.0.0' },
  },
};

describe('http-app /health', () => {
  it('returns 200 and giac:true when the probe reports ready', async () => {
    const app = createHttpApp({ healthProbe: () => true, createServer });
    const res = await app.fetch(new Request('http://localhost/health'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; giac: boolean; transport: string };
    expect(body).toEqual({ status: 'ok', giac: true, transport: 'stateless' });
  });

  it('returns 503 and giac:false when the probe reports not ready', async () => {
    const app = createHttpApp({ healthProbe: () => false, createServer });
    const res = await app.fetch(new Request('http://localhost/health'));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string; giac: boolean };
    expect(body.status).toBe('degraded');
    expect(body.giac).toBe(false);
  });

  it('awaits an async probe (the Node entrypoint drives an engine warmup in it)', async () => {
    // The real probe respawns a recycled Giac worker rather than reading a
    // latched isReady() flag, so it has to be allowed to be async.
    let calls = 0;
    const app = createHttpApp({
      healthProbe: async () => {
        calls++;
        await Promise.resolve();
        return true;
      },
      createServer,
    });

    const res = await app.fetch(new Request('http://localhost/health'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', giac: true, transport: 'stateless' });

    // Re-probed per request: a probe result is never cached, which is what
    // lets a recovered engine flip /health back to 200 on its own.
    await app.fetch(new Request('http://localhost/health'));
    expect(calls).toBe(2);
  });

  it('returns 503 when an async probe resolves false', async () => {
    const app = createHttpApp({ healthProbe: async () => false, createServer });
    const res = await app.fetch(new Request('http://localhost/health'));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string; giac: boolean };
    expect(body).toMatchObject({ status: 'degraded', giac: false });
  });

  it('returns 500 without leaking detail when an async probe rejects', async () => {
    const app = createHttpApp({
      healthProbe: () => Promise.reject(new Error('warmup failed at /secret/path.ts:1:1')),
      createServer,
    });
    const res = await app.fetch(new Request('http://localhost/health'));
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain('/secret/path.ts');
    expect(JSON.parse(text).error.code).toBe(-32603);
  });
});

describe('http-app POST /mcp (stateless)', () => {
  const app = createHttpApp({ healthProbe: () => true, createServer });

  it('answers initialize with the correct serverInfo', async () => {
    const { res, json } = await post(app, INIT_MSG);
    expect(res.status).toBe(200);
    expect(json.result.serverInfo.name).toBe('axiom-advanced-math-mcp');
    expect(json.result.serverInfo.version).toBe(VERSION);
  });

  it('lists all three tools', async () => {
    const { json } = await post(app, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const names = json.result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(['compute', 'plot', 'verify']);
  });

  it('computes a symbolic integral end to end', async () => {
    const { json } = await post(app, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'compute', arguments: { problem: 'integrate(sin(x)^3,x)' } },
    });
    const text = json.result.content.map((c: { text: string }) => c.text).join('\n');
    expect(text).toContain('-cos(x)+cos(x)^3/3');
  });

  it('rejects an oversized compute problem before it ever reaches mathjs/Giac', async () => {
    // Guards the compute schema's `.max()` on `problem` (see
    // src/server/tools/compute/schema.ts): without it, an oversized problem
    // that happens to classify as arithmetic is routed straight to a
    // synchronous, un-timed-out mathjs.evaluate() on the event loop.
    //
    // The SDK reports schema-validation failures as a tool-call result with
    // isError: true (not a top-level JSON-RPC error) -- MCP error -32602 is
    // embedded in the result's text content.
    const { res, json } = await post(app, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'compute', arguments: { problem: '1+'.repeat(5000) } },
    });
    expect(res.status).toBe(200);
    expect(json.result.isError).toBe(true);
    const text = json.result.content.map((c: { text: string }) => c.text).join('\n');
    expect(text).toContain('-32602');
    expect(text).toMatch(/problem must be at most 8192 characters/);
  });

  it('never issues a session id', async () => {
    const { res } = await post(app, INIT_MSG);
    expect(res.headers.get('mcp-session-id')).toBeNull();
  });

  it('serves two independent requests with no handshake between them', async () => {
    const a = await post(app, { jsonrpc: '2.0', id: 10, method: 'tools/list', params: {} });
    const b = await post(app, { jsonrpc: '2.0', id: 11, method: 'tools/list', params: {} });
    expect(a.json.result.tools.length).toBeGreaterThan(0);
    expect(b.json.result.tools.length).toBe(a.json.result.tools.length);
  });

  it('answers with a complete JSON body, not a stream', async () => {
    // Pins the contract the cleanup depends on. The transport is closed as
    // soon as handleRequest resolves, which is only safe while responses are
    // complete JSON bodies — that is what enableJsonResponse guarantees.
    // Without it the transport answers with SSE and the body arrives empty
    // (measured). If someone drops that option, this fails loudly instead of
    // truncating responses in production.
    const { contentType, json } = await post(app, INIT_MSG);
    expect(contentType).toContain('application/json');
    expect(json.result).toBeDefined();
  });
});

describe('http-app CAS state isolation between requests', () => {
  // The HTTP transport is stateless and multi-client, but the Giac worker is
  // one process-wide engine with global session state. Without a reset at the
  // tool-call boundary, one request's `sto`/`assume` silently rewrites the
  // next request's answer — including a request from a different client —
  // and it comes back as a confident 200.
  const app = createHttpApp({ healthProbe: () => true, createServer });

  async function compute(id: number, problem: string): Promise<string> {
    const { json } = await post(app, {
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: 'compute', arguments: { problem } },
    });
    return json.result.content.map((c: { text: string }) => c.text).join('\n');
  }

  it('does not carry a `sto` assignment into the next request', async () => {
    await compute(30, 'sto(7,qq)');
    const text = await compute(31, 'simplify(qq+1)');
    // Pre-fix this is "8": qq is still bound to 7 from the previous request.
    expect(text).toContain('qq+1');
    expect(text).not.toMatch(/\b8\b/);
  });

  it('does not carry an `assume` hypothesis into the next request', async () => {
    await compute(32, 'assume(bb>0)');
    const text = await compute(33, 'integrate(sqrt(bb^2),bb)');
    // Pre-fix this is "bb^2/2" — correct only under the leaked bb>0.
    expect(text).toContain('sign(bb)');
  });

  // Resetting at the tool-call boundary only makes *sequential* calls
  // independent. One tool call makes several `evaluate()` calls (the
  // computation, its latex, its verification pass), so two overlapping calls
  // interleave against the one shared worker and the reset of one lands in the
  // middle of the other. Over a stateless multi-client HTTP transport, that
  // overlap is the normal case, not an edge case — hence the session lock.

  it('does not leak a `sto` assignment into a CONCURRENT request', async () => {
    const [, reader] = await Promise.all([compute(34, 'sto(5,c1)'), compute(35, 'simplify(c1+1)')]);
    // Pre-fix this is "6": the writer's `sto` landed between the reader's
    // reset and the reader's own evaluation.
    expect(reader).toContain('c1+1');
    expect(reader).not.toMatch(/\b6\b/);
  });

  it('does not leak `sto` between four concurrent writers and four readers', async () => {
    const calls: Promise<string>[] = [];
    for (let k = 0; k < 4; k++) {
      calls.push(compute(40 + k, `sto(5,d${k})`));
      calls.push(compute(50 + k, `simplify(d${k}+1)`));
    }
    const results = await Promise.all(calls);
    const readers = results.filter((_, i) => i % 2 === 1);
    // Pre-fix all four readers saw their writer's value and answered "6".
    for (let k = 0; k < 4; k++) {
      expect(readers[k]).toContain(`d${k}+1`);
      expect(readers[k]).not.toMatch(/\b6\b/);
    }
  });
});

describe('http-app method rejection and errors', () => {
  const app = createHttpApp({ healthProbe: () => true, createServer });

  it('rejects GET /mcp with 405 (no SSE stream offered)', async () => {
    const res = await app.fetch(new Request('http://localhost/mcp', { method: 'GET' }));
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
    const body = (await res.json()) as { error: { code: number; message: string } };
    expect(body.error.code).toBe(-32000);
    expect(body.error.message).toContain('no SSE stream is offered');
  });

  it('rejects DELETE /mcp with 405 (no sessions to terminate)', async () => {
    const res = await app.fetch(new Request('http://localhost/mcp', { method: 'DELETE' }));
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
    const body = (await res.json()) as { error: { code: number; message: string } };
    expect(body.error.message).toContain('no sessions to terminate');
  });

  it('rejects PUT /mcp with 405 rather than 404, with an Allow header', async () => {
    const res = await app.fetch(new Request('http://localhost/mcp', { method: 'PUT' }));
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
    const body = (await res.json()) as { error: { code: number; message: string } };
    expect(body.error.code).toBe(-32000);
    expect(body.error.message).toContain('method is not supported');
  });

  it('rejects a body over the 1 MB limit with 413 and a JSON-RPC error', async () => {
    // Replaces the 100 kb cap express.json() used to provide. 2 MB comfortably
    // clears the 1 MB limit so this can't flake on encoding overhead.
    const oversized = 'x'.repeat(2 * 1024 * 1024);
    const res = await app.fetch(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', host: 'localhost' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: oversized } }),
      })
    );
    expect(res.status).toBe(413);
    const body = (await res.json()) as { jsonrpc: string; error: { code: number; message: string } };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.error.code).toBe(-32000);
    expect(body.error.message).toMatch(/exceeds/i);
  });

  /**
   * Builds a JSON-RPC `ping` request body whose exact byte length is
   * `targetBytes`, by padding an unused params field. All characters
   * involved (JSON structure, digits, `x`) are ASCII, so `.length` and the
   * UTF-8 byte length coincide -- no separate byte-counting needed.
   */
  function pingBodyOfSize(targetBytes: number): string {
    const withoutPad = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'ping',
      params: { pad: '' },
    });
    const padLength = targetBytes - withoutPad.length;
    if (padLength < 0) {
      throw new Error(`target ${targetBytes} is smaller than the unpadded body (${withoutPad.length})`);
    }
    return JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'ping',
      params: { pad: 'x'.repeat(padLength) },
    });
  }

  it('accepts a body exactly at the 1 MB limit', async () => {
    const body = pingBodyOfSize(MAX_MCP_BODY_BYTES);
    expect(Buffer.byteLength(body)).toBe(MAX_MCP_BODY_BYTES);
    const res = await app.fetch(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', host: 'localhost' },
        body,
      })
    );
    expect(res.status).not.toBe(413);
  });

  it('rejects a body one byte over the 1 MB limit with 413', async () => {
    const body = pingBodyOfSize(MAX_MCP_BODY_BYTES + 1);
    expect(Buffer.byteLength(body)).toBe(MAX_MCP_BODY_BYTES + 1);
    const res = await app.fetch(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', host: 'localhost' },
        body,
      })
    );
    expect(res.status).toBe(413);
    const responseBody = (await res.json()) as { error: { code: number; message: string } };
    expect(responseBody.error.code).toBe(-32000);
  });

  it('maps a malformed JSON body to -32700', async () => {
    const res = await app.fetch(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', host: 'localhost' },
        body: '{ not json',
      })
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: number; message: string } };
    expect(body.error.code).toBe(-32700);
    expect(body.error.message).toBe('Parse error');
  });

  it('returns a JSON-RPC shaped 404 for unknown paths, using -32000 (not the ' +
    'spec-defined -32601 "method not found", since no JSON-RPC message was ' +
    'ever parsed here)', async () => {
    const res = await app.fetch(new Request('http://localhost/nope'));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { jsonrpc: string; error: { code: number } };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.error.code).toBe(-32000);
  });

  it('never leaks a stack trace in an internal error body', async () => {
    const boom = createHttpApp({
      healthProbe: () => {
        throw new Error('probe exploded at Object.<anonymous> (/secret/path.ts:1:1)');
      },
      createServer,
    });
    const res = await boom.fetch(new Request('http://localhost/health'));
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toMatch(/at .*\(/);
    expect(text).not.toContain('/secret/path.ts');
    const body = JSON.parse(text) as { error: { code: number; message: string } };
    expect(body.error.code).toBe(-32603);
    expect(body.error.message).toBe('Internal error');
  });
});

describe('http-app Host header validation (DNS-rebinding protection)', () => {
  /** POST /mcp with an explicit Host header, bypassing the request's own URL host. */
  async function postWithHost(app: ReturnType<typeof createHttpApp>, host: string | null) {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    if (host !== null) headers.host = host;
    return app.fetch(
      new Request('http://placeholder/mcp', {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      })
    );
  }

  it('allows Host: localhost (default allowlist)', async () => {
    const app = createHttpApp({ healthProbe: () => true, createServer });
    const res = await postWithHost(app, 'localhost');
    expect(res.status).toBe(200);
  });

  it('allows Host: 127.0.0.1:3000 (port ignored, default allowlist)', async () => {
    const app = createHttpApp({ healthProbe: () => true, createServer });
    const res = await postWithHost(app, '127.0.0.1:3000');
    expect(res.status).toBe(200);
  });

  it('allows Host: [::1]:3000 (bracketed IPv6, port ignored, default allowlist)', async () => {
    const app = createHttpApp({ healthProbe: () => true, createServer });
    const res = await postWithHost(app, '[::1]:3000');
    expect(res.status).toBe(200);
  });

  it('rejects an unrecognized Host with 403 and a JSON-RPC error naming the host', async () => {
    const app = createHttpApp({ healthProbe: () => true, createServer });
    const res = await postWithHost(app, 'evil.example.com');
    expect(res.status).toBe(403);
    const body = (await res.json()) as { jsonrpc: string; error: { code: number; message: string } };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.error.code).toBe(-32000);
    expect(body.error.message).toContain('evil.example.com');
    expect(body.error.message).toContain('MCP_ALLOWED_HOSTS');
  });

  it('an explicit allowedHosts list replaces the default rather than extending it', async () => {
    const app = createHttpApp({
      healthProbe: () => true,
      createServer,
      allowedHosts: ['mcp.example.com'],
    });

    const allowed = await postWithHost(app, 'mcp.example.com');
    expect(allowed.status).toBe(200);

    const nowRejected = await postWithHost(app, 'localhost');
    expect(nowRejected.status).toBe(403);
  });

  it('allows Host: LOCALHOST (comparison is case-insensitive)', async () => {
    const app = createHttpApp({ healthProbe: () => true, createServer });
    const res = await postWithHost(app, 'LOCALHOST');
    expect(res.status).toBe(200);
  });

  it('allows Host: localhost. (a trailing FQDN dot is stripped)', async () => {
    const app = createHttpApp({ healthProbe: () => true, createServer });
    const res = await postWithHost(app, 'localhost.');
    expect(res.status).toBe(200);
  });

  it('a mixed-case configured allowlist entry matches a lowercase Host header', async () => {
    const app = createHttpApp({
      healthProbe: () => true,
      createServer,
      allowedHosts: ['MCP.Example.com'],
    });
    const res = await postWithHost(app, 'mcp.example.com');
    expect(res.status).toBe(200);
  });

  it('a mixed-case configured allowlist entry also matches a same-case Host header', async () => {
    const app = createHttpApp({
      healthProbe: () => true,
      createServer,
      allowedHosts: ['MCP.Example.com'],
    });
    const res = await postWithHost(app, 'MCP.Example.com');
    expect(res.status).toBe(200);
  });

  it('rejects a missing Host header (fail closed)', async () => {
    const app = createHttpApp({ healthProbe: () => true, createServer });
    const res = await postWithHost(app, null);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: number; message: string } };
    expect(body.error.code).toBe(-32000);
  });

  it('does not apply the Host check to GET /health', async () => {
    const app = createHttpApp({ healthProbe: () => true, createServer });
    const res = await app.fetch(
      new Request('http://placeholder/health', { headers: { host: 'evil.example.com' } })
    );
    expect(res.status).toBe(200);
  });
});

describe('http-app Origin header validation', () => {
  /** POST /mcp with a Host header always present and an optional Origin header. */
  async function postWithOrigin(app: ReturnType<typeof createHttpApp>, origin: string | undefined) {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      host: 'localhost',
    };
    if (origin !== undefined) headers.origin = origin;
    return app.fetch(
      new Request('http://placeholder/mcp', {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      })
    );
  }

  it('allows a request with no Origin header (non-browser clients)', async () => {
    const app = createHttpApp({ healthProbe: () => true, createServer });
    const res = await postWithOrigin(app, undefined);
    expect(res.status).toBe(200);
  });

  it('allows an Origin whose host is in the allowlist', async () => {
    const app = createHttpApp({ healthProbe: () => true, createServer });
    const res = await postWithOrigin(app, 'http://localhost:5173');
    expect(res.status).toBe(200);
  });

  it('rejects an Origin whose host is not in the allowlist, with a JSON-RPC error naming it', async () => {
    const app = createHttpApp({ healthProbe: () => true, createServer });
    const res = await postWithOrigin(app, 'https://evil.example.com');
    expect(res.status).toBe(403);
    const body = (await res.json()) as { jsonrpc: string; error: { code: number; message: string } };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.error.code).toBe(-32000);
    expect(body.error.message).toContain('evil.example.com');
  });

  it('honors a custom allowedHosts list for Origin the same way it does for Host', async () => {
    const app = createHttpApp({
      healthProbe: () => true,
      createServer,
      allowedHosts: ['mcp.example.com'],
    });
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      host: 'mcp.example.com',
      origin: 'https://mcp.example.com',
    };
    const res = await app.fetch(
      new Request('http://placeholder/mcp', {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      })
    );
    expect(res.status).toBe(200);
  });

  it('does not apply the Origin check to GET /health', async () => {
    const app = createHttpApp({ healthProbe: () => true, createServer });
    const res = await app.fetch(
      new Request('http://placeholder/health', { headers: { origin: 'https://evil.example.com' } })
    );
    expect(res.status).toBe(200);
  });
});
