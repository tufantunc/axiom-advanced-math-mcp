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

/** POST a JSON-RPC message to the running server and return the parsed response. */
async function rpc(
  base: string,
  body: unknown
): Promise<{ status: number; contentType: string; sessionId: string | null; json: any }> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };

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

  it('lists the compute, verify and plot tools', async () => {
    await rpc(base, INIT);
    const { json } = await rpc(base, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const names = json.result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(['compute', 'plot', 'verify']);
  });

  it('computes a symbolic integral end to end', async () => {
    await rpc(base, INIT);
    const { json } = await rpc(base, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'compute', arguments: { problem: 'integrate(sin(x)^3,x)' } },
    });
    const text = json.result.content.map((c: { text: string }) => c.text).join('\n');
    expect(text).toContain('-cos(x)+cos(x)^3/3');
  });

  it('lists the registered prompts', async () => {
    await rpc(base, INIT);
    const { json } = await rpc(base, { jsonrpc: '2.0', id: 4, method: 'prompts/list', params: {} });
    expect(json.result.prompts.length).toBeGreaterThan(0);
  });
});
