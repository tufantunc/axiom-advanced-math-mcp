import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { existsSync } from 'node:fs';
import { VERSION } from '../src/version.js';

/** Ask the OS for a free TCP port, then release it for the server to claim. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      if (addr === null || typeof addr === 'string') {
        probe.close();
        reject(new Error('could not determine a free port'));
        return;
      }
      const { port } = addr;
      probe.close(() => resolve(port));
    });
  });
}

/** Poll /health until the server answers or we give up. */
async function waitForReady(base: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return;
      lastError = new Error(`health returned ${res.status}`);
    } catch (e) {
      lastError = e;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not become ready: ${String(lastError)}`);
}

/**
 * POST a JSON-RPC message and return the parsed response.
 *
 * `sessionId` is forwarded as `mcp-session-id` when given. A stateful server
 * requires it on every request after `initialize`; a stateless one issues no
 * session id, so callers pass the null they got back and no header is sent.
 * The same helper therefore drives both transports.
 */
async function rpc(
  base: string,
  body: unknown,
  sessionId?: string | null
): Promise<{ status: number; contentType: string; sessionId: string | null; json: any }> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;

  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const contentType = res.headers.get('content-type') ?? '';
  const responseSessionId = res.headers.get('mcp-session-id');
  const text = await res.text();
  // Streamable HTTP may answer either as plain JSON or as a single SSE event.
  const payload = contentType.includes('text/event-stream')
    ? JSON.parse(text.split('\n').find((l) => l.startsWith('data:'))!.slice(5).trim())
    : JSON.parse(text);
  return { status: res.status, contentType, sessionId: responseSessionId, json: payload };
}

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'contract-test', version: '1.0.0' },
  },
};

describe('HTTP transport contract (subprocess, real HTTP)', () => {
  let child: ChildProcess;
  let base: string;

  beforeAll(async () => {
    if (!existsSync('dist/http.js')) {
      throw new Error('dist/http.js missing — run `npm run build` before the integration suite');
    }
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    child = spawn('node', ['dist/http.js'], {
      env: { ...process.env, MCP_PORT: String(port), MCP_HOST: '127.0.0.1' },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    await waitForReady(base);
  }, 60_000);

  afterAll(() => {
    child?.kill('SIGKILL');
  });

  it('reports the correct serverInfo on initialize', async () => {
    const { status, json } = await rpc(base, INIT);
    expect(status).toBe(200);
    expect(json.result.serverInfo.name).toBe('axiom-advanced-math-mcp');
    expect(json.result.serverInfo.version).toBe(VERSION);
  });

  it('serves /health', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; giac: boolean };
    expect(body.status).toBe('ok');
    expect(body.giac).toBe(true);
  });

  // CHARACTERIZATION TEST — pins a defect, not desired behaviour.
  //
  // src/http.ts:36 reads transport.sessionId immediately after connect(), but
  // the SDK assigns it while handling `initialize`, which happens later at
  // handleRequest. The guard never fires, so the session map is never
  // populated (/health reports sessions: 0 after any number of initializes).
  //
  // The session id MUST be forwarded here. Without it, src/http.ts builds a
  // fresh uninitialized transport for the second request and returns the same
  // error for an unrelated reason — the test would pass no matter what the
  // session map does, and would pin nothing. Sending the id is what makes the
  // assertion depend on the defect: a correct stateful server would honour it.
  //
  // Task 6 REPLACES this test with real protocol assertions. If it starts
  // failing before then, the session bug changed and this plan needs revising.
  it('currently rejects requests after initialize even with the session id (defect, fixed in Task 6)', async () => {
    const init = await rpc(base, INIT);
    expect(init.sessionId, 'Express should issue a session id on initialize').toBeTruthy();

    const { json } = await rpc(
      base,
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      init.sessionId
    );
    expect(json.error, 'expected an error response, got a result').toBeDefined();
    expect(json.error.message).toContain('Server not initialized');
  });
});
