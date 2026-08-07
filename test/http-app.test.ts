import { describe, it, expect } from 'vitest';
import { createHttpApp } from '../src/server/transports/http-app.js';
import { createServer } from '../src/server/index.js';
import { VERSION } from '../src/version.js';

/** POST a JSON-RPC message into the app in-process and parse the reply. */
async function post(app: ReturnType<typeof createHttpApp>, body: unknown) {
  const res = await app.fetch(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(body),
    })
  );
  const contentType = res.headers.get('content-type') ?? '';
  const text = await res.text();
  const json = contentType.includes('text/event-stream')
    ? JSON.parse(text.split('\n').find((l) => l.startsWith('data:'))!.slice(5).trim())
    : JSON.parse(text);
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
    const app = createHttpApp({ healthProbe: () => true });
    const res = await app.fetch(new Request('http://localhost/health'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; giac: boolean; transport: string };
    expect(body).toEqual({ status: 'ok', giac: true, transport: 'stateless' });
  });

  it('returns 503 and giac:false when the probe reports not ready', async () => {
    const app = createHttpApp({ healthProbe: () => false });
    const res = await app.fetch(new Request('http://localhost/health'));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string; giac: boolean };
    expect(body.status).toBe('degraded');
    expect(body.giac).toBe(false);
  });
});

describe('http-app POST /mcp (stateless)', () => {
  const app = createHttpApp({ healthProbe: () => true });

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

describe('http-app method rejection and errors', () => {
  const app = createHttpApp({ healthProbe: () => true });

  it('rejects GET /mcp with 405 (no SSE stream offered)', async () => {
    const res = await app.fetch(new Request('http://localhost/mcp', { method: 'GET' }));
    expect(res.status).toBe(405);
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32000);
  });

  it('rejects DELETE /mcp with 405 (no sessions to terminate)', async () => {
    const res = await app.fetch(new Request('http://localhost/mcp', { method: 'DELETE' }));
    expect(res.status).toBe(405);
  });

  it('maps a malformed JSON body to -32700', async () => {
    const res = await app.fetch(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{ not json',
      })
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: number; message: string } };
    expect(body.error.code).toBe(-32700);
    expect(body.error.message).toBe('Parse error');
  });

  it('returns a JSON-RPC shaped 404 for unknown paths', async () => {
    const res = await app.fetch(new Request('http://localhost/nope'));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { jsonrpc: string; error: { code: number } };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.error.code).toBe(-32601);
  });

  it('never leaks a stack trace in an internal error body', async () => {
    const boom = createHttpApp({
      healthProbe: () => {
        throw new Error('probe exploded at Object.<anonymous> (/secret/path.ts:1:1)');
      },
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
